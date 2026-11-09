// Command mypaste-code-edit is the editor surface's own runtime.
//
// Protocol v3 lets a UI package that declares `kind: "ui"` also declare a
// runtime and internal commands (no placement). Only that package's own
// surface can reach them, and they never appear in the command palette. The
// page calls one per formatting operation, so the editor keeps its formatting
// when no separate capability package is installed.
//
// The runtime speaks the plugin v2 line protocol (PLUGINS.md section 4): one
// request line on stdin, one response line on stdout. Local formatting engines
// stay the reviewed files shipped beside this binary under engines/: the
// runtime only runs those fixed scripts with a fixed interpreter. The one
// in-process engine is SQL, compiled from the shared sqlkit module that
// com.mypaste.sql also uses.
package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/zhanghuid/mypaste-code-extensions/shared/sqlkit"
)

const (
	// The host bounds extension text at 256 KiB; this is a second, looser
	// ceiling so a broken caller cannot make the runtime buffer forever.
	maxRequestBytes = 1 << 20
	toolTimeout     = 10 * time.Second
	errorCode       = "format-failed"
)

// invocation is the plugin v2 request line, reduced to the fields this
// command reads. Unknown fields are ignored by design.
type invocation struct {
	ID        string         `json:"id"`
	Method    string         `json:"method"`
	CommandID string         `json:"commandId"`
	Settings  map[string]any `json:"settings"`
	Selection *struct {
		Text string `json:"text"`
	} `json:"selection"`
	Input *struct {
		Type string `json:"type"`
		Text string `json:"text"`
	} `json:"input"`
	DeadlineUnixMs int64 `json:"deadlineUnixMs"`
}

// response is the one-line reply. Exactly one of result / error is set.
type response struct {
	ID     string       `json:"id"`
	OK     bool         `json:"ok"`
	Result *resultShape `json:"result,omitempty"`
	Error  *errorShape  `json:"error,omitempty"`
}

type resultShape struct {
	Output string `json:"output,omitempty"`
	Effect string `json:"effect,omitempty"`
}

type errorShape struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// builtin describes one internal command. `script` names a file under the
// package's engines/ directory; an empty script means the operation runs in
// process (only SQL does).
type builtin struct {
	script   string
	arg      string
	node     bool
	compress bool
}

// builtins is the closed command set the page knows. Ids are stable: the
// manifest declares exactly these, and the page invokes them by id.
var builtins = map[string]builtin{
	"format.go":         {script: "format_cli.py", arg: "go"},
	"format.javascript": {script: "js_format.mjs", arg: "javascript", node: true},
	"format.typescript": {script: "js_format.mjs", arg: "typescript", node: true},
	"format.python":     {script: "format_cli.py", arg: "python"},
	"format.rust":       {script: "format_cli.py", arg: "rust"},
	"format.php":        {script: "format_cli.py", arg: "php"},
	"format.html":       {script: "format_cli.py", arg: "html"},
	"format.css":        {script: "format_cli.py", arg: "css"},
	"format.json":       {script: "format_json.py"},
	"format.yaml":       {script: "format_cli.py", arg: "yaml"},
	"format.shell":      {script: "format_cli.py", arg: "shell"},
	"format.sql":        {},
	"compress.sql":      {compress: true},
}

func main() {
	request, err := readRequest()
	if err != nil {
		respond(failure("", err.Error()))
		return
	}
	var call invocation
	if err := json.Unmarshal(request, &call); err != nil {
		respond(failure("", "invalid JSON request"))
		return
	}
	if call.ID == "" {
		// The host matches responses by ID; an unnamed request cannot be
		// answered usefully.
		respond(failure("", "调用请求缺少请求 ID"))
		return
	}
	if call.DeadlineUnixMs > 0 && time.Now().UnixMilli() >= call.DeadlineUnixMs {
		respond(failure(call.ID, "调用已超时"))
		return
	}
	spec, ok := builtins[call.CommandID]
	if !ok {
		respond(failure(call.ID, "不支持的内置格式化操作"))
		return
	}
	text := call.text()
	if strings.TrimSpace(text) == "" {
		respond(failure(call.ID, "没有可格式化的文本"))
		return
	}
	if spec.script == "" {
		output, err := formatSQL(text, spec.compress, call.Settings)
		if err != nil {
			respond(failure(call.ID, err.Error()))
			return
		}
		respond(response{
			ID:     call.ID,
			OK:     true,
			Result: &resultShape{Output: output, Effect: "copy"},
		})
		return
	}
	helper, err := runHelper(resolveEngineDir(), spec, request)
	if err != nil {
		respond(failure(call.ID, err.Error()))
		return
	}
	// The helper answers in the same line protocol, with the same request id.
	// Forward its one validated line unchanged.
	os.Stdout.Write(append(bytes.TrimSpace(helper), '\n'))
}

func (call invocation) text() string {
	if call.Selection != nil && call.Selection.Text != "" {
		return call.Selection.Text
	}
	if call.Input != nil {
		return call.Input.Text
	}
	return ""
}

