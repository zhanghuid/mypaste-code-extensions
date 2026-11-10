# Repository Guidelines

This repository contains independently installable MyPaste code extensions. It
does not contain the MyPaste app or its database. Every package speaks MyPaste
plugin protocol v3 (`docs/PLUGINS.md` in the app repository).

- Each package lives under `plugins/<plugin-id>/` and must have
  `mypaste.plugin.json` directly in that directory. Packages share nothing: a
  package's `src/` is its own code, and no package imports from another.
- Protocol v3 has two roles: **surface** — has UI, ships a page, runs no
  process — and **capability** — no UI, only commands, reached by the host or
  by a surface through the registry. The shapes here are:
  - **run-script capability** — a `run`/`run.sh` speaking the line protocol
    (v3 keeps v2's process protocol), packaged by `scripts/package.py`;
  - **binary capability** — a Go program under `src/`, packaged by
    `scripts/build-official.py`;
  - **surface** — a manifest `surface: {entry, forms, role}` plus one page.
    `role` is `open` (the target of "open this entity") or `preview` (drawn
    into the dock's card preview). A page may also ship a runtime and internal
    commands (code-edit); protocol v3 lets only that package's own surface
    reach them. Json is surface-only and bundles its formatter into the page.
- Highlighting packages are capabilities: they request only `entity.read`,
  declare one `highlight` command with `forms: ["text"]` and no `placement`,
  and return bounded token arrays, never HTML or CSS.
- Formatting packages are capabilities too: only `entity.read`, one `format`
  command with `output: ["text"]` and no `placement`. They must return the
  original input on failure and must never execute user code; the host never
  writes their answer to the clipboard.
- Every manifest is `manifestVersion: 3`. Every command declares non-empty
  `forms` (a subtree of the host's entity tree: `text`/`plain`/`rich`, `link`,
  `color`, `media`/`image`/`audio`/`video`, `file`/`document`/`archive`/
  `folder`/`other`), optionally `output`, and optionally `placement`
  (`palette`, `card-action`, `trigger`). A command without `placement` is a
  pure capability the registry exposes to surfaces. A command that consumes
  the entity declares `"capabilities": ["entity.read"]` on itself: a surface
  invocation passes its buffer as pipe input, and the host checks the
  command's own list before it does. The field may only narrow the package
  grant, never widen it. Languages are an extension's internal concern: the
  host never infers one, and v3 has no `languages` field. Every `runtime`
  block declares `"protocolVersion": 2` beside `mode` and `entrypoint`: v3
  keeps the v2 process protocol, and the host rejects a package without the
  declaration.
- Capabilities are the closed service list of PLUGINS.md section 6
  (`entity.read`, `entity.save`, `copy`, `clipboard.write`, `entry.payload`,
  `secret.read`, `network.outbound`, `storage.plugin`, `companion.read`,
  `history.exchange`); ask for the least one that does the job.
- Official packages (`plugins/com.mypaste.*`, listed in
  `scripts/official_packages.py`) are packaged only by
  `scripts/build-official.py`; `scripts/package.py` skips them and their
  capability model is not bound by the run-script allowlist. Binary packages
  are compiled Go programs with their own `go.mod` under
  `plugins/<plugin-id>/src/`.
- Surface packages keep their sources in `plugins/<plugin-id>/src/`: the page
  template (`preview.html`, markup and styles, exactly one `<!--bundle-->`)
  and the TypeScript it loads. `plugins/<plugin-id>/preview.html` is generated
  by `scripts/build-surfaces.mjs` (esbuild, one IIFE) and is
  what ships; edit the sources, never the generated file. The build refuses a
  page over 1 MiB, which is also the host's surface-document ceiling (D-1091 in
  the app repository); every plugin text that crosses the bridge still stays
  under 256 KiB. A page too large for that ceiling keeps its heavy engine
  beside a runtime instead. A template may be a
  complete document or a fragment the host wraps; the generated entry holds
  the bundled script either way, and it may only talk to the host through the
  fixed bridge in its own `src/bridge.ts`. It has no database, asset,
  preference or filesystem access and must not fetch anything over the
  network.
- `servers/mypaste-relay/` is a standalone HTTPS relay service (own `go.mod`),
  not a plugin package; deploy it separately. The ferry↔relay wire protocol
  (`mypaste-relay-v1`) is frozen: changing it is a breaking protocol change
  owned by the relay server, and ferry's copy of the constants in
  `plugins/com.mypaste.ferry/src/internal/relayproto/` changes with it, not
  independently.
- Official binaries target macOS arm64 (`CGO_ENABLED=0`, `-trimpath`), the
  app's first shipping platform. Add a platform only when the app ships it.
- Adding a command target, capability or runtime field means bumping the package
  version and rebuilding `dist/`, because grants bind to the manifest digest:
  existing installs keep working until the user installs the new package.
- Do not add network, file, process, history or secret capabilities to the
  script packages without a new threat model and explicit maintainer review.
- Verify before committing: `bun run build:surfaces`, `bun run check`, and
  (when official packages changed) `go test ./...` under each touched
  `plugins/*/src` or `servers/*` module plus
  `python3 -m unittest discover -s tests`.
- Commit each language family or protocol change separately when practical.
- Commit `dist/` because it is the fixed raw-GitHub feed consumed by MyPaste.
  It must contain only verified packages, their `.sha256` files, and
  `index.json`.
- Do not commit `node_modules/`, credentials, or temporary build files.
- English identifiers and commit subjects; user-facing plugin descriptions may
  be Chinese.
