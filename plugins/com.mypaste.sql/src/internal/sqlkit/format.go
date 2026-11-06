package sqlkit

import (
	"strings"
)

// FormatOptions carries the declarative settings the format command accepts.
// Values come from the manifest enum; anything unexpected resolves to the
// default instead of erroring.
type FormatOptions struct {
	// KeywordCase is "preserve", "upper" or "lower".
	KeywordCase string
	// IndentWidth is the number of spaces per nesting level (2, 4 or 8).
	IndentWidth int
}

// NewFormatOptions resolves the manifest settings. A zero options value means
// "preserve keywords, indent by 4".
func NewFormatOptions(keywordCase any, indent any) FormatOptions {
	options := FormatOptions{KeywordCase: "preserve", IndentWidth: 4}
	if name, ok := keywordCase.(string); ok {
		switch strings.ToLower(strings.TrimSpace(name)) {
		case "upper":
			options.KeywordCase = "upper"
		case "lower":
			options.KeywordCase = "lower"
		}
	}
	if width, ok := indent.(string); ok {
		switch width {
		case "2":
			options.IndentWidth = 2
		case "8":
			options.IndentWidth = 8
		}
	}
	return options
}

// newlineBefore words start a line of their own at paren depth 0.
var newlineBefore = map[string]bool{
	"SELECT": true, "FROM": true, "WHERE": true, "GROUP": true,
	"HAVING": true, "ORDER": true, "LIMIT": true, "OFFSET": true,
	"UNION": true, "INTERSECT": true, "EXCEPT": true, "MINUS": true,
	"VALUES": true, "SET": true, "INSERT": true, "UPDATE": true,
	"DELETE": true, "CREATE": true, "DROP": true, "ALTER": true,
}

// joinLeading words open a join clause when the next word is JOIN. The JOIN
// word itself always starts a line.
var joinLeading = map[string]bool{
	"JOIN": true, "LEFT": true, "RIGHT": true, "FULL": true,
	"INNER": true, "CROSS": true, "NATURAL": true,
}

// conditionBreaks break a long condition: these words get their own line,
// indented one level deeper than their clause.
var conditionBreaks = map[string]bool{
	"AND": true, "OR": true, "ON": true,
}

// subqueryHead words turn an opening bracket into an indented subquery block.
func subqueryHead(word string) bool {
	return word == "SELECT" || word == "WITH"
}

