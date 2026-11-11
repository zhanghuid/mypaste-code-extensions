r"""The JSON editor surface page (protocol v3).

Everything the page needs is inside the document: Prettier's standalone build
plus the babel and estree plugins are bundled by the same esbuild the surface
build uses, so the test can bundle `src/main.ts` into a module and run it under
Node against a minimal DOM stub. That exercises exactly what the page paints
and what it asks the host for:

- the entry arrives untouched in the left, read-only pane, and the in-page
  Prettier writes its output to the right pane, token for token;
- pasted URL parameters, XML and YAML are recognized and converted to JSON in
  the right pane; unrecognized or broken input lands there verbatim with an
  explanation, and the original stays as it arrived;
- minify, fold, XML and TypeScript actions derive their document without
  touching the original pane, and copying any of them is a host request;
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
  click() { for (const listener of this.listeners.get("click") ?? []) listener({}); }
}

const IDS = ["summary", "status", "editor", "meta", "copy-json", "doc-close",
             "format", "minify", "fold", "to-xml", "to-ts", "output",
             "output-title", "output-meta", "output-text", "copy-output",
             "filter", "filter-run", "preserve-escapes", "editor-gutter"];
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
    element: (id) => elements.get(id),
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
  await until(() => page.text("status") === "已在右侧排版；左侧原文未改动。",
    "preserved format");
  assert.equal(page.text("output-text"),
    '{ "msg": "\\u4efb\\u52a1 \\u5b58\\u5728", "path": "/work/demo/Job.php" }\n');

  page.element("minify").click();
  assert.equal(page.text("output-title"), "压缩");
  assert.equal(page.text("output-text"),
    '{"msg":"\\u4efb\\u52a1 \\u5b58\\u5728","path":"/work/demo/Job.php"}');
  assert.equal(page.text("status"), "已压缩为单行，写在右侧；左侧原文未改动。");

  page.element("preserve-escapes").click();
  assert.equal(page.element("preserve-escapes").attrs["aria-pressed"], "false");
  assert.equal(page.text("output-text"),
    '{"msg":"任务 存在","path":"/work/demo/Job.php"}');
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

// Beautify, minify, fold, XML and TypeScript all write the right pane; the
// original pane keeps the delivered text through every one of them. Copying a
// result is still a host request.
{
  const page = await open();
  page.deliver({ kind: "text", title: "示例", text: SOURCE });
  await until(() => page.text("output-title") === "美化", "in-page formatting");
  assert.equal(page.text("output-text"), FORMATTED);

  page.element("minify").click();
  assert.equal(page.text("output-title"), "压缩");
  assert.equal(page.text("output-text"), JSON.stringify(json(SOURCE)));
  assert.equal(page.text("status"), "已压缩为单行，写在右侧；左侧原文未改动。");
  assert.equal(page.element("editor").value, SOURCE, "the original is untouched");

  page.element("format").click();
  await until(() => page.text("status") === "已在右侧排版；左侧原文未改动。",
    "beautify");
  assert.equal(page.text("output-title"), "美化");
  assert.equal(page.text("output-text"), FORMATTED);

  // This document fits on one line, so there is nothing to fold and the
  // control does not pretend otherwise.
  assert.equal(page.element("fold").disabled, true, "one line has nothing to fold");

  page.element("to-xml").click();
  assert.equal(page.text("output-title"), "XML");
  assert.match(page.text("output-text"), /^<root>/);
  assert.match(page.text("output-text"), /<name>MyPaste<\/name>/);
  assert.equal(page.element("editor").value, SOURCE, "derived, not rewritten");
  assert.equal(page.element("fold").disabled, true, "XML is not JSON to fold");

  page.element("to-ts").click();
  assert.equal(page.text("output-title"), "TypeScript");
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
  assert.equal(page.text("output-title"), "过滤结果");
  assert.equal(page.text("output-text"), "Ada");
  assert.equal(page.text("status"), "已对当前 JSON 求值，写在右侧；左侧原文未改动。");

  page.element("filter").value = ".users.filter(x => x.age > 18).map(x => x.name)";
  page.element("filter").dispatch("keydown", {
    key: "Enter", preventDefault() {},
  });
  assert.deepEqual(json(page.text("output-text")), ["Ada", "Cyd"]);

  page.element("filter").value = "data.users[0].";
  page.element("filter-run").click();
  assert.match(page.text("status"), /^过滤失败：/);

  page.element("filter").value = "data.constructor";
  page.element("filter-run").click();
  assert.match(page.text("status"), /^过滤失败：/);
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
    "已把粘贴的 URL 参数 转为 JSON，写在右侧；左侧原文未改动。");
  assert.deepEqual(json(page.text("output-text")), {
    name: "MyPaste", count: "2", tag: ["a", "b"],
  });
  assert.equal(page.element("editor").value, original);

  page.paste("<root><name>MyPaste</name><count>2</count></root>");
  await until(() => page.text("output-title") === "粘贴 · XML", "XML");
  assert.equal(page.text("status"),
    "已把粘贴的 XML 转为 JSON，写在右侧；左侧原文未改动。");
  assert.deepEqual(json(page.text("output-text")), {
    root: { name: "MyPaste", count: "2" },
  });

  page.paste("name: MyPaste\ncount: 2\nitems:\n  - alpha\n  - beta\n");
  await until(() => page.text("output-title") === "粘贴 · YAML", "YAML");
  assert.equal(page.text("status"),
    "已把粘贴的 YAML 转为 JSON，写在右侧；左侧原文未改动。");
  assert.deepEqual(json(page.text("output-text")), {
    name: "MyPaste", count: 2, items: ["alpha", "beta"],
  });

  page.paste("<root><a></root>");
  await until(() => page.text("status").startsWith("识别为 XML，但转换失败："),
    "failed conversion");
  assert.match(page.text("status"), /粘贴内容原样放在右侧，左侧原文未改动。$/);
  assert.equal(page.text("output-title"), "粘贴内容");
  assert.equal(page.text("output-text"), "<root><a></root>");

  page.paste("just some words");
  await until(() => page.text("status").startsWith("不是可识别的"), "unrecognized");
  assert.match(page.text("status"), /粘贴内容原样放在右侧，左侧原文未改动。$/);
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
        self.assertEqual(manifest["version"], "3.4.0")
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
