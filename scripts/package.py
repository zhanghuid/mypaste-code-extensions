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
# The feed's `runtimeProtocol` is the child-process line protocol, which v3
# keeps from v2 (PLUGINS.md section 8). Every run-script package speaks it;
# a surface package runs no process and the official builder writes zero.
RUNTIME_PROTOCOL = 2
# The host owns the content-form tree (D-1060); a package may only name nodes
# the host declares, and the host re-checks the declaration before running a
# command. A form matches its whole subtree, so "text" covers plain and rich.
FORMS = {
    "text", "plain", "rich", "link", "color", "media", "image", "audio",
    "video", "file", "document", "archive", "folder", "other",
}
# Protocol v3's closed service list (PLUGINS.md section 6). A package may ask
# for a subset; asking for anything else is not a v3 manifest.
SERVICES = {
    "entity.read", "entity.save", "copy", "clipboard.write", "entry.payload",
    "secret.read", "network.outbound", "storage.plugin", "companion.read",
    "history.exchange",
}
# Where the host shows a command. A command without one is a pure capability:
# it is never shown, only reached through the registry by a surface.
PLACEMENTS = {"palette", "card-action", "trigger"}
SURFACE_ROLES = {"open", "preview"}
# Vocabulary v3 removed. A package that still names it is a v2 manifest that
# only changed its version number.
LEGACY_KEYS = {"menu", "menus", "workbench", "appliesTo", "global"}
LEGACY_COMMAND_KEYS = {
    "surface", "input", "languages", "capabilities", "menu", "workbench",
    "appliesTo", "global",
}


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
    if manifest.get("manifestVersion") != 3:
        fail(f"{package.name}: manifestVersion must be 3")
    legacy = LEGACY_KEYS & set(manifest)
    if legacy:
        fail(f"{package.name}: protocol v3 has no {sorted(legacy)}")
    runtime = manifest.get("runtime")
    if not runtime or runtime.get("mode") not in {"command", "resident"}:
        fail(f"{package.name}: runtime mode must be command or resident")
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
    unknown = capabilities - SERVICES
    if unknown:
        fail(f"{package.name}: unsupported capabilities {sorted(unknown)}")
    surface = manifest.get("surface")
    if surface is not None:
        validate_surface(surface, package.name)
    for command in manifest.get("commands", []):
        validate_target(command, package.name)
    return manifest


def validate_forms(forms: object, package_name: str, owner: str) -> None:
    if not isinstance(forms, list) or not forms:
        fail(f"{package_name}: {owner} must declare forms")
    if not all(isinstance(form, str) for form in forms):
        fail(f"{package_name}: forms must be strings")
    unknown = set(forms) - FORMS
    if unknown:
        fail(f"{package_name}: unknown forms {sorted(unknown)}")
    if len(set(forms)) != len(forms):
        fail(f"{package_name}: duplicate form in {owner}")


def validate_surface(surface: object, package_name: str) -> None:
    """A v3 surface names its page, the entities it adapts, and its role."""
    if not isinstance(surface, dict):
        fail(f"{package_name}: surface must be an object")
    entry = surface.get("entry")
    if (not isinstance(entry, str) or not entry or entry.startswith("/")
            or ".." in Path(entry).parts):
        fail(f"{package_name}: invalid surface entry")
    if surface.get("role") not in SURFACE_ROLES:
        fail(f"{package_name}: surface role must be open or preview")
    validate_forms(surface.get("forms"), package_name, "surface")


def validate_target(command: dict, package_name: str) -> None:
    """A v3 command declares the entities it reads and where it is shown.

    `forms` is the input entity type (a leaf or a whole parent such as `text`);
    `output` is the entity type it produces, and is absent when the command
    only returns a result the surface consumes. `placement` is optional: a
    command without one is a pure capability, shown nowhere, reached only
    through the registry by a surface.
    """
    legacy = LEGACY_COMMAND_KEYS & set(command)
    if legacy:
        fail(f"{package_name}: command {command.get('id')} uses v2 fields "
             f"{sorted(legacy)}")
    if not isinstance(command.get("id"), str) or not command["id"]:
        fail(f"{package_name}: command id must be a non-empty string")
    name = f"command {command['id']}"
    validate_forms(command.get("forms"), package_name, name)
    output = command.get("output")
    if output is not None:
        validate_forms(output, package_name, f"{name} output")
    placement = command.get("placement", [])
    if not isinstance(placement, list) or not all(
            isinstance(place, str) for place in placement):
        fail(f"{package_name}: {name} placement must be a list")
    unknown = set(placement) - PLACEMENTS
    if unknown:
        fail(f"{package_name}: {name} has unknown placements {sorted(unknown)}")
    if len(set(placement)) != len(placement):
        fail(f"{package_name}: duplicate placement in {name}")


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
    runtime_protocol = RUNTIME_PROTOCOL
    if manifest["runtime"].get("mode") not in {"command", "resident"}:
        fail(f"{package.name}: invalid runtime mode")
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
