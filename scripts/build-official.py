#!/usr/bin/env python3
"""Build and publish the official extension packages.

The packages under plugins/*/ that this script owns (OFFICIAL below) come in
two shapes, and the shipped archive never contains the source tree:

- a compiled Go program (manifest, menu page, one built binary);
- a workbench document (manifest plus the one HTML fragment the host serves,
  bundled from src/ by scripts/build-workbenches.mjs). A workbench package
  runs no process, so it carries no binary at all.

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

DIST = ROOT / "dist"
INDEX_VERSION = 1
ZIP_TIME = (2026, 1, 1, 0, 0, 0)


def fail(message: str) -> None:
    print(f"error: {message}", file=sys.stderr)
    raise SystemExit(1)


def build_binary(spec: dict, staging: Path) -> None:
    module = ROOT / spec["module"]
    output = staging / spec["entrypoint"]
    environment = dict(os.environ,
                       CGO_ENABLED="0", GOOS=spec["goos"], GOARCH=spec["goarch"])
    done = subprocess.run(
        ["go", "build", "-trimpath", "-o", str(output), spec["package"]],
        cwd=module, env=environment, capture_output=True, text=True)
    if done.returncode != 0:
        fail(f"go build failed:\n{done.stderr.strip()}")


def build_workbench(plugin_id: str, output: Path) -> None:
    done = subprocess.run(
        ["node", "scripts/build-workbenches.mjs", "--package", plugin_id,
         "--out", str(output)],
        cwd=ROOT, capture_output=True, text=True)
    if done.returncode != 0:
        fail(f"workbench build failed:\n{done.stderr.strip()}")


def stage_package(plugin_id: str, spec: dict, staging: Path) -> dict:
    source = ROOT / "plugins" / plugin_id
    manifest_path = source / "mypaste.plugin.json"
    if not manifest_path.is_file():
        fail(f"{plugin_id}: missing mypaste.plugin.json")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("id") != plugin_id:
        fail(f"{plugin_id}: manifest id does not match the directory")
    shutil.copyfile(manifest_path, staging / "mypaste.plugin.json")
    if spec.get("workbench"):
        # The document's own path comes from the manifest: the host reads it
        # from there, so staging and serving cannot disagree about the name.
        document = manifest.get("workbench", {}).get("document", "")
        if not document:
            fail(f"{plugin_id}: spec declares a workbench but the manifest has none")
        build_workbench(plugin_id, staging / document)
        return manifest
    for asset in spec["assets"]:
        asset_path = source / asset
        if not asset_path.is_file():
            fail(f"{plugin_id}: missing asset {asset}")
        shutil.copyfile(asset_path, staging / asset)
    build_binary(spec, staging)
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
            target = write_archive(plugin_id, manifest, staging)
            sha256 = record_digest(target)
            update_index({
                "id": manifest["id"],
                "name": manifest["name"],
                "version": manifest["version"],
                "description": manifest.get("description", ""),
                "fileName": target.name,
                "sha256": sha256,
                # A workbench package declares no runtime; zero says exactly
                # that, and the host keeps such entries.
                "runtimeProtocol": manifest.get("runtime", {}).get(
                    "protocolVersion", 0),
                # The project address the marketplace detail page shows. It is
                # feed metadata: the manifest never carries it, so older hosts
                # keep installing the same package.
                "repository": repository(),
            })
            print(target.relative_to(ROOT))


if __name__ == "__main__":
    main()
