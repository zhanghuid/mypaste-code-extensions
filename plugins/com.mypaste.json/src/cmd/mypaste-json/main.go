// Command mypaste-json is the JSON surface's own runtime.
//
// Protocol v3 lets a UI package declare a runtime and internal commands next
// to its surface; only that package's own page can reach them, and they never
// appear in the command palette. The page posts the entry's text, this binary
// hands it to the Prettier build shipped beside it, and the answer goes back
// as the command's output.
//
// The page cannot carry Prettier itself: a surface document is capped at the
// host's 256 KiB text ceiling, while Prettier's standalone core plus the babel
// and estree plugins is well over that. The engine therefore runs in this
// package's own process, exactly as com.mypaste.code-edit runs its CSS and
// YAML engines. It needs Node on the machine; there is no second JSON
// formatter here, because two owners of "what Prettier prints" would drift.
package main

import (
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
)

const (
	// The host bounds extension text at 256 KiB; this is a second, looser
	// ceiling so a broken caller cannot make the runtime buffer forever.
	maxRequestBytes = 1 << 20
	toolTimeout     = 15 * time.Second
	// The one internal command the page invokes by id.
	formatCommand = "format.document"
)

// invocation is the plugin v2 request line, reduced to the fields this
// command reads. Unknown fields are ignored by design.
type invocation struct {
	ID        string `json:"id"`
	CommandID string `json:"commandId"`
	Selection *struct {
		Text string `json:"text"`
	} `json:"selection"`
	Input *struct {
		Type string `json:"type"`
		Text string `json:"text"`
	} `json:"input"`
	DeadlineUnixMs int64 `json:"deadlineUnixMs"`
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

// response is the one-line reply. Exactly one of result / error is set.
type response struct {
	ID     string       `json:"id"`
	OK     bool         `json:"ok"`
	Result *resultShape `json:"result,omitempty"`
	Error  *errorShape  `json:"error,omitempty"`
}

type resultShape struct {
	Output string `json:"output,omitempty"`
}

type errorShape struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func main() {
	request, err := readRequest()
	if err != nil {
		respond(failure("", err.Error()))
		return
	}
	respond(handle(request, resolveEngineDir(), findTool("node")))
}

// handle answers one request line. It is separate from main so the tests can
// drive the request/response contract without a process boundary; `node` is
// the resolved Node executable, empty when the machine has none.
func handle(request []byte, engineDir, node string) response {
	var call invocation
	if err := json.Unmarshal(request, &call); err != nil {
		return failure("", "invalid JSON request")
	}
	if call.ID == "" {
		// The host matches responses by ID; an unnamed request cannot be
		// answered usefully.
		return failure("", "调用请求缺少请求 ID")
	}
	if call.DeadlineUnixMs > 0 && time.Now().UnixMilli() >= call.DeadlineUnixMs {
		return failure(call.ID, "调用已超时")
	}
	if call.CommandID != formatCommand {
		return failure(call.ID, "不支持的 JSON 操作")
	}
	text := call.text()
	if strings.TrimSpace(text) == "" {
		return failure(call.ID, "没有可格式化的文本")
	}
	output, err := runPrettier(engineDir, node, text)
	if err != nil {
		return failure(call.ID, err.Error())
	}
	return response{ID: call.ID, OK: true, Result: &resultShape{Output: output}}
}

// runPrettier runs the packaged adapter. Missing Node or a missing engine is
// reported as such: the page keeps the entry text and says why, and this
// package never pretends a second formatter produced the layout.
func runPrettier(engineDir, node, text string) (string, error) {
	if node == "" {
		return "", errors.New("本机没有 Node，无法运行包内 Prettier（安装 Node 后重试）")
	}
	script := filepath.Join(engineDir, "prettier.mjs")
	if _, err := os.Stat(script); err != nil {
		return "", errors.New("包内 Prettier 引擎缺失，请重新安装扩展")
	}
	request, err := json.Marshal(map[string]any{
		"id":    "engine",
		"input": map[string]any{"type": "text", "text": text},
	})
	if err != nil {
		return "", err
	}
	ctx, cancel := context.WithTimeout(context.Background(), toolTimeout)
	defer cancel()
	command := exec.CommandContext(ctx, node, script, "json")
	command.Stdin = bytes.NewReader(append(request, '\n'))
	var stdout, stderr bytes.Buffer
	command.Stdout = &stdout
	command.Stderr = &stderr
	if err := command.Run(); err != nil {
		if ctx.Err() == context.DeadlineExceeded {
			return "", errors.New("包内 Prettier 超时")
		}
		detail := strings.TrimSpace(stderr.String())
		if detail == "" {
			detail = err.Error()
		}
		return "", fmt.Errorf("%s", firstLine(detail))
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
		return "", errors.New("包内 Prettier 返回了无法解析的结果")
	}
	if !answer.OK {
		message := strings.TrimSpace(answer.Error.Message)
		if message == "" {
			message = "包内 Prettier 失败"
		}
		return "", errors.New(message)
	}
	if strings.TrimSpace(answer.Result.Output) == "" {
		return "", errors.New("格式化结果为空")
	}
	return answer.Result.Output, nil
}

func firstLine(value string) string {
	line := strings.TrimSpace(strings.SplitN(value, "\n", 2)[0])
	if len(line) > 160 {
		line = line[:160]
	}
	return line
}

func readRequest() ([]byte, error) {
	reader := io.LimitReader(os.Stdin, maxRequestBytes+1)
	request, err := io.ReadAll(reader)
	if err != nil {
		return nil, errors.New("无法读取调用请求")
	}
	if len(request) > maxRequestBytes {
		return nil, errors.New("调用请求超过大小上限")
	}
	return request, nil
}

func respond(answer response) {
	encoded, err := json.Marshal(answer)
	if err != nil {
		encoded = []byte(`{"ok":false,"error":{"code":"format-failed","message":"无法编码回复"}}`)
	}
	os.Stdout.Write(append(encoded, '\n'))
}

func failure(id, message string) response {
	return response{
		ID:    id,
		Error: &errorShape{Code: "format-failed", Message: message},
	}
}

// resolveEngineDir finds the engines directory the host installs beside this
// package's entrypoint.
func resolveEngineDir() string {
	executable, err := os.Executable()
	if err != nil {
		return ""
	}
	return filepath.Join(filepath.Dir(executable), "engines")
}

// findTool looks in the usual macOS tool directories first: a GUI-launched
// host does not inherit the shell's PATH.
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
