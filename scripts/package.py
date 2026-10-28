#!/usr/bin/env python3
"""Build ZIP-root packages and the deterministic repository index."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
from datetime import date
import zipfile

ROOT = Path(__file__).resolve().parent.parent
PLUGINS = ROOT / "plugins"
DIST = ROOT / "dist"
MAX_FILE = 16 * 1024 * 1024
MAX_TOTAL = 64 * 1024 * 1024
INDEX_VERSION = 1
MAX_INDEX_NAME = 72
MAX_INDEX_DESCRIPTION = 280
MAX_INDEX_ID = 96
MAX_INDEX_VERSION = 32
PLUGIN_ID = re.compile(r"^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9-]*)+$")
PLUGIN_VERSION = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$")
LANGUAGE = re.compile(r"^[a-z][a-z0-9+#-]*$")
# The host owns the clipboard item kinds; a package may only declare kinds it
# knows, and the host re-checks the declaration before running a command.
TARGET_KINDS = {"text", "rich_text", "image", "link", "file", "color"}
TEXT_KINDS = {"text", "rich_text"}


def fail(message: str) -> None:
    print(f"error: {message}", file=sys.stderr)
    raise SystemExit(1)


def plugin_dirs() -> list[Path]:
    return sorted(p for p in PLUGINS.iterdir() if p.is_dir() and not p.name.startswith("."))


def validate(package: Path) -> dict:
    manifest_path = package / "mypaste.plugin.json"
    if not manifest_path.is_file():
        fail(f"{package.name}: missing mypaste.plugin.json")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("manifestVersion") != 1:
        fail(f"{package.name}: manifestVersion must be 1")
    runtime = manifest.get("runtime")
    if not runtime or runtime.get("protocolVersion") != 1:
        fail(f"{package.name}: runtime protocolVersion must be 1")
    entrypoint = runtime.get("entrypoint", "")
    if not entrypoint or entrypoint.startswith("/") or ".." in Path(entrypoint).parts:
        fail(f"{package.name}: invalid entrypoint")
    entry = package / entrypoint
    if not entry.is_file():
        fail(f"{package.name}: missing entrypoint {entrypoint}")
    mode = entry.stat().st_mode
    if os.name != "nt" and not mode & stat.S_IXUSR:
        fail(f"{package.name}: entrypoint must be executable")
    capabilities = set(manifest.get("capabilities", []))
    allowed = {"selection.read", "clipboard.write", "selection.render"}
    unknown = capabilities - allowed
    if unknown:
        fail(f"{package.name}: unsupported capabilities {sorted(unknown)}")
    for command in manifest.get("commands", []):
        unknown = set(command.get("capabilities", [])) - allowed
        if unknown:
            fail(f"{package.name}: unsupported command capabilities {sorted(unknown)}")
        validate_target(command, package.name)
    return manifest


def validate_target(command: dict, package_name: str) -> None:
    """Every command declares what it acts on and which languages it serves.

    The declaration is the protocol contract with the host: the host filters
    the command list by kind and binds the preview formatter and highlighter
    by the declared language, so an undeclared command is unusable there.
    """
    applies_to = command.get("appliesTo")
    if not isinstance(applies_to, list) or not applies_to:
        fail(f"{package_name}: command {command.get('id')} must declare appliesTo")
    if not all(isinstance(kind, str) for kind in applies_to):
        fail(f"{package_name}: target kinds must be strings")
    unknown = set(applies_to) - TARGET_KINDS
    if unknown:
        fail(f"{package_name}: unknown target kinds {sorted(unknown)}")
    if len(set(applies_to)) != len(applies_to):
        fail(f"{package_name}: duplicate target kind in {command.get('id')}")
    languages = command.get("languages")
    if not isinstance(languages, list) or not languages:
        fail(f"{package_name}: command {command.get('id')} must declare languages")
    for language in languages:
        if not isinstance(language, str) or not LANGUAGE.match(language):
            fail(f"{package_name}: invalid language {language!r}")
    if len(set(languages)) != len(languages):
        fail(f"{package_name}: duplicate language in {command.get('id')}")
    if not set(applies_to) <= TEXT_KINDS:
        fail(f"{package_name}: only text commands may declare languages")


def files_for(package: Path) -> list[Path]:
    files: list[Path] = []
    total = 0
    for path in sorted(package.rglob("*")):
        relative = path.relative_to(package)
        if "__pycache__" in relative.parts or path.suffix == ".pyc":
            continue
        if path.is_symlink():
            fail(f"{path}: symlinks are not allowed")
        if not path.is_file() or path.name in {".DS_Store"} or path.name.startswith("._"):
            continue
        size = path.stat().st_size
        if size > MAX_FILE:
            fail(f"{path}: file is too large")
        total += size
        if total > MAX_TOTAL:
            fail(f"{package.name}: package is too large")
        files.append(path)
    return files


def build(package: Path) -> dict:
    manifest = validate(package)
    name = package.name
    version = manifest["version"]
    plugin_id = manifest.get("id", "")
    display_name = manifest.get("name", "")
    description = manifest.get("description", "")
    if not isinstance(plugin_id, str) or not PLUGIN_ID.match(plugin_id):
        fail(f"{package.name}: invalid id")
    if len(plugin_id) > MAX_INDEX_ID:
        fail(f"{package.name}: id is too long")
    if not isinstance(version, str) or len(version) > MAX_INDEX_VERSION or not PLUGIN_VERSION.match(version):
        fail(f"{package.name}: invalid version")
    if not isinstance(display_name, str) or not display_name.strip():
        fail(f"{package.name}: missing name")
    if len(display_name) > MAX_INDEX_NAME:
        fail(f"{package.name}: name is too long")
    if not isinstance(description, str) or len(description) > MAX_INDEX_DESCRIPTION:
        fail(f"{package.name}: invalid description")
    if "\x00" in display_name or "\x00" in description:
        fail(f"{package.name}: metadata contains NUL")
    target = DIST / f"{name}-{version}.mypaste-plugin"
    with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for path in files_for(package):
            relative = path.relative_to(package).as_posix()
            info = zipfile.ZipInfo(relative)
            info.date_time = (2026, 1, 1, 0, 0, 0)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = (stat.S_IFREG | 0o644) << 16
            if path.name == manifest["runtime"]["entrypoint"] or os.access(path, os.X_OK):
                info.external_attr = (stat.S_IFREG | 0o755) << 16
            archive.writestr(info, path.read_bytes())
    digest = hashlib.sha256(target.read_bytes()).hexdigest()
    target.with_suffix(target.suffix + ".sha256").write_text(f"{digest}  {target.name}\n", encoding="utf-8")
    return {
        "id": plugin_id,
        "name": display_name,
        "version": version,
        "description": description,
        "fileName": target.name,
        "sha256": digest,
    }


def write_index(packages: list[dict]) -> Path:
    seen: set[str] = set()
    for package in packages:
        plugin_id = package["id"]
        if plugin_id in seen:
            fail(f"duplicate plugin id: {plugin_id}")
        seen.add(plugin_id)
    packages.sort(key=lambda item: (item["name"], item["id"]))
    index = {
        "version": INDEX_VERSION,
        "generated": date.today().isoformat(),
        "packages": packages,
    }
    target = DIST / "index.json"
    target.write_text(
        json.dumps(index, ensure_ascii=False, indent=2, sort_keys=False) + "\n",
        encoding="utf-8",
    )
    return target


def main() -> None:
    if not PLUGINS.is_dir():
        fail("missing plugins directory")
    DIST.mkdir(exist_ok=True)
    built = []
    for package in plugin_dirs():
        built.append(build(package))
    index = write_index(built)
    for entry in built:
        path = DIST / entry["fileName"]
        print(path.relative_to(ROOT))
        print(path.with_suffix(path.suffix + ".sha256").relative_to(ROOT))
    print(index.relative_to(ROOT))


if __name__ == "__main__":
    main()
