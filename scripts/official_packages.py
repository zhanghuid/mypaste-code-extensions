"""The official (compiled or document-only, signed) extension packages.

This module is the one owner of the official package list. Both packaging
pipelines read it: scripts/build-official.py builds and signs exactly these,
and scripts/package.py skips them, because their capability model and runtime
shape are outside the run-script allowlist it validates.

A binary package's spec names the Go module that builds the entrypoint, the
asset files copied into the archive beside the manifest, and the platform the
binary is built for (the host's first shipping platform; see the README). A
workbench package's spec is `{"workbench": True}`: the archive holds the
manifest and the one document the host serves, and no process runs at all.
"""

OFFICIAL = {
    "com.mypaste.code-card": {
        "workbench": True,
    },
    "com.mypaste.image-edit": {
        "workbench": True,
    },
    "com.mypaste.ferry": {
        "module": "plugins/com.mypaste.ferry/src",
        "entrypoint": "ferry",
        "package": "./cmd/mypaste-ferry",
        "assets": ["menu.html"],
        "goos": "darwin",
        "goarch": "arm64",
    },
}
