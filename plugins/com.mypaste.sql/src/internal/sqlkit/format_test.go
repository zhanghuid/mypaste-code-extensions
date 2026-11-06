package sqlkit

import (
	"strings"
	"testing"
)

// formatFor runs the full pipeline (analyze, then format) the command uses.
func formatFor(t *testing.T, input string, options FormatOptions, dialect Dialect) string {
	t.Helper()
	analysis, err := Analyze(input, dialect)
	if err != nil {
		t.Fatalf("分析失败: %v", err)
	}
	for _, diagnostic := range analysis.Diagnostics {
		if diagnostic.Severity == SeverityError {
			t.Fatalf("输入不应有错误诊断: %+v", analysis.Diagnostics)
		}
	}
	return Format(analysis, options)
}

func TestFormatClauseLayout(t *testing.T) {
	output := formatFor(t,
		"SELECT id, name FROM users WHERE age > 18 AND active = 1 ORDER BY id;",
		FormatOptions{KeywordCase: "upper", IndentWidth: 4}, DialectANSI)
	want := strings.Join([]string{
		"SELECT id,",
		"    name",
		"FROM users",
		"WHERE age > 18",
		"    AND active = 1",
		"ORDER BY id;",
	}, "\n")
	if output != want {
		t.Fatalf("排版不符:\ngot:\n%s\nwant:\n%s", output, want)
	}
}

func TestFormatKeepsStringsByteExact(t *testing.T) {
	const input = "SELECT 'a  b\t c' FROM t"
	output := formatFor(t, input, FormatOptions{}, DialectANSI)
	if !strings.Contains(output, "'a  b\t c'") {
		t.Fatalf("字符串字面量被改写: %q", output)
	}
}

func TestFormatKeywordCase(t *testing.T) {
	input := "select id from t where x = 1"
	upper := formatFor(t, input, FormatOptions{KeywordCase: "upper", IndentWidth: 4}, DialectANSI)
	lower := formatFor(t, input, FormatOptions{KeywordCase: "lower", IndentWidth: 4}, DialectANSI)
	preserve := formatFor(t, input, FormatOptions{KeywordCase: "preserve", IndentWidth: 4}, DialectANSI)
	if !strings.Contains(upper, "SELECT") || strings.Contains(upper, "select") {
		t.Fatalf("upper 未生效: %q", upper)
	}
	if !strings.Contains(lower, "select") || strings.Contains(lower, "SELECT") {
		t.Fatalf("lower 未生效: %q", lower)
	}
	if !strings.Contains(preserve, "select") {
		t.Fatalf("preserve 改写了关键字: %q", preserve)
	}
}

func TestFormatIndentWidths(t *testing.T) {
	input := "SELECT id FROM t WHERE a = 1 AND b = 2"
	for width, indent := range map[int]string{2: "  ", 8: "        "} {
		output := formatFor(t, input, FormatOptions{IndentWidth: width}, DialectANSI)
		if !strings.Contains(output, "\n"+indent+"AND") {
			t.Fatalf("缩进宽度 %d 未生效: %q", width, output)
		}
	}
}

func TestFormatJoinsBreak(t *testing.T) {
	output := formatFor(t,
		"SELECT u.name FROM users u LEFT JOIN orders o ON o.user_id = u.id;",
		FormatOptions{}, DialectANSI)
	lines := strings.Split(output, "\n")
	joined := false
	for _, line := range lines {
		if strings.HasPrefix(line, "LEFT JOIN") || strings.HasPrefix(line, "JOIN") {
			joined = true
		}
	}
	if !joined {
		t.Fatalf("JOIN 未独立成行: %q", output)
	}
}

func TestFormatSubqueryIndents(t *testing.T) {
	output := formatFor(t,
		"SELECT id FROM t WHERE x IN (SELECT max(y) FROM u) ORDER BY id;",
		FormatOptions{}, DialectANSI)
	if !strings.Contains(output, "IN (\n") {
		t.Fatalf("子查询未开块: %q", output)
	}
	if !strings.Contains(output, "SELECT max(y)") {
		t.Fatalf("子查询内容缺失: %q", output)
	}
}

func TestFormatFunctionCallStaysInline(t *testing.T) {
	output := formatFor(t,
		"SELECT count(*) FROM t GROUP BY a HAVING count(*) > 1;",
		FormatOptions{}, DialectANSI)
	if !strings.Contains(output, "count(*)") {
		t.Fatalf("函数调用被折行: %q", output)
	}
}

func TestFormatIdempotent(t *testing.T) {
	input := "WITH cte AS (SELECT id, name FROM users WHERE age > 18) SELECT id, name FROM cte ORDER BY id LIMIT 10;"
	once := formatFor(t, input, FormatOptions{}, DialectANSI)
	twice := formatFor(t, once, FormatOptions{}, DialectANSI)
	if once != twice {
		t.Fatalf("格式化不幂等:\nonce:\n%s\ntwice:\n%s", once, twice)
	}
}

func TestFormatDialects(t *testing.T) {
	inputs := map[Dialect]string{
		DialectMySQL:      "SELECT `a b` FROM `t x` WHERE c = 'd';",
		DialectPostgreSQL: "SELECT a::text FROM t WHERE b = E'\\n';",
		DialectTSQL:       "SELECT TOP 10 [a] FROM [dbo].[t] WHERE b = N'c';",
		DialectPLSQL:      "SELECT a FROM t WHERE b IS NOT NULL;",
	}
	for dialect, input := range inputs {
		output := formatFor(t, input, FormatOptions{}, dialect)
		if strings.TrimSpace(output) == "" {
			t.Fatalf("%s: 输出为空", dialect)
		}
	}
}

func TestFormatComments(t *testing.T) {
	input := "SELECT a -- trailing\nFROM t /* block */ WHERE x = 1"
	output := formatFor(t, input, FormatOptions{}, DialectANSI)
	if !strings.Contains(output, "-- trailing") {
		t.Fatalf("行注释丢失: %q", output)
	}
	if !strings.Contains(output, "/* block */") {
		t.Fatalf("块注释丢失: %q", output)
	}
}

func TestFormatLineCommentsGetTheirOwnLine(t *testing.T) {
	input := "SELECT a, -- list comment\nb FROM t"
	output := formatFor(t, input, FormatOptions{}, DialectANSI)
	if !strings.Contains(output, "\n-- list comment\n") {
		t.Fatalf("行注释未独立成行: %q", output)
	}
}
