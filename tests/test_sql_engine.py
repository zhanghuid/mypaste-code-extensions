"""The SQL workspace's in-page engine (protocol v3).

The SQL page has no runtime behind it: its scanner, diagnostics, formatter and
compressor are TypeScript in the package. The test bundles those modules with
the same esbuild the surface build uses and runs them under Node, so every
expectation is about what the page itself computes:

- the seven dialects keep their own identifier quoting, comments and string
  forms, and an unknown picker value resolves to ANSI;
- words become keywords, types, literals, functions or names by the dialect's
  own vocabularies, and a lone `?` is a parameter while `?|` is an operator;
- lexical and structural findings carry 1-based rune positions, are ordered by
  position, and a formatter or compressor refuses to run on one;
- formatting re-lays the token stream at the chosen case and indent width,
  keeps `::`/`->`/`#>>` tight, and is idempotent;
- compressing drops comments except optimizer hints, never rewrites a string,
  and re-inserts a space only where two units would otherwise merge.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PACKAGE = ROOT / "plugins" / "com.mypaste.sql"
ESBUILD = ROOT / "node_modules" / ".bin" / "esbuild"
NODE = shutil.which("node")

RUNNER = r"""
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const work = process.argv[1];
const mod = await import(pathToFileURL(path.join(work, "engine.mjs")).href);
const {
  DIALECTS, DIALECT_IDS, dialectById, tokenizeSql, positionOf,
  analyzeSql, firstError, formatSql, parseFormatOptions, compressSql,
} = mod;

const checks = [];

/** The tokens' text and kind, without the whitespace runs between them. */
const pairs = (sql, dialect) => tokenizeSql(sql, dialectById(dialect))
  .filter((token) => token.text.trim() !== "")
  .map((token) => [token.text, token.kind]);

const diagnostics = (sql, dialect = "ansi") =>
  analyzeSql(sql, dialectById(dialect)).diagnostics;

const format = (sql, keywordCase = "preserve", indentWidth = "2", dialect = "ansi") =>
  formatSql(analyzeSql(sql, dialectById(dialect)), parseFormatOptions(keywordCase, indentWidth));

const compress = (sql, dialect = "ansi") =>
  compressSql(analyzeSql(sql, dialectById(dialect)));

// The dialect picker's closed set, in display order, and the fallback.
assert.deepEqual(DIALECT_IDS, [
  "ansi", "postgresql", "mysql", "sqlite", "tsql", "plsql", "bigquery",
]);
assert.deepEqual(DIALECTS.map((dialect) => dialect.label), [
  "SQL 标准", "PostgreSQL", "MySQL", "SQLite", "SQL Server",
  "Oracle PL/SQL", "BigQuery",
]);
assert.equal(dialectById("nonsense").id, "ansi");
checks.push("seven dialects, one picker, ANSI as the fallback");

// Words are classified by the dialect's vocabularies, not a shared word list.
assert.deepEqual(pairs("SELECT TOP 5 [my col], x FROM [dbo].[t] WHERE y = TRUE", "tsql"), [
  ["SELECT", "keyword"], ["TOP", "keyword"], ["5", "number"],
  ["[my col]", "property"], [",", ""], ["x", "property"],
  ["FROM", "keyword"], ["[dbo]", "property"], [".", ""], ["[t]", "property"],
  ["WHERE", "keyword"], ["y", "property"], ["=", ""], ["TRUE", "literal"],
]);
assert.deepEqual(pairs("SELECT `a b`, JSON_EXTRACT(j, '$.x') FROM t # tail", "mysql"), [
  ["SELECT", "keyword"], ["`a b`", "property"], [",", ""],
  ["JSON_EXTRACT", "function"], ["(", ""], ["j", "property"], [",", ""],
  ["'$.x'", "string"], [")", ""], ["FROM", "keyword"], ["t", "property"],
  ["# tail", "comment"],
]);
assert.deepEqual(pairs('SELECT "x", `y` FROM t', "mysql"), [
  ["SELECT", "keyword"], ['"x"', "string"], [",", ""], ["`y`", "property"],
  ["FROM", "keyword"], ["t", "property"],
]);
assert.deepEqual(pairs('SELECT "x", [y] FROM t', "sqlite"), [
  ["SELECT", "keyword"], ['"x"', "property"], [",", ""], ["[y]", "property"],
  ["FROM", "keyword"], ["t", "property"],
]);
assert.deepEqual(pairs("SELECT NULL, TRUE, FALSE, DEFAULT", "ansi"), [
  ["SELECT", "keyword"], ["NULL", "literal"], [",", ""],
  ["TRUE", "literal"], [",", ""], ["FALSE", "literal"], [",", ""],
  ["DEFAULT", "keyword"],
]);
checks.push("identifier quoting and word classes follow the chosen dialect");

