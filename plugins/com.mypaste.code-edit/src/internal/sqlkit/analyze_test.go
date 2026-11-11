package sqlkit

import (
	"strings"
	"testing"
)

// joined asserts the render invariant: the token texts reconstruct the input
// byte for byte. The formatter copies those tokens, so the engine must hold
// it on every input it accepts.
func joined(tokens []Token) string {
	var out strings.Builder
	for _, token := range tokens {
		out.WriteString(token.Text)
	}
	return out.String()
}

func TestTokensCoverWholeInput(t *testing.T) {
	inputs := []string{
		"SELECT 1",
		"SELECT id, name\nFROM users\nWHERE age > 18 AND city = 'BeiJing';\n",
		"/* block\ncomment */ INSERT INTO t (a) VALUES (1), (2);",
		"-- line comment\r\nUPDATE t SET a = 1 WHERE id IN (SELECT id FROM u);",
		"SELECT `quote` FROM `mysql table` WHERE x = \"double\";",
		"SELECT E'\\x2b' FROM pg_catalog.pg_tables WHERE schemaname <> 'information_schema';",
		"SELECT [bracket] FROM [dbo].[orders] WHERE status = N'open';",
		"CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT NOT NULL);",
		"SELECT CASE WHEN a THEN 1 ELSE 2 END, a.b.c FROM t",
		"WITH cte AS (SELECT 1 AS x) SELECT x FROM cte UNION ALL SELECT 2",
		"SELECT a -- trailing comment\nFROM t",
		"SELECT 'multi\nline string' FROM t",
		"SELECT 'crlf\r\nstring' FROM t WHERE a = 1\r\n",
	}
	for _, dialect := range []Dialect{
		DialectANSI, DialectPostgreSQL, DialectMySQL, DialectSQLite,
		DialectTSQL, DialectPLSQL, DialectBigQuery,
	} {
		for _, input := range inputs {
			analysis, err := Analyze(input, dialect)
			if err != nil {
				t.Fatalf("%s %q: 分析失败: %v", dialect, input, err)
			}
			if got := joined(analysis.Tokens); got != input {
				t.Fatalf("%s %q: token 流没有覆盖全文\ngot  %q\nwant %q", dialect, input, got, input)
			}
		}
	}
}

func TestHighlightKinds(t *testing.T) {
	analysis, err := Analyze("SELECT name FROM users WHERE id = 42;", DialectANSI)
	if err != nil {
		t.Fatal(err)
	}
	var kinds []string
	for _, token := range analysis.Tokens {
		if token.Kind != "" {
			kinds = append(kinds, token.Kind)
		}
	}
	want := []string{"keyword", "property", "keyword", "property", "keyword", "property", "number"}
	if strings.Join(kinds, ",") != strings.Join(want, ",") {
		t.Fatalf("kind 序列不符: got %v want %v", kinds, want)
	}
}

func TestCleanSQLHasNoDiagnostics(t *testing.T) {
	clean := []string{
		"SELECT id, name FROM users WHERE age > 18 GROUP BY id HAVING count(*) > 2 ORDER BY id LIMIT 10 OFFSET 20;",
		"INSERT INTO t (a, b) VALUES (1, 2), (3, 4);",
		"UPDATE t SET a = 1 WHERE id = 2;",
		"DELETE FROM t WHERE id = 2;",
		"WITH cte AS (SELECT 1 AS x) SELECT x FROM cte;",
		"SELECT u.name FROM users u LEFT JOIN orders o ON o.user_id = u.id INNER JOIN items i ON i.order_id = o.id;",
		"SELECT * FROM (SELECT id FROM t) sub WHERE EXISTS (SELECT 1 FROM x WHERE x.id = sub.id);",
	}
	for _, input := range clean {
		for _, dialect := range []Dialect{DialectANSI, DialectMySQL, DialectTSQL, DialectPostgreSQL} {
			analysis, err := Analyze(input, dialect)
			if err != nil {
				t.Fatalf("%s %q: %v", dialect, input, err)
			}
			if len(analysis.Diagnostics) != 0 {
				t.Fatalf("%s %q: 意外诊断 %+v", dialect, input, analysis.Diagnostics)
			}
		}
	}
}

