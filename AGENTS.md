# Repository Guidelines

This repository contains independently installable MyPaste code extensions. It
does not contain the MyPaste app or its database.

- Each script package lives under `plugins/<plugin-id>/` and must have
  `mypaste.plugin.json` directly in that directory.
- Highlighting packages may request only `selection.render` and must return
  bounded token arrays, never HTML or CSS.
- Formatting packages may request only `selection.read` and `clipboard.write`.
  They must return the original input on failure and must never execute user
  code.
- Every command must declare `appliesTo` (a non-empty subset of `text`,
  `rich_text`, `image`, `link`, `file`, `color`) and `languages` (lowercase
  tokens matching `^[a-z][a-z0-9+#-]*$`). Languages are allowed only for text
  commands. The host filters the command palette and binds the preview
  formatter/highlighter by this declaration; it never infers a language from the
  plugin ID, so keep the IDs conventional for readers only.
- Official packages (`plugins/com.mypaste.*`, listed in
  `scripts/official_packages.py`) are compiled Go programs with their own
  `go.mod` under `plugins/<plugin-id>/src/`, packaged only by
  `scripts/build-official.py`. `scripts/package.py` skips them and their
  capability model is not bound by the run-script allowlist; they ship signed
  (offline ed25519, `scripts/sign.py`) or not at all — an unsigned dry run
  never lands in `dist/index.json` with an empty `signature` field. The
  signing key is a 0600 seed file outside every repository; never commit,
  log or transmit it.
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
- Verify before committing: `bun test`, `bun run build`, and (when official
  packages changed) `go test ./...` under each touched `plugins/*/src` or
  `servers/*` module plus `python3 -m unittest discover -s tests`.
- Commit each language family or protocol change separately when practical.
- Commit `dist/` because it is the fixed raw-GitHub feed consumed by MyPaste.
  It must contain only verified packages, their `.sha256` files, and
  `index.json`.
- Do not commit `node_modules/`, credentials, or temporary build files.
- English identifiers and commit subjects; user-facing plugin descriptions may
  be Chinese.
