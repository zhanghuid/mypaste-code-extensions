#!/usr/bin/env python3
"""Stage the Prettier runtime code-edit ships for CSS and YAML.

Prettier is a build dependency pinned in package.json; only the files the
browser-free standalone build needs at runtime are copied into the package's
private engines directory. The CLI, the rest of node_modules and source maps
never enter an archive.

The pinned version and the installed version must agree, so a stale
`node_modules` cannot silently ship a different formatter than the lockfile
declares. The MIT license text travels with the files, and VERSION records the
version and the project address for provenance.

    python3 scripts/vendor_prettier.py /tmp/engines/prettier
"""

from __future__ import annotations

import json
from pathlib import Path
import re
import shutil
import sys

ROOT = Path(__file__).resolve().parent.parent

# The standalone build imports nothing outside these four files at runtime.
FILES = {
    "standalone.mjs": "standalone.mjs",
    "plugins/postcss.mjs": "plugins/postcss.mjs",
    "plugins/yaml.mjs": "plugins/yaml.mjs",
    "LICENSE": "LICENSE",
}

PROJECT = "https://github.com/prettier/prettier"


def fail(message: str) -> None:
    print(f"error: {message}", file=sys.stderr)
    raise SystemExit(1)


def pinned_version(root: Path) -> str:
    manifest = json.loads((root / "package.json").read_text(encoding="utf-8"))
    version = manifest.get("devDependencies", {}).get("prettier")
    if not isinstance(version, str) or not re.fullmatch(r"\d+\.\d+\.\d+", version):
        fail("package.json must pin prettier to an exact version")
    return version


def vendor(root: Path, destination: Path) -> str:
    """Copy the pinned Prettier runtime into `destination`; return its version."""
    version = pinned_version(root)
    source = root / "node_modules" / "prettier"
    installed = source / "package.json"
    if not installed.is_file():
        fail("prettier is not installed; run `bun install`")
    actual = json.loads(installed.read_text(encoding="utf-8")).get("version")
    if actual != version:
        fail(f"installed prettier is {actual!r}, package.json pins {version!r}; "
             "run `bun install`")
    for relative, target in FILES.items():
        origin = source / relative
        if not origin.is_file():
            fail(f"prettier {version} is missing {relative}")
        output = destination / target
        output.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(origin, output)
    (destination / "VERSION").write_text(
        f"prettier {version}\n{PROJECT}\n", encoding="utf-8")
    return version


def main() -> None:
    if len(sys.argv) != 2:
        fail("usage: vendor_prettier.py <destination>")
    version = vendor(ROOT, Path(sys.argv[1]))
    print(f"prettier {version} -> {sys.argv[1]}")


if __name__ == "__main__":
    main()
