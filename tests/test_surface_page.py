"""The code-edit page's action menu and highlight picker (protocol v3, D-1069).

The page is bundled with the same esbuild the surface build uses and runs under
Node against a minimal DOM stub. The host's messages are driven by hand, so the
test sees exactly what the page sends and paints:

- the registry fills the action menu from text-output capabilities and the
  highlight picker from token capabilities, never a placed command;
- capability actions come in document/selection pairs, and the selection pair
  is disabled (not hidden) until the buffer has a selection;
- a successful document action replaces the buffer exactly once, a successful
  selection action slices the buffer, invokes the capability on that slice and
  splices the answer back with the new range selected;
- a failure leaves the buffer untouched and reports the host's reason and the
  diagnostic position;
- the local keyword-case action works without a package and leaves strings
  alone;
- a highlight capability's tokens paint the overlay, and a failed call falls
  back to the page's own tokenizer with a status-line explanation.
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
    this.attributes = {};
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
      listener({ type, target: this, preventDefault() {}, ...event });
    }
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  contains(node) {
    if (node === this) return true;
    return this.children.some((child) => child.contains?.(node) ?? false);
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
  "#doc-actions-root": new ElementStub("div"),
  "#doc-actions": new ElementStub("button"),
  "#doc-action-menu": new ElementStub("div"),
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
const actionsButton = elements["#doc-actions"];
const actionMenu = elements["#doc-action-menu"];
const actionsRoot = elements["#doc-actions-root"];
const highlightSelect = elements["#doc-highlight"];
const status = elements["#doc-status"];
const overlay = elements["#editor-highlight"];

const posted = [];
const listeners = [];
const documentListeners = new Map();
const edits = [];
globalThis.document = {
  documentElement: { dataset: {}, style: { setProperty() {} } },
  querySelector: (selector) => elements[selector] ?? null,
  createElement: (tag) => new ElementStub(tag),
  addEventListener(type, listener) {
    const list = documentListeners.get(type) ?? [];
    list.push(listener);
    documentListeners.set(type, list);
  },
  dispatch(type, event = {}) {
    for (const listener of documentListeners.get(type) ?? []) {
      listener({ type, preventDefault() {}, ...event });
    }
  },
  execCommand(name, _ui, text) {
    if (name !== "insertText") return false;
    const start = input.selectionStart;
    const end = input.selectionEnd;
    edits.push({ text, start, end });
    input.value = input.value.slice(0, start) + text + input.value.slice(end);
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
const menuButtons = () => actionMenu.children.flatMap(
  (section) => section.children.filter((child) => child.tagName === "button"),
);
const menuButton = (label) => menuButtons().find((button) => button.textContent === label);
const groupTitles = () => actionMenu.children.map((section) => section.children[0]?.textContent);
const showMenu = () => { if (actionMenu.hidden) actionsButton.dispatch("click"); };
const hideMenu = () => { if (!actionMenu.hidden) actionsButton.dispatch("click"); };
const clickAction = (label) => {
  showMenu();
  const button = menuButton(label);
  assert.ok(button, `菜单缺少动作「${label}」`);
  button.dispatch("click");
};
const checks = [];

await import(pathToFileURL(path.join(process.argv[2], "page.mjs")));
assert.deepEqual(posted[0], { v: 1, type: "ready" });

// The page asks for text capabilities on startup. The answer mixes both
// capability shapes, a placed command the page must ignore, and declaredness
// on a host that exposes it.
const registry = posted.find((message) => message.type === "registry");
assert.deepEqual(registry.forms, ["text"]);
emit({
  v: 1, type: "result", requestId: registry.requestId, ok: true,
  commands: [
    { pluginId: "mypaste.format-json", commandId: "format", title: "格式化 JSON", output: ["text"] },
    { pluginId: "mypaste.highlight-json", commandId: "highlight", title: "高亮 JSON" },
    { pluginId: "com.mypaste.sql", commandId: "format", title: "格式化 SQL", output: ["text"] },
    { pluginId: "com.mypaste.sql", commandId: "compress", title: "压缩 SQL", output: ["text"] },
    { pluginId: "com.mypaste.sql", commandId: "highlight", title: "高亮 SQL" },
    { pluginId: "com.mypaste.code-card", commandId: "clipboard.code-card", title: "导出代码卡片", placement: ["card-action"] },
    { pluginId: "mypaste.format-yaml", commandId: "format", title: "格式化 YAML", output: ["text"], outputDeclared: true },
    { pluginId: "mypaste.highlight-yaml", commandId: "highlight", title: "高亮 YAML", output: ["text"], outputDeclared: false },
    { pluginId: "mypaste.export-x", commandId: "export", title: "导出", output: ["text"] },
  ],
});
await tick();
assert.deepEqual(groupTitles(), ["格式化", "压缩", "大小写", "其它"]);
assert.deepEqual(menuButtons().map((button) => button.textContent), [
  "格式化 JSON", "格式化 JSON（选区）",
  "格式化 SQL", "格式化 SQL（选区）",
  "格式化 YAML", "格式化 YAML（选区）",
  "压缩 SQL", "压缩 SQL（选区）",
  "切换关键字大小写",
  "导出", "导出（选区）",
]);
assert.deepEqual(optionLabels(highlightSelect), ["内置", "高亮 JSON", "高亮 SQL", "高亮 YAML"]);
assert.equal(highlightSelect.hidden, false);
assert.equal(menuButtons().some((button) => button.textContent === "导出代码卡片"), false);
checks.push("the registry fills grouped action pairs and the highlight picker, not placed commands");

emit({ v: 1, type: "item", item: { kind: "text", title: "main.sql", text: "SELECT id, name FROM t" } });
assert.equal(input.value, "SELECT id, name FROM t");
assert.equal(actionsButton.disabled, false);
showMenu();
assert.equal(actionMenu.hidden, false);
assert.equal(actionsButton.getAttribute("aria-expanded"), "true");
assert.equal(menuButton("格式化 SQL").disabled, false);
assert.equal(menuButton("格式化 SQL（选区）").disabled, true);
checks.push("the item enables the menu and a selection action stays visible but disabled");

// Keyword casing is a local action: no invoke, one replacement, strings kept.
hideMenu();
input.value = "select 'from' from t";
input.setSelectionRange(0, 0);
clickAction("切换关键字大小写");
await tick();
assert.equal(input.value, "SELECT 'from' FROM t");
assert.equal(edits.length, 1);
assert.equal(edits[0].text, "SELECT 'from' FROM t");
assert.equal(status.textContent, "已切换关键字大小写");
checks.push("the local keyword-case action rewrites keywords once and leaves the string alone");

// A document action invokes the whole buffer and applies one replacement.
input.value = "SELECT id FROM t";
input.setSelectionRange(0, 0);
clickAction("格式化 SQL");
assert.equal(last().type, "invoke");
assert.equal(last().pluginId, "com.mypaste.sql");
assert.equal(last().commandId, "format");
assert.equal(last().text, "SELECT id FROM t");
emit({ v: 1, type: "result", requestId: last().requestId, ok: true, output: "SELECT\n  id\nFROM t" });
await tick();
assert.equal(input.value, "SELECT\n  id\nFROM t");
assert.equal(edits.length, 2);
assert.equal(status.textContent, "已应用「格式化 SQL」");
assert.equal(status.dataset.tone, "info");
checks.push("a document action replaces the buffer once");

// A selection action slices the buffer, invokes the same capability on that
// slice, and splices the answer back with the new range selected.
input.value = "SELECT id, name FROM t";
input.setSelectionRange(7, 15);
clickAction("格式化 SQL（选区）");
assert.equal(last().type, "invoke");
assert.equal(last().commandId, "format");
assert.equal(last().text, "id, name");
emit({ v: 1, type: "result", requestId: last().requestId, ok: true, output: "id,\n  name" });
await tick();
assert.equal(input.value, "SELECT id,\n  name FROM t");
assert.equal(edits.at(-1).start, 7);
assert.equal(edits.at(-1).end, 15);
assert.equal(input.selectionStart, 7);
assert.equal(input.selectionEnd, 7 + "id,\n  name".length);
assert.equal(status.textContent, "已对选区应用「格式化 SQL」");
checks.push("a selection action invokes on the slice and splices the result back");

// A failed selection action reports the host's diagnostic and changes nothing.
const before = input.value;
clickAction("压缩 SQL（选区）");
assert.equal(last().commandId, "compress");
emit({
  v: 1, type: "result", requestId: last().requestId, ok: false,
  render: { diagnostics: [{ line: 1, column: 3, message: "unexpected token" }] },
});
await tick();
assert.equal(input.value, before);
assert.match(status.textContent, /第 1 行第 3 列/);
assert.equal(status.dataset.tone, "error");
checks.push("a failed selection action leaves the buffer alone and shows the reason");

// Collapsing the selection disables the selection actions again.
input.setSelectionRange(0, 0);
document.dispatch("selectionchange");
showMenu();
assert.equal(menuButton("压缩 SQL（选区）").disabled, true);
assert.equal(menuButton("压缩 SQL").disabled, false);
checks.push("collapsing the selection disables selection actions without hiding them");

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

    def test_page_actions(self) -> None:
        if self.result.returncode != 0:
            self.fail(
                "page runner failed:\n"
                f"stdout:\n{self.result.stdout}\nstderr:\n{self.result.stderr}"
            )
        checks = json.loads(self.result.stdout.strip().splitlines()[-1])
        self.assertEqual(checks, [
            "the registry fills grouped action pairs and the highlight picker, not placed commands",
            "the item enables the menu and a selection action stays visible but disabled",
            "the local keyword-case action rewrites keywords once and leaves the string alone",
            "a document action replaces the buffer once",
            "a selection action invokes on the slice and splices the result back",
            "a failed selection action leaves the buffer alone and shows the reason",
            "collapsing the selection disables selection actions without hiding them",
            "a highlight capability paints its tokens",
            "a failed highlight falls back to the built-in tokenizer",
        ])


if __name__ == "__main__":
    unittest.main()
