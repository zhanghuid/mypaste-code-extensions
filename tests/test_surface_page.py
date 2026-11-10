"""The code-edit page's two dropdowns (protocol v3, D-1069).

The page is bundled with the same esbuild the surface build uses and runs under
Node against a minimal DOM stub. The host's messages are driven by hand, so the
test sees exactly what the page sends and paints:

- the registry fills the format dropdown from text-output capabilities, never a
  placed command and never a token (highlight) command;
- the built-in operations come from this package's own runtime, work with an
  empty registry, and win over an external capability of the same name;
- capability actions come in document/selection pairs, and the selection pair
  is disabled (not hidden) until the buffer has a selection;
- a successful document action replaces the buffer exactly once, a successful
  selection action slices the buffer, invokes the capability on that slice and
  splices the answer back with the new range selected;
- a failure leaves the buffer untouched and reports the host's reason and the
  diagnostic position;
- the local keyword-case action works without a package and leaves strings
  alone;
- the language and format lists are two dropdowns behind their own toggles,
  groups are set off by a hairline (never a title), and the page's own
  tokenizer always paints the overlay.
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
    this.className = "";
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
  focus() { globalThis.document.activeElement = this; }
  getBoundingClientRect() {
    return { top: 10, right: 900, bottom: 40, left: 780, width: 120, height: 30 };
  }
  get textContent() { return this._text; }
  set textContent(value) { this._text = String(value); this._html = ""; }
  get innerHTML() { return this._html; }
  set innerHTML(value) { this._html = String(value); this._text = ""; }
}

// The dropdowns carry the `hidden` attribute in the markup, which the stub does
// not parse; model it here so a toggle click opens a closed menu.
const languageMenuStub = new ElementStub("div");
languageMenuStub.hidden = true;
const formatMenuStub = new ElementStub("div");
formatMenuStub.hidden = true;
const elements = {
  "#doc-title": new ElementStub("input"),
  "#doc-language-badge": new ElementStub("span"),
  "#doc-language-root": new ElementStub("div"),
  "#doc-language-toggle": new ElementStub("button"),
  "#doc-language-menu": languageMenuStub,
  "#doc-format-root": new ElementStub("div"),
  "#doc-format-toggle": new ElementStub("button"),
  "#doc-format-menu": formatMenuStub,
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
const languageToggle = elements["#doc-language-toggle"];
const languageMenu = elements["#doc-language-menu"];
const formatToggle = elements["#doc-format-toggle"];
const formatMenu = elements["#doc-format-menu"];
const status = elements["#doc-status"];

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
  innerWidth: 1120,
  innerHeight: 840,
  addEventListener(type, listener) {
    if (type === "message") listeners.push(listener);
  },
};
globalThis.matchMedia = () => ({ matches: false });

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const EMPTY = process.env.EMPTY_REGISTRY === "1";
const emit = (data) => {
  for (const listener of listeners) listener({ source: parent, data });
};
const last = () => posted.at(-1);
const menuButtons = () =>
  formatMenu.children.filter((child) => child.tagName === "button");
const menuButton = (label) => menuButtons().find((button) => button.textContent === label);
const separators = () =>
  formatMenu.children.filter((child) => child.className === "menu-separator");
const showFormat = () => { if (formatMenu.hidden) formatToggle.dispatch("click"); };
const hideFormat = () => { if (!formatMenu.hidden) formatToggle.dispatch("click"); };
const showLanguage = () => { if (languageMenu.hidden) languageToggle.dispatch("click"); };
const languageItem = (value) =>
  languageMenu.children.find((button) => button.dataset.value === value);
const chooseLanguage = (value) => {
  showLanguage();
  const button = languageItem(value);
  assert.ok(button, `语言菜单缺少「${value}」`);
  button.dispatch("click");
};
const clickAction = (label) => {
  showFormat();
  const button = menuButton(label);
  assert.ok(button, `格式化菜单缺少动作「${label}」`);
  button.dispatch("click");
};
const checks = [];

await import(pathToFileURL(path.join(process.argv[2], "page.mjs")));
assert.deepEqual(posted[0], { v: 1, type: "ready" });

// The page asks for text capabilities on startup. The answer mixes both
// capability shapes, a placed command the page must ignore, and declaredness
// on a host that exposes it. A highlight (token) command must never become a
// format row: highlighting is the page's own tokenizer, not a capability.
const registry = posted.find((message) => message.type === "registry");
assert.deepEqual(registry.forms, ["text"]);
emit({
  v: 1, type: "result", requestId: registry.requestId, ok: true,
  commands: EMPTY ? [
    // Both are the host's placed card actions. An older host sent them over
    // the surface channel too; the page must never turn them into rows.
    { pluginId: "com.mypaste.code-card", commandId: "clipboard.code-card", title: "导出代码卡片", placement: ["card-action"] },
    { pluginId: "com.mypaste.code-edit", commandId: "clipboard.code-edit", title: "编辑代码", placement: ["card-action"] },
  ] : [
    { pluginId: "mypaste.format-json", commandId: "format", title: "格式化 JSON", output: ["text"] },
    { pluginId: "mypaste.highlight-json", commandId: "highlight", title: "高亮 JSON" },
    { pluginId: "com.mypaste.sql", commandId: "format", title: "格式化 SQL", output: ["text"] },
    { pluginId: "com.mypaste.sql", commandId: "compress", title: "压缩 SQL", output: ["text"] },
    { pluginId: "com.mypaste.sql", commandId: "highlight", title: "高亮 SQL" },
    // A 0.26 host answers its own surface with this package's internal
    // commands too; the page must treat them as built-ins, never as external.
    { pluginId: "com.mypaste.code-edit", commandId: "format.sql", title: "格式化 SQL", output: ["text"], outputDeclared: true },
    { pluginId: "com.mypaste.code-edit", commandId: "compress.sql", title: "压缩 SQL", output: ["text"], outputDeclared: true },
    { pluginId: "com.mypaste.code-card", commandId: "clipboard.code-card", title: "导出代码卡片", placement: ["card-action"] },
    { pluginId: "mypaste.format-yaml", commandId: "format", title: "格式化 YAML", output: ["text"], outputDeclared: true },
    { pluginId: "mypaste.highlight-yaml", commandId: "highlight", title: "高亮 YAML", output: ["text"], outputDeclared: false },
    { pluginId: "mypaste.export-x", commandId: "export", title: "导出", output: ["text"] },
  ],
});
await tick();

// With no capability package installed the built-ins still fill the dropdown:
// the editor owns formatting now. The language dropdown stays complete, and a
// placed command is never a row.
if (EMPTY) {
  emit({ v: 1, type: "item", item: { kind: "text", title: "main.sql", text: "SELECT id, name FROM t" } });
  showFormat();
  assert.equal(formatMenu.hidden, false);
  assert.equal(formatMenu.children[0].className, "menu-item format-item");
  assert.equal(separators().length, 2);
  assert.deepEqual(menuButtons().map((button) => button.textContent), [
    "格式化文档", "格式化选区",
    "压缩文档", "压缩选区",
    "切换关键字大小写",
  ]);
  assert.equal(menuButtons().some((button) => button.textContent.includes("未安装")), false);
  assert.equal(menuButtons().some((button) => button.textContent.includes("导出")), false);
  assert.ok(languageMenu.children.length >= 14);
  assert.equal(languageItem("auto").className, "menu-item language-item is-active");
  clickAction("格式化文档");
  assert.equal(last().type, "invoke");
  assert.equal(last().pluginId, "com.mypaste.code-edit");
  assert.equal(last().commandId, "format.sql");
  assert.equal(last().text, "SELECT id, name FROM t");
  checks.push("built-in formatting fills the list with no capability package and invokes this package's runtime");
  console.log(JSON.stringify(checks));
  process.exit(0);
}

emit({ v: 1, type: "item", item: { kind: "text", title: "main.sql", text: "SELECT id, name FROM t" } });
assert.equal(input.value, "SELECT id, name FROM t");
assert.equal(formatToggle.disabled, false);
showFormat();
assert.equal(formatMenu.hidden, false);
assert.equal(formatToggle.getAttribute("aria-expanded"), "true");
assert.ok(formatMenu.style.top.endsWith("px"), "菜单使用视口坐标定位");
assert.ok(formatMenu.style.left.endsWith("px"), "菜单使用视口坐标定位");
assert.equal(separators().length, 3);
assert.deepEqual(menuButtons().map((button) => button.textContent), [
  "格式化文档", "格式化选区",
  "格式化 JSON（外部：mypaste.format-json）", "格式化 JSON（选区）（外部：mypaste.format-json）",
  "格式化 YAML（外部：mypaste.format-yaml）", "格式化 YAML（选区）（外部：mypaste.format-yaml）",
  "压缩文档", "压缩选区",
  "导出（外部：mypaste.export-x）", "导出（选区）（外部：mypaste.export-x）",
  "切换关键字大小写",
]);
// A highlight (token) command never becomes a format row, and a placed command
// never becomes a row: highlighting is the page's own tokenizer now.
assert.equal(menuButtons().some((button) => button.textContent.includes("高亮")), false);
assert.equal(menuButtons().some((button) => button.textContent === "导出代码卡片"), false);
checks.push("the registry fills ordered action pairs and never a token or placed command");

// The current language's built-in wins over every external capability of the
// same name: the concrete "格式化 SQL" never appears as a row or a source, and
// the built-in document action is enabled while its selection pair is disabled
// until the buffer has a selection.
assert.equal(menuButtons().filter((button) => button.textContent === "格式化文档").length, 1);
assert.equal(
  menuButtons().some((button) => button.textContent.includes("格式化 SQL")),
  false,
);
assert.equal(menuButton("格式化文档").disabled, false);
assert.equal(menuButton("格式化选区").disabled, true);
checks.push("an external format package never repeats the language the built-ins own");

// Picking a language in its dropdown rebuilds the built-ins and re-runs the
// dedupe. The trigger already names the language, so the menu items stay
// language-agnostic while the concrete source moves between external rows.
chooseLanguage("json");
showFormat();
assert.equal(menuButton("格式化文档").disabled, false);
assert.equal(menuButton("格式化 JSON（外部：mypaste.format-json）"), undefined);
assert.ok(menuButtons().some((button) => button.textContent.includes("格式化 SQL（外部：com.mypaste.sql）")));
chooseLanguage("auto");
hideFormat();
checks.push("picking a language moves the built-in operation and keeps external sources distinct");

// Keyword casing is a local action: no invoke, one replacement, strings kept.
hideFormat();
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
clickAction("格式化文档");
assert.equal(last().type, "invoke");
assert.equal(last().pluginId, "com.mypaste.code-edit");
assert.equal(last().commandId, "format.sql");
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
clickAction("格式化选区");
assert.equal(last().type, "invoke");
assert.equal(last().pluginId, "com.mypaste.code-edit");
assert.equal(last().commandId, "format.sql");
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
clickAction("压缩选区");
assert.equal(last().pluginId, "com.mypaste.code-edit");
assert.equal(last().commandId, "compress.sql");
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
showFormat();
assert.equal(menuButton("压缩选区").disabled, true);
assert.equal(menuButton("压缩文档").disabled, false);
checks.push("collapsing the selection disables selection actions without hiding them");

// Opening the dropdown puts focus on the first enabled row; the arrow keys
// walk enabled rows only, in visual order, and wrap at either end. The
// built-in row comes before the external ones.
assert.equal(document.activeElement, menuButton("格式化文档"));
formatMenu.dispatch("keydown", { key: "ArrowDown" });
assert.equal(document.activeElement, menuButton("格式化 JSON（外部：mypaste.format-json）"));
formatMenu.dispatch("keydown", { key: "ArrowUp" });
assert.equal(document.activeElement, menuButton("格式化文档"));

// A disabled row is never activatable, even by a synthetic click.
const disabledButton = menuButton("格式化选区");
assert.equal(disabledButton.disabled, true);
const editsBeforeDisabled = edits.length;
disabledButton.dispatch("click");
await tick();
assert.equal(edits.length, editsBeforeDisabled);
checks.push("keyboard focus walks enabled rows and a disabled row cannot run");

// Esc belongs to the page: the first press closes the dropdown only, the second
// asks the host to close the surface.
showFormat();
const postedBeforeEscape = posted.length;
document.dispatch("keydown", { key: "Escape" });
assert.equal(formatMenu.hidden, true);
assert.equal(posted.length, postedBeforeEscape);
document.dispatch("keydown", { key: "Escape" });
assert.deepEqual(last(), { v: 1, type: "close" });
checks.push("Escape closes the dropdown first and the surface second");

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
        cls.runner = runner
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
            "the registry fills ordered action pairs and never a token or placed command",
            "an external format package never repeats the language the built-ins own",
            "picking a language moves the built-in operation and keeps external sources distinct",
            "the local keyword-case action rewrites keywords once and leaves the string alone",
            "a document action replaces the buffer once",
            "a selection action invokes on the slice and splices the result back",
            "a failed selection action leaves the buffer alone and shows the reason",
            "collapsing the selection disables selection actions without hiding them",
            "keyboard focus walks enabled rows and a disabled row cannot run",
            "Escape closes the dropdown first and the surface second",
        ])

    def test_empty_capability_registry(self) -> None:
        env = {**os.environ, "EMPTY_REGISTRY": "1"}
        result = subprocess.run(
            [str(NODE), str(self.runner), str(self.runner.parent)],
            capture_output=True,
            text=True,
            timeout=30,
            env=env,
        )
        if result.returncode != 0:
            self.fail(
                "empty-registry runner failed:\n"
                f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}"
            )
        checks = json.loads(result.stdout.strip().splitlines()[-1])
        self.assertEqual(checks, [
            "built-in formatting fills the list with no capability package and invokes this package's runtime",
        ])


if __name__ == "__main__":
    unittest.main()
