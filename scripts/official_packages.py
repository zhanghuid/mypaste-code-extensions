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
repository). A binary package may also carry `surface: True` and its page
(protocol v3's UI package with a runtime of its own).

A surface-only package's spec is `{"surface": True}`: the archive holds the
manifest and the one page `surface.entry` names, and no process runs at all.
Either shape's `assets` may be a list (copied at the same relative path) or a
mapping from source path to archive path (private files that should not ship
under `src/`).
"""

OFFICIAL = {
    "com.mypaste.sync": {
        # A settings-window menu package with a runtime of its own: the page
        # invokes sync.request, and an interval trigger runs sync.auto. Both
        # binaries ship in the same archive; the host resolves one by GOOS and
        # GOARCH (D-1057). The page is a hand-written asset, not a built
        # surface.
        "module": "plugins/com.mypaste.sync/src",
        "entrypoint": "sync",
        "package": "./cmd/mypaste-sync",
        "targets": [
            {"goos": "darwin", "goarch": "arm64"},
            {"goos": "darwin", "goarch": "amd64"},
        ],
        "assets": {"panel.html": "panel.html"},
    },
    "com.mypaste.code-edit": {
        # A UI package with a runtime of its own: the page plus the Go
        # formatter that runs in process. Only this package's surface can
        # reach these internal commands.
        "surface": True,
        "module": "plugins/com.mypaste.code-edit/src",
        "entrypoint": "code-edit",
        "package": "./cmd/mypaste-code-edit",
        "assets": {
            "src/engines/js_format.mjs": "engines/js_format.mjs",
            "src/engines/prettier.mjs": "engines/prettier.mjs",
        },
        # The pinned Prettier runtime (standalone plus the postcss and yaml
        # plugins) is copied from node_modules at build time, never hand-copied
        # into src/.
        "prettier": "engines/prettier",
        "goos": "darwin",
        "goarch": "arm64",
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
    "com.mypaste.timestamp": {
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
