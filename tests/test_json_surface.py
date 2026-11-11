r"""The JSON editor surface page (protocol v3).

Everything the page needs is inside the document: Prettier's standalone build
plus the babel and estree plugins are bundled by the same esbuild the surface
build uses, so the test can bundle `src/main.ts` into a module and run it under
Node against a minimal DOM stub. That exercises exactly what the page paints
and what it asks the host for:

- the entry arrives in the left pane, and the in-page Prettier writes its
  output to the right pane, token for token;
- both panes are syntax-coloured and both are editable: an edit on the left
  re-derives the right pane after a pause, and an edit on the right becomes its
  own document that copy and fold act on;
- both panes lint what they hold: the wrong token is squiggled, its line number
  is marked and the message sits under the pane, while a broken entry keeps the
  last good preview instead of blanking it;
- pasted URL parameters, XML and YAML are recognized and converted to JSON in
  the right pane; unrecognized or broken input lands there verbatim with an
  explanation, and the original stays as it arrived;
- minify, fold, XML and TypeScript actions write their document to the right
  pane, and copying any of them is a host request;
- folding collapses nested objects and arrays for reading while copying still
  sends the complete result, and the control stays disabled when there is
  nothing to fold;
- the escape toggle decides whether `\uXXXX` and `\/` read as characters, and
  every writer of the right pane follows that choice;
- the filter bar evaluates a small JavaScript subset against the entry,
  reports failures, and never mutates the original;
- the built page fits the host's 1 MiB surface-document ceiling (D-1091) and
  the manifest ships no runtime at all.
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PACKAGE = ROOT / "plugins" / "com.mypaste.json"
ESBUILD = ROOT / "node_modules" / ".bin" / "esbuild"
NODE = shutil.which("node")

# The host reads a surface document with its own fixed ceiling (D-1091);
# 256 KiB still bounds every plugin text that crosses the bridge.
HOST_SURFACE_BYTES = 1024 * 1024

RUNNER = r"""
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

class ElementStub {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.listeners = new Map();
    this.text = "";
    this.hidden = false;
    this.disabled = false;
    this.value = "";
    this.selectionStart = 0;
    this.selectionEnd = 0;
    this.className = "";
    this.dataset = {};
    this.attrs = {};
    this.classList = { add: () => {}, remove: () => {} };
  }
  get textContent() {
    return this.text + this.children.map((child) => child.textContent ?? "").join("");
  }
  set textContent(value) { this.text = String(value); this.children = []; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.text = ""; this.children = nodes; }
  addEventListener(type, listener) {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }
  dispatch(type, event = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
  setAttribute(name, value) { this.attrs[name] = value; }
  removeAttribute(name) { delete this.attrs[name]; }
  click() { for (const listener of this.listeners.get("click") ?? []) listener({}); }
}

const IDS = ["summary", "status", "editor", "meta", "copy-json", "doc-close",
             "format", "minify", "fold", "to-xml", "to-ts", "output",
             "output-title", "output-meta", "output-text", "copy-output",
             "filter", "filter-run", "preserve-escapes", "wrap-toggle",
             "editor-gutter", "editor-highlight", "editor-lint", "output-gutter",
             "output-input", "output-lint"];
const PAGE = path.join(process.argv[2], "page.mjs");

