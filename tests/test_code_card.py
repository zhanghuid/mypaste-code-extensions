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
const formatter = await import(pathToFileURL(path.join(dir, "format.mjs")));
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

// A pasted one-liner is re-indented for the drawing. An author's own line
// breaks, and any language whose whitespace or grammar this module cannot
// recover, are returned byte for byte; malformed markup is refused, not
// repaired.
assert.equal(
  formatter.formatSource('{"a":[1,2]}', "json"),
  '{\n  "a": [\n    1,\n    2\n  ]\n}',
);
assert.equal(
  formatter.formatSource("<div><p>a</p><p>b</p></div>", "html"),
  "<div>\n  <p>a</p>\n  <p>b</p>\n</div>",
);
assert.equal(
  formatter.formatSource('<span class="x">满分100</span>', "html"),
  '<span class="x">满分100</span>',
);
assert.equal(formatter.formatSource("<div><p>a</p>", "html"), "<div><p>a</p>");
assert.equal(formatter.formatSource("<script>x</script>", "html"), "<script>x</script>");
assert.equal(
  formatter.formatSource("a{color:red;b{}}", "css"),
  "a {\n  color:red;\n  b {\n  }\n}",
);
const kept = "const a = 1;\n    const b = 2;";
assert.equal(formatter.formatSource(kept, "javascript"), kept);
assert.equal(formatter.formatSource("if a:\n  pass", "python"), "if a:\n  pass");
const reformatted = card.cardSource("<div><p>a</p><p>b</p></div>", "", "auto");
assert.equal(reformatted.language, "html");
assert.equal(
  reformatted.tokens.map((token) => token.text).join(""),
  "<div>\n  <p>a</p>\n  <p>b</p>\n</div>",
);
checks.push("a one-line source is re-indented and the author's layout is kept");

// A tab is drawn as four spaces: canvas text has no reliable tab advance, so
// the layout and the drawn text must use the same expansion.
const tabbed = card.cardSource("if (true) {\n\treturn;\n}", "tab", "javascript");
const tabLine = card.splitTokenLines(tabbed.tokens, 80)[1].map((token) => token.text).join("");
assert.ok(tabLine.startsWith("    "));
checks.push("a tab becomes four spaces in the drawn line");

// A wide character takes two cells. Counting a CJK run in single cells drew
// the text that followed it on top of it and wrapped late.
assert.equal(card.charColumns("满分100"), 7);
const cjk = card.cardSource("测试".repeat(10), "cjk", "auto");
const cjkLines = card.splitTokenLines(cjk.tokens, 10);
assert.ok(cjkLines.every((line) => card.charColumns(line.map((token) => token.text).join("")) <= 10));
assert.equal(cjkLines.length, 4);
checks.push("a wide character takes two cells in the drawn line");

// Highlighting survives line splitting: the pieces the renderer paints keep the
// kind of the token they came from, and the palette colour of that kind is what
// reaches the canvas. Every card used to be drawn in one colour because this
// split dropped the kind.
const styled = card.cardSource('<span class="x">hi</span>', "", "html");
const styledLines = card.splitTokenLines(styled.tokens, 80);
assert.deepEqual(
  styledLines.flat().map((token) => token.kind).filter((kind) => kind !== ""),
  ["tag", "property", "string", "tag"],
);
const painted = [];
const painting = new Proxy({}, {
  get(target, prop) {
    if (prop === "fillText") return (text) => painted.push([target.fillStyle, text]);
    if (prop === "measureText") return () => ({ width: 8 });
    if (prop in target) return target[prop];
    return () => {};
  },
  set(target, prop, value) { target[prop] = value; return true; },
});
const canvas = { width: 0, height: 0, style: {}, getContext: () => painting };
card.drawCodeCard(canvas, styled, { ...base, theme: "nord" });
const tagColour = card.CODE_CARD_PALETTES.nord.tokens.tag;
const stringColour = card.CODE_CARD_PALETTES.nord.tokens.string;
assert.ok(painted.some(([fill, text]) => fill === tagColour && text === "span"));
assert.ok(painted.some(([fill]) => fill === stringColour));
checks.push("line splitting keeps each token's kind and the card paints it");

