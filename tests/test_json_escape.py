"""The JSON page's escape shaping (`src/escape.ts`).

Prettier's JSON printer keeps the escapes the source spelled, so `\\u4efb` and
`\\/` survived formatting and the page showed wire text where the reader wanted
characters. The page now decodes around Prettier, and keeps the wire spelling
when asked. The rules that matter are the ones a naive replace would break: an
escaped backslash is text, not the start of an escape, and a code point that
must stay escaped (quote, backslash, control character, lone surrogate) is
never decoded, because decoding it would produce invalid JSON or invalid UTF-8.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "plugins" / "com.mypaste.json" / "src" / "escape.ts"
ESBUILD = ROOT / "node_modules" / ".bin" / "esbuild"
NODE = shutil.which("node")

RUNNER = r"""
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const dir = process.argv[2];
const { decodeEscapes, escapeNonAscii } = await import(pathToFileURL(path.join(dir, "escape.mjs")));
const checks = [];

assert.equal(
  decodeEscapes('{"msg":"\\u4efb\\u52a1 \\u5b58\\u5728","path":"\\/work\\/demo\\/Job.php"}'),
  '{"msg":"任务 存在","path":"/work/demo/Job.php"}',
);
checks.push("readable characters and slashes come back");

assert.equal(decodeEscapes('"\\\\u4efb"'), '"\\\\u4efb"');
checks.push("an escaped backslash keeps its spelling");

for (const escape of ["\\u0022", "\\u005c", "\\u000a"]) {
  assert.equal(decodeEscapes(`"${escape}"`), `"${escape}"`);
}
checks.push("quote, backslash and control escapes stay escaped");

assert.equal(decodeEscapes('"\\ud83d"'), '"\\ud83d"');
checks.push("a lone high surrogate stays escaped");

assert.equal(decodeEscapes('"\\ud83d\\ude00"'), '"😀"');
checks.push("a surrogate pair becomes one character");

assert.equal(decodeEscapes('"\\q\\u12"'), '"\\q\\u12"');
checks.push("malformed escapes are left alone");

assert.equal(escapeNonAscii('任务 😀 ok'), '\\u4efb\\u52a1 \\ud83d\\ude00 ok');
checks.push("non-ASCII is spelled as \\uXXXX, astral characters as a pair");

assert.equal(decodeEscapes(escapeNonAscii("任务 😀 ok")), "任务 😀 ok");
checks.push("the two directions invert each other");

console.log(JSON.stringify(checks));
"""


class JsonEscapeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        if NODE is None or not ESBUILD.exists():
            raise unittest.SkipTest("node and esbuild are needed for the escape test")
        cls.temp = tempfile.TemporaryDirectory()
        work = Path(cls.temp.name)
        built = subprocess.run(
            [
                str(ESBUILD),
                str(SOURCE),
                "--bundle",
                "--format=esm",
                "--platform=neutral",
                "--log-level=error",
                f"--outfile={work / 'escape.mjs'}",
            ],
            capture_output=True,
            text=True,
        )
        if built.returncode != 0:
            raise AssertionError(f"esbuild failed: {built.stderr}")
        runner = work / "runner.mjs"
        runner.write_text(RUNNER, encoding="utf-8")
        cls.result = subprocess.run(
            [str(NODE), str(runner), str(work)],
            capture_output=True,
            text=True,
            timeout=30,
        )

    @classmethod
    def tearDownClass(cls) -> None:
        if hasattr(cls, "temp"):
            cls.temp.cleanup()

    def test_escape_shaping(self) -> None:
        if self.result.returncode != 0:
            self.fail(
                "escape runner failed:\n"
                f"stdout:\n{self.result.stdout}\nstderr:\n{self.result.stderr}"
            )
        checks = json.loads(self.result.stdout.strip().splitlines()[-1])
        self.assertEqual(checks, [
            "readable characters and slashes come back",
            "an escaped backslash keeps its spelling",
            "quote, backslash and control escapes stay escaped",
            "a lone high surrogate stays escaped",
            "a surrogate pair becomes one character",
            "malformed escapes are left alone",
            "non-ASCII is spelled as \\uXXXX, astral characters as a pair",
            "the two directions invert each other",
        ])


if __name__ == "__main__":
    unittest.main()
