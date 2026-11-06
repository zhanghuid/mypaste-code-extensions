// Command mypaste-sql is the out-of-process half of com.mypaste.sql.
//
// It speaks the plugin v2 line protocol (PLUGINS.md section 4): one request
// line on stdin, one response line on stdout. The highlight command returns
// render tokens plus diagnostics; the format command returns formatted text
// for the host to copy, or refuses with the first finding when the SQL has an
// error. All SQL work lives in internal/sqlkit.
package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/zhanghuid/mypaste-code-extensions/plugins/com.mypaste.sql/src/internal/sqlkit"
)

// errorCode names the failure family. The format family's code is the one the
// host surfaces for refused formatting; analysis failures share it so the
// page's wording stays consistent.
const errorCode = "format-failed"

// invocation is the plugin v2 request line, reduced to the fields this
// command reads. Unknown fields are ignored by design: the host may extend
// the payload, and an old binary must not reject a new envelope.
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
	ID     string `json:"id"`
	OK     bool   `json:"ok"`
	Result *struct {
		Output string          `json:"output,omitempty"`
		Effect string          `json:"effect,omitempty"`
		Render *renderResponse `json:"render,omitempty"`
	} `json:"result,omitempty"`
	Error *struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error,omitempty"`
}

// renderResponse mirrors the host render contract: tokens cover the whole
// input and the kinds come from the closed set. Diagnostics is the field this
// extension adds (DECISIONS D-1058 in the host repository).
type renderResponse struct {
	Language    string              `json:"language"`
	Tokens      []sqlkit.Token      `json:"tokens"`
	Diagnostics []sqlkit.Diagnostic `json:"diagnostics,omitempty"`
}

func main() {
	reader := bufio.NewReader(os.Stdin)
	line, err := reader.ReadString('\n')
	if err != nil && line == "" {
		writeError("", "没有收到调用请求")
		os.Exit(0)
	}
	invocation, err := decodeInvocation(line)
	if err != nil {
		writeError("", err.Error())
		os.Exit(0)
	}
	reply := handle(invocation)
	writer := bufio.NewWriter(os.Stdout)
	encoded, _ := json.Marshal(reply)
	writer.Write(encoded)
	writer.WriteByte('\n')
	writer.Flush()
}

// decodeInvocation parses one request line. Trailing whitespace is expected;
// an empty object or a foreign method is a failure the host can name.
func decodeInvocation(line string) (*invocation, error) {
	trimmed := strings.TrimSpace(line)
	if trimmed == "" {
		return nil, errors.New("调用请求为空")
	}
	var invocation invocation
	if err := json.Unmarshal([]byte(trimmed), &invocation); err != nil {
		return nil, fmt.Errorf("调用请求不是有效 JSON：%w", err)
	}
	if invocation.Method != "" && invocation.Method != "invoke" {
		return nil, fmt.Errorf("不支持的方法 %q", invocation.Method)
	}
	return &invocation, nil
}

// handle dispatches one invocation. It never panics into the protocol: every
// failure becomes an error response the host can fall back from.
func handle(invocation *invocation) *response {
	if invocation.DeadlineUnixMs > 0 &&
		time.Now().UnixMilli() >= invocation.DeadlineUnixMs {
		return failure(invocation.ID, "调用已超时")
	}
	if invocation.ID == "" {
		// The host matches responses by ID; an unnamed request cannot be
		// answered usefully.
		return failure("", "调用请求缺少请求 ID")
	}

	text := ""
	if invocation.Selection != nil {
		text = invocation.Selection.Text
	}
	if text == "" && invocation.Input != nil {
		text = invocation.Input.Text
	}

	dialect := sqlkit.ParseDialect(invocation.Settings["dialect"])
	analysis, err := sqlkit.Analyze(text, dialect)
	if err != nil {
		return failure(invocation.ID, err.Error())
	}

	switch invocation.CommandID {
	case "highlight":
		return &response{
			ID: invocation.ID,
			OK: true,
			Result: &struct {
				Output string          `json:"output,omitempty"`
				Effect string          `json:"effect,omitempty"`
				Render *renderResponse `json:"render,omitempty"`
			}{
				Render: &renderResponse{
					Language:    "sql",
					Tokens:      analysis.Tokens,
					Diagnostics: analysis.Diagnostics,
				},
			},
		}
	case "format":
		if firstError(analysis.Diagnostics) != nil {
			finding := *firstError(analysis.Diagnostics)
			message := fmt.Sprintf("SQL 语法错误（第 %d 行第 %d 列）：%s",
				finding.Line, finding.Column, finding.Message)
			return failure(invocation.ID, message)
		}
		formatted := sqlkit.Format(analysis, sqlkit.NewFormatOptions(
			invocation.Settings["keywordcase"], invocation.Settings["indent"]))
		if strings.TrimSpace(formatted) == "" {
			return failure(invocation.ID, "格式化结果为空，未写入剪贴板")
		}
		return &response{
			ID: invocation.ID,
			OK: true,
			Result: &struct {
				Output string          `json:"output,omitempty"`
				Effect string          `json:"effect,omitempty"`
				Render *renderResponse `json:"render,omitempty"`
			}{
				Output: formatted,
				Effect: "copy",
			},
		}
	default:
		return failure(invocation.ID, fmt.Sprintf("未知命令 %q", invocation.CommandID))
	}
}

// firstError returns the first error-severity diagnostic, or nil.
func firstError(diagnostics []sqlkit.Diagnostic) *sqlkit.Diagnostic {
	for index := range diagnostics {
		if diagnostics[index].Severity == sqlkit.SeverityError {
			return &diagnostics[index]
		}
	}
	return nil
}

func failure(id, message string) *response {
	return &response{
		ID: id,
		OK: false,
		Error: &struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		}{Code: errorCode, Message: message},
	}
}

func writeError(id, message string) {
	reply := failure(id, message)
	encoded, _ := json.Marshal(reply)
	fmt.Fprintln(os.Stdout, string(encoded))
}