// A long item is bounded once; the marker is part of the drawn text.
const long = card.cardSource("x".repeat(card.CARD_SOURCE_LIMIT + 1), "long", "javascript");
const longText = long.tokens.map((token) => token.text).join("");
assert.ok(longText.length <= card.CARD_SOURCE_LIMIT + 5);
assert.ok(longText.endsWith("\n..."));
checks.push("the source limit truncates once and marks the cut");

// The window band is Carbon's constant 48 px; the style only decides what is
// drawn in it. The shadow is painted inside the padding, so it changes pixels,
// not geometry.
const mac = card.codeCardLayout(source, base);
const windows = card.codeCardLayout(source, { ...base, windowStyle: "windows" });
const none = card.codeCardLayout(source, { ...base, windowStyle: "none" });
assert.equal(mac.barHeight, card.CARD_BAR_HEIGHT);
assert.equal(windows.barHeight, card.CARD_BAR_HEIGHT);
assert.equal(none.barHeight, card.CARD_BAR_HEIGHT);
assert.equal(mac.width, windows.width);
assert.equal(mac.height, none.height);
const unshadowed = card.codeCardLayout(source, { ...base, shadow: false });
assert.equal(unshadowed.width, mac.width);
assert.equal(unshadowed.height, mac.height);
checks.push("the window band is constant and the shadow never moves the geometry");

// Line numbers reserve a gutter; font size, line height and padding grow the
// window; auto width follows the code, a fixed width does not, and the longest
// content still cannot push past the ceiling.
const noLines = card.codeCardLayout(source, { ...base, lineNumbers: false });
assert.equal(noLines.gutterWidth, 0);
const withLines = card.codeCardLayout(source, { ...base, lineNumbers: true });
assert.ok(withLines.gutterWidth > 0);
assert.ok(withLines.width > noLines.width);
assert.equal(withLines.contentLeft, card.CARD_PAD_LEFT + withLines.gutterWidth);
const multiline = card.cardSource(
  Array.from({ length: 12 }, (_, index) => `const v${index} = ${index};`).join("\n"),
  "many", "javascript",
);
const bigFont = card.codeCardLayout(multiline, { ...base, fontSize: 18 });
const smallFont = card.codeCardLayout(multiline, { ...base, fontSize: 11 });
assert.ok(bigFont.height > smallFont.height);
assert.ok(bigFont.cardWidth >= smallFont.cardWidth);
const loose = card.codeCardLayout(multiline, { ...base, lineHeight: 200 });
const compact = card.codeCardLayout(multiline, { ...base, lineHeight: 100 });
assert.ok(loose.height > compact.height);
assert.equal(
  loose.cardHeight - card.CARD_BAR_HEIGHT - card.CARD_PAD_BOTTOM,
  loose.lines.length * loose.lineHeight,
);
const roomy = card.codeCardLayout(source, { ...base, paddingX: 96, paddingY: 96 });
const tight = card.codeCardLayout(source, { ...base, paddingX: 16, paddingY: 16 });
assert.ok(roomy.height > tight.height);
assert.ok(roomy.width > tight.width);
assert.equal(roomy.cardWidth, tight.cardWidth);
const fixed = card.codeCardLayout(source, { ...base, autoWidth: false });
assert.equal(fixed.cardWidth, card.FIXED_CARD_WIDTH);
const wide = card.cardSource("x".repeat(5000), "wide", "javascript");
assert.ok(card.codeCardLayout(wide, base).cardWidth <= card.MAX_CARD_WIDTH);
checks.push("gutter, font size, line height and padding grow the layout within the ceiling");

// Auto width is the drawn text, not an estimate of it. A measure handed to the
// layout sets the window exactly, and the drawn card asks the canvas for that
// measurement, so the right padding stays 18 px whatever font the page resolves
// — the estimate left a wide band of card beside a short line. Very short code
// still keeps the floor the window's own controls need.
const exact = card.codeCardLayout(source, base, () => 300);
assert.equal(exact.cardWidth, card.CARD_PAD_LEFT + card.CARD_PAD_RIGHT + 300);
const tiny = card.codeCardLayout(card.cardSource("x", "tiny", "auto"), base);
assert.equal(tiny.cardWidth, card.MIN_CARD_WIDTH);
let measuredCalls = 0;
const measuring = {
  width: 0, height: 0, style: {},
  getContext: () => new Proxy({}, {
    get(target, prop) {
      if (prop === "measureText") {
        return (text) => { measuredCalls += 1; return { width: text.length * 7 }; };
      }
      if (prop in target) return target[prop];
      return () => {};
    },
    set(target, prop, value) { target[prop] = value; return true; },
  }),
};
const single = card.cardSource("const x = 1;", "one", "javascript");
const hugging = card.drawCodeCard(measuring, single, base);
assert.ok(measuredCalls > 0);
assert.equal(hugging.cardWidth, card.CARD_PAD_LEFT + card.CARD_PAD_RIGHT + 7 * 12);
checks.push("auto width follows the measured glyphs and keeps a floor for the window controls");