// Every string form stays one token, prefix included.
assert.deepEqual(pairs("SELECT E'a\\nb', $tag$hi$tag$, a ? 'k', j ?| ARRAY['a'] FROM t", "postgresql"), [
  ["SELECT", "keyword"], ["E'a\\nb'", "string"], [",", ""],
  ["$tag$hi$tag$", "string"], [",", ""], ["a", "property"], ["?", "property"],
  ["'k'", "string"], [",", ""], ["j", "property"], ["?|", ""],
  ["ARRAY", "keyword"], ["[", ""], ["'a'", "string"], ["]", ""],
  ["FROM", "keyword"], ["t", "property"],
]);
assert.deepEqual(pairs("SELECT N'x' FROM t", "mysql"), [
  ["SELECT", "keyword"], ["N'x'", "string"], ["FROM", "keyword"], ["t", "property"],
]);
assert.deepEqual(pairs("SELECT 'it''s', :name, @row, $1 FROM t", "ansi"), [
  ["SELECT", "keyword"], ["'it''s'", "string"], [",", ""],
  [":name", "property"], [",", ""], ["@row", "property"], [",", ""],
  ["$1", "property"], ["FROM", "keyword"], ["t", "property"],
]);
assert.deepEqual(pairs("SELECT a /* c */ -- d\nFROM t", "ansi"), [
  ["SELECT", "keyword"], ["a", "property"], ["/* c */", "comment"],
  ["-- d", "comment"], ["FROM", "keyword"], ["t", "property"],
]);
checks.push("strings, parameters and both comment styles keep their shape");

// Findings carry rune positions, and the page may rely on the first one.
assert.deepEqual(diagnostics("select (a from t"), [
  { line: 1, column: 8, length: 1, severity: "error", message: "有未闭合的左括号" },
]);
assert.deepEqual(diagnostics("select a) from t"), [
  { line: 1, column: 9, length: 1, severity: "error", message: "多余的右括号" },
]);
assert.deepEqual(diagnostics("select * from (a]"), [
  { line: 1, column: 15, length: 1, severity: "error", message: "有未闭合的左括号" },
  { line: 1, column: 17, length: 1, severity: "error", message: "括号不匹配：此处应为 )" },
]);
assert.deepEqual(diagnostics("select a from t where x = 1 where y = 2"), [
  { line: 1, column: 29, length: 5, severity: "error", message: "重复的 WHERE 子句" },
]);
assert.deepEqual(diagnostics("select a from t limit 1 where x = 1"), [
  { line: 1, column: 25, length: 5, severity: "error", message: "子句顺序不正确：WHERE 出现在 LIMIT 之后" },
]);
assert.deepEqual(diagnostics("select ) , 'abc"), [
  { line: 1, column: 8, length: 1, severity: "error", message: "多余的右括号" },
  { line: 1, column: 12, length: 4, severity: "error",
    message: "无法识别的记号（常见原因：未闭合的引号或注释）" },
]);
assert.equal(diagnostics("  ").length, 0);
assert.equal(firstError(diagnostics("select a from t")), null);
assert.equal(firstError(diagnostics("select (a from t")).column, 8);
assert.deepEqual([positionOf("a\nbc", 3), positionOf("😀x", 2), positionOf("", 0)], [
  { line: 2, column: 2 }, { line: 1, column: 2 }, { line: 1, column: 1 },
]);
checks.push("diagnostics are rune-positioned and ordered for the status line");