func readRequest() ([]byte, error) {
	reader := bufio.NewReaderSize(os.Stdin, 64*1024)
	var buffer bytes.Buffer
	for {
		chunk, err := reader.ReadSlice('\n')
		if buffer.Len()+len(chunk) > maxRequestBytes {
			return nil, errors.New("请求过大")
		}
		buffer.Write(chunk)
		if err == nil {
			return buffer.Bytes(), nil
		}
		if errors.Is(err, bufio.ErrBufferFull) {
			continue
		}
		if errors.Is(err, io.EOF) {
			if buffer.Len() > 0 {
				return buffer.Bytes(), nil
			}
			return nil, errors.New("请求为空")
		}
		return nil, errors.New("读取请求失败")
	}
}

// resolveEngineDir finds the engines shipped beside the installed entrypoint.
func resolveEngineDir() string {
	executable, err := os.Executable()
	if err != nil {
		return ""
	}
	// macOS reports the resolved path for the host's copied entrypoint; the
	// engines directory sits next to it in the installed package.
	return filepath.Join(filepath.Dir(executable), "engines")
}

func findTool(name string) string {
	for _, directory := range []string{"/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"} {
		candidate := filepath.Join(directory, name)
		info, err := os.Stat(candidate)
		if err == nil && !info.IsDir() && info.Mode()&0o111 != 0 {
			return candidate
		}
	}
	if path, err := exec.LookPath(name); err == nil {
		return path
	}
	return ""
}

// runHelper runs one shipped engine script with the fixed interpreter its
// language needs. User text travels only through stdin; nothing is
// interpolated into a shell.
func runHelper(engineDir string, spec builtin, request []byte) ([]byte, error) {
	interpreter := "python3"
	if spec.node {
		interpreter = "node"
	}
	tool := findTool(interpreter)
	if tool == "" {
		return nil, fmt.Errorf("%s is not installed", interpreter)
	}
	script := filepath.Join(engineDir, spec.script)
	if info, err := os.Stat(script); err != nil || info.IsDir() {
		return nil, errors.New("内置格式化引擎缺失")
	}
	args := []string{script}
	if spec.arg != "" {
		args = append(args, spec.arg)
	}
	ctx, cancel := context.WithTimeout(context.Background(), toolTimeout)
	defer cancel()
	command := exec.CommandContext(ctx, tool, args...)
	command.Stdin = bytes.NewReader(request)
	var stdout, stderr bytes.Buffer
	command.Stdout = &stdout
	command.Stderr = &stderr
	if err := command.Run(); err != nil {
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return nil, errors.New("格式化超时")
		}
		message := firstLine(stderr.String())
		if message == "" {
			message = err.Error()
		}
		return nil, errors.New("内置格式化失败：" + message)
	}
	line := bytes.TrimSpace(stdout.Bytes())
	if len(line) == 0 {
		return nil, errors.New("内置格式化没有返回结果")
	}
	if !json.Valid(line) {
		return nil, errors.New("内置格式化返回了无法解析的结果")
	}
	return line, nil
}

func firstLine(value string) string {
	line := strings.TrimSpace(strings.SplitN(value, "\n", 2)[0])
	if len(line) > 160 {
		line = line[:160]
	}
	return line
}

// formatSQL runs the shared sqlkit engine in process. It is the same
// implementation com.mypaste.sql ships, so both packages format SQL the same
// way.
func formatSQL(text string, compress bool, settings map[string]any) (string, error) {
	dialect := sqlkit.ParseDialect(settings["dialect"])
	analysis, err := sqlkit.Analyze(text, dialect)
	if err != nil {
		return "", err
	}
	if finding := firstError(analysis.Diagnostics); finding != nil {
		return "", fmt.Errorf("SQL 语法错误（第 %d 行第 %d 列）：%s",
			finding.Line, finding.Column, finding.Message)
	}
	if compress {
		compressed, err := sqlkit.Compress(analysis)
		if err != nil {
			return "", err
		}
		if strings.TrimSpace(compressed) == "" {
			return "", errors.New("压缩结果为空")
		}
		return compressed, nil
	}
	formatted := sqlkit.Format(analysis, sqlkit.NewFormatOptions(
		settings["keywordcase"], settings["indent"]))
	if strings.TrimSpace(formatted) == "" {
		return "", errors.New("格式化结果为空")
	}
	return formatted, nil
}

func firstError(diagnostics []sqlkit.Diagnostic) *sqlkit.Diagnostic {
	for index := range diagnostics {
		if diagnostics[index].Severity == sqlkit.SeverityError {
			return &diagnostics[index]
		}
	}
	return nil
}

func failure(id string, message string) response {
	return response{ID: id, OK: false, Error: &errorShape{Code: errorCode, Message: message}}
}

func respond(value response) {
	encoded, err := json.Marshal(value)
	if err != nil {
		return
	}
	os.Stdout.Write(append(encoded, '\n'))
}