// Wrapping is the default and it is what keeps the stage from scrolling
// sideways: the card is laid out to the room the stage reports, so a long line
// breaks instead of widening the export past the pane. Turned off, the card
// grows to the old ceiling again.
assert.equal(card.DEFAULT_CODE_CARD_OPTIONS.wrap, true);
const room = 720;
const longish = card.cardSource("x".repeat(120), "longish", "javascript");
const unwrapped = card.codeCardLayout(longish, { ...base, wrap: false }, undefined, room);
assert.equal(unwrapped.lines.length, 1);
assert.ok(unwrapped.width > room);
const wrapped = card.codeCardLayout(longish, base, undefined, room);
assert.ok(wrapped.lines.length > 1);
assert.ok(wrapped.width <= room);
assert.equal(wrapped.cardWidth, room - base.paddingX * 2);
const drawnWrapped = card.drawCodeCard(measuring, longish, base, null, room);
assert.ok(drawnWrapped.lines.length > 1);
assert.ok(drawnWrapped.width <= room);
checks.push("wrapping keeps the card inside the stage it is previewed in");

// A wrapped line ends at a space when it has one, so a break lands between
// words instead of through them — cutting at a fixed column put "Promise" over
// two lines. Only a word longer than the whole line is broken.
const sentences = card.cardSource("const promise = loadTemplates(root, options); ".repeat(4), "words", "javascript");
const wordLines = card
  .splitTokenLines(sentences.tokens, 30)
  .map((line) => line.map((token) => token.text).join(""));
assert.ok(wordLines.length > 1);
assert.ok(wordLines.every((line) => line.length <= 30));
assert.ok(wordLines.slice(0, -1).every((line) => line.endsWith(" ")));
const unbroken = card
  .splitTokenLines(card.cardSource("y".repeat(50), "y", "auto").tokens, 24)
  .map((line) => line.map((token) => token.text).join(""));
assert.deepEqual(unbroken.map((line) => line.length), [24, 24, 2]);
checks.push("a wrapped line ends at a space, and only a word longer than the line is cut");

// The canvas behind the window is the palette's ground, a chosen hex, or
// nothing at all for a transparent export.
const ground = card.resolvePalette("nord", null);
assert.equal(card.resolveBackground({ ...base, background: "host" }, ground), ground.background);
assert.equal(card.resolveBackground({ ...base, background: "#4a90e2" }, ground), "#4a90e2");
assert.equal(card.resolveBackground({ ...base, background: "transparent" }, ground), null);
checks.push("the background resolves to the palette, a hex, or transparent");

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
assert.equal(lightHost.gutter, "#888888");
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
  for (const field of ["surface", "background", "shadow", "ink", "muted", "gutter", "accent"]) {
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
        for name in ("card", "bridge", "format"):
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
            "a one-line source is re-indented and the author's layout is kept",
            "a tab becomes four spaces in the drawn line",
            "a wide character takes two cells in the drawn line",
            "line splitting keeps each token's kind and the card paints it",
            "the source limit truncates once and marks the cut",
            "the window band is constant and the shadow never moves the geometry",
            "gutter, font size, line height and padding grow the layout within the ceiling",
            "auto width follows the measured glyphs and keeps a floor for the window controls",
            "wrapping keeps the card inside the stage it is previewed in",
            "a wrapped line ends at a space, and only a word longer than the line is cut",
            "the background resolves to the palette, a hex, or transparent",
            "the host palette follows the host tokens and stored palettes do not",
            "every stored palette is complete",
            "the theme channel applies known tokens and ignores malformed ones",
            "save, copy and close keep their v3 message shapes",
        ])


if __name__ == "__main__":
    unittest.main()
