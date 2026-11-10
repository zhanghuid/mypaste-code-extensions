"""The JSON surface page and its Prettier engine (protocol v3).

The page is bundled with the same esbuild the surface build uses and runs under
Node against a minimal DOM stub, so the test sees exactly what the page paints
and what it asks the host for:

- the entry's text is handed to this package's own runtime command, and the
  painted text is Prettier's own output, token for token;
- the token spans mark member names, strings, numbers and keywords apart;
- the copy button posts the formatted text and reports the host's answer,
  including a refused write;
- a refusal from the runtime (a parse error, a missing Node) is shown with its
  position and keeps the entry's text verbatim; it never shows a copy action
  for text that was not formatted;
- an empty entry is explained instead of parsed, and the runtime is not called.

The engine test runs the packaged adapter against the pinned Prettier build,
because the page can only stay under the host's 256 KiB document ceiling when
Prettier runs in the runtime instead of in the document.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PACKAGE = ROOT / "plugins" / "com.mypaste.json"
ESBUILD = ROOT / "node_modules" / ".bin" / "esbuild"
NODE = shutil.which("node")

sys.path.insert(0, str(ROOT / "scripts"))
import vendor_prettier  # noqa: E402

# The host reads a surface document with its fixed text ceiling (D-1075 in the
# host repository); a larger page is refused before it is served.
HOST_SURFACE_BYTES = 256 * 1024

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
    invoke() {
      return posted.find((message) => message.type === "invoke");
    },
    answer(request, payload) {
      for (const listener of listeners) {
        listener({ source: parent, data: {
          v: 1, type: "result", requestId: request.requestId, ...payload,
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

// A valid document: the page asks its own runtime to format, paints the
// answer, and copies exactly what it painted through the host.
{
  const page = await open();
  const source = '{"name":"MyPaste","count":2,"ok":true,"items":[1,null,"x"]}';
  const expected = '{ "name": "MyPaste", "count": 2, "ok": true, "items": [1, null, "x"] }\n';
  page.deliver({ kind: "text", title: "示例", text: source });
  await until(() => page.invoke() !== undefined, "runtime request");
  const request = page.invoke();
  assert.equal(request.v, 1);
  assert.equal(request.pluginId, "com.mypaste.json");
  assert.equal(request.commandId, "format.document");
  assert.equal(request.text, source);
  assert.equal(page.text("code-body"), "");
  assert.equal(page.text("status"), "正在用包内 Prettier 解析…");

  page.answer(request, { ok: true, output: expected });
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
  const copyRequest = page.posted.find((message) => message.type === "copy");
  assert.equal(copyRequest.text, expected);
  page.answer(copyRequest, { ok: true });
  await until(() => page.text("status") === "已复制格式化后的 JSON。", "copy confirmation");

  page.elements.get("copy").click();
  await until(() => page.posted.filter((message) => message.type === "copy").length === 2,
    "second copy request");
  const refused = page.posted.filter((message) => message.type === "copy")[1];
  page.answer(refused, { ok: false, message: "宿主拒绝写入" });
  await until(() => page.text("status") === "复制失败：宿主拒绝写入", "refused copy");
}

// The runtime refuses the text: its position is reported, the entry's text is
// kept verbatim, and no copy action is offered for text that was not formatted.
{
  const page = await open();
  const broken = '{"a": 1,\n "b": 2,\n oops}';
  const reason = "第 3 行第 2 列附近无法解析（Unexpected token）";
  page.deliver({ kind: "text", title: "坏掉的", text: broken });
  await until(() => page.invoke() !== undefined, "runtime request");
  page.answer(page.invoke(), { ok: false, message: reason });
  await until(() => page.text("status").startsWith("无法格式化"), "refusal");
  assert.equal(page.text("status"), `无法格式化：${reason}`);
  assert.equal(page.elements.get("original").hidden, false);
  assert.equal(page.text("original-text"), broken);
  assert.equal(page.elements.get("result").hidden, true);
  assert.equal(page.elements.get("copy").hidden, true);
}

// A machine without Node: the runtime says so and the page repeats it; there
// is no second formatter and no silent fallback.
{
  const page = await open();
  const source = '{"a":1}';
  page.deliver({ kind: "text", title: "无 Node", text: source });
  await until(() => page.invoke() !== undefined, "runtime request");
  page.answer(page.invoke(), {
    ok: false, message: "本机没有 Node，无法运行包内 Prettier（安装 Node 后重试）",
  });
  await until(() => page.text("status").startsWith("无法格式化"), "refusal");
  assert.equal(page.text("original-text"), source);
  assert.equal(page.elements.get("copy").hidden, true);
}

// An empty entry is explained and the runtime is not called.
{
  const page = await open();
  page.deliver({ kind: "text", title: "", text: "   \n" });
  await until(() => page.text("status").includes("条目为空"), "empty state");
  assert.equal(page.text("summary"), "当前条目");
  assert.equal(page.invoke(), undefined);
  assert.equal(page.elements.get("copy").hidden, true);
}

console.log("json surface page: ok");
"""

