package main

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func selectionInvocation(id, commandID, text string, settings map[string]any) *invocation {
	return &invocation{
		ID:        id,
		Method:    "invoke",
		CommandID: commandID,
		Settings:  settings,
		Selection: &struct {
			Text string `json:"text"`
		}{Text: text},
	}
}

func TestHighlightReturnsTokensAndDiagnostics(t *testing.T) {
	reply := handle(selectionInvocation("req-1", "highlight", "SELECT id FROM t;", nil))
	if !reply.OK || reply.Result == nil || reply.Result.Render == nil {
		t.Fatalf("高亮调用失败: %+v", reply)
	}
	if reply.Result.Render.Language != "sql" {
		t.Fatalf("渲染语言不是 sql: %q", reply.Result.Render.Language)
	}
	if len(reply.Result.Render.Tokens) == 0 {
		t.Fatal("没有返回 token")
	}
	var joined strings.Builder
	for _, token := range reply.Result.Render.Tokens {
		joined.WriteString(token.Text)
	}
	if joined.String() != "SELECT id FROM t;" {
		t.Fatalf("token 未覆盖全文: %q", joined.String())
	}
	if len(reply.Result.Render.Diagnostics) != 0 {
		t.Fatalf("合法 SQL 不应有诊断: %+v", reply.Result.Render.Diagnostics)
	}
}

func TestHighlightCarriesDiagnostics(t *testing.T) {
	reply := handle(selectionInvocation("req-2", "highlight", "SELECT a FROM t WHERE (x = 1", nil))
	if !reply.OK || reply.Result == nil || reply.Result.Render == nil {
		t.Fatalf("高亮调用失败: %+v", reply)
	}
	if len(reply.Result.Render.Diagnostics) == 0 {
		t.Fatal("括号错误没有产生诊断")
	}
	diagnostic := reply.Result.Render.Diagnostics[0]
	if diagnostic.Severity != "error" || diagnostic.Line < 1 || diagnostic.Column < 1 {
		t.Fatalf("诊断字段不完整: %+v", diagnostic)
	}
	encoded, err := json.Marshal(reply)
	if err != nil {
		t.Fatal(err)
	}
	// Diagnostics is an optional sibling of tokens in the render object.
	if !strings.Contains(string(encoded), `"diagnostics"`) {
		t.Fatalf("响应缺少 diagnostics 字段: %s", encoded)
	}
}

func TestFormatCopiesFormattedText(t *testing.T) {
	reply := handle(selectionInvocation("req-3", "format",
		"select id, name from t where x = 1;",
		map[string]any{"dialect": "ansi", "keywordcase": "upper", "indent": "4"}))
	if !reply.OK || reply.Result == nil {
		t.Fatalf("格式化调用失败: %+v", reply)
	}
	if reply.Result.Effect != "copy" {
		t.Fatalf("缺少 copy 效果: %+v", reply.Result)
	}
	if !strings.Contains(reply.Result.Output, "SELECT") {
		t.Fatalf("关键字未转为大写: %q", reply.Result.Output)
	}
}

func TestFormatRefusesOnSyntaxError(t *testing.T) {
	reply := handle(selectionInvocation("req-4", "format", "SELECT a ORDER BY b FROM t", nil))
	if reply.OK || reply.Error == nil {
		t.Fatalf("语法错误应当拒绝格式化: %+v", reply)
	}
	if reply.Error.Code != errorCode {
		t.Fatalf("错误码不是 %s: %q", errorCode, reply.Error.Code)
	}
	if !strings.Contains(reply.Error.Message, "行") || !strings.Contains(reply.Error.Message, "列") {
		t.Fatalf("错误消息缺少位置: %q", reply.Error.Message)
	}
}

func TestCompressReturnsOneLine(t *testing.T) {
	reply := handle(selectionInvocation("req-compress", "compress",
		"SELECT id,\n  name -- comment\nFROM t", nil))
	if !reply.OK || reply.Result == nil {
		t.Fatalf("压缩调用失败: %+v", reply)
	}
	if reply.Result.Output != "SELECT id, name FROM t" {
		t.Fatalf("压缩结果不对: %q", reply.Result.Output)
	}
}

func TestCompressRefusesOnSyntaxError(t *testing.T) {
	reply := handle(selectionInvocation("req-compress-bad", "compress",
		"SELECT a ORDER BY b FROM t", nil))
	if reply.OK || reply.Error == nil {
		t.Fatalf("语法错误应当拒绝压缩: %+v", reply)
	}
	if reply.Error.Code != errorCode {
		t.Fatalf("错误码不是 %s: %q", errorCode, reply.Error.Code)
	}
}

func TestUnknownCommandFails(t *testing.T) {
	reply := handle(selectionInvocation("req-5", "explode", "SELECT 1", nil))
	if reply.OK || reply.Error == nil {
		t.Fatalf("未知命令应当失败: %+v", reply)
	}
}

func TestExpiredDeadlineFails(t *testing.T) {
	invocation := selectionInvocation("req-6", "highlight", "SELECT 1", nil)
	invocation.DeadlineUnixMs = time.Now().Add(-time.Second).UnixMilli()
	if reply := handle(invocation); reply.OK {
		t.Fatal("过期调用应当失败")
	}
}

func TestInputFallbackWhenNoSelection(t *testing.T) {
	invocation := &invocation{
		ID:        "req-7",
		Method:    "invoke",
		CommandID: "format",
		Input: &struct {
			Type string `json:"type"`
			Text string `json:"text"`
		}{Type: "text/plain", Text: "SELECT 1"},
	}
	reply := handle(invocation)
	if !reply.OK || reply.Result == nil || reply.Result.Output == "" {
		t.Fatalf("input 回退失败: %+v", reply)
	}
}

func TestDecodeInvocationRejectsGarbage(t *testing.T) {
	if _, err := decodeInvocation("   "); err == nil {
		t.Fatal("空行应当报错")
	}
	if _, err := decodeInvocation("{not json}"); err == nil {
		t.Fatal("非法 JSON 应当报错")
	}
	if _, err := decodeInvocation(`{"method":"cancel"}`); err == nil {
		t.Fatal("未知 method 应当报错")
	}
	invocation, err := decodeInvocation("  {\"id\":\"a\"}\n")
	if err != nil || invocation.ID != "a" {
		t.Fatalf("正常请求解码失败: %v %+v", err, invocation)
	}
}

func TestMissingIDFails(t *testing.T) {
	if reply := handle(selectionInvocation("", "highlight", "SELECT 1", nil)); reply.OK {
		t.Fatal("缺少请求 ID 应当失败")
	}
}