func TestUnbalancedParentheses(t *testing.T) {
	for _, input := range []string{
		"SELECT count(* FROM t",
		"SELECT * FROM t) WHERE x = 1",
		"SELECT * FROM t WHERE a IN (1, 2] ",
	} {
		analysis, err := Analyze(input, DialectANSI)
		if err != nil {
			t.Fatalf("%q: %v", input, err)
		}
		found := false
		for _, diagnostic := range analysis.Diagnostics {
			if strings.Contains(diagnostic.Message, "括号") {
				found = true
			}
		}
		if !found {
			t.Fatalf("%q: 没有报告括号问题，诊断 %+v", input, analysis.Diagnostics)
		}
	}
}

func TestClauseOrderViolation(t *testing.T) {
	analysis, err := Analyze("SELECT a ORDER BY b FROM t", DialectANSI)
	if err != nil {
		t.Fatal(err)
	}
	if len(analysis.Diagnostics) == 0 {
		t.Fatal("ORDER BY 在 FROM 之前没有被报告")
	}
	found := false
	for _, diagnostic := range analysis.Diagnostics {
		if strings.Contains(diagnostic.Message, "顺序") &&
			strings.Contains(diagnostic.Message, "FROM") {
			found = true
		}
	}
	if !found {
		t.Fatalf("诊断没有指明 FROM 顺序错误: %+v", analysis.Diagnostics)
	}
}

func TestDuplicateClause(t *testing.T) {
	analysis, err := Analyze("SELECT a FROM t WHERE x = 1 WHERE y = 2", DialectANSI)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, diagnostic := range analysis.Diagnostics {
		if strings.Contains(diagnostic.Message, "重复") &&
			strings.Contains(diagnostic.Message, "WHERE") {
			found = true
		}
	}
	if !found {
		t.Fatalf("重复 WHERE 没有被报告: %+v", analysis.Diagnostics)
	}
}

func TestSubqueriesHaveTheirOwnClausePipeline(t *testing.T) {
	// A subquery may legally reverse the outer pipeline's order, and the
	// outer pipeline continues after the subquery closes.
	input := "SELECT id FROM t WHERE x IN (SELECT max(y) FROM u HAVING count(*) > 1) ORDER BY id;"
	analysis, err := Analyze(input, DialectANSI)
	if err != nil {
		t.Fatal(err)
	}
	if len(analysis.Diagnostics) != 0 {
		t.Fatalf("子查询不应产生诊断: %+v", analysis.Diagnostics)
	}
}

func TestDiagnosticsCarryPositions(t *testing.T) {
	input := "SELECT a\nFROM t WHERE (x = 1"
	analysis, err := Analyze(input, DialectANSI)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, diagnostic := range analysis.Diagnostics {
		if diagnostic.Severity == SeverityError && diagnostic.Line >= 1 && diagnostic.Column >= 1 {
			found = true
		}
	}
	if !found {
		t.Fatalf("诊断缺少合法位置: %+v", analysis.Diagnostics)
	}
}

func TestDiagnosticBudget(t *testing.T) {
	// 60 violations: the budget caps at 50 findings.
	var builder strings.Builder
	for i := 0; i < 60; i++ {
		builder.WriteString("SELECT a ORDER BY b FROM t ")
	}
	analysis, err := Analyze(builder.String(), DialectANSI)
	if err != nil {
		t.Fatal(err)
	}
	if len(analysis.Diagnostics) > maxDiagnostics {
		t.Fatalf("诊断超出上限: %d", len(analysis.Diagnostics))
	}
}

func TestParseDialectFallsBackToANSI(t *testing.T) {
	for value, want := range map[any]Dialect{
		nil:            DialectANSI,
		"":             DialectANSI,
		42:             DialectANSI,
		"nonsense":     DialectANSI,
		" PostgreSQL ": DialectPostgreSQL,
		"MYSQL":        DialectMySQL,
		"tsql":         DialectTSQL,
	} {
		if got := ParseDialect(value); got != want {
			t.Fatalf("ParseDialect(%v) = %s, want %s", value, got, want)
		}
	}
}

func TestEmptyInputIsRejected(t *testing.T) {
	if _, err := Analyze("   \n\t ", DialectANSI); err == nil {
		t.Fatal("空白输入应当被拒绝")
	}
}
