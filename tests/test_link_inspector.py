"""The link type packages: the detector document and the inspector's reading.

Two units are covered here:

- the inspector's pure reader (`src/result.ts`), bundled with the same esbuild
  the surface build uses and executed under Node, so the page's refusal rules
  are the ones that really run;
- the two manifests and the detector's type table, which the packaging scripts
  also validate but whose contract (forms, roles, capabilities, MIME shape) is
  the feature itself.

Detection itself lives in Go and is covered by the package's own Go tests; all
fixtures here are synthetic links.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DETECTOR = ROOT / "plugins" / "com.mypaste.link-mime"
INSPECTOR = ROOT / "plugins" / "com.mypaste.link-inspector"
ESBUILD = ROOT / "node_modules" / ".bin" / "esbuild"
NODE = shutil.which("node")

MIME_PATTERN = re.compile(r"^[a-z0-9][a-z0-9!#$&^_.+-]*/[a-z0-9][a-z0-9!#$&^_.+-]*$")
CATEGORIES = {
    "image", "video", "audio", "text", "document", "archive", "font",
    "page", "email", "torrent", "other",
}
CONFIDENCE = {"high", "medium", "low"}

RUNNER = r"""
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const work = process.argv[2];
const mod = await import(pathToFileURL(path.join(work, "result.mjs")).href);
const {
  parseDetectorResult, confidenceWord, sourceWord, evidenceWord,
} = mod;
const renderers = await import(pathToFileURL(path.join(work, "renderer.mjs")).href);
const { planFor, planWord, formatText, decodeInlineText, MAX_TEXT_CHARS } = renderers;

const checks = [];
const complete = {
  schema: 1,
  url: "https://example.com/files/photo.png",
  scheme: "https",
  host: "example.com",
  path: "/files/photo.png",
  mime: "image/png",
  label: "PNG 图像",
  category: "image",
  categoryLabel: "图像",
  confidence: "high",
  source: "extension",
  evidence: [{ kind: "extension", value: ".png", detail: "URL 路径的扩展名是 .png" }],
  note: "仅根据链接文本推断。",
};

const parsed = parseDetectorResult(JSON.stringify(complete));
assert.equal(parsed.schema, 1);
assert.equal(parsed.mime, "image/png");
assert.equal(parsed.categoryLabel, "图像");
assert.equal(parsed.evidence[0].value, ".png");
checks.push("a complete document survives with every displayed field");

// A link with no MIME is allowed, and an unknown extra field is ignored.
const withoutMime = { ...complete };
delete withoutMime.mime;
assert.equal(parseDetectorResult(JSON.stringify(withoutMime)).mime, undefined);
const withExtra = parseDetectorResult(JSON.stringify({ ...complete, future: { x: 1 } }));
assert.equal(withExtra.label, "PNG 图像");
checks.push("a missing MIME stays missing and unknown fields are ignored");

const refused = [
  "not json",
  "{}",
  JSON.stringify({ ...complete, schema: 2 }),
  JSON.stringify({ ...complete, confidence: "certain" }),
  JSON.stringify({ ...complete, label: 3 }),
  JSON.stringify({ ...complete, source: undefined }),
  JSON.stringify({ ...complete, evidence: [] }),
  JSON.stringify({ ...complete, evidence: [{ kind: "extension", detail: "" }] }),
  JSON.stringify({ ...complete, evidence: [{ detail: "no kind" }] }),
];
for (const value of refused) {
  assert.equal(parseDetectorResult(value), null, value);
}
checks.push("an incomplete or newer document is refused whole");

assert.equal(confidenceWord("high"), "高");
assert.equal(confidenceWord("medium"), "中");
assert.equal(confidenceWord("low"), "低");
assert.equal(sourceWord("extension"), "URL 扩展名");
assert.equal(sourceWord("data-url"), "data: 内联内容");
assert.equal(sourceWord("future-source"), "future-source");
assert.equal(evidenceWord("host"), "站点");
assert.equal(evidenceWord("future-kind"), "future-kind");
checks.push("closed words map, and an unknown word passes through");

const base = {
  schema: 1,
  url: "https://example.com/files/photo.png",
  label: "PNG 图像",
  category: "image",
  categoryLabel: "图像",
  confidence: "high",
  source: "extension",
  evidence: [{ kind: "extension", detail: "URL 路径的扩展名是 .png" }],
};
const plan = (over) => planFor({ ...base, ...over });

const imagePlan = plan({ mime: "image/png" });
assert.equal(imagePlan.kind, "image");
assert.equal(imagePlan.inline, false);
assert.equal(plan({ mime: "video/mp4" }).kind, "video");
assert.equal(plan({ mime: "audio/mpeg" }).kind, "audio");
checks.push("images, video and audio keep the browser's own element");

