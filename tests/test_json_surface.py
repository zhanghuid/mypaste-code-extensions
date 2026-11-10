"""The JSON editor surface page (protocol v3).

Everything the page needs is inside the document: Prettier's standalone build
plus the babel and estree plugins are bundled by the same esbuild the surface
build uses, so the test can bundle `src/main.ts` into a module and run it under
Node against a minimal DOM stub. That exercises exactly what the page paints
and what it asks the host for:

- an entry is formatted by the in-page Prettier, the editor stays editable,
  and the result is Prettier's own output, token for token;
- pasted URL parameters, XML and YAML are recognized and converted to JSON,
  unrecognized or broken input is inserted verbatim with an explanation;
- minify, escape, XML and TypeScript actions derive their document without
  touching the editor, and copying any of them is a host request;
- the filter bar evaluates a small JavaScript subset against the current JSON,
  reports failures, and never mutates or copies over the original;
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

const IDS = ["summary", "status", "editor", "meta", "copy-json", "format",
             "minify", "escape", "to-xml", "to-ts", "output", "output-title",
             "output-meta", "output-text", "copy-output", "filter",
             "filter-run", "doc-format-root", "doc-format-toggle",
             "doc-format-menu", "editor-gutter"];
const PAGE = path.join(process.argv[2], "page.mjs");

/** One fresh page: a surface document is delivered exactly one item. */
function boot() {
  const elements = new Map(IDS.map((id) => [id, new ElementStub("stub")]));
  const posted = [];
  const listeners = [];
  const parent = { postMessage: (message) => posted.push(message) };
  globalThis.parent = parent;
  globalThis.document = {
    documentElement: { dataset: {}, style: { setProperty() {} } },
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

// Delivery: Prettier runs inside the page, the editor holds its output, and
// the copy button asks the host instead of touching a clipboard.
{
  const page = await open();
  page.deliver({ kind: "text", title: "示例", text: SOURCE });
  await until(() => page.text("status") === "", "in-page formatting");
  assert.equal(page.text("summary"), "示例");
  assert.equal(page.element("editor").value, FORMATTED);
  assert.equal(page.text("meta"),
    `1 行 · ${new TextEncoder().encode(FORMATTED).length} 字节`);
  assert.equal(page.element("copy-json").disabled, false);

  page.element("copy-json").click();
  await until(() => page.copyRequests().length === 1, "copy request");
  const copyRequest = page.copyRequests()[0];
  assert.equal(copyRequest.text, FORMATTED);
  page.answer(copyRequest, { ok: true });
  await until(() => page.text("status") === "已复制 JSON。", "copy confirmation");

  page.element("copy-json").click();
  await until(() => page.copyRequests().length === 2, "second copy request");
  page.answer(page.copyRequests()[1], { ok: false, message: "宿主拒绝写入" });
  await until(() => page.text("status") === "复制失败：宿主拒绝写入", "refused copy");
}

// Broken JSON: the parse position is explained, the entry's text is kept
// verbatim so the user can still edit it, and nothing is invented.
{
  const page = await open();
  const broken = '{"a": 1,\n "b": 2,\n oops}';
  page.deliver({ kind: "text", title: "坏掉的", text: broken });
  await until(() => page.text("status").startsWith("无法排版："), "parse failure");
  assert.match(page.text("status"), /^无法排版：第 \d+ 行第 \d+ 列/);
  assert.equal(page.element("editor").value, broken);
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

// The four derived actions and the beautify action: minify rewrites the
// editor, format restores Prettier's layout, and escape, XML and TypeScript
// write only the result panel. Copying the result is still a host request.
{
  const page = await open();
  page.deliver({ kind: "text", title: "示例", text: SOURCE });
  await until(() => page.text("status") === "", "in-page formatting");

  page.element("minify").click();
  assert.equal(page.element("editor").value, JSON.stringify(json(SOURCE)));
  assert.equal(page.text("status"), "已压缩为单行 JSON。");
  assert.equal(page.element("output").hidden, true);

  page.element("format").click();
  await until(() => page.text("status") === "已按 Prettier 排版。", "beautify");
  assert.equal(page.element("editor").value, FORMATTED);

  page.element("escape").click();
  assert.equal(page.element("output").hidden, false);
  assert.equal(page.text("output-title"), "转义结果");
  assert.equal(page.text("output-text"), JSON.stringify(FORMATTED));
  assert.equal(page.element("editor").value, FORMATTED, "derived, not rewritten");

  page.element("to-xml").click();
  assert.equal(page.text("output-title"), "XML");
  assert.match(page.text("output-text"), /^<root>/);
  assert.match(page.text("output-text"), /<name>MyPaste<\/name>/);
  assert.equal(page.element("editor").value, FORMATTED, "derived, not rewritten");

  page.element("to-ts").click();
  assert.equal(page.text("output-title"), "TypeScript");
  assert.match(page.text("output-text"), /^export interface Root \{/);
  assert.match(page.text("output-text"), /name: string;/);
  assert.match(page.text("output-text"), /count: number;/);
  assert.match(page.text("output-text"), /items: \(number \| null \| string\)\[\];/);
  assert.equal(page.element("editor").value, FORMATTED, "derived, not rewritten");

  const derived = page.text("output-text");
  page.element("copy-output").click();
  await until(() => page.copyRequests().length === 1, "copy result request");
  assert.equal(page.copyRequests()[0].text, derived);
  page.answer(page.copyRequests()[0], { ok: true });
  await until(() => page.text("status") === "已复制 TypeScript。", "copied result");
}

// The filter bar: member access, a leading-dot array filter, a syntax error
// and a dangerous key. The evaluated document never changes the editor.
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
  await until(() => page.text("status") === "", "in-page formatting");
  const original = page.element("editor").value;

  page.element("filter").value = "data.users[0].name";
  page.element("filter-run").click();
  assert.equal(page.text("output-title"), "过滤结果");
  assert.equal(page.text("output-text"), "Ada");
  assert.equal(page.text("status"), "已对当前 JSON 求值；原数据未改动。");

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

// Paste recognition: URL parameters, XML and YAML become formatted JSON; a
// document the page cannot convert is inserted verbatim with the reason.
{
  const page = await open();

  page.paste("name=MyPaste&count=2&tag=a&tag=b");
  await until(() => page.text("status").startsWith("已把粘贴的"), "URL params");
  assert.equal(page.text("status"), "已把粘贴的 URL 参数 转为 JSON 并排版。");
  assert.deepEqual(json(page.element("editor").value), {
    name: "MyPaste", count: "2", tag: ["a", "b"],
  });

  page.paste("<root><name>MyPaste</name><count>2</count></root>");
  await until(() => page.text("status") === "已把粘贴的 XML 转为 JSON 并排版。",
    "XML");
  assert.deepEqual(json(page.element("editor").value), {
    root: { name: "MyPaste", count: "2" },
  });

  page.paste("name: MyPaste\ncount: 2\nitems:\n  - alpha\n  - beta\n");
  await until(() => page.text("status") === "已把粘贴的 YAML 转为 JSON 并排版。",
    "YAML");
  assert.deepEqual(json(page.element("editor").value), {
    name: "MyPaste", count: 2, items: ["alpha", "beta"],
  });

  page.element("editor").value = "";
  page.paste("<root><a></root>");
  await until(() => page.text("status").startsWith("识别为 XML，但转换失败："),
    "failed conversion");
  assert.match(page.text("status"), /已原样插入。$/);
  assert.equal(page.element("editor").value, "<root><a></root>");

  page.element("editor").value = "";
  page.paste("just some words");
  await until(() => page.text("status").includes("已原样插入"), "unrecognized");
  assert.equal(page.element("editor").value, "just some words");
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
        # Square corners (D-1045): the only radii allowed are the button reset
        # (0) and a semantically round dot (50%). Anything else is a box.
        radii = re.findall(r"border-radius:\s*([^;}]+)", text)
        self.assertTrue(
            all(value.strip() in {"0", "50%"} for value in radii), radii)
        self.assertIn("Prettier 内置于页面", text)

    def test_manifest_declares_no_runtime(self) -> None:
        manifest = json.loads(
            (PACKAGE / "mypaste.plugin.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["manifestVersion"], 3)
        self.assertEqual(manifest["version"], "3.1.0")
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
