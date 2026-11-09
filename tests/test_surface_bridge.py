"""The code-edit surface bridge (protocol v3).

The page runs in a browser sandbox, but its bridge is plain TypeScript with one
dependency on the host's message channel. This test bundles the bridge with the
same esbuild the surface build uses, runs it under Node with a minimal
window/parent stub, and drives the exact messages the host exchanges: `ready`,
the item, the theme, save/copy/close, and the registry's `list("text")` plus
`invoke()`. The refusal rule comes from the package's own bridge module, so the
1 MiB / UTF-8 / NUL sentence is the one the page really uses.
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
const applied = {};
const parent = { postMessage: (message) => posted.push(message) };
globalThis.document = {
  documentElement: {
    dataset: {},
    style: { setProperty: (name, value) => { applied[name] = value; } },
  },
};
globalThis.parent = parent;
globalThis.window = {
  addEventListener(type, listener) {
    if (type === "message") listeners.push(listener);
  },
};
globalThis.matchMedia = () => ({ matches: false });

const { connectSurface, textRefusal } = await import(pathToFileURL(path.join(dir, "bridge.mjs")));

function emit(data) {
  for (const listener of listeners) listener({ source: parent, data });
}
const last = () => posted.at(-1);
const checks = [];

const bridge = connectSurface();
assert.deepEqual(posted[0], { v: 1, type: "ready" });
checks.push("ready carries no v2 feature or action declaration");

let received = null;
bridge.onItem((item) => { received = item; });
emit({ v: 1, type: "item", item: { kind: "text", title: "main.go", text: "package main" } });
assert.equal(received.title, "main.go");
assert.equal(bridge.item.text, "package main");
checks.push("the text item reaches onItem and the bridge");

emit({ v: 1, type: "item", item: { kind: "image", title: "x", mime: "image/png", dataURL: "data:" } });
assert.equal(received.title, "main.go");
checks.push("a second or non-text item is dropped");

emit({ v: 1, type: "theme", scheme: "dark", tokens: { ink: "#fff", "bad name": "x" } });
assert.equal(document.documentElement.dataset.scheme, "dark");
assert.equal(applied["--mp-ink"], "#fff");
assert.equal(applied["--mp-bad name"], undefined);
checks.push("the theme sets the scheme and only valid token names");

const saving = bridge.save("package main", "main.go");
assert.deepEqual(last(), {
  v: 1, type: "save", requestId: 1, text: "package main", title: "main.go",
});
emit({ v: 1, type: "result", requestId: 1, ok: true, id: 3 });
const saved = await saving;
assert.equal(saved.ok, true);
assert.equal(saved.id, 3);
checks.push("save keeps its host result path");

const copying = bridge.copy("package main");
assert.deepEqual(last(), { v: 1, type: "copy", requestId: 2, text: "package main" });
emit({ v: 1, type: "result", requestId: 2, ok: false, message: "复制失败" });
assert.equal((await copying).message, "复制失败");
checks.push("copy keeps its host result path");

bridge.close();
assert.deepEqual(last(), { v: 1, type: "close" });
checks.push("close is one message with no request id");

const listing = bridge.list(["text"]);
assert.deepEqual(last(), { v: 1, type: "registry", requestId: 3, forms: ["text"] });
emit({
  v: 1, type: "result", requestId: 3, ok: true,
  commands: [
    { pluginId: "mypaste.format-json", commandId: "format", title: "格式化 JSON", output: ["text"] },
    { pluginId: "", commandId: "format", title: "no plugin" },
    { pluginId: "mypaste.highlight-json", commandId: "highlight", title: "高亮 JSON", outputDeclared: false },
    { pluginId: "mypaste.code-card", commandId: "clipboard.code-card", title: "导出代码卡片", placement: ["card-action"] },
  ],
});
const commands = await listing;
assert.equal(commands.length, 3);
assert.equal(commands[0].pluginId, "mypaste.format-json");
assert.deepEqual(commands[0].output, ["text"]);
assert.equal(commands[1].outputDeclared, false);
assert.equal(commands[2].placement.length, 1);
checks.push("registry.list returns the commands and drops malformed entries");

const failing = bridge.list(["text"]);
emit({ v: 1, type: "result", requestId: 4, ok: false, message: "registry unavailable" });
let refusal = "";
try { await failing; } catch (error) { refusal = error.message; }
assert.equal(refusal, "registry unavailable");
checks.push("a refused registry read is an error, not an empty list");

const running = bridge.invoke(commands[0], "{\"a\":1}");
assert.deepEqual(last(), {
  v: 1, type: "invoke", requestId: 5,
  pluginId: "mypaste.format-json", commandId: "format", text: "{\"a\":1}",
});
emit({ v: 1, type: "result", requestId: 5, ok: true, output: "{\n  \"a\": 1\n}" });
const formatted = await running;
assert.equal(formatted.output, "{\n  \"a\": 1\n}");
assert.deepEqual(formatted.diagnostics, []);
checks.push("a format command returns its output text");

const checking = bridge.invoke(commands[1], "select from");
assert.equal(last().commandId, "highlight");
emit({
  v: 1, type: "result", requestId: 6, ok: false, message: "format-failed",
  render: { diagnostics: [{ line: 1, column: 7, message: "unexpected token" }] },
});
const checked = await checking;
assert.equal(checked.ok, false);
assert.deepEqual(checked.diagnostics, [{ line: 1, column: 7, message: "unexpected token" }]);
checks.push("diagnostics survive a render result");

const highlighting = bridge.invoke(commands[1], "select 1");
emit({
  v: 1, type: "result", requestId: 7, ok: true,
  render: { tokens: [
    { text: "select", kind: "keyword" },
    { text: " ", kind: "" },
    { text: "1", kind: "number" },
  ] },
});
const highlighted = await highlighting;
assert.deepEqual(highlighted.tokens, [
  { text: "select", kind: "keyword" },
  { text: " ", kind: "" },
  { text: "1", kind: "number" },
]);
checks.push("a highlight command's render tokens reach the page");

const malformedTokens = bridge.invoke(commands[1], "select 1");
emit({
  v: 1, type: "result", requestId: 8, ok: true,
  render: { tokens: [{ text: "select", kind: "keyword" }, { text: 1, kind: "number" }] },
});
assert.equal((await malformedTokens).tokens, undefined);
checks.push("a malformed token list is dropped whole, not partially painted");

assert.equal(textRefusal("a\u0000b"), "内容包含无法处理的字符");
assert.equal(textRefusal("plain"), "");
checks.push("a control character is refused before the page applies it");

console.log(JSON.stringify(checks));
"""


class SurfaceBridgeTest(unittest.TestCase):
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

    def test_v3_surface_messages(self) -> None:
        if self.result.returncode != 0:
            self.fail(
                "bridge runner failed:\n"
                f"stdout:\n{self.result.stdout}\nstderr:\n{self.result.stderr}"
            )
        checks = json.loads(self.result.stdout.strip().splitlines()[-1])
        self.assertEqual(checks, [
            "ready carries no v2 feature or action declaration",
            "the text item reaches onItem and the bridge",
            "a second or non-text item is dropped",
            "the theme sets the scheme and only valid token names",
            "save keeps its host result path",
            "copy keeps its host result path",
            "close is one message with no request id",
            "registry.list returns the commands and drops malformed entries",
            "a refused registry read is an error, not an empty list",
            "a format command returns its output text",
            "diagnostics survive a render result",
            "a highlight command's render tokens reach the page",
            "a malformed token list is dropped whole, not partially painted",
            "a control character is refused before the page applies it",
        ])


if __name__ == "__main__":
    unittest.main()
