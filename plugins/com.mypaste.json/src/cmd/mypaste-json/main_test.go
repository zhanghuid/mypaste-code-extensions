package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func requestLine(t *testing.T, id, commandID, text string) []byte {
	t.Helper()
	encoded, err := json.Marshal(map[string]any{
		"id":        id,
		"commandId": commandID,
		"input":     map[string]any{"type": "text", "text": text},
	})
	if err != nil {
		t.Fatal(err)
	}
	return encoded
}

func TestHandleRejectsWhatItCannotAnswer(t *testing.T) {
	cases := []struct {
		name    string
		request string
		want    string
	}{
		{"malformed", "{", "invalid JSON request"},
		{"unnamed", `{"commandId":"format.document","input":{"text":"{}"}}`, "调用请求缺少请求 ID"},
		{"unknown command", `{"id":"1","commandId":"format.other","input":{"text":"{}"}}`, "不支持的 JSON 操作"},
		{"blank text", `{"id":"1","commandId":"format.document","input":{"text":"  "}}`, "没有可格式化的文本"},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			answer := handle([]byte(test.request), t.TempDir(), "")
			if answer.OK || answer.Error == nil {
				t.Fatalf("expected refusal, got %+v", answer)
			}
			if answer.Error.Message != test.want {
				t.Fatalf("message = %q, want %q", answer.Error.Message, test.want)
			}
		})
	}
}

func TestHandleExplainsAMachineWithoutNode(t *testing.T) {
	answer := handle(requestLine(t, "1", formatCommand, `{"a":1}`), t.TempDir(), "")
	if answer.OK || answer.Error == nil {
		t.Fatalf("expected refusal, got %+v", answer)
	}
	if !strings.Contains(answer.Error.Message, "Node") {
		t.Fatalf("message %q does not name Node", answer.Error.Message)
	}
	if answer.ID != "1" {
		t.Fatalf("id = %q, want the request id", answer.ID)
	}
}

func TestHandleExplainsAMissingEngine(t *testing.T) {
	node := findTool("node")
	if node == "" {
		t.Skip("node is not installed")
	}
	answer := handle(requestLine(t, "1", formatCommand, `{"a":1}`), t.TempDir(), node)
	if answer.OK || answer.Error == nil {
		t.Fatalf("expected refusal, got %+v", answer)
	}
	if !strings.Contains(answer.Error.Message, "引擎缺失") {
		t.Fatalf("message = %q, want a missing-engine note", answer.Error.Message)
	}
}

// engineScript is a stand-in for the packaged adapter: it applies the same
// stdin/stdout contract and echoes its answer, so the test sees the text the
// runtime actually handed over.
const engineScript = `import { readFileSync } from "node:fs";
const request = JSON.parse(readFileSync(0, "utf8"));
if (request.input.text === "boom") {
  process.stdout.write(JSON.stringify({
    id: request.id, ok: false, error: { code: "format-failed", message: "引擎拒绝" },
  }) + "\n");
} else {
  process.stdout.write(JSON.stringify({
    id: request.id, ok: true, result: { output: request.input.text.toUpperCase() + "\n" },
  }) + "\n");
}
`

func engineDir(t *testing.T) string {
	t.Helper()
	directory := t.TempDir()
	if err := os.WriteFile(filepath.Join(directory, "prettier.mjs"),
		[]byte(engineScript), 0o600); err != nil {
		t.Fatal(err)
	}
	return directory
}

func TestHandlePassesTheTextThroughTheEngine(t *testing.T) {
	node := findTool("node")
	if node == "" {
		t.Skip("node is not installed")
	}
	answer := handle(requestLine(t, "7", formatCommand, `{"a":1}`), engineDir(t), node)
	if !answer.OK || answer.Result == nil {
		t.Fatalf("expected output, got %+v", answer)
	}
	if answer.Result.Output != "{\"A\":1}\n" {
		t.Fatalf("output = %q", answer.Result.Output)
	}
	if answer.ID != "7" {
		t.Fatalf("id = %q, want the request id", answer.ID)
	}
}

func TestHandleKeepsTheEngineRefusal(t *testing.T) {
	node := findTool("node")
	if node == "" {
		t.Skip("node is not installed")
	}
	answer := handle(requestLine(t, "8", formatCommand, "boom"), engineDir(t), node)
	if answer.OK || answer.Error == nil {
		t.Fatalf("expected refusal, got %+v", answer)
	}
	if answer.Error.Message != "引擎拒绝" {
		t.Fatalf("message = %q", answer.Error.Message)
	}
}

func TestHandleRejectsAnExpiredCall(t *testing.T) {
	expired := []byte(`{"id":"9","commandId":"format.document","deadlineUnixMs":1,` +
		`"input":{"text":"{}"}}`)
	answer := handle(expired, t.TempDir(), "")
	if answer.OK || answer.Error == nil || answer.Error.Message != "调用已超时" {
		t.Fatalf("got %+v", answer)
	}
}
