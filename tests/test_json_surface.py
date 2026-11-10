"""The JSON surface page (protocol v3).

The page is bundled with the same esbuild the surface build uses and runs under
Node against a minimal DOM stub, so the test sees exactly what the page paints
and what it sends to the host:

- a valid document is handed to the bundled Prettier build, and the painted
  text is Prettier's own output, token for token;
- the token spans mark member names, strings, numbers and keywords apart;
- the copy button posts the formatted text and reports the host's answer,
  including a refused write;
- a document Prettier cannot parse reports its line and column and keeps the entry's
  text verbatim; it never shows a copy action for text it could not format;
- an empty entry is explained instead of parsed, and a top-level scalar is
  still a JSON document.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PACKAGE = ROOT / "plugins" / "com.mypaste.json"
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
    this.text = "";
    this.hidden = false;
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
  setAttribute(name, value) { this.attrs[name] = value; }
  click() { for (const listener of this.listeners.get("click") ?? []) listener({}); }
}

const IDS = ["summary", "status", "result", "meta", "code-body", "copy",
             "original", "original-text"];
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
    deliver(item) {
      for (const listener of listeners) {
        listener({ source: parent, data: { v: 1, type: "item", item } });
      }
    },
    answer(request, ok, message) {
      for (const listener of listeners) {
        listener({ source: parent, data: {
          v: 1, type: "result", requestId: request.requestId, ok, message,
        } });
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
    if (Date.now() - start > 10000) throw new Error(`timeout waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// A valid document: the page paints Prettier's canonical layout, marks the
// tokens apart, and copies exactly what it painted through the host.
{
  const page = await open();
  const source = '{"name":"MyPaste","count":2,"ok":true,"items":[1,null,"x"]}';
  const expected = '{ "name": "MyPaste", "count": 2, "ok": true, "items": [1, null, "x"] }\n';
  page.deliver({ kind: "text", title: "示例", text: source });
  await until(() => page.text("code-body") !== "", "formatted document");
  assert.equal(page.text("code-body"), expected);
  assert.equal(page.text("summary"), "示例");
  assert.equal(page.text("status"), "");
  assert.equal(page.elements.get("result").hidden, false);
  assert.equal(page.elements.get("copy").hidden, false);
  assert.equal(page.text("meta"),
    `1 行 · ${new TextEncoder().encode(expected).length} 字节`);

  const painted = page.elements.get("code-body").children;
  const classes = painted.filter((node) => node.className).map((node) => node.className);
  for (const kind of ["tok-key", "tok-string", "tok-number", "tok-keyword", "tok-punct"]) {
    assert.ok(classes.includes(kind), `${kind} token painted`);
  }
  const keys = painted.filter((node) => node.className === "tok-key")
    .map((node) => node.textContent);
  assert.deepEqual(keys, ['"name"', '"count"', '"ok"', '"items"']);

  page.elements.get("copy").click();
  await until(() => page.posted.some((message) => message.type === "copy"),
    "copy request");
  const request = page.posted.find((message) => message.type === "copy");
  assert.equal(request.text, expected);
  page.answer(request, true);
  await until(() => page.text("status") === "已复制格式化后的 JSON。", "copy confirmation");

  page.elements.get("copy").click();
  await until(() => page.posted.filter((message) => message.type === "copy").length === 2,
    "second copy request");
  const refused = page.posted.filter((message) => message.type === "copy")[1];
  page.answer(refused, false, "宿主拒绝写入");
  await until(() => page.text("status") === "复制失败：宿主拒绝写入", "refused copy");
}

// An invalid document: Prettier's position is reported, the entry's text is
// kept verbatim, and no copy action is offered for text that was not formatted.
{
  const page = await open();
  const broken = '{"a": 1,\n "b": 2,\n oops}';
  page.deliver({ kind: "text", title: "坏掉的", text: broken });
  await until(() => page.text("status").includes("解析失败"), "parse error");
  assert.match(page.text("status"),
    /^解析失败：第 3 行第 2 列附近无法解析（.+）$/u);
  assert.equal(page.elements.get("original").hidden, false);
  assert.equal(page.text("original-text"), broken);
  assert.equal(page.elements.get("result").hidden, true);
  assert.equal(page.elements.get("copy").hidden, true);
}

// An empty entry is explained, not parsed.
{
  const page = await open();
  page.deliver({ kind: "text", title: "", text: "   \n" });
  await until(() => page.text("status").includes("条目为空"), "empty state");
  assert.equal(page.text("summary"), "当前条目");
  assert.equal(page.elements.get("copy").hidden, true);
}

// JSON also allows a top-level scalar; Prettier formats it like any document.
{
  const page = await open();
  page.deliver({ kind: "text", title: "标量", text: " 42 " });
  await until(() => page.text("code-body") === "42\n", "scalar formatting");
  assert.equal(page.text("meta"), "1 行 · 3 字节");
  assert.equal(page.text("status"), "");}

console.log("json surface page: ok");
"""


@unittest.skipUnless(NODE and ESBUILD.is_file(), "node and esbuild are required")
class JSONSurfacePageTest(unittest.TestCase):
    def test_page_formats_copies_and_explains_failures(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            page = Path(directory) / "page.mjs"
            subprocess.run(
                [str(ESBUILD), str(PACKAGE / "src" / "main.ts"),
                 "--bundle", "--format=esm", "--platform=neutral",
                 f"--outfile={page}", "--log-level=warning"],
                cwd=ROOT, check=True, capture_output=True, text=True,
            )
            runner = Path(directory) / "runner.mjs"
            runner.write_text(RUNNER, encoding="utf-8")
            result = subprocess.run(
                [NODE, str(runner), directory],
                cwd=ROOT, capture_output=True, text=True, timeout=120,
            )
        if result.returncode != 0:
            self.fail(f"页面测试失败：\n{result.stdout}\n{result.stderr}")
        self.assertIn("json surface page: ok", result.stdout)

    def test_built_page_is_the_bundled_surface(self) -> None:
        document = (PACKAGE / "preview.html").read_text(encoding="utf-8")
        self.assertIn("Generated by scripts/build-surfaces.mjs", document)
        self.assertNotIn("<!--bundle-->", document)
        self.assertLess(len(document.encode("utf-8")), 1 << 20)
        self.assertIn('id="code-body"', document)
        manifest = json.loads((PACKAGE / "mypaste.plugin.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["kind"], "ui")
        self.assertEqual(manifest["capabilities"], ["entity.read"])
        self.assertEqual(manifest["surface"]["entry"], "preview.html")


if __name__ == "__main__":
    unittest.main()
