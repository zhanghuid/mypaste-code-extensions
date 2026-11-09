package main

import (
	"os"
	"strings"
	"testing"
)

// emptyEngines is a directory without the optional Node helpers: every
// operation must still answer in process when the machine has no formatter.
func emptyEngines(t *testing.T) string {
	t.Helper()
	return t.TempDir()
}

func format(t *testing.T, command, text string) string {
	t.Helper()
	output, err := formatBuiltin(command, text, nil, emptyEngines(t))
	if err != nil {
		t.Fatalf("%s: %v", command, err)
	}
	if strings.TrimSpace(output) == "" {
		t.Fatalf("%s returned empty output", command)
	}
	return output
}

func TestGoFormatsWithoutALocalGofmt(t *testing.T) {
	output := format(t, "format.go", "package main\nfunc main(){println(1)}\n")
	if !strings.Contains(output, "func main() {") {
		t.Fatalf("not gofmt output: %q", output)
	}
}

func TestJSONFormatsAndRefusesBrokenSource(t *testing.T) {
	output := format(t, "format.json", `{"a":1,"b":[true,null]}`)
	if !strings.Contains(output, "  \"a\": 1") {
		t.Fatalf("output was not formatted: %q", output)
	}
	if _, err := formatBuiltin("format.json", `{"a":`, nil, emptyEngines(t)); err == nil {
		t.Fatal("expected a refusal")
	}
}

func TestCSSFallsBackToTheBuiltInReindenter(t *testing.T) {
	output := format(t, "format.css", "a{color:red;margin:0}")
	want := "a {\n  color:red;\n  margin:0;\n}\n"
	if output != want {
		t.Fatalf("got %q, want %q", output, want)
	}
}

func TestYAMLAndJavaScriptFallBackToWhitespaceNormalization(t *testing.T) {
	yaml := format(t, "format.yaml", "a: 1   \r\nb:\r\n  - 2\r\n")
	if yaml != "a: 1\nb:\n  - 2\n" {
		t.Fatalf("yaml: %q", yaml)
	}
	javascript := format(t, "format.javascript", "const a = 1;   \r\n")
	if javascript != "const a = 1;\n" {
		t.Fatalf("javascript: %q", javascript)
	}
}

func TestEveryBuiltinRunsWithoutExternalTools(t *testing.T) {
	samples := map[string]string{
		"format.go":         "package main\n",
		"format.javascript": "const a = 1;\n",
		"format.typescript": "const a: number = 1;\n",
		"format.python":     "x = 1\n",
		"format.rust":       "fn main() {}\n",
		"format.php":        "<?php echo 1;\n",
		"format.html":       "<p>hi</p>\n",
		"format.css":        "a{color:red}\n",
		"format.json":       `{"a":1}`,
		"format.yaml":       "a: 1\n",
		"format.shell":      "echo hi\n",
		"format.sql":        "select 1;",
		"compress.sql":      "select 1;",
	}
	for command, source := range samples {
		format(t, command, source)
	}
	if _, err := formatBuiltin("format.unknown", "x", nil, emptyEngines(t)); err == nil {
		t.Fatal("unknown command must be refused")
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

func TestEngineScriptsAreOptional(t *testing.T) {
	// No helper may be required for any command: the engine directory here
	// holds nothing, and every operation above still answered.
	directory := emptyEngines(t)
	entries, err := os.ReadDir(directory)
	if err != nil || len(entries) != 0 {
		t.Fatalf("test engine directory is not empty: %v %v", entries, err)
	}
}
