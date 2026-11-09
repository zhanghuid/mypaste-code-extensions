package sqlkit

import "testing"

func compress(t *testing.T, text string) string {
	t.Helper()
	analysis, err := Analyze(text, DialectANSI)
	if err != nil {
		t.Fatalf("分析失败: %v", err)
	}
	compressed, err := Compress(analysis)
	if err != nil {
		t.Fatalf("压缩失败: %v", err)
	}
	return compressed
}

func TestCompressFoldsWhitespaceAndDropsComments(t *testing.T) {
	got := compress(t, "SELECT id,\n  name -- keep this out\nFROM t /* and this */ WHERE x = 1;")
	want := "SELECT id, name FROM t WHERE x = 1;"
	if got != want {
		t.Fatalf("压缩结果不对:\n got: %q\nwant: %q", got, want)
	}
}

func TestCompressPreservesStringLiterals(t *testing.T) {
	got := compress(t, "SELECT '--not a comment', 'a  b' FROM t")
	want := "SELECT '--not a comment', 'a  b' FROM t"
	if got != want {
		t.Fatalf("字符串被改写:\n got: %q\nwant: %q", got, want)
	}
}

func TestCompressKeepsOperatorBoundaries(t *testing.T) {
	got := compress(t, "SELECT a - -1, b / * 2 FROM t")
	if got == "SELECT a--1, b/**/ 2 FROM t" {
		t.Fatalf("压缩后形成了注释: %q", got)
	}
	if len(got) == 0 {
		t.Fatal("压缩结果为空")
	}
}

func TestCompressKeepsOptimizerHints(t *testing.T) {
	got := compress(t, "SELECT /*+ INDEX(t idx) */ id FROM t")
	if got != "SELECT /*+ INDEX(t idx) */ id FROM t" {
		t.Fatalf("优化器提示被删除: %q", got)
	}
}

func TestCompressRefusesEmptyText(t *testing.T) {
	analysis, err := Analyze("-- only a comment", DialectANSI)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Compress(analysis); err == nil {
		t.Fatal("只有注释的文本应当拒绝压缩")
	}
}
