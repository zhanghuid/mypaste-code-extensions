// Command mypaste-code-edit is the editor surface's own runtime.
//
// Protocol v3 lets a UI package that declares `kind: "ui"` also declare a
// runtime and internal commands (no placement). Only that package's own
// surface can reach them, and they never appear in the command palette. The
// page calls one per formatting operation, so the editor keeps its formatting
// when no separate capability package is installed.
//
// The runtime speaks the plugin v2 line protocol (PLUGINS.md section 4): one
// request line on stdin, one response line on stdout. Formatting happens in
// this binary: nothing looks up gofmt, rustfmt, black, php-cs-fixer, tidy or
// shfmt on the user's machine. Go, JSON and SQL use real parsers; CSS gets a
// conservative re-indenter; the other languages get a whitespace normalizer.
// The bundled Node helpers (Prettier for CSS and YAML, js_format.mjs for
// JavaScript and TypeScript) improve the result when Node happens to exist,
// but every command has an in-process answer without it.
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

	builtinformat "github.com/zhanghuid/mypaste-code-extensions/plugins/com.mypaste.code-edit/src/internal/format"
	"github.com/zhanghuid/mypaste-code-extensions/plugins/com.mypaste.code-edit/src/internal/sqlkit"
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

// builtins is the closed command set the page knows. Ids are stable: the
// manifest declares exactly these, and the page invokes them by id. Every
// entry runs in this binary; only CSS, YAML and JavaScript/TypeScript may
// consult the bundled helper when Node is available.
var builtins = map[string]struct{}{
	"format.go":         {},
	"format.javascript": {},
	"format.typescript": {},
	"format.python":     {},
	"format.rust":       {},
	"format.php":        {},
	"format.html":       {},
	"format.css":        {},
	"format.json":       {},
	"format.yaml":       {},
	"format.shell":      {},
	"format.sql":        {},
	"compress.sql":      {},
}

// formatBuiltin runs one editor operation without asking the machine for a
// formatter. The engine directory only holds the optional Prettier wrapper;
// when it or Node is absent the in-process implementation answers instead.
func formatBuiltin(commandID, text string, settings map[string]any, engineDir string) (string, error) {
	switch commandID {
	case "format.go":
		return builtinformat.Go(text)
	case "format.json":
		return builtinformat.JSON(text)
	case "format.python", "format.rust", "format.php", "format.html", "format.shell":
		return builtinformat.Hygiene(text)
	case "format.css":
		if output, available, err := runNodeEngine(engineDir, "prettier.mjs", "css", text); err != nil {
			return "", err
		} else if available {
			return output, nil
		}
		return builtinformat.CSS(text)
	case "format.yaml":
		if output, available, err := runNodeEngine(engineDir, "prettier.mjs", "yaml", text); err != nil {
			return "", err
		} else if available {
			return output, nil
		}
		return builtinformat.Hygiene(text)
	case "format.javascript", "format.typescript":
		language := "javascript"
		if commandID == "format.typescript" {
			language = "typescript"
		}
		if output, available, err := runNodeEngine(engineDir, "js_format.mjs", language, text); err != nil {
			return "", err
		} else if available {
			return output, nil
		}
		return builtinformat.Hygiene(text)
	case "format.sql":
		return formatSQL(text, false, settings)
	case "compress.sql":
		return formatSQL(text, true, settings)
	default:
		return "", errors.New("不支持的内置格式化操作")
	}
}

// runNodeEngine runs a reviewed helper with Node when both exist. `available`
// is false only when Node or the script is missing, which is the one case the
// caller may answer in process; an engine that ran and refused the text keeps
// its error so a broken source never gets a partial answer.
func runNodeEngine(engineDir, script, arg, text string) (string, bool, error) {
	node := findTool("node")
	if node == "" {
		return "", false, nil
	}
	path := filepath.Join(engineDir, script)
	if _, err := os.Stat(path); err != nil {
		return "", false, nil
	}
	request, err := json.Marshal(map[string]any{
		"id": "engine", "selection": map[string]any{"text": text},
	})
	if err != nil {
		return "", true, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), toolTimeout)
	defer cancel()
	command := exec.CommandContext(ctx, node, path, arg)
	command.Stdin = bytes.NewReader(append(request, '\n'))
	var stdout, stderr bytes.Buffer
	command.Stdout = &stdout
	command.Stderr = &stderr
	if err := command.Run(); err != nil {
		detail := strings.TrimSpace(stderr.String())
		if detail == "" {
			detail = err.Error()
		}
		return "", true, fmt.Errorf("%s", firstLine(detail))
	}
	var answer struct {
		OK     bool `json:"ok"`
		Result struct {
			Output string `json:"output"`
		} `json:"result"`
		Error struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(stdout.Bytes(), &answer); err != nil {
		return "", true, errors.New("格式化引擎返回了无法解析的结果")
	}
	if !answer.OK {
		message := strings.TrimSpace(answer.Error.Message)
		if message == "" {
			message = "格式化引擎失败"
		}
		return "", true, errors.New(message)
	}
	if strings.TrimSpace(answer.Result.Output) == "" {
		return "", true, errors.New("格式化结果为空")
	}
	return answer.Result.Output, true, nil
}

func firstLine(value string) string {
	line := strings.TrimSpace(strings.SplitN(value, "\n", 2)[0])
	if len(line) > 160 {
		line = line[:160]
	}
	return line
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
	if _, ok := builtins[call.CommandID]; !ok {
		respond(failure(call.ID, "不支持的内置格式化操作"))
		return
	}
	text := call.text()
	if strings.TrimSpace(text) == "" {
		respond(failure(call.ID, "没有可格式化的文本"))
		return
	}
	output, err := formatBuiltin(call.CommandID, text, call.Settings, resolveEngineDir())
	if err != nil {
		respond(failure(call.ID, err.Error()))
		return
	}
	respond(response{
		ID:     call.ID,
		OK:     true,
		Result: &resultShape{Output: output, Effect: "copy"},
	})
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

// formatSQL runs this package's own sqlkit engine in process. The editor
// ships its SQL scanner, diagnostics and layout; no other extension takes
// part.
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
