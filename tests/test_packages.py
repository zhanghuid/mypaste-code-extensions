from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import hashlib
import os
from pathlib import Path
import re
import subprocess
import sys
import unittest
import zipfile

ROOT = Path(__file__).resolve().parent.parent
PLUGINS = ROOT / "plugins"
DIST = ROOT / "dist"

sys.path.insert(0, str(ROOT / "scripts"))
import index_metadata  # noqa: E402


def official_ids() -> set[str]:
    spec = importlib.util.spec_from_file_location(
        "official_packages", ROOT / "scripts" / "official_packages.py")
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(module)
    return set(module.OFFICIAL)


def build_packages() -> None:
    subprocess.run(
        ["python3", "scripts/package.py"],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
    )


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


def load_packaging():
    spec = importlib.util.spec_from_file_location(
        "mypaste_packaging", ROOT / "scripts" / "package.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class PackageTests(unittest.TestCase):
    def test_packaging_rejects_undeclared_commands(self) -> None:
        packaging = load_packaging()
        packaging.validate_target(
            {"id": "format", "appliesTo": ["text", "rich_text"], "languages": ["json"]},
            "mypaste.format-json",
        )
        invalid = [
            {"id": "format", "languages": ["json"]},
            {"id": "format", "appliesTo": [], "languages": ["json"]},
            {"id": "format", "appliesTo": "text", "languages": ["json"]},
            {"id": "format", "appliesTo": [["text"]], "languages": ["json"]},
            {"id": "format", "appliesTo": ["pdf"], "languages": ["json"]},
            {"id": "format", "appliesTo": ["text", "text"], "languages": ["json"]},
            {"id": "format", "appliesTo": ["text"]},
            {"id": "format", "appliesTo": ["text"], "languages": ["JSON"]},
            {"id": "format", "appliesTo": ["text"], "languages": ["json", "json"]},
            {"id": "format", "appliesTo": ["image"], "languages": ["json"]},
        ]
        stderr = io.StringIO()
        for command in invalid:
            with contextlib.redirect_stderr(stderr), self.assertRaises(SystemExit):
                packaging.validate_target(command, "mypaste.format-json")

    def test_every_package_has_valid_manifest(self) -> None:
        official = official_ids()
        # Official packages are compiled by build-official.py; their source
        # tree holds no entrypoint binary and their capability model is the
        # official one, not the run-script allowlist.
        packages = sorted(p for p in PLUGINS.iterdir()
                          if p.is_dir() and p.name not in official)
        self.assertGreaterEqual(len(packages), 16)
        for package in packages:
            manifest = json.loads((package / "mypaste.plugin.json").read_text())
            self.assertEqual(manifest["manifestVersion"], 1)
            self.assertEqual(manifest["runtime"]["protocolVersion"], 2)
            self.assertTrue((package / manifest["runtime"]["entrypoint"]).is_file())
            capabilities = set(manifest.get("capabilities", []))
            language = manifest["id"].rsplit("-", 1)[-1]
            if manifest["id"].startswith("mypaste.highlight-"):
                self.assertEqual(capabilities, {"selection.render"})
            elif manifest["id"].startswith("mypaste.format-"):
                self.assertEqual(capabilities, {"selection.read", "clipboard.write"})
            # Every command declares what it acts on. MyPaste filters the
            # command palette by these kinds and binds the preview formatter
            # and highlighter by the declared language, so a package without
            # the declaration silently stops being usable there.
            command = manifest["commands"][0]
            self.assertEqual(command["appliesTo"], ["text", "rich_text"])
            self.assertEqual(command["languages"], [language])

    def test_index_declares_each_package_runtime_protocol(self) -> None:
        # The host filters catalog entries by this field before listing them,
        # so a package built for another protocol never reaches the install
        # offer and the manifest rejection never has to happen at install time.
        index = json.loads((DIST / "index.json").read_text())
        self.assertGreaterEqual(len(index["packages"]), 16)
        for entry in index["packages"]:
            manifest = json.loads(
                (PLUGINS / entry["id"] / "mypaste.plugin.json").read_text()
            )
            # A workbench package runs no process and declares no runtime;
            # the index says exactly that with zero.
            self.assertEqual(
                entry["runtimeProtocol"],
                manifest.get("runtime", {}).get("protocolVersion", 0),
            )

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
                "protocolVersion": 2,
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
                "protocolVersion": 2,
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
                "protocolVersion": 2,
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
            "protocolVersion": 2,
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
            "protocolVersion": 2,
            "id": "test-id",
            "method": "invoke",
            "commandId": "format",
            "capabilities": ["selection.read", "clipboard.write"],
            "selection": {"id": 1, "kind": "text", "title": "x", "text": "{\"a\":"},
        })
        self.assertFalse(response["ok"])
        self.assertNotIn("result", response)

    def test_formatting_json_applies_the_declared_indent(self) -> None:
        package = PLUGINS / "mypaste.format-json"
        source = '{"a":1,"b":[true,null]}'
        request = {
            "protocolVersion": 2,
            "id": "test-id",
            "method": "invoke",
            "commandId": "format",
            "capabilities": ["selection.read", "clipboard.write"],
            "selection": {"id": 1, "kind": "text", "title": "x", "text": source},
        }
        wide = invoke(package, {**request, "settings": {"indent": 6}})
        self.assertTrue(wide["ok"], wide)
        self.assertIn('      "a": 1', wide["result"]["output"])
        # A host that sends nothing, or a value outside the declared range,
        # still formats: the manifest default is the fallback, not an error.
        self.assertIn('  "a": 1', invoke(package, request)["result"]["output"])
        self.assertIn(
            '  "a": 1',
            invoke(package, {**request, "settings": {"indent": 12}})["result"]["output"],
        )

    def test_formatting_accepts_text_above_the_former_32kib_wall(self) -> None:
        # The host bounds extension text at extension.MaxTextBytes (256 KiB).
        # A formatter that invents a smaller ceiling rejects text the host has
        # already delivered, so every adapter must accept what it receives.
        pad = "a" * (64 * 1024)
        cases = {
            "go": "package main\n\nvar pad = \"" + pad + "\"\n",
            "javascript": "const pad = \"" + pad + "\";\n",
            "json": '{"pad":"' + pad + '"}',
            "python": "pad = \"" + pad + "\"\n",
        }
        for language, source in cases.items():
            package = PLUGINS / f"mypaste.format-{language}"
            response = invoke(package, {
                "protocolVersion": 2,
                "id": "test-id",
                "method": "invoke",
                "commandId": "format",
                "capabilities": ["selection.read", "clipboard.write"],
                "selection": {"id": 1, "kind": "text", "title": "x", "text": source},
            })
            self.assertTrue(response["ok"], (language, response))
            self.assertGreater(len(response["result"]["output"]), 0)

    def test_archives_exclude_python_caches(self) -> None:
        build_packages()
        archives = sorted((ROOT / "dist").glob("*.mypaste-plugin"))
        self.assertGreaterEqual(len(archives), 16)
        for archive in archives:
            with zipfile.ZipFile(archive) as bundle:
                names = bundle.namelist()
            self.assertFalse(
                any("__pycache__" in name or name.endswith(".pyc") for name in names),
                archive.name,
            )

    def test_multi_target_archives_ship_one_binary_per_platform(self) -> None:
        # D-1057 in the host repository: a package with a targets list nests
        # one binary per platform under bin/<goos>-<goarch>/ (".exe" on
        # windows), while single-target packages keep the flat layout.
        sys.path.insert(0, str(ROOT / "scripts"))
        import official_packages  # noqa: E402

        spec = official_packages.OFFICIAL["com.mypaste.sql"]
        archive = next(
            path for path in DIST.glob("com.mypaste.sql-*.mypaste-plugin")
        )
        with zipfile.ZipFile(archive) as bundle:
            names = bundle.namelist()
        expected = {
            f"bin/{target['goos']}/{target['goarch']}/"
            + ("sql.exe" if target["goos"] == "windows" else "sql")
            for target in spec["targets"]
        }
        self.assertEqual(expected, expected & set(names))
        self.assertIn("mypaste.plugin.json", names)
        flat = next(
            path for path in DIST.glob("com.mypaste.ferry-*.mypaste-plugin")
        )
        with zipfile.ZipFile(flat) as bundle:
            self.assertIn("ferry", bundle.namelist())
            self.assertFalse(any(name.startswith("bin/") for name in bundle.namelist()))

    def test_dist_index_covers_every_package_with_verified_digests(self) -> None:
        build_packages()
        index = json.loads((DIST / "index.json").read_text(encoding="utf-8"))
        self.assertEqual(index["version"], 1)
        self.assertRegex(index["generated"], r"^\d{4}-\d{2}-\d{2}$")

        manifests = [
            (
                json.loads((package / "mypaste.plugin.json").read_text()),
                package,
            )
            for package in PLUGINS.iterdir()
            if package.is_dir()
        ]
        manifests.sort(key=lambda item: item[0]["id"])
        self.assertEqual(len(index["packages"]), len(manifests))
        self.assertGreaterEqual(len(index["packages"]), 16)
        by_id = {item["id"]: item for item in index["packages"]}
        self.assertEqual(len(by_id), len(index["packages"]))
        self.assertEqual(
            set(by_id),
            {manifest["id"] for manifest, _ in manifests},
        )

        for manifest, package in manifests:
            entry = by_id[manifest["id"]]
            archive = DIST / entry["fileName"]
            self.assertEqual(
                entry["fileName"],
                f"{package.name}-{manifest['version']}.mypaste-plugin",
            )
            self.assertEqual(entry["name"], manifest["name"])
            self.assertEqual(entry["version"], manifest["version"])
            self.assertEqual(entry["description"], manifest.get("description", ""))
            self.assertRegex(entry["sha256"], r"^[0-9a-f]{64}$")
            self.assertEqual(
                entry["sha256"],
                hashlib.sha256(archive.read_bytes()).hexdigest(),
            )
            self.assertEqual(
                (DIST / f"{entry['fileName']}.sha256").read_text(
                    encoding="utf-8",
                ),
                f"{entry['sha256']}  {entry['fileName']}\n",
            )
            # D-1039: installation is the trust decision, so the feed carries
            # no signature and every entry has the same field set.
            entry_keys = {
                "id", "name", "version", "description", "fileName", "sha256",
                "runtimeProtocol", "repository",
            }
            # The project address belongs to the feed, not to any package: one
            # module owns it, and every entry must declare the same one.
            self.assertEqual(entry["repository"], index_metadata.repository())
            self.assertEqual(set(entry), entry_keys)
            self.assertLessEqual(len(entry["id"]), 96)
            self.assertLessEqual(len(entry["name"]), 72)
            self.assertLessEqual(len(entry["description"]), 280)
            self.assertRegex(entry["version"], r"^\d+\.\d+\.\d+$")
            self.assertIsNone(re.search(r"[/\\\x00]", entry["fileName"]))

        # `dist/` holds exactly what the index lists. A leftover archive from an
        # earlier version looks like a second package for the same plugin id to
        # anything that scans the directory instead of reading the index.
        self.assertEqual(
            {path.name for path in DIST.glob("*.mypaste-plugin")},
            {entry["fileName"] for entry in index["packages"]},
        )
        self.assertEqual(
            {path.name for path in DIST.glob("*.mypaste-plugin.sha256")},
            {f"{entry['fileName']}.sha256" for entry in index["packages"]},
        )

    def test_workbench_packages_ship_one_document_and_no_binary(self) -> None:
        build_packages()
        index = json.loads((DIST / "index.json").read_text(encoding="utf-8"))
        by_id = {entry["id"]: entry for entry in index["packages"]}
        for plugin_id in (
            "com.mypaste.code-card",
            "com.mypaste.code-edit",
            "com.mypaste.diff-view",
            "com.mypaste.image-edit",
        ):
            package = PLUGINS / plugin_id
            manifest = json.loads(
                (package / "mypaste.plugin.json").read_text(encoding="utf-8"))
            workbench = manifest.get("workbench")
            self.assertIsNotNone(workbench, plugin_id)
            self.assertNotIn("runtime", manifest, plugin_id)
            # D-1041: only the two editing documents answer a preview
            # double-click; the export card and the comparison stay on the
            # command panel.
            if plugin_id in ("com.mypaste.code-edit", "com.mypaste.image-edit"):
                self.assertIs(workbench.get("editor"), True, plugin_id)
            else:
                self.assertNotIn("editor", workbench, plugin_id)
            # D-1040: a document asks for a second text with the one word the
            # host knows; anything else fails installation on the host side.
            companion = workbench.get("companion")
            if companion is not None:
                self.assertEqual(companion, "previous-text", plugin_id)
            self.assertTrue(manifest["commands"], plugin_id)
            for command in manifest["commands"]:
                self.assertTrue(command.get("workbench"), plugin_id)
                self.assertTrue(command.get("appliesTo"), plugin_id)
                self.assertNotIn("capabilities", command, plugin_id)
                self.assertNotIn("pageAction", command, plugin_id)

            document = workbench["document"]
            archive = DIST / f"{plugin_id}-{manifest['version']}.mypaste-plugin"
            with zipfile.ZipFile(archive) as bundle:
                self.assertEqual(
                    sorted(bundle.namelist()),
                    sorted(["mypaste.plugin.json", document]),
                    plugin_id,
                )
                fragment = bundle.read(document)
            # The host serves the document as a fragment it wraps itself: it
            # must not carry a document skeleton, and its script must already
            # be bundled in.
            text = fragment.decode("utf-8")
            head = text.lstrip().lower()
            self.assertFalse(head.startswith("<!doctype"), plugin_id)
            self.assertFalse(head.startswith("<html"), plugin_id)
            self.assertNotIn("<!--bundle-->", text, plugin_id)
            self.assertIn("<script>", text, plugin_id)
            self.assertLessEqual(len(fragment), 1 << 20, plugin_id)

            entry = by_id[plugin_id]
            self.assertEqual(entry["runtimeProtocol"], 0, plugin_id)

    def test_dist_index_is_deterministic(self) -> None:
        build_packages()
        first = (DIST / "index.json").read_bytes()
        build_packages()
        self.assertEqual(first, (DIST / "index.json").read_bytes())


if __name__ == "__main__":
    unittest.main()


class IndexMetadataTests(unittest.TestCase):
    """The feed's own metadata has one owner and one shape.

    The host rejects the entire feed over one malformed repository address, so
    a bad value must fail here rather than at every user's marketplace page.
    """

    def test_repository_is_the_project_root(self) -> None:
        value = index_metadata.repository()
        self.assertTrue(value.startswith("https://"))
        self.assertFalse(value.endswith("/"))
        self.assertLessEqual(len(value), index_metadata.MAX_REPOSITORY)

    def test_repository_refuses_what_the_host_refuses(self) -> None:
        original = index_metadata.REPOSITORY
        try:
            for bad in (
                "http://github.com/example/extensions",
                "https://user:pass@github.com/example/extensions",
                "https://github.com/example/extensions?ref=main",
                "https://github.com/example/extensions#readme",
                "ftp://github.com/example/extensions",
                "https://" + "a" * 300 + ".test",
            ):
                index_metadata.REPOSITORY = bad
                with self.assertRaises(ValueError, msg=bad):
                    index_metadata.repository()
        finally:
            index_metadata.REPOSITORY = original