// Beautifying: a clause stays on one line while it fits, then breaks at its
// commas, AND/OR and clause heads; join phrases, IN/VALUES lists and window
// clauses keep their shape; a wide CASE opens into WHEN rows; a second pass
// changes nothing.
assert.equal(
  format("select a.id,a.name, sum(o.total) as total from accounts a left join orders o on o.account_id=a.id where a.deleted_at is null and o.total>100 group by a.id,a.name order by total desc limit 10;", "upper"),
  "SELECT a.id, a.name, SUM(o.total) AS total\n" +
  "FROM accounts a\nLEFT JOIN orders o ON o.account_id = a.id\n" +
  "WHERE a.deleted_at IS null AND o.total > 100\n" +
  "GROUP BY a.id, a.name\nORDER BY total DESC\nLIMIT 10;",
);
assert.equal(format("select a, b from t where x=1 and y=2", "upper", "4"),
  "SELECT a, b\nFROM t\nWHERE x = 1 AND y = 2");
assert.equal(format("select a from t", "lower", "8"), "select a\nfrom t");
assert.equal(format("select a from t", "nonsense", "3"), "select a\nfrom t");
assert.equal(format("select a::text, b->>c, d #>> e, x?|y from t", "preserve", "2", "postgresql"),
  "select a::text, b->>c, d#>>e, x ?| y\nfrom t");
// A wide WHERE breaks at AND with one indent; a wide select list at commas;
// wide function arguments one per line, closing bracket on its own row.
assert.equal(
  format("select a from t where x = 1 and y = 2 and z = 3 and w = 4 and v = 5 and u = 6 and long_column_name_here = 7 and another_long_column = 8"),
  "select a\nfrom t\nwhere x = 1\n  and y = 2\n  and z = 3\n  and w = 4\n  and v = 5\n" +
  "  and u = 6\n  and long_column_name_here = 7\n  and another_long_column = 8");
assert.equal(
  format("select first_column, second_column, third_column_with_long_name, fourth_column, fifth_column, sixth_column from t"),
  "select first_column,\n  second_column,\n  third_column_with_long_name,\n" +
  "  fourth_column,\n  fifth_column,\n  sixth_column\nfrom t");
assert.equal(
  format("select coalesce(first_value, second_value, third_value, fourth_value, fifth_value, sixth_value, seventh_value) as merged from t"),
  "select coalesce(\n  first_value,\n  second_value,\n  third_value,\n" +
  "  fourth_value,\n  fifth_value,\n  sixth_value,\n  seventh_value\n) as merged\nfrom t");
// Join phrases stay whole; IN and VALUES lists keep their space; COUNT sits
// tight; AND after BETWEEN stays inline; INSERT INTO keeps the column list
// spaced; a multi-branch CASE opens into rows, a fitting one stays inline.
assert.equal(format("select a from t1 left outer join t2 on t1.x = t2.x cross join t3"),
  "select a\nfrom t1\nleft outer join t2 on t1.x = t2.x\ncross join t3");
assert.equal(format("select * from t where id in (1, 2) and name in ('a', 'b')"),
  "select *\nfrom t\nwhere id in (1, 2) and name in ('a', 'b')");
assert.equal(format("insert into users (id, name) values (1, 'a'), (2, 'b')"),
  "insert into users (id, name)\nvalues (1, 'a'), (2, 'b')");
