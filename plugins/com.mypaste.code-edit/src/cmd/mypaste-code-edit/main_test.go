package main

import (
	"encoding/json"
	"strings"
	"testing"
)

// engineDirForTest is the engines directory the binary ships beside itself.
const engineDirForTest = "../../engines"

func request(t *testing.T, text string) []byte {
	t.Helper()
	payload, err := json.Marshal(map[string]any{
		"id":      "test-id",
		"method":  "invoke",
		"commandId": "format.json",
		"selection": map[string]any{
			"id": 1, "kind": "text", "title": "x", "text": text,
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	return payload
}

func TestJSONHelperFormatsAndKeepsTheRequestID(t *testing.T) {
	line, err := runHelper(engineDirForTest, builtins["format.json"], request(t, `{"a":1,"b":[true,null]}`))
	if err != nil {
		t.Fatal(err)
	}
	var answer struct {
		ID     string `json:"id"`
		OK     bool   `json:"ok"`
		Result struct {
			Output string `json:"output"`
			Effect string `json:"effect"`
		} `json:"result"`
	}
	if err := json.Unmarshal(line, &answer); err != nil {
		t.Fatalf("helper answered invalid JSON: %v", err)
	}
	if answer.ID != "test-id" || !answer.OK || answer.Result.Effect != "copy" {
		t.Fatalf("unexpected answer: %s", line)
	}
	if !strings.Contains(answer.Result.Output, "  \"a\": 1") {
		t.Fatalf("output was not formatted: %q", answer.Result.Output)
	}
}

func TestHelperReportsInvalidSourceWithoutPartialOutput(t *testing.T) {
	line, err := runHelper(engineDirForTest, builtins["format.json"], request(t, `{"a":`))
	if err != nil {
		t.Fatal(err)
	}
	var answer struct {
		OK     bool   `json:"ok"`
		Result any    `json:"result"`
		Error  struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(line, &answer); err != nil {
		t.Fatal(err)
	}
	if answer.OK || answer.Result != nil || answer.Error.Message == "" {
		t.Fatalf("expected a refusal, got %s", line)
	}
}

func TestSQLFormattingUsesTheSharedEngine(t *testing.T) {
	output, err := formatSQL("select id,name from users where age>18;", false,
		map[string]any{"keywordcase": "upper", "indent": "2"})
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"SELECT", "FROM", "WHERE"} {
		if !strings.Contains(output, want) {
			t.Fatalf("formatted SQL missing %q: %s", want, output)
		}
	}
}

func TestSQLCompressionCollapsesWhitespace(t *testing.T) {
	output, err := formatSQL("select id, name\nfrom users\n-- note\nwhere age > 18;", true, nil)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(output, "\n") || strings.Contains(output, "--") {
		t.Fatalf("compressed SQL still has breaks or comments: %q", output)
	}
	if !strings.Contains(output, "select id, name from users where age > 18;") {
		t.Fatalf("compression changed tokens: %q", output)
	}
}

func TestSQLFormattingRefusesSyntaxErrors(t *testing.T) {
	if _, err := formatSQL("select (1;", false, nil); err == nil {
		t.Fatal("expected a syntax refusal")
	}
}

func TestBuiltinsCoverEveryEditorLanguage(t *testing.T) {
	// The page's language table lists these; the manifest declares one command
	// per entry. SQL also compresses.
	for _, language := range []string{
		"go", "javascript", "typescript", "python", "rust", "php",
		"html", "css", "json", "yaml", "sql", "shell",
	} {
		if _, ok := builtins["format."+language]; !ok {
			t.Fatalf("missing format.%s", language)
		}
	}
	if _, ok := builtins["compress.sql"]; !ok {
		t.Fatal("missing compress.sql")
	}
}
