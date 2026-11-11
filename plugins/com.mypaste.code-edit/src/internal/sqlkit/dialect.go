// Package sqlkit turns SQL text into bounded tokens, structural diagnostics
// and formatted output for the code-edit runtime.
//
// Lexing belongs to chroma (the mainstream Go syntax-highlighting library);
// this package maps its token stream onto a closed kind set, derives
// diagnostics from that same stream, and lays the stream out again for
// formatting. It never executes SQL and never returns HTML or CSS.
package sqlkit

import (
	"fmt"
	"strings"

	"github.com/alecthomas/chroma/v2"
	"github.com/alecthomas/chroma/v2/lexers"
)

// Dialect is one closed SQL dialect the manifest's `dialect` setting may name.
// The words are the manifest's words: the setting enum and this set must stay
// in step, and dialect_test.go pins the mapping so a typo fails loudly.
type Dialect string

const (
	DialectANSI       Dialect = "ansi"
	DialectPostgreSQL Dialect = "postgresql"
	DialectMySQL      Dialect = "mysql"
	DialectSQLite     Dialect = "sqlite"
	DialectTSQL       Dialect = "tsql"
	DialectPLSQL      Dialect = "plsql"
	DialectBigQuery   Dialect = "bigquery"
)

// chromaLexerName maps each dialect onto the closest chroma lexer. chroma has
// no dedicated SQLite, BigQuery or Oracle PL/SQL lexer, so those fall back to
// the generic SQL lexer (SQLite) or the structurally nearest one (PL/pgSQL for
// PL/SQL, the generic SQL dialect for BigQuery).
var chromaLexerName = map[Dialect]string{
	DialectANSI:       "SQL",
	DialectPostgreSQL: "PostgreSQL SQL dialect",
	DialectMySQL:      "MySQL",
	DialectSQLite:     "SQL",
	DialectTSQL:       "Transact-SQL",
	DialectPLSQL:      "PL/pgSQL",
	DialectBigQuery:   "SQL",
}

// ParseDialect resolves one manifest setting value. Anything unknown — a
// missing setting, a wrong type, a value outside the closed set — resolves to
// ANSI, never to an error: the host validates the enum already, and a corrupt
// value must not break highlighting.
func ParseDialect(value any) Dialect {
	name, ok := value.(string)
	if !ok {
		return DialectANSI
	}
	dialect := Dialect(strings.ToLower(strings.TrimSpace(name)))
	if _, known := chromaLexerName[dialect]; known {
		return dialect
	}
	return DialectANSI
}

// lexerFor returns the dialect's chroma lexer, or nil when chroma does not
// know the mapped name (only possible if a chroma upgrade drops a lexer).
func lexerFor(dialect Dialect) chroma.Lexer {
	name, known := chromaLexerName[dialect]
	if !known {
		return nil
	}
	return lexers.Get(name)
}

// Token is one bounded text span with one closed render kind. The kinds are
// the host render protocol's kinds, nothing more: the page converts unknown
// ones to plain text, and the host rejects them outright.
type Token struct {
	Text string `json:"text"`
	Kind string `json:"kind"`
}

// Diagnostic is one structural finding with a 1-based position. Line and
// Column count runes; Length is the span length in runes, 0 meaning "at this
// position, no span". Message carries context only — never a quote of the
// user's SQL.
type Diagnostic struct {
	Line     int    `json:"line"`
	Column   int    `json:"column"`
	Length   int    `json:"length,omitempty"`
	Severity string `json:"severity"`
	Message  string `json:"message"`
}

const (
	SeverityError   = "error"
	SeverityWarning = "warning"

	// maxDiagnostics keeps the render payload bounded; the host rejects
	// anything above its own ceiling anyway.
	maxDiagnostics = 50
	// maxMessageRunes keeps one finding to one short, actionable line.
	maxMessageRunes = 120
)

// Analysis is everything one invocation derives from the token stream: the
// render tokens (always covering the whole input), the diagnostics, and the
// per-token kinds formatting needs.
type Analysis struct {
	Tokens      []Token
	Diagnostics []Diagnostic
}

