"""The JSON page's folded view (`src/fold.ts`).

Folding is a reading aid, not a rewrite: the page collapses nested objects and
arrays into `{ … }` / `[ … ]` for display, while the result itself and the
text handed to the host stay complete. That only holds if the scanner is
string-aware — a brace or bracket inside a string must never move the depth,
and an escaped quote must not end the string — and if nothing is re-serialised,
so duplicate keys and the source's spelling survive. The page disables the
control when there is nothing to fold rather than offering an action that does
nothing.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "plugins" / "com.mypaste.json" / "src" / "fold.ts"
ESBUILD = ROOT / "node_modules" / ".bin" / "esbuild"
NODE = shutil.which("node")

RUNNER = r"""
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const dir = process.argv[2];
const { foldJson } = await import(pathToFileURL(path.join(dir, "fold.mjs")));
const checks = [];

const document = `{
  "name": "demo",
  "tags": [
    "a",
    "b"
  ],
  "meta": {
    "ok": true,
    "note": "brace } and bracket ] stay text"
  },
  "count": 2
}
`;
assert.deepEqual(foldJson(document), {
  text: `{
  "name": "demo",
  "tags": [ … ],
  "meta": { … },
  "count": 2
}
`,
  count: 2,
});
checks.push("nested objects and arrays become one marker line each");

const strings = `{
  "quote": "say \\"}\\" out loud",
  "braces": "{ [ } ]",
  "deep": {
    "value": 1
  }
}
`;
assert.equal(foldJson(strings).text, `{
  "quote": "say \\"}\\" out loud",
  "braces": "{ [ } ]",
  "deep": { … }
}
`);
checks.push("brackets and escaped quotes inside strings never move the depth");

const arrayRoot = `[
  {
    "a": 1
  },
  [
    1,
    2
  ]
]
`;
assert.deepEqual(foldJson(arrayRoot), {
  text: `[
  { … },
  [ … ]
]
`,
  count: 2,
});
checks.push("a root array keeps its shape and folds every element");

const duplicate = `{
  "a": {
    "x": 1
  },
  "a": {
    "x": 2
  }
}
`;
assert.equal(foldJson(duplicate).text, `{
  "a": { … },
  "a": { … }
}
`);
checks.push("duplicate keys survive because no value is re-serialised");

const escaped = `{
  "msg": "\\u4efb\\u52a1",
  "nested": {
    "v": 1
  }
}
`;
assert.equal(foldJson(escaped).text, `{
  "msg": "\\u4efb\\u52a1",
  "nested": { … }
}
`);
checks.push("the preserved escape spelling is untouched");

assert.equal(foldJson('{"a":{"b":1}}'), null);
checks.push("a single line has nothing to fold");

assert.equal(foldJson(`{
  "a": 1,
  "b": 2
}
`), null);
checks.push("a flat document has nothing to fold");

assert.equal(foldJson(`{
  "a": { "b": 1 },
  "c": [1, 2]
}
`), null);
checks.push("containers already on one line are left alone");

assert.equal(foldJson('{"a": }'), null);
checks.push("invalid JSON is not offered as foldable");

assert.equal(foldJson(""), null);
checks.push("an empty result is not offered as foldable");

console.log(JSON.stringify(checks));
"""


class JsonFoldTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        if NODE is None or not ESBUILD.exists():
            raise unittest.SkipTest("node and esbuild are needed for the fold test")
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
                f"--outfile={work / 'fold.mjs'}",
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

    def test_folded_view(self) -> None:
        if self.result.returncode != 0:
            self.fail(
                "fold runner failed:\n"
                f"stdout:\n{self.result.stdout}\nstderr:\n{self.result.stderr}"
            )
        checks = json.loads(self.result.stdout.strip().splitlines()[-1])
        self.assertEqual(checks, [
            "nested objects and arrays become one marker line each",
            "brackets and escaped quotes inside strings never move the depth",
            "a root array keeps its shape and folds every element",
            "duplicate keys survive because no value is re-serialised",
            "the preserved escape spelling is untouched",
            "a single line has nothing to fold",
            "a flat document has nothing to fold",
            "containers already on one line are left alone",
            "invalid JSON is not offered as foldable",
            "an empty result is not offered as foldable",
        ])


if __name__ == "__main__":
    unittest.main()