const jsonPlan = plan({ url: "https://example.com/a.json", mime: "application/json" });
assert.equal(jsonPlan.kind, "text");
assert.equal(jsonPlan.flavor, "json");
assert.equal(jsonPlan.inline, false);
assert.equal(plan({ url: "https://example.com/a", mime: "application/ld+json" }).flavor, "json");
assert.equal(plan({ url: "https://example.com/a.xml", mime: "application/xml" }).flavor, "xml");
assert.equal(plan({ url: "https://example.com/a", mime: "text/html" }).flavor, "html");
assert.equal(plan({ url: "https://example.com/a.css", mime: "text/css" }).flavor, "text");
checks.push("text flavours are chosen by MIME, not by a second word list");

const unsupported = [
  ["https://example.com/a.pdf", "application/pdf"],
  ["mailto:someone@example.com", "message/rfc822"],
  ["javascript:alert(1)", "text/html"],
  ["file:///etc/passwd", "text/plain"],
  [base.url, undefined],
];
for (const [url, mime] of unsupported) {
  const refused = plan({ url, mime });
  assert.equal(refused.kind, "unsupported", url);
  assert.ok(refused.reason.length > 0, url);
}
assert.ok(plan({ url: "https://example.com/a.pdf", mime: "application/pdf" })
  .reason.includes("PDF"));
checks.push("a scheme or type the page cannot load is refused with a reason");

const inlineJsonURL =
  "data:application/json;base64," + Buffer.from('{"b":2,"a":1}').toString("base64");
const inlineJson = plan({ url: inlineJsonURL, mime: "application/json" });
assert.equal(inlineJson.kind, "text");
assert.equal(inlineJson.inline, true);
assert.equal(inlineJson.text, '{"b":2,"a":1}');
const inlineImage = plan({ url: "data:image/png;base64,iVBORw0KGgo=", mime: "image/png" });
assert.equal(inlineImage.kind, "image");
assert.equal(inlineImage.inline, true);
const inlineText = plan({ url: "data:text/plain,%E4%BD%A0%E5%A5%BD", mime: "text/plain" });
assert.equal(inlineText.text, "你好");
assert.equal(decodeInlineText("data:text/plain;base64,!!!", 100), null);
assert.equal(
  decodeInlineText("data:text/plain;base64," + Buffer.alloc(64).toString("base64"), 32), null);
checks.push("inline data: content is decoded locally and kept out of the network");

const pretty = formatText("json", '{"b":2,"a":1}');
assert.equal(pretty.text, '{\n  "b": 2,\n  "a": 1\n}');
assert.ok(pretty.note.includes("JSON"));
const invalidJson = formatText("json", "{nope");
assert.equal(invalidJson.text, "{nope");
assert.ok(invalidJson.note.includes("不是有效 JSON"));
const htmlText = formatText("html", "<p>x</p>");
assert.equal(htmlText.text, "<p>x</p>");
assert.ok(htmlText.note.includes("源码"));
const long = formatText("text", "x".repeat(MAX_TEXT_CHARS + 5));
assert.equal(long.text.length, MAX_TEXT_CHARS);
assert.equal(long.truncated, true);
assert.ok(long.note.includes("内容过长"));
checks.push("fetched text is formatted, never injected, and always bounded");

assert.equal(planWord(imagePlan), "图片");
assert.equal(planWord(jsonPlan), "JSON");
assert.equal(planWord(plan({ url: "https://example.com/a.pdf", mime: "application/pdf" })),
  "无预览");
checks.push("the stage badge names the renderer that ran");

