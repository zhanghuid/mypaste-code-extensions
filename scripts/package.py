#!/usr/bin/env python3
"""Build ZIP-root .mypaste-plugin archives without third-party dependencies."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import stat
import sys
import zipfile

ROOT = Path(__file__).resolve().parent.parent
PLUGINS = ROOT / "plugins"
DIST = ROOT / "dist"
MAX_FILE = 16 * 1024 * 1024
MAX_TOTAL = 64 * 1024 * 1024


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
    return manifest


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


def build(package: Path) -> Path:
    manifest = validate(package)
    name = package.name
    version = manifest["version"]
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
    return target


def main() -> None:
    if not PLUGINS.is_dir():
        fail("missing plugins directory")
    DIST.mkdir(exist_ok=True)
    built = []
    for package in plugin_dirs():
        built.append(build(package))
    for path in built:
        print(path.relative_to(ROOT))
        print(path.with_suffix(path.suffix + ".sha256").relative_to(ROOT))


if __name__ == "__main__":
    main()
