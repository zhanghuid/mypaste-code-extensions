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
# The host owns the content-form tree (D-1060); a package may only name nodes
# the host declares, and the host re-checks the declaration before running a
# command. A form matches its whole subtree, so "text" covers plain and rich.
FORMS = {
    "text", "plain", "rich", "link", "color", "media", "image", "audio",
    "video", "file", "document", "archive", "folder", "other",
}
TEXT_FORMS = {"text", "plain", "rich"}
SURFACES = {"renderer", "palette", "editor", "workbench", "data-action"}


def fail(message: str) -> None:
    print(f"error: {message}", file=sys.stderr)
    raise SystemExit(1)


def plugin_dirs() -> list[Path]:
    # Official packages are compiled binaries owned by build-official.py with
    # their own capability model; this script would reject their manifests, so
    # it never looks at them.
    from official_packages import OFFICIAL
    return sorted(p for p in PLUGINS.iterdir()
                  if p.is_dir() and not p.name.startswith(".")
                  and p.name not in OFFICIAL)


def validate(package: Path) -> dict:
    manifest_path = package / "mypaste.plugin.json"
    if not manifest_path.is_file():
        fail(f"{package.name}: missing mypaste.plugin.json")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("manifestVersion") != 2:
        fail(f"{package.name}: manifestVersion must be 2")
    if "menu" in manifest:
        fail(f"{package.name}: manifestVersion 2 uses menus, not menu")
    runtime = manifest.get("runtime")
    if not runtime or runtime.get("protocolVersion") != 2:
        fail(f"{package.name}: runtime protocolVersion must be 2")
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
    """Every command declares its content forms, its surface and its languages.

    The declaration is the protocol contract with the host: the host filters
    each surface by it, and the page matches the form subtree and the language
    before offering the command (D-1060, D-1063). A command without `forms` is
    form-agnostic; a command that names a language must sit under `text`.
    """
    surface = command.get("surface", "palette")
    if surface not in SURFACES:
        fail(f"{package_name}: unknown surface {surface!r}")
    forms = command.get("forms", [])
    if not isinstance(forms, list):
        fail(f"{package_name}: forms must be a list")
    if not all(isinstance(form, str) for form in forms):
        fail(f"{package_name}: forms must be strings")
    unknown = set(forms) - FORMS
    if unknown:
        fail(f"{package_name}: unknown forms {sorted(unknown)}")
    if len(set(forms)) != len(forms):
        fail(f"{package_name}: duplicate form in {command.get('id')}")
    if surface == "data-action":
        if forms or command.get("languages"):
            fail(f"{package_name}: data actions declare no forms or languages")
    elif not forms:
        fail(f"{package_name}: command {command.get('id')} must declare forms")
    languages = command.get("languages", [])
    if not isinstance(languages, list):
        fail(f"{package_name}: languages must be a list")
    for language in languages:
        if language == "*":
            continue
        if not isinstance(language, str) or not LANGUAGE.match(language):
            fail(f"{package_name}: invalid language {language!r}")
    if len(set(languages)) != len(languages):
        fail(f"{package_name}: duplicate language in {command.get('id')}")
    if "*" in languages and len(languages) > 1:
        fail(f"{package_name}: wildcard language must stand alone")
    if languages and not set(forms) <= TEXT_FORMS:
        fail(f"{package_name}: only text forms may declare languages")
    capabilities = set(command.get("capabilities", []))
    if surface == "renderer" and "selection.render" not in capabilities:
        fail(f"{package_name}: renderer commands must declare selection.render")
    if surface == "editor":
        if "selection.read" not in capabilities:
            fail(f"{package_name}: editor commands must declare selection.read")
        if "text/plain" not in command.get("output", []):
            fail(f"{package_name}: editor commands must output text/plain")
    if surface == "workbench" and capabilities:
        fail(f"{package_name}: workbench commands do not start a process")
    if surface == "data-action" and not capabilities:
        fail(f"{package_name}: data actions must declare a capability")


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
    runtime_protocol = manifest["runtime"].get("protocolVersion", 0)
    if not isinstance(runtime_protocol, int) or runtime_protocol < 1:
        fail(f"{package.name}: invalid runtime protocolVersion")
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
    # Earlier versions go only after this manifest validated, so a broken
    # package never destroys the last good archive.
    prune_stale(name, version)
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
    from index_metadata import repository
    return {
        "id": plugin_id,
        "name": display_name,
        "version": version,
        "description": description,
        "fileName": target.name,
        "sha256": digest,
        "runtimeProtocol": runtime_protocol,
        "repository": repository(),
    }


def prune_stale(package_name: str, version: str) -> None:
    """Remove archives this script built for earlier versions of one package.

    Without this, every version bump leaves its predecessor in `dist/`, and a
    directory scan of the repository finds two packages for one plugin id. The
    delete is bounded: only `<package>-<other version>.mypaste-plugin` files and
    their `.sha256` companions, which this script is the only writer of.
    """
    keep = f"{package_name}-{version}.mypaste-plugin"
    for stale in sorted(DIST.glob(f"{package_name}-*.mypaste-plugin")):
        if stale.name == keep:
            continue
        stale.unlink()
        stale.with_suffix(stale.suffix + ".sha256").unlink(missing_ok=True)


def write_index(packages: list[dict]) -> Path:
    seen: set[str] = set()
    for package in packages:
        plugin_id = package["id"]
        if plugin_id in seen:
            fail(f"duplicate plugin id: {plugin_id}")
        seen.add(plugin_id)
    # Official packages are not built here, so their entries still belong in
    # the index. Carry them over; only the feed's own metadata is restamped. A
    # stale entry for an id this run did build is replaced by the fresh one.
    from official_packages import OFFICIAL
    if (DIST / "index.json").is_file():
        previous = json.loads((DIST / "index.json").read_text(encoding="utf-8"))
        from index_metadata import repository
        for entry in previous.get("packages", []):
            if entry.get("id") not in seen and entry.get("id") in OFFICIAL:
                # The project address belongs to the feed, not to the package,
                # so an entry carried over from an older run is stamped here.
                entry["repository"] = repository()
                packages.append(entry)
    packages.sort(key=lambda item: (item["name"], item["id"]))
    index = {
        "version": INDEX_VERSION,
        "generated": date.today().isoformat(),
        "packages": packages,
    }
    # Every entry carries the protocol its manifest declares, so a host can
    # drop packages it cannot run before offering them to the user.
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
