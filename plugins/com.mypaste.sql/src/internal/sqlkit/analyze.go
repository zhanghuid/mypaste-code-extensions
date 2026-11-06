package sqlkit

import (
	"fmt"
	"strings"
)

// Analyze produces the render tokens and the structural diagnostics for one
// piece of SQL. The tokens always cover the whole input — the host render
// protocol and the page both verify that — and the diagnostics only ever name
// findings the token stream actually shows. Nothing here parses SQL deeply:
// balance, clause order and statement shape are what a bounded token stream
// can state with confidence, and every uncertain construct is skipped rather
// than reported (a false error destroys more trust than a missed one).
func Analyze(text string, dialect Dialect) (*Analysis, error) {
	if strings.TrimSpace(text) == "" {
		return nil, fmt.Errorf("没有可分析的 SQL 文本")
	}
	raw, err := tokenise(text, dialect)
	if err != nil {
		return nil, err
	}
	diagnostics := lexicalDiagnostics(text, raw)
	diagnostics = append(diagnostics, structuralDiagnostics(text, raw)...)
	if len(diagnostics) > maxDiagnostics {
		diagnostics = diagnostics[:maxDiagnostics]
	}
	return &Analysis{
		Tokens:      fold(raw),
		Diagnostics: diagnostics,
	}, nil
}

// lexicalDiagnostics turns chroma's Error tokens into positioned findings.
// chroma marks unmatched text — unterminated strings and comments, stray
// quote characters — with its Error type; those are the lexical half of the
// diagnostics.
func lexicalDiagnostics(text string, raw []rawToken) []Diagnostic {
	var out []Diagnostic
	for _, token := range raw {
		if !token.isError {
			continue
		}
		line, column := position(text, token.offset)
		out = append(out, Diagnostic{
			Line:     line,
			Column:   column,
			Length:   runeLength(text, token.offset, len(token.text)),
			Severity: SeverityError,
			Message:  "无法识别的记号（常见原因：未闭合的引号或注释）",
		})
		if len(out) >= maxDiagnostics {
			break
		}
	}
	return out
}

// clauseWord lists the leading words of the fixed SELECT pipeline. Order is
// the position in the pipeline; a later clause may not appear before an
// earlier one in the same SELECT scope.
var clauseOrder = map[string]int{
	"SELECT": 1, "FROM": 2, "WHERE": 3, "GROUP": 4,
	"HAVING": 5, "ORDER": 6, "LIMIT": 7, "OFFSET": 8,
}

// clauseName is the display name for the same words; a separate map keeps the
// two tables in step by construction instead of by string reverse lookup.
var clauseName = map[int]string{
	1: "SELECT", 2: "FROM", 3: "WHERE", 4: "GROUP",
	5: "HAVING", 6: "ORDER", 7: "LIMIT", 8: "OFFSET",
}

// setOperators reset the clause pipeline: everything after a UNION belongs to
// a fresh SELECT scope.
var setOperators = map[string]bool{
	"UNION": true, "INTERSECT": true, "EXCEPT": true, "MINUS": true,
}

// statementStarters begin a new statement and reset the clause pipeline.
var statementStarters = map[string]bool{
	"SELECT": true, "INSERT": true, "UPDATE": true, "DELETE": true,
	"CREATE": true, "DROP": true, "ALTER": true, "TRUNCATE": true,
	"WITH": true, "REPLACE": true, "CALL": true, "GRANT": true,
	"REVOKE": true, "BEGIN": true, "COMMIT": true, "ROLLBACK": true,
	"EXPLAIN": true, "USE": true, "SHOW": true, "DESC": true,
	"DESCRIBE": true, "SET": true,
}

// openers and closers drive the bracket check. The bracket kind is derived
// from the token text, so only the literal characters listed here participate.
var closerFor = map[string]string{"(": ")", "[": "]", "{": "}"}

// structuralDiagnostics walks the folded token stream and reports bracket
// balance and clause-order findings. Positions come from the token that
// caused the finding.
func structuralDiagnostics(text string, raw []rawToken) []Diagnostic {
	var out []Diagnostic
	add := func(offset int, length int, severity, message string) {
		if len(out) >= maxDiagnostics {
			return
		}
		line, column := position(text, offset)
		out = append(out, Diagnostic{
			Line:     line,
			Column:   column,
			Length:   runeLength(text, offset, length),
			Severity: severity,
			Message:  clampMessage(message),
		})
	}

	// bracket stack: for each open bracket the expected closer and its offset.
	type pending struct {
		closer string
		offset int
	}
	var brackets []pending

	// clause pipeline state per bracket depth: the highest clause index seen
	// in the current SELECT scope at that depth. Depth 0 is the statement
	// itself; a subquery at depth 1 has its own pipeline.
	type scope struct {
		lastIndex int
		lastWord  string
		seen      map[string]bool
	}
	scopes := []scope{{seen: map[string]bool{}}}

	// A subquery pushes its own pipeline scope when a "(" opens, and ")"
	// pops it again; the stack therefore always mirrors the bracket depth.
	pushScope := func() { scopes = append(scopes, scope{seen: map[string]bool{}}) }
	popScope := func() {
		if len(scopes) > 1 {
			scopes = scopes[:len(scopes)-1]
		}
	}

	for _, token := range raw {
		if token.isError || token.kind == "string" || token.kind == "comment" {
			continue
		}
		word := strings.ToUpper(strings.TrimSpace(token.text))
		if word == "" {
			continue
		}

		// A statement separator ends the clause pipeline at its depth.
		if word == ";" {
			active := &scopes[len(scopes)-1]
			*active = scope{seen: map[string]bool{}}
			continue
		}

		// Brackets first: they own the depth a clause belongs to.
		if closer, open := closerFor[word]; open {
			brackets = append(brackets, pending{closer: closer, offset: token.offset})
			pushScope()
			continue
		}
		if word == ")" || word == "]" || word == "}" {
			if len(brackets) == 0 {
				add(token.offset, len(token.text), SeverityError, "多余的右括号")
				continue
			}
			top := brackets[len(brackets)-1]
			if top.closer != word {
				add(token.offset, len(token.text), SeverityError, "括号不匹配：此处应为 "+top.closer)
				continue
			}
			brackets = brackets[:len(brackets)-1]
			popScope()
			continue
		}

		// A subquery's SELECT opens a fresh pipeline; an INSERT/UPDATE/etc.
		// statement resets the one at its depth.
		if statementStarters[word] && word != "SELECT" {
			active := &scopes[len(scopes)-1]
			*active = scope{seen: map[string]bool{}}
			continue
		}

		if setOperators[word] {
			active := &scopes[len(scopes)-1]
			*active = scope{seen: map[string]bool{}}
			continue
		}

		order, isClause := clauseOrder[word]
		if !isClause {
			continue
		}
		// GROUP BY / ORDER BY / OFFSET: only the leading word matters, and a
		// bare second word (BY) is not in the clause table.
		active := &scopes[len(scopes)-1]
		if active.seen[word] && word != "SELECT" {
			add(token.offset, len(token.text), SeverityError, "重复的 "+word+" 子句")
			continue
		}
		if active.lastIndex > order && word != "SELECT" {
			add(token.offset, len(token.text), SeverityError,
				fmt.Sprintf("子句顺序不正确：%s 出现在 %s 之后", word, active.lastWord))
			continue
		}
		active.seen[word] = true
		if order >= active.lastIndex {
			active.lastIndex = order
			active.lastWord = word
		}
	}

	if len(brackets) > 0 {
		top := brackets[len(brackets)-1]
		add(top.offset, 1, SeverityError, "有未闭合的左括号")
	}
	return out
}
