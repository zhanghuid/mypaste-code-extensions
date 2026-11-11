// Command mypaste-link-mime is the out-of-process half of
// com.mypaste.link-mime.
//
// It speaks the plugin line protocol (PLUGINS.md section 4): one request line
// on stdin, one response line on stdout. The one command, detect, reads the
// link text the host or a surface hands it and returns a JSON document
// describing the inferred content type. The inference never opens a network
// connection.
package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"

	"github.com/zhanghuid/mypaste-code-extensions/plugins/com.mypaste.link-mime/src/internal/linkmime"
)

// commandID is the manifest's only command. The host sends it back on every
// invocation; an empty id is accepted so a direct probe line still works.
const commandID = "detect"

// errorCode names the failure family.
const errorCode = "detect-failed"

// invocation is the plugin request line, reduced to the fields this command
// reads. Unknown fields are ignored by design: the host may extend the
// payload, and an old binary must not reject a new envelope.
type input struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

type selection struct {
	Text string `json:"text"`
}

type invocation struct {
	ID        string     `json:"id"`
	Method    string     `json:"method"`
	CommandID string     `json:"commandId"`
	Input     *input     `json:"input"`
	Selection *selection `json:"selection"`
}

// response is the one-line reply. Exactly one of result / error is set.
type response struct {
	ID     string `json:"id"`
	OK     bool   `json:"ok"`
	Result *struct {
		Output string `json:"output,omitempty"`
	} `json:"result,omitempty"`
	Error *struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error,omitempty"`
}

func main() {
	reader := bufio.NewReader(os.Stdin)
	line, err := reader.ReadString('\n')
	if err != nil && line == "" {
		writeError("", "没有收到调用请求")
		return
	}
	request, err := decodeInvocation(line)
	if err != nil {
		writeError("", err.Error())
		return
	}
	writeResponse(handle(request))
}

func decodeInvocation(line string) (*invocation, error) {
	trimmed := strings.TrimSpace(line)
	if trimmed == "" {
		return nil, errors.New("调用请求为空")
	}
	var request invocation
	if err := json.Unmarshal([]byte(trimmed), &request); err != nil {
		return nil, fmt.Errorf("调用请求不是有效 JSON：%w", err)
	}
	if request.Method != "" && request.Method != "invoke" {
		return nil, fmt.Errorf("不支持的方法 %q", request.Method)
	}
	return &request, nil
}

func handle(request *invocation) response {
	if request.CommandID != "" && request.CommandID != commandID {
		return failure(request.ID, fmt.Sprintf("不支持的命令 %q", request.CommandID))
	}
	text := ""
	if request.Input != nil {
		text = request.Input.Text
	}
	if text == "" && request.Selection != nil {
		text = request.Selection.Text
	}
	result, err := linkmime.Detect(text)
	if err != nil {
		return failure(request.ID, err.Error())
	}
	// A link carries `&` often enough that HTML escaping would only make the
	// result the page and the reader copy harder to read.
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(result); err != nil {
		return failure(request.ID, "识别结果无法编码")
	}
	reply := response{ID: request.ID, OK: true}
	reply.Result = &struct {
		Output string `json:"output,omitempty"`
	}{Output: strings.TrimSuffix(buffer.String(), "\n")}
	return reply
}

func failure(id, message string) response {
	reply := response{ID: id}
	reply.Error = &struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	}{Code: errorCode, Message: message}
	return reply
}

func writeResponse(reply response) {
	writer := bufio.NewWriter(os.Stdout)
	encoded, err := json.Marshal(reply)
	if err != nil {
		encoded = []byte(`{"ok":false,"error":{"code":"detect-failed","message":"响应无法编码"}}`)
	}
	writer.Write(encoded)
	writer.WriteByte('\n')
	writer.Flush()
}

func writeError(id, message string) {
	writeResponse(failure(id, message))
}
