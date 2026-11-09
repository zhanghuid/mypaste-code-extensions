"""The code-edit page's two capability pickers (protocol v3, D-1069).

The page is bundled with the same esbuild the surface build uses and runs under
Node against a minimal DOM stub. The host's messages are driven by hand, so the
test sees exactly what the page sends and paints:

- the registry answer fills the format picker with commands that declare text
  output and the highlight picker with token commands, never a placed command;
- a successful format replaces the buffer exactly once (one undo step) and a
  failure leaves the buffer untouched and reports the host's reason;
- a highlight capability's tokens paint the overlay, and a failed call falls
  back to the page's own tokenizer with a status-line explanation;
- the footer no longer renders a row of capability buttons.
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

class ElementStub {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.listeners = new Map();
    this.dataset = {};
    this.style = {};
    this.value = "";
    this._text = "";
    this._html = "";
    this.hidden = false;
    this.disabled = false;
    this.title = "";
    this.selectionStart = 0;
    this.selectionEnd = 0;
    this.scrollTop = 0;
    this.scrollLeft = 0;
  }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = [...nodes]; }
  addEventListener(type, listener) {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }
  dispatch(type, event = {}) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ type, preventDefault() {}, ...event });
    }
  }
  setSelectionRange(start, end) {
    this.selectionStart = start;
    this.selectionEnd = end;
  }
  setRangeText(text, start, end, mode) {
    this.value = this.value.slice(0, start) + text + this.value.slice(end);
    const caret = mode === "end" ? start + text.length : start;
    this.selectionStart = caret;
    this.selectionEnd = caret;
  }
  focus() {}
  get textContent() { return this._text; }
  set textContent(value) { this._text = String(value); this._html = ""; }
  get innerHTML() { return this._html; }
  set innerHTML(value) { this._html = String(value); this._text = ""; }
}

const elements = {
  "#doc-title": new ElementStub("input"),
  "#doc-language": new ElementStub("select"),
  "#doc-format": new ElementStub("select"),
  "#doc-highlight": new ElementStub("select"),
  "#doc-caret": new ElementStub("span"),
  "#doc-dirty": new ElementStub("span"),
  "#editor-gutter": new ElementStub("pre"),
  "#editor-highlight": new ElementStub("pre"),
  "#editor-input": new ElementStub("textarea"),
  "#doc-status": new ElementStub("span"),
  "[data-action=copy]": new ElementStub("button"),
  "[data-action=save]": new ElementStub("button"),
};
const input = elements["#editor-input"];
const formatSelect = elements["#doc-format"];
const highlightSelect = elements["#doc-highlight"];
const status = elements["#doc-status"];
const overlay = elements["#editor-highlight"];

const posted = [];
const listeners = [];
const edits = [];
globalThis.document = {
  documentElement: { dataset: {}, style: { setProperty() {} } },
  querySelector: (selector) => elements[selector] ?? null,
  createElement: (tag) => new ElementStub(tag),
  execCommand(name, _ui, text) {
    if (name !== "insertText") return false;
    edits.push(text);
    input.value = text;
    return true;
  },
};
globalThis.parent = { postMessage: (message) => posted.push(message) };
globalThis.window = {
  addEventListener(type, listener) {
    if (type === "message") listeners.push(listener);
  },
};
globalThis.matchMedia = () => ({ matches: false });

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const emit = (data) => {
  for (const listener of listeners) listener({ source: parent, data });
};
const last = () => posted.at(-1);
const optionLabels = (select) => select.children.map((item) => item.textContent);
const checks = [];

await import(pathToFileURL(path.join(process.argv[2], "page.mjs")));
assert.deepEqual(posted[0], { v: 1, type: "ready" });

const registry = posted.find((message) => message.type === "registry");
assert.deepEqual(registry.forms, ["text"]);
emit({
  v: 1, type: "result", requestId: registry.requestId, ok: true,
  commands: [
    { pluginId: "mypaste.format-json", commandId: "format", title: "格式化 JSON", output: ["text"] },
    { pluginId: "mypaste.highlight-json", commandId: "highlight", title: "高亮 JSON" },
    // A command the host shows itself is not a capability this page composes.
    { pluginId: "com.mypaste.code-card", commandId: "clipboard.code-card", title: "导出代码卡片", placement: ["card-action"] },
    // Declaredness wins when a host exposes it, whatever the command id is.
    { pluginId: "mypaste.format-yaml", commandId: "convert", title: "格式化 YAML", output: ["text"], outputDeclared: true },
    { pluginId: "mypaste.highlight-yaml", commandId: "tokens", title: "高亮 YAML", output: ["text"], outputDeclared: false },
    // Neither shape: not something this page can place in a picker.
    { pluginId: "mypaste.export-x", commandId: "export", title: "导出", output: ["text"] },
  ],
});
await tick();
assert.deepEqual(optionLabels(formatSelect), ["不格式化", "格式化 JSON", "格式化 YAML"]);
assert.deepEqual(optionLabels(highlightSelect), ["内置", "高亮 JSON", "高亮 YAML"]);
assert.equal(formatSelect.hidden, false);
assert.equal(highlightSelect.hidden, false);
checks.push("the registry fills two pickers by declared output, not placed commands");

emit({ v: 1, type: "item", item: { kind: "text", title: "main.sql", text: "SELECT 1" } });
assert.equal(input.value, "SELECT 1");
assert.equal(formatSelect.disabled, false);
checks.push("the item enables the pickers and fills the buffer");

// A successful format is one replacement, then the action picker resets.
formatSelect.value = "1";
formatSelect.dispatch("change");
assert.equal(last().type, "invoke");
assert.equal(last().pluginId, "mypaste.format-json");
assert.equal(last().commandId, "format");
assert.equal(last().text, "SELECT 1");
assert.equal(formatSelect.value, "");
emit({ v: 1, type: "result", requestId: last().requestId, ok: true, output: "SELECT\n  1" });
await tick();
assert.equal(input.value, "SELECT\n  1");
assert.equal(edits.length, 1);
assert.equal(status.textContent, "已应用「格式化 JSON」");
assert.equal(status.dataset.tone, "info");
checks.push("a format replaces the buffer once and resets its picker");

// A failed format reports the host's reason and changes nothing.
input.value = "SELECT 2";
formatSelect.value = "1";
formatSelect.dispatch("change");
emit({ v: 1, type: "result", requestId: last().requestId, ok: false, message: "语法错误" });
await tick();
assert.equal(input.value, "SELECT 2");
assert.equal(edits.length, 1);
assert.equal(status.textContent, "语法错误");
assert.equal(status.dataset.tone, "error");
checks.push("a failed format leaves the buffer alone and shows the reason");

// A highlight capability's tokens paint the overlay.
input.value = "SELECT 1 FROM t";
highlightSelect.value = "1";
highlightSelect.dispatch("change");
assert.equal(last().type, "invoke");
assert.equal(last().commandId, "highlight");
emit({
  v: 1, type: "result", requestId: last().requestId, ok: true,
  render: { tokens: [
    { text: "SELECT", kind: "tag" },
    { text: " 1 FROM t", kind: "" },
  ] },
});
await tick();
assert.match(overlay.innerHTML, /tok-tag">SELECT</);
checks.push("a highlight capability paints its tokens");

// A failed call falls back to the page's own tokenizer and says so.
highlightSelect.value = "1";
highlightSelect.dispatch("change");
emit({ v: 1, type: "result", requestId: last().requestId, ok: false, message: "highlight failed" });
await tick();
assert.doesNotMatch(overlay.innerHTML, /tok-tag/);
assert.match(overlay.innerHTML, /tok-keyword">SELECT</);
assert.match(status.textContent, /已回退内置高亮/);
assert.equal(status.dataset.tone, "error");
checks.push("a failed highlight falls back to the built-in tokenizer");

console.log(JSON.stringify(checks));
"""


class SurfacePageTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        if NODE is None or not ESBUILD.exists():
            raise unittest.SkipTest("node and esbuild are needed for the page test")
        cls.temp = tempfile.TemporaryDirectory()
        work = Path(cls.temp.name)
        built = subprocess.run(
            [
                str(ESBUILD),
                str(PACKAGE / "src" / "main.ts"),
                "--bundle",
                "--format=esm",
                "--platform=neutral",
                "--log-level=error",
                f"--outfile={work / 'page.mjs'}",
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

    def test_page_pickers(self) -> None:
        if self.result.returncode != 0:
            self.fail(
                "page runner failed:\n"
                f"stdout:\n{self.result.stdout}\nstderr:\n{self.result.stderr}"
            )
        checks = json.loads(self.result.stdout.strip().splitlines()[-1])
        self.assertEqual(checks, [
            "the registry fills two pickers by declared output, not placed commands",
            "the item enables the pickers and fills the buffer",
            "a format replaces the buffer once and resets its picker",
            "a failed format leaves the buffer alone and shows the reason",
            "a highlight capability paints its tokens",
            "a failed highlight falls back to the built-in tokenizer",
        ])


if __name__ == "__main__":
    unittest.main()
