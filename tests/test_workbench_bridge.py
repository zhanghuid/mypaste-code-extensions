"""The code-edit document's buffer exchange (host D-1065).

The document runs in a browser sandbox, but its bridge is plain TypeScript with
one dependency on the host's message channel. This test bundles the bridge with
the same esbuild the workbench build uses, runs it under Node with a minimal
window/parent stub, and drives the exact messages the host sends: `ready` with
the buffer feature, `buffer-request`, and `replace` at a current and a stale
revision. The refusal rule comes from the package's own bridge module, so the
revision-mismatch sentence is the one the document really uses.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PACKAGE = ROOT / "plugins" / "com.mypaste.code-edit"
ESBUILD = ROOT / "node_modules" / ".bin" / "esbuild"
NODE = shutil.which("node")

RUNNER = r"""
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const dir = process.argv[2];
const posted = [];
const listeners = [];
const parent = { postMessage: (message) => posted.push(message) };
globalThis.document = { documentElement: { dataset: {} } };
globalThis.parent = parent;
globalThis.window = {
  addEventListener(type, listener) {
    if (type === "message") listeners.push(listener);
  },
};
globalThis.matchMedia = () => ({ matches: false });

const { connectWorkbench, replaceRefusal } = await import(pathToFileURL(path.join(dir, "bridge.mjs")));

function emit(data) {
  for (const listener of listeners) listener({ source: parent, data });
}
const last = () => posted.at(-1);
const checks = [];

const bridge = connectWorkbench();
assert.deepEqual(posted[0], { v: 1, type: "ready", features: ["buffer"] });
checks.push("ready advertises the buffer feature");

const state = { text: "package main", revision: 0 };
bridge.onBufferRequest(() => ({ text: state.text, revision: state.revision }));
bridge.onReplace((text, expected) => {
  const refusal = replaceRefusal(state.revision, expected);
  if (refusal !== "") return { ok: false, message: refusal };
  state.text = text;
  state.revision += 1;
  return { ok: true };
});

emit({ v: 1, type: "buffer-request", requestId: 5 });
assert.deepEqual(last(), {
  v: 1, type: "buffer", requestId: 5, text: "package main", revision: 0,
});
checks.push("buffer-request is answered with the buffer and its revision");

emit({ v: 1, type: "replace", requestId: 6, text: "package  main\n", revision: 0 });
assert.deepEqual(last(), { v: 1, type: "result", requestId: 6, ok: true });
assert.equal(state.text, "package  main\n");
assert.equal(state.revision, 1);
checks.push("a replace at the current revision applies");

emit({ v: 1, type: "replace", requestId: 7, text: "stale", revision: 0 });
assert.deepEqual(last(), {
  v: 1, type: "result", requestId: 7, ok: false, message: "内容已变化，未替换",
});
assert.equal(state.text, "package  main\n");
assert.equal(state.revision, 1);
checks.push("a replace at a stale revision changes nothing");

emit({ v: 1, type: "replace", requestId: 8, text: "a\u0000b", revision: 1 });
assert.deepEqual(last(), {
  v: 1, type: "result", requestId: 8, ok: false, message: "内容包含无法处理的字符",
});
assert.equal(state.text, "package  main\n");
checks.push("a control character is refused before the buffer sees it");

const before = posted.length;
emit({ v: 1, type: "replace", requestId: 9, text: "x", revision: 1, extra: true });
assert.equal(posted.length, before);
checks.push("a replace with an extra key is dropped");

const saving = bridge.save("package main", "main.go");
assert.deepEqual(last(), {
  v: 1, type: "save", requestId: 1, text: "package main", title: "main.go",
});
emit({ v: 1, type: "result", requestId: 1, ok: true, id: 3 });
const saved = await saving;
assert.equal(saved.ok, true);
assert.equal(saved.id, 3);
checks.push("save keeps its host result path");

console.log(JSON.stringify(checks));
"""


class WorkbenchBridgeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        if NODE is None or not ESBUILD.exists():
            raise unittest.SkipTest("node and esbuild are needed for the bridge test")
        cls.temp = tempfile.TemporaryDirectory()
        work = Path(cls.temp.name)
        built = subprocess.run(
            [
                str(ESBUILD),
                str(PACKAGE / "src" / "bridge.ts"),
                "--bundle",
                "--format=esm",
                "--platform=neutral",
                "--log-level=error",
                f"--outfile={work / 'bridge.mjs'}",
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

    def test_buffer_and_replace_messages(self) -> None:
        if self.result.returncode != 0:
            self.fail(
                "bridge runner failed:\n"
                f"stdout:\n{self.result.stdout}\nstderr:\n{self.result.stderr}"
            )
        checks = json.loads(self.result.stdout.strip().splitlines()[-1])
        self.assertEqual(checks, [
            "ready advertises the buffer feature",
            "buffer-request is answered with the buffer and its revision",
            "a replace at the current revision applies",
            "a replace at a stale revision changes nothing",
            "a control character is refused before the buffer sees it",
            "a replace with an extra key is dropped",
            "save keeps its host result path",
        ])


if __name__ == "__main__":
    unittest.main()
