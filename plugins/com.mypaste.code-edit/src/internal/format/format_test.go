package format

import (
	"strings"
	"testing"
)

func TestGoUsesGofmt(t *testing.T) {
	output, err := Go("package main\nfunc main(){println(1)}\n")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(output, "func main() {") {
		t.Fatalf("not gofmt output: %q", output)
	}
}

func TestGoRefusesBrokenSource(t *testing.T) {
	if _, err := Go("package main\nfunc {"); err == nil {
		t.Fatal("expected a syntax error")
	}
}

func TestJSONIndentsWithoutRecordingKeys(t *testing.T) {
	output, err := JSON(`{"a":1,"b":[true,null]}`)
	if err != nil {
		t.Fatal(err)
	}
	want := "{\n  \"a\": 1,\n  \"b\": [\n    true,\n    null\n  ]\n}\n"
	if output != want {
		t.Fatalf("got %q, want %q", output, want)
	}
}

func TestJSONRefusesBrokenSource(t *testing.T) {
	if _, err := JSON(`{"a":`); err == nil {
		t.Fatal("expected a syntax error")
	}
}

func TestCSSReindentsByBraceDepth(t *testing.T) {
	output, err := CSS("a{color:red;margin:0}\n@media screen{b{display:block}}")
	if err != nil {
		t.Fatal(err)
	}
	want := "a {\n  color:red;\n  margin:0;\n}\n@media screen {\n  b {\n    display:block;\n  }\n}\n"
	if output != want {
		t.Fatalf("got %q, want %q", output, want)
	}
}

func TestCSSKeepsSelectorsAndLiteralText(t *testing.T) {
	source := "a:hover{content:\"}\";/* } */color:red}"
	output, err := CSS(source)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(output, "a:hover {") ||
		!strings.Contains(output, "content:\"}\";") ||
		!strings.Contains(output, "/* } */") {
		t.Fatalf("literal text changed: %q", output)
	}
	// A space before `:` is a descendant selector, not a pseudo-class.
	descendant, err := CSS("a :hover{color:red}")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(descendant, "a :hover {") {
		t.Fatalf("descendant selector changed: %q", descendant)
	}
}

func TestCSSKeepsMultiLineComments(t *testing.T) {
	source := "a{/* one\n   two */color:red}"
	output, err := CSS(source)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(output, "/* one\n   two */") {
		t.Fatalf("comment changed: %q", output)
	}
}

func TestCSSRefusesUnbalancedBraces(t *testing.T) {
	if _, err := CSS("a{color:red"); err == nil {
		t.Fatal("expected a brace error")
	}
}

func TestHygieneOnlyTouchesWhitespace(t *testing.T) {
	output, err := Hygiene("def f():\r\n    x = 1   \r\n\r\n\r\n")
	if err != nil {
		t.Fatal(err)
	}
	if output != "def f():\n    x = 1\n" {
		t.Fatalf("got %q", output)
	}
	if strings.Contains(output, "\r") || strings.Contains(output, " \n") {
		t.Fatalf("wrong whitespace: %q", output)
	}
}

func TestHygieneRefusesEmptySource(t *testing.T) {
	if _, err := Hygiene(" \n\t\n"); err == nil {
		t.Fatal("expected an empty-source error")
	}
}
