"""The code-card surface: geometry, palettes and the host theme channel.

The card is canvas drawing, so the test does not rasterise it. Instead it
bundles the package's own `card.ts` and `bridge.ts` with the same esbuild the
surface build uses and drives the pure parts under Node: language detection and
override, layout geometry for every window style and appearance option, palette
resolution from host tokens, and the exact theme message the page applies. The
1 MiB page build is covered by test_surface_page.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PACKAGE = ROOT / "plugins" / "com.mypaste.code-card"
ESBUILD = ROOT / "node_modules" / ".bin" / "esbuild"
NODE = shutil.which("node")

RUNNER = r"""
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const dir = process.argv[2];
const posted = [];
const listeners = [];
const vars = {};
const root = {
  dataset: {},
  style: {
    setProperty(name, value) { vars[name] = value; },
    removeProperty(name) { delete vars[name]; },
  },
};
globalThis.document = { documentElement: root };
const parent = { postMessage: (message) => posted.push(message) };
globalThis.parent = parent;
globalThis.window = {
  parent,
  addEventListener(type, listener) {
    if (type === "message") listeners.push(listener);
  },
};

const card = await import(pathToFileURL(path.join(dir, "card.mjs")));
const bridgeModule = await import(pathToFileURL(path.join(dir, "bridge.mjs")));
const checks = [];

const base = { ...card.DEFAULT_CODE_CARD_OPTIONS };
const source = card.cardSource("const answer = 42;\nconsole.log(answer);", "示例", "javascript");

// Detection still owns "auto"; an explicit language skips it. The explicit
// choice is also what the label prints, so the two cannot disagree.
assert.equal(source.language, "javascript");
assert.equal(source.label, "JavaScript");
const detected = card.cardSource('{"ok": true}', "JSON", "auto");
assert.equal(detected.language, "json");
assert.equal(detected.label, "JSON");
const forced = card.cardSource("fn main() {}", "Rust", "rust");
assert.equal(forced.language, "rust");
assert.equal(forced.label, "Rust");
const plain = card.cardSource("hello there", "plain", "auto");
assert.equal(plain.language, "javascript");
assert.equal(plain.label, "文本");
assert.equal(card.cardSource("   \n  ", "empty", "auto"), null);
checks.push("auto detection and an explicit language both reach the card source");

// A tab is drawn as four spaces: canvas text has no reliable tab advance, so
// the layout and the drawn text must use the same expansion.
const tabbed = card.cardSource("if (true) {\n\treturn;\n}", "tab", "javascript");
const tabLine = card.splitTokenLines(tabbed.tokens, 80)[1].map((token) => token.text).join("");
assert.ok(tabLine.startsWith("    "));
checks.push("a tab becomes four spaces in the drawn line");

// A long item is bounded once; the marker is part of the drawn text.
const long = card.cardSource("x".repeat(card.CARD_SOURCE_LIMIT + 1), "long", "javascript");
const longText = long.tokens.map((token) => token.text).join("");
assert.ok(longText.length <= card.CARD_SOURCE_LIMIT + 5);
assert.ok(longText.endsWith("\n..."));
checks.push("the source limit truncates once and marks the cut");

// Each window style has its own chrome height; the shadow decides the outer
// margin, so an option changes the export without touching the tokenizer.
const mac = card.codeCardLayout(source, base);
const windows = card.codeCardLayout(source, { ...base, windowStyle: "windows" });
const none = card.codeCardLayout(source, { ...base, windowStyle: "none" });
assert.equal(mac.titleHeight, 46);
assert.equal(windows.titleHeight, 40);
assert.equal(none.titleHeight, 0);
assert.equal(none.headerExtra, 22);
assert.equal(mac.margin, 54);
const unshadowed = card.codeCardLayout(source, { ...base, shadow: false });
assert.equal(unshadowed.margin, 32);
assert.ok(unshadowed.width < mac.width);
assert.ok(unshadowed.height < mac.height);
checks.push("window chrome and shadow change geometry, not content");

// Line numbers reserve a gutter; font size and padding grow the window; the
// longest content still cannot push past the card ceiling.
const noLines = card.codeCardLayout(source, { ...base, lineNumbers: false });
assert.equal(noLines.gutterWidth, 0);
assert.ok(mac.gutterWidth > 0);
const multiline = card.cardSource(
  Array.from({ length: 12 }, (_, index) => `const v${index} = ${index};`).join("\n"),
  "many", "javascript",
);
const bigFont = card.codeCardLayout(multiline, { ...base, fontSize: 18 });
const smallFont = card.codeCardLayout(multiline, { ...base, fontSize: 11 });
assert.ok(bigFont.height > smallFont.height);
assert.ok(bigFont.width >= smallFont.width);
const roomy = card.codeCardLayout(source, { ...base, padding: 56 });
const tight = card.codeCardLayout(source, { ...base, padding: 16 });
assert.ok(roomy.height > tight.height);
assert.ok(roomy.width >= tight.width);
const wide = card.cardSource("x".repeat(5000), "wide", "javascript");
const wideLayout = card.codeCardLayout(wide, base);
assert.ok(wideLayout.cardWidth <= 1600);
assert.ok(wideLayout.width > 1600);
checks.push("gutter, font size and padding grow the layout within the width ceiling");