/** One fresh page: a surface document is delivered exactly one item. */
function boot() {
  const elements = new Map(IDS.map((id) => [id, new ElementStub("stub")]));
  const posted = [];
  const listeners = [];
  const keys = [];
  const parent = { postMessage: (message) => posted.push(message) };
  globalThis.parent = parent;
  globalThis.document = {
    documentElement: { dataset: {}, style: { setProperty() {} } },
    addEventListener(type, listener) {
      if (type === "keydown") keys.push(listener);
    },
    querySelector(selector) {
      assert.ok(selector.startsWith("#"), `unexpected selector ${selector}`);
      return elements.get(selector.slice(1)) ?? null;
    },
    createElement: (tag) => new ElementStub(tag),
    createTextNode: (text) => ({ textContent: text }),
    createDocumentFragment: () => new ElementStub("#fragment"),
  };
  globalThis.window = {
    addEventListener(type, listener) {
      if (type === "message") listeners.push(listener);
    },
  };
  globalThis.matchMedia = () => ({ matches: false });
  return {
    elements,
    posted,
    text: (id) => elements.get(id).textContent,
    value: (id) => elements.get(id).value,
    element: (id) => elements.get(id),
    /** Every class name painted inside an element, spans included. */
    classes(id) {
      const names = [];
      const walk = (node) => {
        if (typeof node.className === "string" && node.className !== "") {
          names.push(node.className);
        }
        for (const child of node.children ?? []) walk(child);
      };
      walk(elements.get(id));
      return names;
    },
    /** Whether a run of text inside the element carries the error marker. */
    marked(id) {
      return this.classes(id).some((name) => name.split(" ").includes("tok-error"));
    },
    /** Types into a pane the way a person does: value first, then `input`. */
    edit(id, text) {
      elements.get(id).value = text;
      elements.get(id).dispatch("input", {});
    },
    deliver(item) {
      for (const listener of listeners) {
        listener({ source: parent, data: { v: 1, type: "item", item } });
      }
    },
    paste(text) {
      let prevented = false;
      elements.get("editor").dispatch("paste", {
        clipboardData: { getData: () => text },
        preventDefault() { prevented = true; },
      });
      assert.equal(prevented, true, "the page owns the paste");
    },
    answer(request, payload) {
      for (const listener of listeners) {
        listener({ source: parent, data: {
          v: 1, type: "result", requestId: request.requestId, ...payload,
        } });
      }
    },
    copyRequests() {
      return posted.filter((message) => message.type === "copy");
    },
    key(name) {
      for (const listener of keys) {
        listener({ key: name, preventDefault() {} });
      }
    },
  };
}

let boots = 0;
async function open() {
  const page = boot();
  boots += 1;
  await import(`${pathToFileURL(PAGE).href}?case=${boots}`);
  assert.deepEqual(page.posted[0], { v: 1, type: "ready" });
  return page;
}

