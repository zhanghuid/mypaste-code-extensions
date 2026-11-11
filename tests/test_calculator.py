"""Unit tests for the calculator extension's expression engine.

The package's pure module (`src/evaluate.ts`) is bundled with the same esbuild
the surface build uses and executed under Node. Every fixture is synthetic: no
clipboard text, entry or user content is involved, and the engine itself never
reads anything outside the lines it is given.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PACKAGE = ROOT / "plugins" / "com.mypaste.calculator"
ESBUILD = ROOT / "node_modules" / ".bin" / "esbuild"
NODE = shutil.which("node")

RUNNER = r"""
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const work = process.argv[2];
const { evaluateSheet } = await import(pathToFileURL(path.join(work, "evaluate.mjs")).href);

const checks = [];
const row = (line) => evaluateSheet([line])[0];
function value(line) {
  const outcome = row(line);
  assert.equal(outcome.kind, "value", `${line} → ${outcome.error}`);
  return outcome.value;
}
function error(line) {
  const outcome = row(line);
  assert.equal(outcome.kind, "error", `${line} should fail`);
  return outcome.error;
}
const near = (actual, expected, label) => {
  assert.ok(Math.abs(actual - expected) < 1e-12, `${label}: ${actual}`);
};

// Arithmetic, precedence, signs and number literals.
assert.equal(value("1 + 2 * 3"), 7);
assert.equal(value("(1 + 2) * 3"), 9);
assert.equal(value("2^3^2"), 512);
assert.equal(value("-2^2"), -4);
assert.equal(value("2^-3"), 0.125);
assert.equal(value("10 / 4"), 2.5);
assert.equal(value("1_000 + 2"), 1002);
assert.equal(value(".5 + .25"), 0.75);
assert.equal(value("1e3 / 4"), 250);
assert.equal(value("2 ** 10"), 1024);
assert.equal(value("6 × 7"), 42);
assert.equal(value("9 ÷ 3 − 1"), 2);
checks.push("arithmetic, precedence, signs and literals");

// Juxtaposition is multiplication.
assert.equal(value("2(3 + 4)"), 14);
assert.equal(value("(1 + 2)(3 + 4)"), 21);
assert.equal(value("2 3"), 6);
checks.push("juxtaposition multiplies");

// Percent and degrees.
assert.equal(value("50%"), 0.5);
assert.equal(value("200 * 10%"), 20);
assert.equal(value("200 + 10%"), 220);
assert.equal(value("200 - 10%"), 180);
near(value("180°"), Math.PI, "degrees");
near(value("sin(90°)"), 1, "sine of a degree angle");
checks.push("percent as a share and degree angles");

// Functions and constants.
assert.equal(value("sqrt(9)"), 3);
assert.equal(value("cbrt(27)"), 3);
assert.equal(value("abs(-4)"), 4);
assert.equal(value("round(2.567, 2)"), 2.57);
assert.equal(value("min(3, 1, 2)"), 1);
assert.equal(value("max(3, 1, 2)"), 3);
assert.equal(value("hypot(3, 4)"), 5);
assert.equal(value("mod(10, 3)"), 1);
assert.equal(value("log(100)"), 2);
assert.equal(value("log2(8)"), 3);
near(value("ln(e)"), 1, "natural log");
near(value("2pi"), Math.PI * 2, "implicit pi");
near(value("tau / 2"), Math.PI, "tau");
assert.equal(value("SQRT(9)"), 3);
near(value("PI"), Math.PI, "case-insensitive constant");
checks.push("functions and constants");

// One scope down the sheet, ans is the previous value, names may be Chinese.
const sheet = evaluateSheet(["x = 5", "x * 2", "ans + 1", "y = ans * 2", "y"]);
assert.deepEqual(sheet.map((outcome) => outcome.value), [5, 10, 11, 22, 22]);
assert.equal(sheet[0].display, "5");
const chinese = evaluateSheet(["单价 = 12.5", "单价 * 3"]);
assert.equal(chinese[1].value, 37.5);
assert.equal(evaluateSheet(["x = 1", "X"])[1].kind, "error");
checks.push("variables, ans and case-sensitive names");

