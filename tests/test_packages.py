from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import hashlib
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parent.parent
PLUGINS = ROOT / "plugins"
DIST = ROOT / "dist"

sys.path.insert(0, str(ROOT / "scripts"))
import index_metadata  # noqa: E402
import vendor_prettier  # noqa: E402


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
    def test_packaging_validates_v3_commands(self) -> None:
        packaging = load_packaging()
        # A pure capability: forms and an output entity, no placement at all.
        packaging.validate_target(
            {"id": "format", "forms": ["text"], "output": ["text"]},
            "mypaste.format-json",
        )
        # A placed command, and one that only returns a result to its surface.
        packaging.validate_target(
            {"id": "push", "forms": ["text", "file"], "placement": ["palette", "trigger"]},
            "com.mypaste.ferry",
        )
        packaging.validate_target(
            {"id": "highlight", "forms": ["text"]},
            "mypaste.highlight-json",
        )
        invalid = [
            {"id": "format"},
            {"id": "format", "forms": []},
            {"id": "format", "forms": "text"},
            {"id": "format", "forms": [["text"]]},
            {"id": "format", "forms": ["pdf"]},
            {"id": "format", "forms": ["text", "text"]},
            {"id": "format", "forms": ["text"], "output": ["text/plain"]},
            {"id": "format", "forms": ["text"], "placement": "palette"},
            {"id": "format", "forms": ["text"], "placement": ["toolbar"]},
            {"id": "format", "forms": ["text"], "placement": ["palette", "palette"]},
            {"id": "", "forms": ["text"]},
            # Vocabulary v3 removed: a manifest that still names it is v2.
            {"id": "format", "forms": ["text"], "surface": "editor"},
            {"id": "format", "forms": ["text"], "languages": ["json"]},
            {"id": "format", "forms": ["text"], "input": ["text"]},
            {"id": "format", "forms": ["text"], "capabilities": ["entity.read"]},
            {"id": "sync", "surface": "data-action"},
        ]
        stderr = io.StringIO()
        for command in invalid:
            with contextlib.redirect_stderr(stderr), self.assertRaises(SystemExit):
                packaging.validate_target(command, "mypaste.format-json")

    def test_packaging_validates_package_kind(self) -> None:
        packaging = load_packaging()
        surface = {"entry": "preview.html", "forms": ["text"], "role": "open"}
        # The protocol lets a manifest omit `kind`; the shape then decides.
        self.assertEqual(packaging.resolve_kind({"surface": surface}, "p"), "ui")
        self.assertEqual(packaging.resolve_kind({}, "p"), "command")
        self.assertEqual(
            packaging.resolve_kind({"surface": surface, "kind": "ui"}, "p"), "ui")
        self.assertEqual(packaging.resolve_kind({"kind": "command"}, "p"), "command")
        invalid = [
            {"kind": "ui"},                      # no surface
            {"kind": "command", "surface": surface},
            {"kind": "worker"},
        ]
        stderr = io.StringIO()
        for manifest in invalid:
            with contextlib.redirect_stderr(stderr), self.assertRaises(SystemExit):
                packaging.resolve_kind(manifest, "p")

    def test_every_package_has_valid_manifest(self) -> None:
        packaging = load_packaging()
        legacy_keys = {"menu", "menus", "workbench", "appliesTo", "global"}
        legacy_command_keys = {
            "surface", "input", "languages", "capabilities", "menu",
            "workbench", "appliesTo", "global",
        }
        packages = sorted(p for p in PLUGINS.iterdir()
                          if p.is_dir() and not p.name.startswith("."))
        self.assertGreaterEqual(len(packages), 22)
        for package in packages:
            manifest = json.loads((package / "mypaste.plugin.json").read_text())
            self.assertEqual(manifest["manifestVersion"], 3)
            self.assertFalse(legacy_keys & set(manifest), manifest["id"])
            capabilities = set(manifest.get("capabilities", []))
            self.assertLessEqual(capabilities, packaging.SERVICES, manifest["id"])
            runtime = manifest.get("runtime")
            if runtime:
                self.assertIn(runtime["mode"], {"command", "resident"})
                self.assertTrue(runtime.get("entrypoint"))
            # Protocol v3 derives a package's kind from its shape, but every
            # manifest here declares it and must agree: a page makes a `ui`
            # package, no page makes a `command` package.
            self.assertIn(manifest.get("kind"), {"ui", "command"}, manifest["id"])
            self.assertEqual(
                manifest["kind"],
                "ui" if manifest.get("surface") is not None else "command",
                manifest["id"],
            )
            # A surface names its page, the entity subtree it adapts and one of
            # the two roles. Languages are the surface's own concern, never a
            # manifest declaration (protocol v3 has no `languages`).
            surface = manifest.get("surface")
            if surface is not None:
                self.assertIn(surface["role"], packaging.SURFACE_ROLES)
                self.assertTrue(surface.get("forms"), manifest["id"])
                self.assertNotIn("languages", surface)
            # The eight headless highlight and eight headless format packages
            # have no surface at all: they are pure capabilities the surfaces
            # reach through the registry.
            if (manifest["id"].startswith("mypaste.highlight-")
                    or manifest["id"].startswith("mypaste.format-")):
                self.assertEqual(capabilities, {"entity.read"})
                self.assertNotIn("surface", manifest)
            for command in manifest.get("commands", []):
                self.assertTrue(command.get("forms"), manifest["id"])
                self.assertFalse(set(command) & legacy_command_keys,
                                 (manifest["id"], command["id"]))
                for placement in command.get("placement", []):
                    self.assertIn(placement, packaging.PLACEMENTS)
                for form in command["forms"]:
                    self.assertIn(form, packaging.FORMS)
                for output in command.get("output", []):
                    self.assertIn(output, packaging.FORMS)

    def test_index_declares_each_package_runtime_protocol(self) -> None:
        # The host filters catalog entries by this field before listing them,
        # so a package built for another protocol never reaches the install
        # offer and the manifest rejection never has to happen at install time.
        index = json.loads((DIST / "index.json").read_text())
        self.assertGreaterEqual(len(index["packages"]), 22)
        for entry in index["packages"]:
            manifest = json.loads(
                (PLUGINS / entry["id"] / "mypaste.plugin.json").read_text()
            )
            # A surface package runs no process and declares no runtime;
            # the index says exactly that with zero.
            self.assertEqual(
                entry["runtimeProtocol"],
                2 if "runtime" in manifest else 0,
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
                "capabilities": ["entity.read"],
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
                "capabilities": ["entity.read"],
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
                "capabilities": ["entity.read"],
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
            "capabilities": ["entity.read"],
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
            "capabilities": ["entity.read"],
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
            "capabilities": ["entity.read"],
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
                "capabilities": ["entity.read"],
                "selection": {"id": 1, "kind": "text", "title": "x", "text": source},
            })
            self.assertTrue(response["ok"], (language, response))
            self.assertGreater(len(response["result"]["output"]), 0)

    def test_archives_exclude_python_caches(self) -> None:
        build_packages()
        archives = sorted((ROOT / "dist").glob("*.mypaste-plugin"))
        self.assertGreaterEqual(len(archives), 22)
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
        self.assertGreaterEqual(len(index["packages"]), 22)
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
                "id", "name", "version", "kind", "description", "fileName",
                "sha256", "runtimeProtocol", "repository",
            }
            # The project address belongs to the feed, not to any package: one
            # module owns it, and every entry must declare the same one.
            self.assertEqual(entry["repository"], index_metadata.repository())
            self.assertEqual(set(entry), entry_keys)
            self.assertEqual(entry["kind"], manifest.get("kind", "command"))
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

    def test_surface_packages_ship_one_page_and_no_binary(self) -> None:
        build_packages()
        index = json.loads((DIST / "index.json").read_text(encoding="utf-8"))
        by_id = {entry["id"]: entry for entry in index["packages"]}
        roles = {
            "com.mypaste.code-card": "preview",
            "com.mypaste.diff-view": "open",
            "com.mypaste.image-edit": "open",
        }
        for plugin_id, role in roles.items():
            package = PLUGINS / plugin_id
            manifest = json.loads(
                (package / "mypaste.plugin.json").read_text(encoding="utf-8"))
            surface = manifest.get("surface")
            self.assertIsNotNone(surface, plugin_id)
            self.assertNotIn("runtime", manifest, plugin_id)
            self.assertEqual(surface["role"], role, plugin_id)
            self.assertTrue(surface["forms"], plugin_id)
            self.assertNotIn("languages", surface, plugin_id)
            self.assertTrue(manifest["commands"], plugin_id)
            for command in manifest["commands"]:
                self.assertTrue(command.get("placement"), plugin_id)
                self.assertTrue(command.get("forms"), plugin_id)
                self.assertNotIn("capabilities", command, plugin_id)
                self.assertNotIn("pageAction", command, plugin_id)

            document = surface["entry"]
            archive = DIST / f"{plugin_id}-{manifest['version']}.mypaste-plugin"
            with zipfile.ZipFile(archive) as bundle:
                self.assertEqual(
                    sorted(bundle.namelist()),
                    sorted(["mypaste.plugin.json", document]),
                    plugin_id,
                )
                page = bundle.read(document)
            # The archive ships the built page itself: the script is already
            # bundled in, and no placeholder survives. A template may be a
            # complete document or a fragment the host wraps, so the test does
            # not insist on a doctype.
            text = page.decode("utf-8")
            self.assertNotIn("<!--bundle-->", text, plugin_id)
            self.assertIn("<script>", text, plugin_id)
            self.assertLessEqual(len(page), 1 << 20, plugin_id)

            entry = by_id[plugin_id]
            self.assertEqual(entry["runtimeProtocol"], 0, plugin_id)

    def test_code_edit_ships_its_page_runtime_and_private_engines(self) -> None:
        # Protocol v3's UI package with a runtime: one archive holds the page,
        # the dispatcher and the private formatting engines, and only this
        # package's surface can reach the internal commands.
        package = PLUGINS / "com.mypaste.code-edit"
        manifest = json.loads(
            (package / "mypaste.plugin.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["kind"], "ui")
        index = json.loads((DIST / "index.json").read_text(encoding="utf-8"))
        entry = next(item for item in index["packages"]
                     if item["id"] == "com.mypaste.code-edit")
        self.assertEqual(entry["kind"], "ui")
        self.assertEqual(entry["runtimeProtocol"], 2)
        self.assertEqual(manifest["runtime"], {
            "mode": "command", "entrypoint": "code-edit",
        })
        internal = [
            command for command in manifest["commands"]
            if not command.get("placement")
        ]
        self.assertTrue(internal)
        for command in internal:
            self.assertEqual(command["forms"], ["text"])
            self.assertEqual(command["output"], ["text"])
        placed = [
            command for command in manifest["commands"] if command.get("placement")
        ]
        self.assertEqual([command["id"] for command in placed],
                         ["clipboard.code-edit"])

        archive = DIST / f"{package.name}-{manifest['version']}.mypaste-plugin"
        self.assertLess(archive.stat().st_size, 16 * 1024 * 1024)
        with zipfile.ZipFile(archive) as bundle:
            names = set(bundle.namelist())
            self.assertIn("mypaste.plugin.json", names)
            self.assertIn("preview.html", names)
            self.assertIn("code-edit", names)
            for engine in ("js_format.mjs", "prettier.mjs"):
                self.assertIn(f"engines/{engine}", names)
            # The formatting engines are Go code inside the binary; the old
            # Python helpers are gone and must not come back.
            for retired in ("format_cli.py", "format_json.py"):
                self.assertNotIn(f"engines/{retired}", names)
            self.assertNotIn("<!--bundle-->", bundle.read("preview.html").decode())

    def test_code_edit_archive_carries_the_pinned_prettier(self) -> None:
        # CSS and YAML must format without a tool on the user's machine, so
        # the archive carries Prettier's standalone build, the two parser
        # plugins and the MIT license — never the CLI or all of node_modules.
        package = PLUGINS / "com.mypaste.code-edit"
        manifest = json.loads(
            (package / "mypaste.plugin.json").read_text(encoding="utf-8"))
        version = vendor_prettier.pinned_version(ROOT)
        archive = DIST / f"{package.name}-{manifest['version']}.mypaste-plugin"
        self.assertLess(archive.stat().st_size, 16 * 1024 * 1024)
        with zipfile.ZipFile(archive) as bundle:
            names = set(bundle.namelist())
            for name in ("standalone.mjs", "plugins/postcss.mjs",
                         "plugins/yaml.mjs", "LICENSE", "VERSION"):
                self.assertIn(f"engines/prettier/{name}", names)
            self.assertEqual(
                bundle.read("engines/prettier/VERSION").decode("utf-8"),
                f"prettier {version}\nhttps://github.com/prettier/prettier\n",
            )
            license_text = bundle.read("engines/prettier/LICENSE").decode("utf-8")
            self.assertIn("James Long and contributors", license_text)
            self.assertIn("Permission is hereby granted", license_text)
            self.assertNotIn("engines/prettier/bin/prettier.cjs", names)
            total = sum(item.file_size for item in bundle.infolist())
            self.assertLessEqual(total, 64 * 1024 * 1024)
            for item in bundle.infolist():
                self.assertLessEqual(item.file_size, 16 * 1024 * 1024, item.filename)

    def extracted_code_edit(self) -> tuple[Path, tempfile.TemporaryDirectory]:
        # The archive's own binary, unpacked next to its page and engines.
        package = PLUGINS / "com.mypaste.code-edit"
        manifest = json.loads(
            (package / "mypaste.plugin.json").read_text(encoding="utf-8"))
        archive = DIST / f"{package.name}-{manifest['version']}.mypaste-plugin"
        temp = tempfile.TemporaryDirectory(prefix="mypaste-code-edit-")
        with zipfile.ZipFile(archive) as bundle:
            bundle.extractall(temp.name)
        runtime = Path(temp.name) / "code-edit"
        runtime.chmod(0o755)
        return runtime, temp

    def hermetic_environment(self, temp: str) -> dict[str, str]:
        # No formatter on PATH: the only tools this runtime may reach are the
        # ones in its own package.
        empty = Path(temp) / "empty-path"
        empty.mkdir(exist_ok=True)
        return {
            "PATH": str(empty),
            "HOME": temp,
            "TMPDIR": temp,
            "LANG": "en_US.UTF-8",
        }

    def invoke_packaged(
        self, runtime: Path, command: str, source: str, environment: dict[str, str]
    ) -> dict:
        done = subprocess.run(
            [str(runtime)],
            input=json.dumps({
                "protocolVersion": 2,
                "id": "test",
                "method": "invoke",
                "commandId": command,
                "selection": {"text": source},
            }) + "\n",
            text=True, capture_output=True, timeout=30,
            cwd=str(runtime.parent), env=environment,
        )
        self.assertEqual(done.returncode, 0, done.stderr)
        return json.loads(done.stdout)

    def test_packaged_runtime_formats_every_language_without_helpers(self) -> None:
        # Every formatter is compiled into the binary. This copy has its
        # optional Node helpers removed and a PATH with no formatter tool, so
        # only the in-process engines can answer — the case of a machine with
        # nothing installed.
        if sys.platform != "darwin" or platform.machine() != "arm64":
            self.skipTest("official binaries target darwin/arm64")
        runtime, temp = self.extracted_code_edit()
        with temp:
            shutil.rmtree(Path(temp.name) / "engines")
            environment = self.hermetic_environment(temp.name)
            cases = [
                ("format.go", "package main\nfunc main(){println(1)}\n",
                 "package main\n\nfunc main() { println(1) }\n"),
                ("format.javascript", "const a = 1;  \r\n", "const a = 1;\n"),
                ("format.typescript", "const a: number = 1;\n", "const a: number = 1;\n"),
                ("format.python", "def f():\r\n    x = 1   \r\n", "def f():\n    x = 1\n"),
                ("format.rust", "fn main() {}\n", "fn main() {}\n"),
                ("format.php", "<?php echo 1;\n", "<?php echo 1;\n"),
                ("format.html", "<p>hi</p>\n", "<p>hi</p>\n"),
                ("format.css", "a{color:red}", "a {\n  color:red;\n}\n"),
                ("format.json", '{"a":1}', '{\n  "a": 1\n}\n'),
                ("format.yaml", "a: 1\r\nb:\r\n  - 2\r\n", "a: 1\nb:\n  - 2\n"),
                ("format.shell", "echo hi  \r\n", "echo hi\n"),
                ("format.sql", "select 1;", "select 1;"),
                ("compress.sql", "select  1;", "select 1;"),
            ]
            for command, source, expected in cases:
                payload = self.invoke_packaged(runtime, command, source, environment)
                self.assertTrue(payload["ok"], (command, payload))
                self.assertEqual(payload["result"]["output"], expected, command)

    def test_bundled_prettier_formats_css_and_yaml_when_node_exists(self) -> None:
        # Node is optional: when it exists the package's own Prettier build
        # improves CSS and YAML. PATH holds node and nothing else, so the
        # formatter still cannot come from the machine.
        node = shutil.which("node")
        if not node:
            self.skipTest("node is not installed")
        if sys.platform != "darwin" or platform.machine() != "arm64":
            self.skipTest("official binaries target darwin/arm64")
        runtime, temp = self.extracted_code_edit()
        with temp:
            environment = self.hermetic_environment(temp.name)
            environment["PATH"] = str(Path(node).parent)
            cases = [
                ("format.css", "a{color:red;margin:0}",
                 "a {\n  color: red;\n  margin: 0;\n}\n"),
                ("format.yaml", "a:   1\nb:\n  - 2", "a: 1\nb:\n  - 2\n"),
            ]
            for command, source, expected in cases:
                payload = self.invoke_packaged(runtime, command, source, environment)
                self.assertTrue(payload["ok"], (command, payload))
                self.assertEqual(payload["result"]["output"], expected, command)

    def test_shared_engines_have_one_owner(self) -> None:
        # The private copy is the shipping asset; its source stays in shared/
        # so the editor cannot drift from the reviewed engine. The Python
        # predecessors are gone from code-edit: formatting now runs in the Go
        # binary.
        self.assertEqual(
            (PLUGINS / "com.mypaste.code-edit" / "src" / "engines" / "js_format.mjs").read_bytes(),
            (ROOT / "shared" / "js_format.mjs").read_bytes(),
            "engines/js_format.mjs",
        )
        # SQL has exactly one implementation: both modules compile the shared
        # sqlkit package through a local replace.
        for module in ("plugins/com.mypaste.sql/src", "plugins/com.mypaste.code-edit/src"):
            go_mod = (ROOT / module / "go.mod").read_text(encoding="utf-8")
            self.assertIn("shared/sqlkit", go_mod, module)
            self.assertIn("=> ../../../shared/sqlkit", go_mod, module)

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
