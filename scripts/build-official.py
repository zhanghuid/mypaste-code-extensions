#!/usr/bin/env python3
"""Build and publish the official extension packages.

The packages under plugins/*/ that this script owns (OFFICIAL below) come in
two shapes, and the shipped archive never contains the source tree:

- a compiled Go program (manifest, optional assets, one built binary — or, for
  a package with a `targets` list, one binary per platform under
  `bin/<goos>/<goarch>/`);
- a surface document (manifest plus the one HTML page `surface.entry` names,
  bundled from src/ by scripts/build-surfaces.mjs);
- or both: a UI package that also declares a runtime and internal commands
  (com.mypaste.code-edit), which ships its page, its binary, its private
  engine files and the pinned Prettier runtime in one archive.

Installation is the trust decision (D-1039 in the MyPaste host repository):
the feed carries no signature, and the host does not read one. Publishing is
therefore just the deterministic build below plus the package digest.

    python3 scripts/build-official.py
    python3 scripts/build-official.py --only com.mypaste.ferry

Everything is deterministic for review: fixed Go build flags, fixed zip
timestamps, one entry per package in dist/index.json with its SHA-256.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import zipfile
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
from index_metadata import repository  # noqa: E402
from official_packages import OFFICIAL  # noqa: E402
import vendor_prettier  # noqa: E402

DIST = ROOT / "dist"
INDEX_VERSION = 1
ZIP_TIME = (2026, 1, 1, 0, 0, 0)
# Protocol v3 keeps the v2 child-process line protocol. The host rejects a
# runtime package whose manifest does not say so, before it reads any file.
RUNTIME_PROTOCOL = 2


def fail(message: str) -> None:
    print(f"error: {message}", file=sys.stderr)
    raise SystemExit(1)


def build_binary(spec: dict, staging: Path) -> None:
    module = ROOT / spec["module"]
    targets = spec.get("targets") or [{
        "goos": spec["goos"], "goarch": spec["goarch"],
    }]
    for target in targets:
        # A single-target package keeps the flat layout the first host knew:
        # the binary sits beside the manifest. A multi-target package nests
        # one binary per platform under bin/<goos>/<goarch>/, which the host
        # resolves through (D-1057 in the host repository).
        if len(targets) == 1:
            output = staging / spec["entrypoint"]
        else:
            name = spec["entrypoint"]
            if target["goos"] == "windows":
                name += ".exe"
            output = staging / "bin" / target["goos"] / target["goarch"] / name
        output.parent.mkdir(parents=True, exist_ok=True)
        environment = dict(os.environ,
                           CGO_ENABLED="0", GOOS=target["goos"],
                           GOARCH=target["goarch"])
        # -buildvcs=false keeps the binary out of the commit history: without
        # it Go stamps the repository revision into the executable, so every
        # rebuild of an unchanged package produced a new archive under the
        # same version.
        done = subprocess.run(
            ["go", "build", "-trimpath", "-buildvcs=false", "-o", str(output),
             spec["package"]],
            cwd=module, env=environment, capture_output=True, text=True)
        if done.returncode != 0:
            fail(f"go build failed:\n{done.stderr.strip()}")


def build_surface(plugin_id: str, output: Path) -> None:
    done = subprocess.run(
        ["node", "scripts/build-surfaces.mjs", "--package", plugin_id,
         "--out", str(output)],
        cwd=ROOT, capture_output=True, text=True)
    if done.returncode != 0:
        fail(f"surface build failed:\n{done.stderr.strip()}")


def package_kind(manifest: dict, plugin_id: str) -> str:
    """The package's kind, which must agree with its shape (protocol v3)."""
    # A UI package either owns an entry surface or a settings-window menu tab
    # (D-1085). A runtime with neither is a command package.
    has_page = manifest.get("surface") is not None or bool(manifest.get("menus"))
    expected = "ui" if has_page else "command"
    kind = manifest.get("kind", expected)
    if kind not in {"ui", "command"} or kind != expected:
        fail(f"{plugin_id}: kind {kind!r} does not match its shape "
             f"({expected!r})")
    return kind


def copy_asset(source: Path, staging: Path, asset: str, destination: str) -> None:
    if (not destination or destination.startswith("/")
            or ".." in Path(destination).parts):
        fail(f"{source.name}: invalid asset destination {destination}")
    asset_path = source / asset
    if not asset_path.is_file():
        fail(f"{source.name}: missing asset {asset}")
    target = staging / destination
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(asset_path, target)