ENGINE = r"""
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";

const adapter = process.argv[2];
const cases = JSON.parse(process.argv[3]);

function run(text) {
  const done = spawnSync(process.execPath, [adapter, "json"], {
    input: JSON.stringify({ id: "t", input: { type: "text", text } }) + "\n",
    encoding: "utf8",
  });
  assert.equal(done.status, 0, done.stderr);
  return JSON.parse(done.stdout);
}

const formatted = run(cases.source);
assert.equal(formatted.ok, true);
assert.equal(formatted.id, "t");
assert.equal(formatted.result.output, cases.expected);

const refused = run(cases.broken);
assert.equal(refused.ok, false);
assert.equal(refused.id, "t");
assert.equal(refused.error.code, "format-failed");
assert.match(refused.error.message,
  /^第 \d+ 行第 \d+ 列附近无法解析（.+）$/u);

console.log("json engine: ok");
"""


@unittest.skipUnless(NODE and ESBUILD.is_file(), "node and esbuild are required")
class JSONSurfacePageTest(unittest.TestCase):
    def test_page_asks_its_runtime_and_paints_the_answer(self) -> None:
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

    def test_built_page_fits_the_host_document_ceiling(self) -> None:
        document = (PACKAGE / "preview.html").read_text(encoding="utf-8")
        self.assertIn("Generated by scripts/build-surfaces.mjs", document)
        self.assertNotIn("<!--bundle-->", document)
        # The host refuses a surface entry over this size before serving it
        # (D-1075); the page therefore cannot carry the Prettier build.
        self.assertLessEqual(len(document.encode("utf-8")), HOST_SURFACE_BYTES)
        self.assertIn('id="code-body"', document)
        manifest = json.loads((PACKAGE / "mypaste.plugin.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["kind"], "ui")
        self.assertEqual(manifest["capabilities"], ["entity.read"])
        self.assertEqual(manifest["surface"]["entry"], "preview.html")
        self.assertEqual(manifest["runtime"]["entrypoint"], "json")


@unittest.skipUnless(NODE, "node is required to run the packaged engine")
class PrettierJSONEngineTest(unittest.TestCase):
    def test_engine_formats_json_and_reports_positions(self) -> None:
        source = '{"name":"MyPaste","count":2,"ok":true,"items":[1,null,"x"]}'
        expected = '{ "name": "MyPaste", "count": 2, "ok": true, "items": [1, null, "x"] }\n'
        broken = '{"a": 1,\n "b": 2,\n oops}'
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            vendor_prettier.vendor(ROOT, root / "prettier", ("babel", "estree"))
            adapter = root / "prettier.mjs"
            shutil.copyfile(PACKAGE / "src" / "engines" / "prettier.mjs", adapter)
            runner = root / "engine.mjs"
            runner.write_text(ENGINE, encoding="utf-8")
            cases = json.dumps({
                "source": source, "expected": expected, "broken": broken,
            })
            result = subprocess.run(
                [NODE, str(runner), str(adapter), cases],
                cwd=ROOT, capture_output=True, text=True, timeout=120,
            )
            # The vendored subset is what the package ships; a missing plugin
            # would surface here as a module-not-found failure.
            if result.returncode != 0:
                self.fail(f"引擎测试失败：\n{result.stdout}\n{result.stderr}")
            self.assertIn("json engine: ok", result.stdout)
            version = vendor_prettier.pinned_version(ROOT)
            self.assertTrue((root / "prettier" / "VERSION").read_text(
                encoding="utf-8").startswith(f"prettier {version}"))


if __name__ == "__main__":
    unittest.main()
