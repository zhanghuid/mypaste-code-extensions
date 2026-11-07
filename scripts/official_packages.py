"""The official (compiled or surface-only) extension packages.

This module is the one owner of the official package list. Both packaging
pipelines read it: scripts/build-official.py builds and archives exactly these,
and scripts/package.py skips them, because their capability model and runtime
shape are outside the run-script allowlist it validates.

A binary package's spec names the Go module that builds the entrypoint and
the asset files copied into the archive beside the manifest, plus either one
platform (`goos`/`goarch`, the host's first shipping platform; see the README)
or a `targets` list: a multi-target package ships one binary per platform
under `bin/<goos>-<goarch>/<entrypoint>` (`.exe` appended on windows), and the
host resolves the entrypoint through that layout (D-1057 in the host
repository). A surface package's spec is `{"surface": True}`: the archive holds
the manifest and the one page `surface.entry` names, and no process runs at
all.
"""

OFFICIAL = {
    "com.mypaste.code-edit": {
        "surface": True,
    },
    "com.mypaste.code-card": {
        "surface": True,
    },
    "com.mypaste.diff-view": {
        "surface": True,
    },
    "com.mypaste.image-edit": {
        "surface": True,
    },
    "com.mypaste.ferry": {
        "module": "plugins/com.mypaste.ferry/src",
        "entrypoint": "ferry",
        "package": "./cmd/mypaste-ferry",
        "assets": [],
        "goos": "darwin",
        "goarch": "arm64",
    },
    "com.mypaste.sql": {
        "module": "plugins/com.mypaste.sql/src",
        "entrypoint": "sql",
        "package": "./cmd/mypaste-sql",
        "assets": [],
        # One binary per platform the host may ever run on; the layout the
        # host resolves through is bin/<goos>-<goarch>/<entrypoint>.
        "targets": [
            {"goos": "darwin", "goarch": "arm64"},
            {"goos": "darwin", "goarch": "amd64"},
            {"goos": "linux", "goarch": "amd64"},
            {"goos": "linux", "goarch": "arm64"},
            {"goos": "windows", "goarch": "amd64"},
        ],
    },
}