assert.equal(format("select count(*) from t"), "select count(*)\nfrom t");
assert.equal(format("select a from t where x between 1 and 10 and y = 2"),
  "select a\nfrom t\nwhere x between 1 and 10 and y = 2");
assert.equal(
  format("select case when a = 1 then 'one' when a = 2 then 'two' else 'other' end as label from t"),
  "select case\n  when a = 1 then 'one'\n  when a = 2 then 'two'\n  else 'other'\nend as label\nfrom t");
assert.equal(format("select x = case when a then b else c end from t"),
  "select x = case when a then b else c end\nfrom t");
// A fitting subquery and window clause stay on the line that holds them.
const subquery = format("select * from (select a from t where b=1) s join u on u.id=s.a");
assert.equal(subquery,
  "select *\nfrom (select a from t where b = 1) s\njoin u on u.id = s.a");
assert.equal(format(subquery), subquery);
assert.equal(format("select count(*) over (partition by dept order by hired) as rank from staff"),
  "select count(*) over (partition by dept order by hired) as rank\nfrom staff");
// CTEs sit one per row once the WITH list breaks at its commas.
assert.equal(
  format("with a as (select 1 as x, 2 as y, 3 as z, 4 as w, 5 as v, 6 as u, 7 as t2, 8 as s), b as (select 2 as y) select * from a join b on a.x = b.y"),
  "with a as (select 1 as x, 2 as y, 3 as z, 4 as w, 5 as v, 6 as u, 7 as t2, 8 as s),\n" +
  "  b as (select 2 as y)\nselect *\nfrom a\njoin b on a.x = b.y");
checks.push("beautifying keeps fitting clauses whole and breaks wide ones at their joints");

// Compressing keeps strings and hints, drops other comments, and only adds a
// space where two units would merge.
assert.deepEqual(compress("SELECT /*+ INDEX(t) */ a, 'x y' -- note\nFROM t WHERE a=1"),
  { ok: true, text: "SELECT /*+ INDEX(t) */ a, 'x y' FROM t WHERE a = 1" });
assert.deepEqual(compress("select ( a + b ) , c from t where x in (1,2)"),
  { ok: true, text: "select(a + b), c from t where x in(1, 2)" });
assert.deepEqual(compress("select -1 / 2 from t"),
  { ok: true, text: "select - 1 / 2 from t" });
assert.deepEqual(compress("  -- only\n /* c */"),
  { ok: false, message: "没有可压缩的 SQL 文本" });
checks.push("compressing removes comments and keeps lexical boundaries");

console.log(JSON.stringify({ ok: true, checks }));
"""


def bundle(work: Path) -> None:
    sources = ["dialect", "tokenize", "analyze", "format", "compress"]
    entry = work / "engine.ts"
    entry.write_text(
        "".join(
            f'export * from {json.dumps(str(PACKAGE / "src" / f"{name}.ts"))};\n'
            for name in sources
        ),
        encoding="utf-8",
    )
    subprocess.run(
        [
            str(ESBUILD),
            str(entry),
            "--bundle",
            "--format=esm",
            "--target=es2022",
            "--log-level=warning",
            f"--outfile={work / 'engine.mjs'}",
        ],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
    )


@unittest.skipIf(NODE is None, "node is required for the surface engine test")
class SqlEngineTests(unittest.TestCase):
    def test_engine(self) -> None:
        if not ESBUILD.exists():
            self.skipTest("esbuild is not installed (run bun install)")
        with tempfile.TemporaryDirectory() as directory:
            work = Path(directory)
            bundle(work)
            result = subprocess.run(
                [NODE, "--input-type=module", "-e", RUNNER, str(work)],
                cwd=ROOT,
                check=False,
                capture_output=True,
                text=True,
                timeout=60,
            )
        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads(result.stdout.strip().splitlines()[-1])
        self.assertTrue(report["ok"])
        self.assertEqual(len(report["checks"]), 6, report["checks"])


if __name__ == "__main__":
    unittest.main()