// Format lays the token stream out again: one clause per line at the top
// level, commas break the select list, joins and conditions break, and
// subqueries indent per nesting level. String, number and comment tokens
// pass through byte-for-byte; spacing and keyword casing outside them are
// policy, not preservation. The input is expected to be error-free — the
// command refuses to format when Analyze reports an error — so layout never
// has to guess about broken syntax.
func Format(analysis *Analysis, options FormatOptions) string {
	// piece is the condensed view formatting works on: whitespace is
	// re-derived, everything else keeps its text.
	type piece struct {
		text      string
		kind      string
		isKeyword bool
	}
	pieces := make([]piece, 0, len(analysis.Tokens))
	for _, token := range analysis.Tokens {
		switch token.Kind {
		case "string", "comment", "number":
			pieces = append(pieces, piece{text: token.Text, kind: token.Kind})
		case "keyword":
			pieces = append(pieces, piece{text: token.Text, kind: token.Kind, isKeyword: true})
		default:
			// Operators, punctuation and identifiers: collapse whitespace,
			// keep the characters. A merged token such as " ," becomes ",".
			// A whitespace-only token reduces to the empty string and is
			// dropped entirely: layout spacing is policy, not preservation.
			text := strings.Join(strings.Fields(token.Text), " ")
			if text == "" {
				continue
			}
			pieces = append(pieces, piece{text: text})
		}
	}

	// nextWord is the next non-comment piece's uppercase text, or "" when a
	// literal intervenes — a bracket before a literal is never a subquery.
	nextWord := func(from int) string {
		for index := from + 1; index < len(pieces); index++ {
			if pieces[index].kind == "comment" {
				continue
			}
			return strings.ToUpper(pieces[index].text)
		}
		return ""
	}

	// The output is a list of lines. `current` accumulates the line being
	// written; `lastChar` is its last meaningful character for the spacing
	// policy. Layout never depends on the input's own whitespace.
	var lines []string
	current := ""
	lastChar := byte(0)
	emit := func(text string) {
		current += text
		trimmed := strings.TrimRight(text, " \t")
		if trimmed != "" {
			lastChar = trimmed[len(trimmed)-1]
		}
	}
	// startLine closes the current line when it has content, then indents.
	// An empty line is replaced so consecutive breaks never stack indents.
	startLine := func(levels int) {
		if strings.TrimSpace(current) != "" {
			lines = append(lines, current)
			current = ""
			lastChar = 0
		} else {
			current = ""
			lastChar = 0
		}
		if levels > 0 {
			current += strings.Repeat(" ", levels*options.IndentWidth)
		}
	}
	// inline appends text on the current line with policy spacing.
	inline := func(text string) {
		if strings.TrimSpace(current) == "" {
			// The line carries indentation only; spacing comes from it.
			emit(text)
			return
		}
		switch {
		case text == "," || text == ")" || text == ";" || text == "." ||
			text == "(" || strings.HasPrefix(text, "("):
			// Tight before closers, separators and openers. Lexers merge
			// whole argument lists into one chunk ("(*)"), so the prefix
			// rule matters, not just the bare bracket.
		default:
			switch lastChar {
			case '(', '.':
				// Tight after openers and in qualified names.
			default:
				emit(" ")
			}
		}
		emit(text)
	}

	// parenBlocks mirrors the bracket depth: whether each opening bracket
	// started an indented subquery block, so its closer knows to break.
	var parenBlocks []bool
	depth := 0

	for index, currentPiece := range pieces {
		if currentPiece.kind == "comment" {
			if strings.HasPrefix(strings.TrimSpace(currentPiece.text), "--") {
				// A line comment owns its line and ends it.
				if strings.TrimSpace(current) != "" {
					lines = append(lines, current)
					current = ""
				}
				current += strings.TrimRight(currentPiece.text, " \t")
				lines = append(lines, current)
				current = ""
				lastChar = 0
			} else {
				inline(currentPiece.text)
			}
			continue
		}
		if currentPiece.kind == "string" || currentPiece.kind == "number" {
			inline(currentPiece.text)
			continue
		}

		word := strings.ToUpper(currentPiece.text)
		switch {
		case currentPiece.text == "(":
			opensBlock := subqueryHead(nextWord(index))
			if opensBlock {
				// A subquery after an expression reads better with a space:
				// "IN (\n  SELECT …" — unlike a function call, which is tight.
				if strings.TrimSpace(current) != "" {
					emit(" ")
				}
				emit("(")
				depth++
				parenBlocks = append(parenBlocks, true)
				startLine(depth)
			} else {
				parenBlocks = append(parenBlocks, false)
				depth++
				inline("(")
			}

		case currentPiece.text == ")":
			block := false
			if len(parenBlocks) > 0 {
				block = parenBlocks[len(parenBlocks)-1]
				parenBlocks = parenBlocks[:len(parenBlocks)-1]
			}
			depth = max(0, depth-1)
			if block {
				startLine(depth)
			}
			inline(")")

		case currentPiece.text == ",":
			emit(",")
			// List items break at statement depth; function arguments and
			// column definitions stay on one line.
			if depth == 0 {
				startLine(1)
			}

		case currentPiece.text == ";":
			emit(";")
			startLine(0)

		case currentPiece.isKeyword && joinLeading[word] && word != "JOIN" && nextWord(index) != "JOIN":
			// LEFT / INNER / … not followed by JOIN: part of an expression,
			// keep it inline with its neighbours.
			inline(renderKeyword(currentPiece.text, options))

		case currentPiece.isKeyword && (newlineBefore[word] ||
			word == "JOIN" || conditionBreaks[word]):
			levels := depth
			if conditionBreaks[word] && word != "ON" {
				levels = depth + 1
			}
			startLine(levels)
			emit(renderKeyword(currentPiece.text, options))

		default:
			if currentPiece.isKeyword {
				inline(renderKeyword(currentPiece.text, options))
			} else {
				inline(currentPiece.text)
			}
		}
	}

	if strings.TrimSpace(current) != "" {
		lines = append(lines, current)
	}
	return strings.Join(lines, "\n")
}

// renderKeyword applies the keyword-case policy to one keyword token.
func renderKeyword(text string, options FormatOptions) string {
	switch options.KeywordCase {
	case "upper":
		return strings.ToUpper(text)
	case "lower":
		return strings.ToLower(text)
	}
	return text
}
