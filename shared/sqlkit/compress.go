package sqlkit

import (
	"fmt"
	"strings"
	"unicode"
	"unicode/utf8"
)

// Compress folds SQL onto one line: comments are removed and whitespace runs
// collapse to a single space only where the neighbouring tokens would
// otherwise run together. String literals, quoted identifiers and numbers are
// copied byte for byte, so nothing inside them is rewritten.
//
// `/*+ ... */` is kept: in the dialects that support optimizer hints that
// comment is semantically load-bearing, and a compressor must not silently
// change a query's plan. Every other comment is dropped.
func Compress(analysis *Analysis) (string, error) {
	var units []string
	for _, token := range analysis.Tokens {
		if token.Kind == "comment" {
			if strings.HasPrefix(token.Text, "/*+") {
				units = append(units, token.Text)
			}
			continue
		}
		if token.Kind != "" {
			units = append(units, token.Text)
			continue
		}
		// Plain tokens mix punctuation and whitespace (chroma reports both as
		// Text). The punctuation is kept; the whitespace is re-inserted only
		// where joining would merge two lexical units.
		var compact strings.Builder
		for _, r := range token.Text {
			if !unicode.IsSpace(r) {
				compact.WriteRune(r)
			}
		}
		if compact.Len() > 0 {
			units = append(units, compact.String())
		}
	}
	if len(units) == 0 {
		return "", fmt.Errorf("没有可压缩的 SQL 文本")
	}

	var out strings.Builder
	previous := ""
	for _, unit := range units {
		if previous != "" && needsSeparator(previous, unit) {
			out.WriteByte(' ')
		}
		out.WriteString(unit)
		previous = unit
	}
	compressed := strings.TrimSpace(out.String())
	if compressed == "" {
		return "", fmt.Errorf("没有可压缩的 SQL 文本")
	}
	return compressed, nil
}

// needsSeparator reports whether two adjacent units must keep a space to stay
// two tokens. Punctuation attaches to its neighbour (`a.b`, `f(x)`, `(a, b)`),
// word-like units never do (`SELECT x`, `1 2`), and `- -`, `/ *` and `* /`
// keep a space so removing whitespace can never create a comment.
func needsSeparator(previous, next string) bool {
	last, _ := utf8.DecodeLastRuneInString(previous)
	first, _ := utf8.DecodeRuneInString(next)
	if isClosingPunctuation(first) || isOpeningPunctuation(last) {
		return false
	}
	if first == '(' {
		return false
	}
	if (last == '-' && first == '-') ||
		(last == '/' && first == '*') ||
		(last == '*' && first == '/') {
		return true
	}
	return isWordRune(last) || isWordRune(first)
}

func isWordRune(r rune) bool {
	return r == '_' || r == '$' || r == '\'' || r == '"' || r == '`' ||
		unicode.IsLetter(r) || unicode.IsDigit(r)
}

func isClosingPunctuation(r rune) bool {
	switch r {
	case ',', ';', ')', ']', '}', '.':
		return true
	}
	return false
}

func isOpeningPunctuation(r rune) bool {
	switch r {
	case '(', '[', '{', '.':
		return true
	}
	return false
}