def stage_package(plugin_id: str, spec: dict, staging: Path) -> dict:
    source = ROOT / "plugins" / plugin_id
    manifest_path = source / "mypaste.plugin.json"
    if not manifest_path.is_file():
        fail(f"{plugin_id}: missing mypaste.plugin.json")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("id") != plugin_id:
        fail(f"{plugin_id}: manifest id does not match the directory")
    package_kind(manifest, plugin_id)
    runtime = manifest.get("runtime")
    if runtime is not None and runtime.get("protocolVersion") != RUNTIME_PROTOCOL:
        fail(f"{plugin_id}: runtime protocolVersion must be {RUNTIME_PROTOCOL}")
    shutil.copyfile(manifest_path, staging / "mypaste.plugin.json")
    if spec.get("surface"):
        # The page's own path comes from the manifest: the host reads it from
        # `surface.entry`, so staging and serving cannot disagree about it.
        document = manifest.get("surface", {}).get("entry", "")
        if not document:
            fail(f"{plugin_id}: spec declares a surface but the manifest has none")
        build_surface(plugin_id, staging / document)
    if spec.get("module"):
        # `assets` is either a list (copied at the same relative path) or a
        # mapping (source path -> archive path) for packages whose private
        # files should not ship under their source directory.
        assets = spec.get("assets", [])
        if isinstance(assets, dict):
            for asset, destination in assets.items():
                copy_asset(source, staging, asset, destination)
        else:
            for asset in assets:
                copy_asset(source, staging, asset, asset)
        build_binary(spec, staging)
    if spec.get("prettier"):
        # A build dependency whose runtime subset ships beside the package's
        # engines; the version is pinned by package.json and checked here. A
        # string names the destination with the editor's default parsers; a
        # mapping also names the parser plugins this package's engines import.
        prettier = spec["prettier"]
        if isinstance(prettier, dict):
            destination = prettier.get("destination")
            plugins = tuple(prettier.get("plugins") or vendor_prettier.DEFAULT_PLUGINS)
        else:
            destination = prettier
            plugins = vendor_prettier.DEFAULT_PLUGINS
        if (not isinstance(destination, str) or not destination
                or destination.startswith("/")
                or ".." in Path(destination).parts):
            fail(f"{plugin_id}: invalid prettier destination {destination}")
        vendor_prettier.vendor(ROOT, staging / destination, plugins)
    if not spec.get("surface") and not spec.get("module"):
        fail(f"{plugin_id}: spec declares neither a surface nor a module")
    return manifest


def write_archive(plugin_id: str, manifest: dict, staging: Path) -> Path:
    version = manifest["version"]
    target = DIST / f"{plugin_id}-{version}.mypaste-plugin"
    with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED,
                         compresslevel=9) as archive:
        for path in sorted(staging.rglob("*")):
            if path.is_dir():
                continue
            info = zipfile.ZipInfo(path.relative_to(staging).as_posix())
            info.date_time = ZIP_TIME
            info.compress_type = zipfile.ZIP_DEFLATED
            # Every staged file is published executable by the installer only
            # for the declared entrypoint; the archive keeps 0755 for all so
            # the mode survives the round-trip through other unzip tools.
            info.external_attr = (stat.S_IFREG | 0o755) << 16
            archive.writestr(info, path.read_bytes())
    return target


def record_digest(target: Path) -> str:
    digest = hashlib.sha256(target.read_bytes()).hexdigest()
    target.with_suffix(target.suffix + ".sha256").write_text(
        f"{digest}  {target.name}\n", encoding="utf-8")
    return digest


def prune_stale(plugin_id: str, version: str) -> None:
    """Remove archives this script built for earlier versions of one package.

    A v3 release supersedes every v2 archive for the same id; the marketplace
    must never list two protocols for one package, so the predecessor goes the
    same way scripts/package.py treats its own. The delete is bounded to this
    id's `<id>-<version>.mypaste-plugin` files and their digests.
    """
    keep = f"{plugin_id}-{version}.mypaste-plugin"
    for stale in sorted(DIST.glob(f"{plugin_id}-*.mypaste-plugin")):
        if stale.name == keep:
            continue
        stale.unlink()
        stale.with_suffix(stale.suffix + ".sha256").unlink(missing_ok=True)


def update_index(entry: dict) -> None:
    index_path = DIST / "index.json"
    index = json.loads(index_path.read_text(encoding="utf-8"))
    packages = [item for item in index.get("packages", [])
                if item.get("id") != entry["id"]]
    packages.append(entry)
    packages.sort(key=lambda item: (item["name"], item["id"]))
    index_path.write_text(json.dumps({
        "version": INDEX_VERSION,
        "generated": date.today().isoformat(),
        "packages": packages,
    }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--only", choices=sorted(OFFICIAL),
                        help="build one official package instead of all")
    args = parser.parse_args()

    DIST.mkdir(exist_ok=True)
    for plugin_id, spec in sorted(OFFICIAL.items()):
        if args.only and plugin_id != args.only:
            continue
        with tempfile.TemporaryDirectory(prefix="mypaste-official-") as temp:
            staging = Path(temp) / plugin_id
            staging.mkdir()
            manifest = stage_package(plugin_id, spec, staging)
            prune_stale(plugin_id, manifest["version"])
            target = write_archive(plugin_id, manifest, staging)
            sha256 = record_digest(target)
            update_index({
                "id": manifest["id"],
                "name": manifest["name"],
                "version": manifest["version"],
                "kind": package_kind(manifest, plugin_id),
                "description": manifest.get("description", ""),
                "fileName": target.name,
                "sha256": sha256,
                # A surface package declares no runtime; zero says exactly
                # that, and the host keeps such entries. A command package
                # speaks the child-process protocol v3 inherited from v2.
                "runtimeProtocol": 2 if "runtime" in manifest else 0,
                # The project address the marketplace detail page shows. It is
                # feed metadata: the manifest never carries it, so older hosts
                # keep installing the same package.
                "repository": repository(),
            })
            print(target.relative_to(ROOT))


if __name__ == "__main__":
    main()
