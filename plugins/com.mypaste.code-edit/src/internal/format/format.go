// Package format implements the editor's own formatting engines.
//
// Every language has an implementation in this binary: nothing here looks up
// gofmt, rustfmt, black, php-cs-fixer, tidy or shfmt on the user's machine.
// Go, JSON and SQL use standard-library or shared parsers; CSS gets a
// conservative brace re-indenter; the languages whose whitespace is semantic
// (Python, YAML, HTML, Shell) and those without a formatter in the standard
// library (Rust, PHP) get a whitespace normalizer that never re-nests code.
// The optional Node helpers (Prettier for CSS and YAML, js_format.mjs for
// JavaScript and TypeScript) live in the parent runtime; this package never
// depends on them.
package format

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	gofmt "go/format"
	"strings"
)

// Go formats Go source with the standard library's gofmt.
func Go(source string) (string, error) {
	output, err := gofmt.Source([]byte(source))
	if err != nil {
		return "", fmt.Errorf("Go 语法错误：%s", firstLine(err.Error()))
	}
	return string(output), nil
}

// JSON validates and re-indents JSON. Key order and escapes are preserved:
// json.Indent only rewrites insignificant whitespace.
func JSON(source string) (string, error) {
	if !json.Valid([]byte(source)) {
		return "", errors.New("JSON 语法错误")
	}
	var output bytes.Buffer
	if err := json.Indent(&output, []byte(source), "", "  "); err != nil {
		return "", errors.New("JSON 语法错误")
	}
	return strings.TrimRight(output.String(), "\n") + "\n", nil
}

// Hygiene normalizes line endings, trailing whitespace and the final newline.
// It never changes leading indentation, which is semantic in Python, YAML,
// HTML and Shell and which this package cannot re-nest without a parser.
func Hygiene(source string) (string, error) {
	text := strings.ReplaceAll(source, "\r\n", "\n")
	text = strings.ReplaceAll(text, "\r", "\n")
	lines := strings.Split(text, "\n")
	for index, line := range lines {
		lines[index] = strings.TrimRight(line, " \t")
	}
	output := strings.TrimRight(strings.Join(lines, "\n"), "\n") + "\n"
	if strings.TrimSpace(output) == "" {
		return "", errors.New("没有可格式化的文本")
	}
	return output, nil
}

// CSS re-indents CSS by brace depth and puts one rule or declaration per line.
// It leaves string literals and comments byte-for-byte alone, does not touch
// spacing around `:` (so `a:hover` stays a selector), and refuses source whose
// braces, strings or block comments do not close.
func CSS(source string) (string, error) {
	text := strings.ReplaceAll(source, "\r\n", "\n")
	text = strings.ReplaceAll(text, "\r", "\n")
	runes := []rune(text)
	var output strings.Builder
	var line strings.Builder
	depth := 0
	space := false

	writeIndent := func(level int) {
		if level < 0 {
			level = 0
		}
		output.WriteString(strings.Repeat("  ", level))
	}
	appendToken := func(token string) {
		if space && line.Len() > 0 {
			line.WriteByte(' ')
		}
		space = false
		line.WriteString(token)
	}
	// emit flushes the pending line, prefixed by indentation for `level` and
	// followed by an optional suffix.
	emit := func(level int, suffix string) {
		content := strings.TrimSpace(line.String())
		line.Reset()
		space = false
		if content == "" && suffix == "" {
			return
		}
		writeIndent(level)
		output.WriteString(content)
		output.WriteString(suffix)
		output.WriteString("\n")
	}
	// flushPending closes a declaration that omitted its semicolon.
	flushPending := func() {
		content := strings.TrimSpace(line.String())
		if content == "" {
			return
		}
		if depth > 0 && !strings.HasSuffix(content, ";") {
			line.WriteByte(';')
		}
		emit(depth, "")
	}

	for index := 0; index < len(runes); index++ {
		char := runes[index]
		switch {
		case char == ' ' || char == '\t' || char == '\n':
			if line.Len() > 0 {
				space = true
			}
		case char == '"' || char == '\'':
			start := index
			index++
			for index < len(runes) && runes[index] != char {
				if runes[index] == '\\' {
					index++
				}
				index++
			}
			if index >= len(runes) {
				return "", errors.New("CSS 字符串没有闭合")
			}
			appendToken(string(runes[start : index+1]))
		case char == '/' && index+1 < len(runes) && runes[index+1] == '*':
			start := index
			index += 2
			for index+1 < len(runes) && !(runes[index] == '*' && runes[index+1] == '/') {
				index++
			}
			if index+1 >= len(runes) {
				return "", errors.New("CSS 注释没有闭合")
			}
			index++
			comment := string(runes[start : index+1])
			if !strings.Contains(comment, "\n") {
				appendToken(comment)
				break
			}
			// A multi-line comment is literal text: keep its later lines as
			// written and resume on a fresh line afterwards.
			emit(depth, "")
			lines := strings.Split(comment, "\n")
			writeIndent(depth)
			output.WriteString(lines[0])
			output.WriteString("\n")
			for _, current := range lines[1:] {
				output.WriteString(current)
				output.WriteString("\n")
			}
		case char == '{':
			emit(depth, " {")
			depth++
		case char == '}':
			flushPending()
			depth--
			if depth < 0 {
				return "", errors.New("CSS 花括号不平衡")
			}
			emit(depth, "}")
		case char == ';':
			space = false
			appendToken(";")
			emit(depth, "")
		case char == ',' || char == ')':
			space = false
			appendToken(string(char))
			if char == ',' {
				space = true
			}
		case char == ':':
			// Space before `:` is significant in selectors (`a :hover` is a
			// descendant selector), so keep whatever the source had.
			appendToken(":")
		case char == '(':
			space = false
			appendToken("(")
		default:
			appendToken(string(char))
		}
	}
	flushPending()
	if depth != 0 {
		return "", errors.New("CSS 花括号不平衡")
	}
	result := output.String()
	if strings.TrimSpace(result) == "" {
		return "", errors.New("没有可格式化的文本")
	}
	return result, nil
}

func firstLine(value string) string {
	line := strings.TrimSpace(strings.SplitN(value, "\n", 2)[0])
	if len(line) > 160 {
		line = line[:160]
	}
	return line
}