async function until(check, what) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > 20000) throw new Error(`timeout waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Waits long enough for the page's own debounced preview to have run. */
async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 400));
}

function json(value) {
  return JSON.parse(value);
}

const SOURCE = '{"name":"MyPaste","count":2,"ok":true,"items":[1,null,"x"]}';
const FORMATTED =
  '{ "name": "MyPaste", "count": 2, "ok": true, "items": [1, null, "x"] }\n';

// Delivery: the left pane keeps the entry exactly as it arrived, the in-page
// Prettier writes its output to the right, and the copy button asks the host
// instead of touching a clipboard.
{
  const page = await open();
  page.deliver({ kind: "text", title: "示例", text: SOURCE });
  await until(() => page.text("output-title") === "美化", "in-page formatting");
  assert.equal(page.text("summary"), "示例");
  assert.equal(page.element("editor").value, SOURCE, "the original is untouched");
  assert.equal(page.text("output-text"), FORMATTED);
  assert.equal(page.text("meta"),
    `1 行 · ${new TextEncoder().encode(SOURCE).length} 字节`);
  assert.equal(page.element("copy-json").disabled, false);

  page.element("copy-json").click();
  await until(() => page.copyRequests().length === 1, "copy request");
  const copyRequest = page.copyRequests()[0];
  assert.equal(copyRequest.text, SOURCE);
  page.answer(copyRequest, { ok: true });
  await until(() => page.text("status") === "已复制 JSON。", "copy confirmation");

  page.element("copy-json").click();
  await until(() => page.copyRequests().length === 2, "second copy request");
  page.answer(page.copyRequests()[1], { ok: false, message: "宿主拒绝写入" });
  await until(() => page.text("status") === "复制失败：宿主拒绝写入", "refused copy");
}

// The page owns the card (D-1097): closing is its own control in the header,
// and Escape does the same through the bridge.
{
  const page = await open();
  page.deliver({ kind: "text", title: "示例", text: SOURCE });
  await until(() => page.text("output-title") === "美化", "in-page formatting");
  page.element("doc-close").click();
  await until(() => page.posted.some((m) => m.type === "close"), "close request");
  assert.deepEqual(page.posted.filter((m) => m.type === "close"),
    [{ v: 1, type: "close" }]);
  page.key("Escape");
  await until(() => page.posted.filter((m) => m.type === "close").length === 2,
    "escape close");
}

// Escape spelling: an entry delivered in wire form keeps its bytes on the
// left, while the right pane shows its characters; the labeled toggle puts the
// \uXXXX spelling back. `\/` follows the same switch, so a PHP-style path reads
// as a path instead of a row of slashes.
{
  const page = await open();
  const escaped =
    '{"msg":"\\u4efb\\u52a1 \\u5b58\\u5728","path":"\\/work\\/demo\\/Job.php"}';
  page.deliver({ kind: "text", title: "转义", text: escaped });
  await until(() => page.text("output-title") === "美化", "escape decoding");
  assert.equal(page.element("editor").value, escaped, "the original is untouched");
  assert.equal(page.text("output-text"),
    '{ "msg": "任务 存在", "path": "/work/demo/Job.php" }\n');
  assert.equal(page.element("preserve-escapes").attrs["aria-pressed"], "false");

  page.element("preserve-escapes").click();
  assert.equal(page.element("preserve-escapes").attrs["aria-pressed"], "true");
  await until(() => page.text("output-text").includes("\\u4efb"), "preserved spelling");
  assert.equal(page.text("output-text"),
    '{ "msg": "\\u4efb\\u52a1 \\u5b58\\u5728", "path": "/work/demo/Job.php" }\n');
  assert.equal(page.element("editor").value, escaped);

  page.element("format").click();
  await until(() => page.text("status") === "已在右侧重新排版。",
    "preserved format");
  assert.equal(page.text("output-text"),
    '{ "msg": "\\u4efb\\u52a1 \\u5b58\\u5728", "path": "/work/demo/Job.php" }\n');

  page.element("minify").click();
  await until(() => page.text("output-title") === "压缩", "minified spelling");
  assert.equal(page.text("output-text"),
    '{"msg":"\\u4efb\\u52a1 \\u5b58\\u5728","path":"/work/demo/Job.php"}');
  assert.equal(page.text("status"), "已压缩为单行，写在右侧。");

  page.element("preserve-escapes").click();
  assert.equal(page.element("preserve-escapes").attrs["aria-pressed"], "false");
  await until(() => page.text("output-text") ===
    '{"msg":"任务 存在","path":"/work/demo/Job.php"}', "decoded spelling");
  assert.equal(page.element("editor").value, escaped, "the original is untouched");
}

// Broken JSON: the parse position is explained, the entry's text is kept
// verbatim on the left, and the right pane stays empty rather than inventing
// a document.
{
  const page = await open();
  const broken = '{"a": 1,\n "b": 2,\n oops}';
  page.deliver({ kind: "text", title: "坏掉的", text: broken });
  await until(() => page.text("status").startsWith("无法排版："), "parse failure");
  assert.match(page.text("status"), /^无法排版：第 \d+ 行第 \d+ 列/);
  assert.equal(page.element("editor").value, broken);
  assert.equal(page.element("output").dataset.state, "empty");
}

// An empty entry is explained, not parsed, and nothing can be copied.
{
  const page = await open();
  page.deliver({ kind: "text", title: "", text: "   \n" });
  await until(() => page.text("status").includes("条目为空"), "empty state");
  assert.equal(page.text("summary"), "当前条目");
  assert.equal(page.element("copy-json").disabled, true);
  assert.deepEqual(page.copyRequests(), []);
}

// Both panes wrap their text by default. The head's toggle flips the two
// textareas and the coloured copies together and brings wrapping back.
{
  const page = await open();
  const toggle = page.element("wrap-toggle");
  assert.equal(toggle.attrs["aria-pressed"], "true");
  assert.equal(page.element("editor").attrs.wrap, "soft");
  assert.equal(page.element("output-input").attrs.wrap, "soft");
  assert.equal(document.documentElement.dataset.wrap, "on");

  toggle.click();
  assert.equal(toggle.attrs["aria-pressed"], "false");
  assert.equal(page.element("editor").attrs.wrap, "off");
  assert.equal(page.element("output-input").attrs.wrap, "off");
  assert.equal(document.documentElement.dataset.wrap, "off");

  toggle.click();
  assert.equal(toggle.attrs["aria-pressed"], "true");
  assert.equal(page.element("editor").attrs.wrap, "soft");
  assert.equal(document.documentElement.dataset.wrap, "on");
}

// Beautify, minify, fold, XML and TypeScript all write the right pane; the
// original pane keeps the delivered text through every one of them. Copying a
// result is still a host request.
{
  const page = await open();
  page.deliver({ kind: "text", title: "示例", text: SOURCE });
  await until(() => page.text("output-title") === "美化", "in-page formatting");
  assert.equal(page.text("output-text"), FORMATTED);

  page.element("minify").click();
  await until(() => page.text("output-title") === "压缩", "minified result");
  assert.equal(page.text("output-text"), JSON.stringify(json(SOURCE)));
  assert.equal(page.text("status"), "已压缩为单行，写在右侧。");
  assert.equal(page.element("editor").value, SOURCE, "the original is untouched");

  page.element("format").click();
  await until(() => page.text("status") === "已在右侧重新排版。",
    "beautify");
  assert.equal(page.text("output-title"), "美化");
  assert.equal(page.text("output-text"), FORMATTED);

  // This document fits on one line, so there is nothing to fold and the
  // control does not pretend otherwise.
  assert.equal(page.element("fold").disabled, true, "one line has nothing to fold");

  page.element("to-xml").click();
  await until(() => page.text("output-title") === "XML", "XML result");
  assert.match(page.text("output-text"), /^<root>/);
  assert.match(page.text("output-text"), /<name>MyPaste<\/name>/);
  assert.equal(page.element("editor").value, SOURCE, "derived, not rewritten");
  assert.equal(page.element("fold").disabled, true, "XML is not JSON to fold");

  page.element("to-ts").click();
  await until(() => page.text("output-title") === "TypeScript", "TypeScript result");
  assert.match(page.text("output-text"), /^export interface Root \{/);
  assert.match(page.text("output-text"), /name: string;/);
  assert.match(page.text("output-text"), /count: number;/);
  assert.match(page.text("output-text"), /items: \(number \| null \| string\)\[\];/);
  assert.equal(page.element("editor").value, SOURCE, "derived, not rewritten");

  const derived = page.text("output-text");
  page.element("copy-output").click();
  await until(() => page.copyRequests().length === 1, "copy result request");
  assert.equal(page.copyRequests()[0].text, derived);
  page.answer(page.copyRequests()[0], { ok: true });
  await until(() => page.text("status") === "已复制 TypeScript。", "copied result");
}

// Both panes are one surface: each is coloured, each is editable, and each
// keeps its own line numbers. The right pane previews the left one, and a hand
// edit on the right makes it its own document until an action is asked again.
{
  const page = await open();
  page.deliver({ kind: "text", title: "示例", text: SOURCE });
  await until(() => page.text("output-title") === "美化", "in-page formatting");

  assert.ok(page.classes("editor-highlight").includes("tok-property"));
  assert.ok(page.classes("editor-highlight").includes("tok-string"));
  assert.ok(page.classes("output-text").includes("tok-number"));
  assert.equal(page.text("editor-highlight"), SOURCE);
  assert.equal(page.text("output-text"), FORMATTED);
  assert.equal(page.element("editor-gutter").textContent, "1");
  assert.equal(page.value("editor"), SOURCE);
  assert.equal(page.value("output-input"), FORMATTED);

  // Editing the entry previews it: after the pause the result pane shows the
  // new document, with no status line of its own.
  page.edit("editor", '{"a":1,"b":[2,3]}');
  await until(() => page.value("output-input") === '{ "a": 1, "b": [2, 3] }\n',
    "live preview of the entry");
  assert.equal(page.text("output-text"), '{ "a": 1, "b": [2, 3] }\n');
  assert.equal(page.text("status"), "已在右侧重新排版。", "a preview stays quiet");
  assert.equal(page.element("output").dataset.state, "filled");

  // The preview follows the chosen action rather than resetting to beautify.
  page.element("minify").click();
  await until(() => page.text("output-title") === "压缩", "minified result");
  page.edit("editor", '{"a":2}');
  await until(() => page.value("output-input") === '{"a":2}',
    "the minified action previews");

  page.element("format").click();
  await until(() => page.value("output-input") === '{ "a": 2 }\n',
    "the beautified action previews");

  // A hand edit on the right becomes its own document: copy and fold act on
  // it, and the entry stops previewing into it.
  const edited = '{\n  "hand": 1,\n  "text": "edited"\n}';
  page.edit("output-input", edited);
  assert.equal(page.text("output-text"), edited);
  assert.equal(page.element("output-gutter").textContent, "1\n2\n3\n4");
  assert.equal(page.element("output").dataset.state, "filled");
  assert.equal(page.element("copy-output").disabled, false);
  assert.ok(page.classes("output-text").includes("tok-property"));

  page.element("copy-output").click();
  await until(() => page.copyRequests().length === 1, "copy an edited result");
  assert.equal(page.copyRequests()[0].text, edited, "copy sends the edit");
  page.answer(page.copyRequests()[0], { ok: true });
  await until(() => page.text("status").startsWith("已复制"), "copied edit");

  // The left pane takes an edit of its own and leaves the result alone; its
  // colour follows what was typed, not what arrived.
  page.edit("editor", "[1, 2, 3]");
  assert.equal(page.element("editor-gutter").textContent, "1");
  assert.ok(page.classes("editor-highlight").includes("tok-number"));
  await settle();
  assert.equal(page.value("output-input"), edited, "the hand edit is not overwritten");

  // Emptying the right pane returns it to its empty state.
  page.edit("output-input", "");
  assert.equal(page.element("output").dataset.state, "empty");
  assert.equal(page.element("copy-output").disabled, true);
  assert.equal(page.text("output-text"), "");
}

// Lint is per pane and points at the problem: the wrong token carries the
// squiggle, the gutter marks its line, and the message stands under the pane.
// A broken entry keeps the last good preview while its own pane explains it.
{
  const page = await open();
  page.deliver({ kind: "text", title: "示例", text: SOURCE });
  await until(() => page.text("output-title") === "美化", "in-page formatting");
  const good = page.text("output-text");

  page.edit("editor", '{\n  "a": 1\n  b: 2\n}');
  assert.equal(page.element("editor-lint").hidden, false, "the strip speaks");
  assert.equal(page.text("editor-lint"),
    "第 3 行第 3 列 · 属性值后面少了逗号，读到的是「b」");
  assert.equal(page.element("editor").attrs["aria-invalid"], "true");
  assert.ok(page.marked("editor-highlight"), "the token carries the squiggle");
  assert.ok(page.classes("editor-gutter").includes("gutter-line is-error"));
  await settle();
  assert.equal(page.text("output-text"), good, "a broken entry keeps the last good preview");
  assert.equal(page.text("status"), "已在右侧重新排版。", "a preview reports nothing");

  page.edit("editor", '{\n  "a": 1,\n  "b": 2\n}');
  assert.equal(page.element("editor-lint").hidden, true, "the strip goes quiet");
  assert.equal(page.element("editor").attrs["aria-invalid"], "false");
  // Prettier keeps the source's own line breaks, so the preview is the same
  // document with its keys spaced, not a collapsed one-liner.
  await until(() => page.value("output-input") === '{\n  "a": 1,\n  "b": 2\n}\n',
    "the preview resumes");

  // The right pane lints the document it holds, in its own language.
  page.edit("output-input", '{\n  "a" 1\n}');
  assert.equal(page.element("output-lint").hidden, false);
  assert.equal(page.text("output-lint"), "第 2 行第 7 列 · 属性名后面少了冒号，读到的是「1」");
  assert.equal(page.element("output-input").attrs["aria-invalid"], "true");
  assert.ok(page.marked("output-text"), "the wrong token carries the squiggle");
  assert.ok(page.classes("output-gutter").includes("gutter-line is-error"));

  page.edit("output-input", '{"a": 1}');
  assert.equal(page.element("output-lint").hidden, true, "a sound document is quiet");
}

// The filter bar: member access, a leading-dot array filter, a syntax error
// and a dangerous key. The evaluated document lands on the right and never
// changes the original.
{
  const page = await open();
  const document = JSON.stringify({
    users: [
      { name: "Ada", age: 36 },
      { name: "Bob", age: 12 },
      { name: "Cyd", age: 24 },
    ],
  });
  page.deliver({ kind: "text", title: "用户", text: document });
  await until(() => page.text("output-title") === "美化", "in-page formatting");
  const original = page.element("editor").value;

  page.element("filter").value = "data.users[0].name";
  page.element("filter-run").click();
  await until(() => page.text("output-title") === "过滤结果", "filtered result");
  assert.equal(page.text("output-text"), "Ada");
  assert.equal(page.text("status"), "已对当前 JSON 求值，写在右侧。");

  page.element("filter").value = ".users.filter(x => x.age > 18).map(x => x.name)";
  page.element("filter").dispatch("keydown", {
    key: "Enter", preventDefault() {},
  });
  await until(() => page.text("output-text").startsWith("["), "array filter result");
  assert.deepEqual(json(page.text("output-text")), ["Ada", "Cyd"]);

  page.element("filter").value = "data.users[0].";
  page.element("filter-run").click();
  await until(() => /^过滤失败：/.test(page.text("status")), "a broken expression");

  page.element("filter").value = "data.constructor";
  page.element("filter-run").click();
  await until(() => /^过滤失败：/.test(page.text("status")), "a dangerous key");
  assert.equal(page.element("editor").value, original, "filter never mutates");
}

// Folding reads the result as an outline: nested containers become one line,
// the root keeps its shape, and the copy request still carries the whole
// document rather than the folded view.
{
  const page = await open();
  const document = JSON.stringify({
    users: [
      { name: "Ada", age: 36 },
      { name: "Bob", age: 12 },
      { name: "Cyd", age: 24 },
    ],
    note: "x".repeat(90),
  });
  page.deliver({ kind: "text", title: "折叠", text: document });
  await until(() => page.text("output-title") === "美化", "in-page formatting");
  const full = page.text("output-text");
  assert.ok(full.includes('"users": ['), "the array spans several lines");
  assert.equal(page.element("fold").disabled, false);

  page.element("fold").click();
  assert.equal(page.element("fold").attrs["aria-pressed"], "true");
  assert.equal(page.element("fold").attrs["aria-label"], "展开全部");
  const folded = page.text("output-text");
  assert.ok(folded.includes('"users": [ … ]'), folded);
  assert.ok(!folded.includes("Ada"), "folded rows are hidden");
  assert.equal(page.text("status"), "已折叠 1 处嵌套结构；复制仍是完整 JSON。");
  assert.equal(page.element("output-lint").hidden, true,
    "the folded view is a rendering, not a document to lint");

  page.element("copy-output").click();
  await until(() => page.copyRequests().length === 1, "copy folded result");
  assert.equal(page.copyRequests()[0].text, full,
    "copy sends the complete result, not the folded view");

  page.element("fold").click();
  assert.equal(page.element("fold").attrs["aria-pressed"], "false");
  assert.equal(page.element("fold").attrs["aria-label"], "折叠全部");
  assert.equal(page.text("output-text"), full);
  assert.equal(page.text("status"), "已展开全部结构。");
}

// Paste recognition: URL parameters, XML and YAML become JSON on the right,
// and a document the page cannot convert lands there verbatim with the reason.
// The original pane is never written.
{
  const page = await open();
  const original = page.element("editor").value;

  page.paste("name=MyPaste&count=2&tag=a&tag=b");
  await until(() => page.text("output-title") === "粘贴 · URL 参数", "URL params");
  assert.equal(page.text("status"),
    "已把粘贴的 URL 参数 转为 JSON，写在右侧。");
  assert.deepEqual(json(page.text("output-text")), {
    name: "MyPaste", count: "2", tag: ["a", "b"],
  });
  assert.equal(page.element("editor").value, original);

  page.paste("<root><name>MyPaste</name><count>2</count></root>");
  await until(() => page.text("output-title") === "粘贴 · XML", "XML");
  assert.equal(page.text("status"),
    "已把粘贴的 XML 转为 JSON，写在右侧。");
  assert.deepEqual(json(page.text("output-text")), {
    root: { name: "MyPaste", count: "2" },
  });

  page.paste("name: MyPaste\ncount: 2\nitems:\n  - alpha\n  - beta\n");
  await until(() => page.text("output-title") === "粘贴 · YAML", "YAML");
  assert.equal(page.text("status"),
    "已把粘贴的 YAML 转为 JSON，写在右侧。");
  assert.deepEqual(json(page.text("output-text")), {
    name: "MyPaste", count: 2, items: ["alpha", "beta"],
  });

  page.paste("<root><a></root>");
  await until(() => page.text("status").startsWith("识别为 XML，但转换失败："),
    "failed conversion");
  assert.match(page.text("status"), /粘贴内容原样放在右侧。$/);
  assert.equal(page.text("output-title"), "粘贴内容");
  assert.equal(page.text("output-text"), "<root><a></root>");

  page.paste("just some words");
  await until(() => page.text("status").startsWith("不是可识别的"), "unrecognized");
  assert.match(page.text("status"), /粘贴内容原样放在右侧。$/);
  assert.equal(page.text("output-title"), "粘贴内容");
  assert.equal(page.text("output-text"), "just some words");
  assert.equal(page.element("editor").value, original, "paste never writes the original");
}

console.log("json surface page: ok");
"""


@unittest.skipUnless(NODE and ESBUILD.is_file(), "node and esbuild are required")
class JSONSurfacePageTest(unittest.TestCase):
    def test_page_formats_converts_and_filters_in_the_document(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            page = Path(directory) / "page.mjs"
            subprocess.run(
                [str(ESBUILD), str(PACKAGE / "src" / "main.ts"),
                 "--bundle", "--format=esm",
                 "--loader:.html=text", f"--outfile={page}"],
                check=True, capture_output=True, text=True,
            )
            runner = Path(directory) / "runner.mjs"
            runner.write_text(RUNNER, encoding="utf-8")
            done = subprocess.run(
                [NODE, str(runner), directory],
                capture_output=True, text=True, timeout=300,
            )
            self.assertEqual(done.returncode, 0, done.stderr)
            self.assertIn("json surface page: ok", done.stdout)

    def test_built_page_fits_the_surface_ceiling(self) -> None:
        subprocess.run(
            [NODE, "scripts/build-surfaces.mjs", "--package", "com.mypaste.json"],
            cwd=ROOT, check=True, capture_output=True, text=True,
        )
        page = PACKAGE / "preview.html"
        size = page.stat().st_size
        self.assertLessEqual(size, HOST_SURFACE_BYTES)
        text = page.read_text(encoding="utf-8")
        self.assertNotIn("<!--bundle-->", text)
        # The page is self-contained: no external script, no network load.
        self.assertNotIn("<script src", text)
        self.assertIn('id="editor"', text)
        self.assertIn('id="filter"', text)
        self.assertIn('data-scheme="dark"', text)
        # Both panes are the same surface: a coloured copy under an editable
        # textarea, with a gutter of their own.
        for element in ('id="editor-highlight"', 'id="output-text"',
                        'id="output-input"', 'id="output-gutter"'):
            self.assertIn(element, text)
        # Each pane reports its own problems where they are.
        for element in ('id="editor-lint"', 'id="output-lint"',
                        'aria-describedby="editor-lint"',
                        'aria-describedby="output-lint"'):
            self.assertIn(element, text)
        self.assertNotIn("readonly aria-label", text)
        # The fold glyph answers the next click; TypeScript is spelled out
        # rather than drawn as two braces.
        self.assertIn('class="fold-in"', text)
        self.assertIn('class="fold-out"', text)
        self.assertIn("M2.6 4.2h4.6", text)
        self.assertNotIn("M6.4 2.8c-1.3", text)
        # Corners come from one ladder (host D-1099): a token from the page's
        # own set, or 50% where roundness is the shape's meaning. A literal
        # pixel radius is not allowed.
        radii = re.findall(r"border-radius:\s*([^;}]+)", text)
        allowed = {
            "0", "50%", "var(--radius-xs)", "var(--radius-sm)",
            "var(--radius-md)", "var(--radius-lg)", "var(--radius-pill)",
        }
        self.assertTrue(all(value.strip() in allowed for value in radii), radii)
        for token in ("--radius-xs: 4px", "--radius-sm: 6px",
                      "--radius-md: 10px", "--radius-lg: 14px",
                      "--radius-pill: 999px"):
            self.assertIn(token, text)
        self.assertIn("Prettier 内置于页面", text)

    def test_manifest_declares_no_runtime(self) -> None:
        manifest = json.loads(
            (PACKAGE / "mypaste.plugin.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["manifestVersion"], 3)
        self.assertEqual(manifest["version"], "3.5.1")
        self.assertEqual(manifest["capabilities"], ["entity.read"])
        self.assertNotIn("runtime", manifest)
        self.assertNotIn("commands", manifest)
        self.assertEqual(manifest["surface"]["entry"], "preview.html")
        self.assertEqual(manifest["surface"]["forms"], ["text"])
        self.assertEqual(manifest["surface"]["role"], "open")
        # The runtime and engine sources of 2.0.0 are gone, not just unused.
        self.assertFalse((PACKAGE / "src" / "cmd").exists())
        self.assertFalse((PACKAGE / "src" / "engines").exists())


if __name__ == "__main__":
    unittest.main()
