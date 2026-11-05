"""The official (compiled, signed) extension packages.

This module is the one owner of the official package list. Both packaging
pipelines read it: scripts/build-official.py builds and signs exactly these,
and scripts/package.py skips them, because their capability model and runtime
shape are outside the run-script allowlist it validates.

Each spec names the Go module that builds the entrypoint binary, the asset
files copied into the archive beside the manifest, and the platform the binary
is built for (the host's first shipping platform; see the repository README).
"""

OFFICIAL = {
    "com.mypaste.ferry": {
        "module": "plugins/com.mypaste.ferry/src",
        "entrypoint": "ferry",
        "package": "./cmd/mypaste-ferry",
        "assets": ["menu.html"],
        "goos": "darwin",
        "goarch": "arm64",
    },
}
