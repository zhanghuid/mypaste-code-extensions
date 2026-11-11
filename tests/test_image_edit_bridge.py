"""The image editor's surface bridge, including the host's theme message.

The editor used to paint its own fixed warm palette: its frame's
`prefers-color-scheme` follows the system, while the host resolves the scheme
from the appearance chosen in MyPaste (D-1042). This test bundles the package's
own bridge exactly as the surface build does and drives the messages the host
really sends, so the editor is held to the same token contract as the code pages
(D-1043): the scheme lands on `data-scheme`, token values become `--mp-*`, and a
token name the protocol does not allow is dropped rather than written.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PACKAGE = ROOT / "plugins" / "com.mypaste.image-edit"
ESBUILD = ROOT / "node_modules" / ".bin" / "esbuild"
NODE = shutil.which("node")

RUNNER = r"""
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const dir = process.argv[2];
const posted = [];
const listeners = [];
const applied = {};
const parent = { postMessage: (message) => posted.push(message) };
globalThis.document = {
  documentElement: {
    dataset: {},
    style: { setProperty: (name, value) => { applied[name] = value; } },
  },
};
globalThis.parent = parent;
globalThis.window = {
  parent,
  // A dark system with a light application is the case the guess exists for.
  matchMedia: () => ({ matches: true }),
  addEventListener(type, listener) {
    if (type === "message") listeners.push(listener);
  },
};

const { connectSurface } = await import(pathToFileURL(path.join(dir, "bridge.mjs")));

function emit(data) {
  for (const listener of listeners) listener({ source: parent, data });
}
const checks = [];

const bridge = connectSurface();
assert.deepEqual(posted[0], { v: 1, type: "ready" });
checks.push("ready is the first message and carries nothing else");

assert.equal(document.documentElement.dataset.scheme, "dark");
checks.push("before the host answers, the system appearance is the guess");

const image = { kind: "image", title: "shot", mime: "image/png", dataURL: "data:image/png;base64,AA" };
let received = null;
bridge.onItem((item) => { received = item; });
emit({ v: 1, type: "item", item: image });
assert.deepEqual(received, image);
assert.deepEqual(bridge.item, image);
checks.push("the image item reaches onItem and the bridge");

emit({ v: 1, type: "theme", scheme: "light", tokens: { ink: "#101010", "bad name": "x" } });
assert.equal(document.documentElement.dataset.scheme, "light");
assert.equal(applied["--mp-ink"], "#101010");
assert.equal(applied["--mp-bad name"], undefined);
checks.push("the theme sets the host's scheme and only valid token names");

emit({ v: 1, type: "theme", scheme: "sepia", tokens: { ink: "#000" } });
assert.equal(document.documentElement.dataset.scheme, "light");
checks.push("a scheme outside the protocol changes nothing");

const saving = bridge.save("data:image/png;base64,BB", "edited");
const saveMessage = posted.at(-1);
assert.equal(saveMessage.type, "save");
assert.equal(saveMessage.image.title, "edited");
assert.equal(typeof saveMessage.requestId, "number");
emit({ v: 1, type: "result", requestId: saveMessage.requestId, ok: true, id: 42 });
const saved = await saving;
assert.equal(saved.ok, true);
assert.equal(saved.id, 42);
checks.push("save keeps its host result path");

const copying = bridge.copy("data:image/png;base64,CC");
const copyMessage = posted.at(-1);
assert.equal(copyMessage.type, "copy");
assert.equal(copyMessage.image.dataURL, "data:image/png;base64,CC");
emit({ v: 1, type: "result", requestId: copyMessage.requestId, ok: true });
assert.equal((await copying).ok, true);
checks.push("copy keeps its host result path");

bridge.close();
assert.deepEqual(posted.at(-1), { v: 1, type: "close" });
checks.push("close is one message with no request id");

console.log(JSON.stringify(checks));
"""


class ImageEditBridgeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        if NODE is None or not ESBUILD.exists():
            raise unittest.SkipTest("node and esbuild are needed for the bridge test")
        cls.temp = tempfile.TemporaryDirectory()
        work = Path(cls.temp.name)
        built = subprocess.run(
            [
                str(ESBUILD),
                str(PACKAGE / "src" / "bridge.ts"),
                "--bundle",
                "--format=esm",
                "--platform=neutral",
                "--log-level=error",
                f"--outfile={work / 'bridge.mjs'}",
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

    def test_surface_messages_and_theme(self) -> None:
        if self.result.returncode != 0:
            self.fail(
                "bridge runner failed:\n"
                f"stdout:\n{self.result.stdout}\nstderr:\n{self.result.stderr}"
            )
        checks = json.loads(self.result.stdout.strip().splitlines()[-1])
        self.assertEqual(checks, [
            "ready is the first message and carries nothing else",
            "before the host answers, the system appearance is the guess",
            "the image item reaches onItem and the bridge",
            "the theme sets the host's scheme and only valid token names",
            "a scheme outside the protocol changes nothing",
            "save keeps its host result path",
            "copy keeps its host result path",
            "close is one message with no request id",
        ])


if __name__ == "__main__":
    unittest.main()
