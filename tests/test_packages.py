from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import unittest
import zipfile

ROOT = Path(__file__).resolve().parent.parent
PLUGINS = ROOT / "plugins"


def invoke(package: Path, request: dict) -> dict:
    entry = package / "run"
    result = subprocess.run(
        [str(entry)],
        input=json.dumps(request, ensure_ascii=False) + "\n",
        text=True,
        capture_output=True,
        timeout=10,
        cwd=package,
        env={
            **os.environ,
            "PATH": "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:" + os.environ.get("PATH", ""),
        },
    )
    if result.returncode != 0:
        raise AssertionError(f"{package.name} failed: {result.stderr}")
    return json.loads(result.stdout)


class PackageTests(unittest.TestCase):
    def test_every_package_has_valid_manifest(self) -> None:
        packages = sorted(p for p in PLUGINS.iterdir() if p.is_dir())
        self.assertGreaterEqual(len(packages), 16)
        for package in packages:
            manifest = json.loads((package / "mypaste.plugin.json").read_text())
            self.assertEqual(manifest["manifestVersion"], 1)
            self.assertEqual(manifest["runtime"]["protocolVersion"], 1)
            self.assertTrue((package / manifest["runtime"]["entrypoint"]).is_file())
            capabilities = set(manifest.get("capabilities", []))
            if manifest["id"].startswith("mypaste.highlight-"):
                self.assertEqual(capabilities, {"selection.render"})
            elif manifest["id"].startswith("mypaste.format-"):
                self.assertEqual(capabilities, {"selection.read", "clipboard.write"})

    def test_highlighting_all_languages(self) -> None:
        fixtures = {
            "go": "package main\n\nfunc main() { println(\"hi\") }\n",
            "json": '{"name":"MyPaste","private":true}\n',
            "javascript": "const answer = 42;\nconsole.log(answer);\n",
            "typescript": "interface Item { id: number }\nconst item: Item = { id: 1 };\n",
            "html": "<!doctype html>\n<main class=\"app\">Hello</main>\n",
            "php": "<?php\nfunction greet(string $name): string {\n  return \"Hi \" . $name;\n}\n",
            "python": "def load_items():\n    return [1, 2, 3]\n",
            "rust": "pub struct Item { pub id: i64 }\n\nfn main() { println!(\"hi\"); }\n",
        }
        for language, source in fixtures.items():
            package = PLUGINS / f"mypaste.highlight-{language}"
            response = invoke(package, {
                "protocolVersion": 1,
                "id": "test-id",
                "method": "invoke",
                "commandId": "highlight",
                "capabilities": ["selection.render"],
                "render": True,
                "selection": {"id": 1, "kind": "text", "title": "x", "text": source},
            })
            self.assertTrue(response["ok"], response)
            render = response["result"]["render"]
            self.assertEqual(render["language"], language)
            self.assertGreater(len(render["tokens"]), 0)
            for token in render["tokens"]:
                self.assertIn(token["kind"], {
                    "", "keyword", "string", "comment", "number", "literal",
                    "property", "function", "tag", "type",
                })
            self.assertEqual("".join(token["text"] for token in render["tokens"]), source)

    def test_formatting_all_available_languages(self) -> None:
        fixtures = {
            "go": ("package main\nfunc main(){println(\"hi\")}\n", "func main()"),
            "javascript": ("function run(){\nconst x={a:1};\nreturn x;\n}\n", "  const x={a:1};"),
            "typescript": ("interface Item {\nid: number;\n}\nconst x: Item={id:1};\n", "  id: number;"),
            "html": ("<!doctype html><html><body><p>Hello</p></body></html>\n", "<html"),
            "php": ("<?php\nfunction greet($name){return \"Hi \".$name;}\n", "function greet"),
            "python": ("def load():\n\treturn [1,2]\n", "def load():"),
            "rust": ("fn main(){println!(\"hi\");}\n", "fn main()"),
        }
        for language, (source, expected) in fixtures.items():
            package = PLUGINS / f"mypaste.format-{language}"
            response = invoke(package, {
                "protocolVersion": 1,
                "id": "test-id",
                "method": "invoke",
                "commandId": "format",
                "capabilities": ["selection.read", "clipboard.write"],
                "selection": {"id": 1, "kind": "text", "title": "x", "text": source},
            })
            self.assertTrue(response["ok"], (language, response))
            self.assertEqual(response["result"]["effect"], "copy")
            self.assertIn(expected, response["result"]["output"])
            self.assertGreater(len(response["result"]["output"]), 0)

    def test_formatting_failures_never_return_partial_output(self) -> None:
        fixtures = {
            "go": "package main\nfunc main( {\n",
            "javascript": "const = ;\nfunction {\n",
            "typescript": "interface {\n",
            "html": "<div><span></div>\n",
            "php": "<?php function ( {\n",
            "python": "def load(:\n",
            "rust": "fn main( {\n",
        }
        for language, source in fixtures.items():
            package = PLUGINS / f"mypaste.format-{language}"
            response = invoke(package, {
                "protocolVersion": 1,
                "id": "test-id",
                "method": "invoke",
                "commandId": "format",
                "capabilities": ["selection.read", "clipboard.write"],
                "selection": {"id": 1, "kind": "text", "title": "x", "text": source},
            })
            self.assertFalse(response["ok"], (language, response))
            self.assertNotIn("result", response)

    def test_formatting_json(self) -> None:
        package = PLUGINS / "mypaste.format-json"
        source = '{"a":1,"b":[true,null]}'
        response = invoke(package, {
            "protocolVersion": 1,
            "id": "test-id",
            "method": "invoke",
            "commandId": "format",
            "capabilities": ["selection.read", "clipboard.write"],
            "selection": {"id": 1, "kind": "text", "title": "x", "text": source},
        })
        self.assertTrue(response["ok"], response)
        self.assertIn('  "a": 1', response["result"]["output"])
        self.assertEqual(response["result"]["effect"], "copy")

    def test_formatting_rejects_invalid_source_without_partial_output(self) -> None:
        package = PLUGINS / "mypaste.format-json"
        response = invoke(package, {
            "protocolVersion": 1,
            "id": "test-id",
            "method": "invoke",
            "commandId": "format",
            "capabilities": ["selection.read", "clipboard.write"],
            "selection": {"id": 1, "kind": "text", "title": "x", "text": "{\"a\":"},
        })
        self.assertFalse(response["ok"])
        self.assertNotIn("result", response)

    def test_archives_exclude_python_caches(self) -> None:
        subprocess.run(
            ["python3", "scripts/package.py"],
            cwd=ROOT,
            check=True,
            capture_output=True,
            text=True,
        )
        archives = sorted((ROOT / "dist").glob("*.mypaste-plugin"))
        self.assertGreaterEqual(len(archives), 16)
        for archive in archives:
            with zipfile.ZipFile(archive) as bundle:
                names = bundle.namelist()
            self.assertFalse(
                any("__pycache__" in name or name.endswith(".pyc") for name in names),
                archive.name,
            )


if __name__ == "__main__":
    unittest.main()