// A failing row does not stop later rows or define its name.
const isolated = evaluateSheet(["a = 2", "1 / 0", "a + 3"]);
assert.equal(isolated[1].kind, "error");
assert.match(isolated[1].error, /不能除以零/);
assert.equal(isolated[2].value, 5);
const failedAssignment = evaluateSheet(["x = 1 / 0", "x"]);
assert.equal(failedAssignment[0].kind, "error");
assert.match(failedAssignment[1].error, /未知标识符/);
assert.match(error("ans + 1"), /还没有/);
checks.push("errors stay on their own row");

// Notes, blanks and inline comments.
const mixed = evaluateSheet(["# 本周", "", "1 + 1 # 合计", "// 下一项", "2 + 2"]);
assert.deepEqual(mixed.map((outcome) => outcome.kind), [
  "note", "blank", "value", "note", "value",
]);
assert.equal(mixed[2].source, "1 + 1");
assert.equal(mixed[2].value, 2);
checks.push("notes, blank lines and inline comments");

// Reader-facing failures.
assert.match(error("1 +"), /缺少运算数/);
assert.match(error("(1 + 2"), /缺少右括号/);
assert.match(error("1 + 2)"), /多余的右括号/);
assert.match(error("foo + 1"), /未知标识符/);
assert.match(error("foo(1)"), /未知函数/);
assert.match(error("sqrt(1, 2)"), /需要 1 个参数/);
assert.match(error("min()"), /至少需要 1 个参数/);
assert.match(error("pi = 3"), /不能赋值/);
assert.match(error("x = "), /等号右边缺少算式/);
assert.match(error("mod(10, 0)"), /不能除以零/);
assert.match(error("1 & 2"), /无法识别的字符/);
assert.match(error("1e999"), /无法表示/);
assert.match(error("10^400"), /超出可表示范围/);
assert.match(error("sqrt(-1)"), /不是一个数/);
assert.match(error("ln(0)"), /超出可表示范围/);
checks.push("reader-facing errors");

// Display groups thousands; copy stays pasteable.
const grouped = row("1234567");
assert.equal(grouped.display, "1,234,567");
assert.equal(grouped.copy, "1234567");
const negative = row("-1234.5");
assert.equal(negative.display, "-1,234.5");
assert.equal(negative.copy, "-1234.5");
assert.equal(row("0.1 + 0.2").display, "0.3");
assert.equal(row("1 / 3").display, "0.333333333333");
assert.equal(row("0 - 0").display, "0");
assert.equal(row("1e20").display, "1e20");
assert.equal(row("1.5e-7").display, "1.5e-7");
assert.equal(row("10^15").display, "1e15");
assert.equal(row("2 + 3").copy, "5");
checks.push("display grouping and copy form");

console.log(JSON.stringify(checks));
"""


class CalculatorEvaluateTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        if NODE is None or not ESBUILD.exists():
            raise unittest.SkipTest("node and esbuild are needed for the calculator test")
        cls.temp = tempfile.TemporaryDirectory()
        work = Path(cls.temp.name)
        built = subprocess.run(
            [
                str(ESBUILD),
                str(PACKAGE / "src" / "evaluate.ts"),
                "--bundle",
                "--format=esm",
                "--platform=neutral",
                "--log-level=error",
                f"--outfile={work / 'evaluate.mjs'}",
            ],
            capture_output=True,
            text=True,
        )
        if built.returncode != 0:
            raise AssertionError(f"esbuild failed: {built.stderr}")
        runner = work / "runner.mjs"
        runner.write_text(RUNNER, encoding="utf-8")
        environment = dict(os.environ)
        environment["TZ"] = "Asia/Shanghai"
        cls.result = subprocess.run(
            [str(NODE), str(runner), str(work)],
            capture_output=True,
            text=True,
            timeout=60,
            env=environment,
        )

    @classmethod
    def tearDownClass(cls) -> None:
        cls.temp.cleanup()

    def test_expression_engine(self) -> None:
        self.assertEqual(
            self.result.returncode,
            0,
            self.result.stdout + self.result.stderr,
        )
        checks = json.loads(self.result.stdout)
        self.assertGreaterEqual(len(checks), 9)
        self.assertIn("percent as a share and degree angles", checks)
        self.assertIn("variables, ans and case-sensitive names", checks)
        self.assertIn("display grouping and copy form", checks)


if __name__ == "__main__":
    unittest.main()