console.log(JSON.stringify(checks));
"""


class InspectorResultTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        if NODE is None or not ESBUILD.exists():
            raise unittest.SkipTest("node and esbuild are needed for the inspector test")
        cls.temp = tempfile.TemporaryDirectory()
        work = Path(cls.temp.name)
        for name in ("result", "renderer"):
            built = subprocess.run(
                [
                    str(ESBUILD),
                    str(INSPECTOR / "src" / f"{name}.ts"),
                    "--bundle",
                    "--format=esm",
                    "--platform=neutral",
                    "--log-level=error",
                    f"--outfile={work / f'{name}.mjs'}",
                ],
                capture_output=True,
                text=True,
            )
            if built.returncode != 0:
                raise AssertionError(f"esbuild failed for {name}.ts: {built.stderr}")
        runner = work / "runner.mjs"
        runner.write_text(RUNNER, encoding="utf-8")
        cls.result = subprocess.run(
            [str(NODE), str(runner), str(work)],
            capture_output=True,
            text=True,
            timeout=60,
            env=dict(os.environ),
        )

    @classmethod
    def tearDownClass(cls) -> None:
        cls.temp.cleanup()

    def test_result_reader(self) -> None:
        self.assertEqual(
            self.result.returncode, 0, self.result.stdout + self.result.stderr)
        checks = json.loads(self.result.stdout)
        self.assertIn("a complete document survives with every displayed field", checks)
        self.assertIn("an incomplete or newer document is refused whole", checks)
        self.assertIn("images, video and audio keep the browser's own element", checks)
        self.assertIn("text flavours are chosen by MIME, not by a second word list", checks)
        self.assertIn(
            "a scheme or type the page cannot load is refused with a reason", checks)
        self.assertIn(
            "inline data: content is decoded locally and kept out of the network", checks)
        self.assertIn(
            "fetched text is formatted, never injected, and always bounded", checks)
        self.assertIn("the stage badge names the renderer that ran", checks)


class LinkPackagesTest(unittest.TestCase):
    def test_detector_is_an_unplaced_link_capability(self) -> None:
        manifest = json.loads((DETECTOR / "mypaste.plugin.json").read_text())
        self.assertEqual(manifest["kind"], "command")
        self.assertEqual(set(manifest["capabilities"]), {"entity.read"})
        self.assertEqual(manifest["runtime"]["mode"], "command")
        self.assertTrue((DETECTOR / manifest["runtime"]["entrypoint"]).is_file() or
                        manifest["runtime"]["entrypoint"] == "link-mime")
        self.assertEqual(len(manifest["commands"]), 1)
        command = manifest["commands"][0]
        self.assertEqual(command["id"], "detect")
        self.assertEqual(command["forms"], ["link"])
        self.assertEqual(command["output"], ["text"])
        # No placement: the host shows nothing on its own, so the inspector is
        # the only surface that reaches it (the composition path of v3).
        self.assertNotIn("placement", command)

    def test_inspector_opens_a_link_with_a_page_of_its_own(self) -> None:
        manifest = json.loads((INSPECTOR / "mypaste.plugin.json").read_text())
        self.assertEqual(manifest["kind"], "ui")
        self.assertNotIn("runtime", manifest)
        self.assertEqual(set(manifest["capabilities"]),
                         {"entity.read", "clipboard.write", "surface.network"})
        surface = manifest["surface"]
        self.assertEqual(surface["forms"], ["link"])
        self.assertEqual(surface["role"], "open")
        self.assertEqual(surface["chrome"], "page")
        self.assertTrue((INSPECTOR / surface["entry"]).is_file())

    def test_type_table_keeps_the_closed_vocabulary(self) -> None:
        table = json.loads(
            (DETECTOR / "src" / "internal" / "linkmime" / "mime-types.json").read_text())
        self.assertEqual(table["schema"], 1)
        self.assertTrue(table["note"].strip())
        self.assertEqual(set(table["categoryLabels"]), CATEGORIES)
        self.assertGreaterEqual(len(table["types"]), 80)
        for extension, rule in table["types"].items():
            self.assertEqual(extension, extension.lower(), extension)
            self.assertFalse(extension.startswith("."), extension)
            self.assertTrue(rule["label"].strip(), extension)
            self.assertIn(rule["category"], CATEGORIES, extension)
            self.assertRegex(rule["mime"], MIME_PATTERN)
            if "confidence" in rule:
                self.assertIn(rule["confidence"], CONFIDENCE, extension)

        seen: set[str] = set()
        for rule in table["hosts"]:
            self.assertEqual(rule["suffix"], rule["suffix"].lower())
            self.assertNotIn(rule["suffix"], seen)
            seen.add(rule["suffix"])
            self.assertIn(rule["confidence"], CONFIDENCE, rule["suffix"])
            self.assertIn(rule["category"], CATEGORIES, rule["suffix"])
            self.assertRegex(rule["mime"], MIME_PATTERN)

        for scheme, rule in table["schemes"].items():
            self.assertEqual(scheme, scheme.lower())
            self.assertIn(rule["category"], CATEGORIES, scheme)
            self.assertIn(rule["confidence"], CONFIDENCE, scheme)
            if rule["mime"]:
                self.assertRegex(rule["mime"], MIME_PATTERN)
        self.assertGreater(len(table["queryKeys"]), 0)

    def test_every_selector_the_page_looks_up_exists_in_the_markup(self) -> None:
        source = (INSPECTOR / "src" / "main.ts").read_text()
        markup = (INSPECTOR / "src" / "preview.html").read_text()
        selectors = re.findall(r'one<[^>]*>\("#([A-Za-z0-9_-]+)"\)', source)
        self.assertGreaterEqual(len(selectors), 20)
        for element_id in selectors:
            self.assertIn(f'id="{element_id}"', markup, element_id)

    def test_inspector_page_ships_the_detector_pair_and_a_close_control(self) -> None:
        page = (INSPECTOR / "preview.html").read_text()
        self.assertIn("com.mypaste.link-mime", page)
        self.assertIn('id="doc-close"', page)
        self.assertIn("Generated by scripts/build-surfaces.mjs", page)
        # The bundle lives inside a script element; without it the page paints
        # the whole program as text.
        self.assertIn("<script>", page)


if __name__ == "__main__":
    unittest.main()