// tokenise lexes text with the dialect's chroma lexer and folds the result
// into closed-kind tokens. chroma normalizes line endings, so the input is
// pre-stripped of carriage returns and every token is mapped back onto a byte
// slice of the original text — the render protocol requires exact coverage of
// the input, and the page falls back to its built-in SQL tokenizer when the
// extension cannot guarantee it (anything chroma still rewrites fails the
// coverage check and errors out).
func tokenise(text string, dialect Dialect) ([]rawToken, error) {
	lexer := lexerFor(dialect)
	if lexer == nil {
		return nil, fmt.Errorf("chroma 没有方言 %q 的词法器", dialect)
	}
	normalized, normToOrig := stripCarriageReturns(text)
	iterator, err := lexer.Tokenise(nil, normalized)
	if err != nil {
		return nil, fmt.Errorf("词法分析失败：%w", err)
	}
	var (
		tokens []rawToken
		offset int
		panned any
	)
	func() {
		defer func() {
			// chroma documents that lexers may report failures as panics.
			if recovered := recover(); recovered != nil {
				panned = recovered
			}
		}()
		for token := iterator(); token != chroma.EOF; token = iterator() {
			if token.Value == "" {
				continue
			}
			start := normToOrig[offset]
			end := len(text)
			if next := offset + len(token.Value); next < len(normToOrig) {
				end = normToOrig[next]
			}
			if end < start {
				return
			}
			tokens = append(tokens, rawToken{
				text:    text[start:end],
				kind:    mapKind(token.Type),
				isError: token.Type == chroma.Error,
				offset:  start,
			})
			offset += len(token.Value)
		}
	}()
	if panned != nil {
		return nil, fmt.Errorf("词法分析失败：%v", panned)
	}
	if offset != len(normalized) {
		return nil, fmt.Errorf("词法流没有覆盖全部输入（%d / %d 字节）", offset, len(normalized))
	}
	return tokens, nil
}

// stripCarriageReturns removes '\r' bytes, which chroma's line-ending
// normalization would drop silently, and returns the normalized text plus a
// byte-offset map from normalized positions back onto the original.
func stripCarriageReturns(text string) (string, []int) {
	var (
		out        strings.Builder
		normToOrig = make([]int, 0, len(text))
	)
	out.Grow(len(text))
	for index := 0; index < len(text); index++ {
		if text[index] == '\r' {
			continue
		}
		out.WriteByte(text[index])
		normToOrig = append(normToOrig, index)
	}
	return out.String(), normToOrig
}

// rawToken is one chroma token before folding: it keeps the byte offset so
// diagnostics can name a position without re-scanning.
type rawToken struct {
	text    string
	kind    string
	isError bool
	offset  int
}

// mapKind folds chroma's token taxonomy onto the closed render kind set.
// Everything unmapped is plain text: the host render protocol has no
// "operator" or "punctuation" kind, and the page renders "" tokens as-is.
func mapKind(tokenType chroma.TokenType) string {
	switch tokenType {
	case chroma.Error:
		return ""
	}
	switch tokenType.Category() {
	case chroma.Keyword:
		return "keyword"
	case chroma.Comment:
		return "comment"
	case chroma.Name:
		switch tokenType {
		case chroma.NameBuiltin, chroma.NameConstant:
			return "literal"
		case chroma.NameAttribute, chroma.NameOther, chroma.NameVariable:
			return "property"
		case chroma.NameFunction:
			return "function"
		case chroma.NameTag:
			return "tag"
		case chroma.NameClass, chroma.NameException, chroma.NameNamespace:
			return "type"
		}
		return "property"
	case chroma.Literal:
		// Strings and numbers are subcategories of Literal; Category() maps
		// both onto Literal.
		switch tokenType.SubCategory() {
		case chroma.LiteralString:
			return "string"
		case chroma.LiteralNumber:
			return "number"
		}
		return "literal"
	}
	return ""
}

// fold merges adjacent tokens that map to the same render kind, so the token
// array stays well below the host's budget on long files.
func fold(tokens []rawToken) []Token {
	out := make([]Token, 0, len(tokens))
	for _, token := range tokens {
		if len(out) > 0 && out[len(out)-1].Kind == token.kind {
			out[len(out)-1].Text += token.text
			continue
		}
		out = append(out, Token{Text: token.text, Kind: token.kind})
	}
	return out
}

// position converts a byte offset into a 1-based rune line and column.
func position(text string, offset int) (line, column int) {
	if offset > len(text) {
		offset = len(text)
	}
	line = 1
	runesSinceNewline := 0
	for _, r := range text[:offset] {
		if r == '\n' {
			line++
			runesSinceNewline = 0
			continue
		}
		runesSinceNewline++
	}
	return line, runesSinceNewline + 1
}

// runeLength measures the diagnostic span in runes, capped to the message
// budget so one pathological token cannot inflate the payload.
func runeLength(text string, offset, length int) int {
	if offset >= len(text) {
		return 0
	}
	if offset+length > len(text) {
		length = len(text) - offset
	}
	return len([]rune(text[offset : offset+length]))
}

func clampMessage(message string) string {
	runes := []rune(message)
	if len(runes) > maxMessageRunes {
		return string(runes[:maxMessageRunes-1]) + "…"
	}
	return message
}
