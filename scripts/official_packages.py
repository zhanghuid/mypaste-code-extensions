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
A settings-window menu package with no runtime of its own is
`{"menus": True}`: the archive holds the manifest and the pages that
`menus[].entry` names, copied verbatim. Either shape's `assets` may be a list
(copied at the same relative path) or a mapping from source path to archive
path (private files that should not ship under `src/`).
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
    "com.mypaste.calculator": {
        # A surface-only scratch sheet: the page evaluates every row in the
        # document, and copying or saving still goes through the host. No
        # process runs and nothing leaves the machine.
        "surface": True,
    },
    "com.mypaste.code-card": {
        "surface": True,
    },
    "com.mypaste.data-settings": {
        # A settings-window menu page with no runtime: the page reaches the
        # host only through the settings.data service, and every file choice,
        # check and write stays on the host side. The page is the one the host
        # embeds, byte for byte, so installing it from the marketplace keeps
        # the package first-party.
        "menus": True,
    },
    "com.mypaste.diff-view": {
        "surface": True,
    },
    "com.mypaste.image-edit": {
        "surface": True,
    },
    "com.mypaste.link-mime": {
        # A headless link capability with no placement: it answers on the
        # `link` form only when another surface invokes it through the
        # registry, so the host never shows it on its own. The type table is
        # embedded in the binary, and the process only reads URL text.
        "module": "plugins/com.mypaste.link-mime/src",
        "entrypoint": "link-mime",
        "package": "./cmd/mypaste-link-mime",
        "assets": [],
        "goos": "darwin",
        "goarch": "arm64",
    },
    "com.mypaste.link-inspector": {
        # A surface-only package: the page reaches the detector through the
        # host's registry and invoke, and has no runtime of its own.
        "surface": True,
    },
    "com.mypaste.json": {
        # A surface-only package: Prettier's standalone build and the babel /
        # estree plugins are bundled into the page itself, so no process runs
        # and nothing else ships. The host reads surface documents up to 1 MiB
        # (D-1091), which the built page fits inside.
        "surface": True,
    },
    "com.mypaste.timestamp": {
        "surface": True,
    },
    "com.mypaste.boards": {
        "script": True,
    },
    "com.mypaste.saved-searches": {
        "script": True,
    },
    "com.mypaste.backup-scheduler": {
        "script": True,
    },
    "com.mypaste.history-cleanup": {
        # The host's palette projects these trigger commands by their
        # history.cleanup capability and palette placement (host D-1094).
        "script": True,
    },
    "com.mypaste.ferry": {
        "module": "plugins/com.mypaste.ferry/src",
        "entrypoint": "ferry",
        "package": "./cmd/mypaste-ferry",
        "assets": [],
        "goos": "darwin",
        "goarch": "arm64",
    },
    # The SQL workspace is a surface-only package: its scanner, diagnostics,
    # formatter and compressor live in the page, so no process runs and the
    # archive carries one HTML document.
    "com.mypaste.sql": {
        "surface": True,
    },
}