// The host palette reads the host's own code tokens; missing values fall back
// by scheme, and a stored theme stays independent of the host.
const lightHost = card.resolvePalette("host", {
  scheme: "light",
  tokens: {
    "code-surface": "#101010",
    "code-ink": "#fefefe",
    "code-keyword": "#ff0000",
    "code-comment": "#888888",
    "surface-solid": "#fafafa",
    "line": "rgba(0, 0, 0, 0.2)",
  },
});
assert.equal(lightHost.surface, "#101010");
assert.equal(lightHost.ink, "#fefefe");
assert.equal(lightHost.tokens.keyword, "#ff0000");
assert.equal(lightHost.background, "#fafafa");
assert.equal(lightHost.border, "rgba(0, 0, 0, 0.2)");
assert.equal(lightHost.tokens.string, card.resolvePalette("host", { scheme: "light", tokens: {} }).tokens.string);
const darkHost = card.resolvePalette("host", { scheme: "dark", tokens: {} });
assert.notEqual(darkHost.surface, lightHost.surface);
assert.notEqual(darkHost.background, lightHost.background);
const stored = card.resolvePalette("nord", { scheme: "light", tokens: { "code-surface": "#ffffff" } });
assert.equal(stored.surface, card.CODE_CARD_PALETTES.nord.surface);
checks.push("the host palette follows the host tokens and stored palettes do not");

// Every stored theme answers every token kind the tokenizer can emit.
const kinds = ["keyword", "string", "comment", "number", "function", "property", "literal", "tag", "type"];
for (const [id, palette] of Object.entries(card.CODE_CARD_PALETTES)) {
  for (const kind of kinds) assert.ok(palette.tokens[kind], `${id} has ${kind}`);
  for (const field of ["surface", "titleBar", "background", "border", "shadow", "ink", "muted", "gutter", "accent"]) {
    assert.ok(palette[field], `${id} has ${field}`);
  }
}
checks.push("every stored palette is complete");

// The bridge: ready, item, then the theme. Only valid token names reach CSS,
// and a malformed theme is ignored rather than clearing the page's palette.
const bridge = bridgeModule.connectSurface();
assert.deepEqual(posted[0], { v: 1, type: "ready" });
let received = null;
bridge.onItem((item) => { received = item; });
let theme = null;
bridge.onTheme((next) => { theme = next; });
function emit(data) {
  for (const listener of listeners) listener({ source: parent, data });
}
emit({ v: 1, type: "item", item: { kind: "text", title: "标题", text: "hello" } });
assert.equal(received.text, "hello");
emit({
  v: 1, type: "theme", scheme: "dark",
  tokens: {
    "code-surface": "#222222",
    "bad name!": "#ffffff",
    "empty": "",
  },
});
assert.equal(theme.scheme, "dark");
assert.equal(root.dataset.scheme, "dark");
assert.equal(vars["--mp-code-surface"], "#222222");
assert.equal(vars["--mp-bad name!"], undefined);
assert.equal(vars["--mp-empty"], undefined);
emit({ v: 1, type: "theme", scheme: "neon", tokens: { "code-surface": "#ffffff" } });
assert.equal(theme.scheme, "dark");
assert.equal(vars["--mp-code-surface"], "#222222");
checks.push("the theme channel applies known tokens and ignores malformed ones");

// Saving and copying keep their request/result shape after the theme was added.
const save = bridge.save("data:image/png;base64,AA==", "卡片");
assert.deepEqual(posted.at(-1), {
  v: 1, type: "save", image: { dataURL: "data:image/png;base64,AA==", title: "卡片" }, requestId: 1,
});
emit({ v: 1, type: "result", requestId: 1, ok: true, id: 7 });
assert.deepEqual(await save, { ok: true, requestId: 1, id: 7, message: undefined });
const copy = bridge.copy("data:image/png;base64,AA==");
emit({ v: 1, type: "result", requestId: 2, ok: false, message: "拒绝" });
assert.deepEqual(await copy, { ok: false, requestId: 2, id: undefined, message: "拒绝" });
bridge.close();
assert.deepEqual(posted.at(-1), { v: 1, type: "close" });
checks.push("save, copy and close keep their v3 message shapes");

process.stdout.write(JSON.stringify(checks) + "\n");
"""


class CodeCardTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        if NODE is None or not ESBUILD.exists():
            raise unittest.SkipTest("node and esbuild are needed for the card test")
        cls.temp = tempfile.TemporaryDirectory()
        work = Path(cls.temp.name)
        for name in ("card", "bridge"):
            built = subprocess.run(
                [
                    str(ESBUILD),
                    str(PACKAGE / "src" / f"{name}.ts"),
                    "--bundle",
                    "--format=esm",
                    "--platform=neutral",
                    "--log-level=error",
                    f"--outfile={work / (name + '.mjs')}",
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

    def test_card_geometry_palettes_and_theme_channel(self) -> None:
        if self.result.returncode != 0:
            self.fail(
                "card runner failed:\n"
                f"stdout:\n{self.result.stdout}\nstderr:\n{self.result.stderr}"
            )
        checks = json.loads(self.result.stdout.strip().splitlines()[-1])
        self.assertEqual(checks, [
            "auto detection and an explicit language both reach the card source",
            "a tab becomes four spaces in the drawn line",
            "the source limit truncates once and marks the cut",
            "window chrome and shadow change geometry, not content",
            "gutter, font size and padding grow the layout within the width ceiling",
            "the host palette follows the host tokens and stored palettes do not",
            "every stored palette is complete",
            "the theme channel applies known tokens and ignores malformed ones",
            "save, copy and close keep their v3 message shapes",
        ])


if __name__ == "__main__":
    unittest.main()
