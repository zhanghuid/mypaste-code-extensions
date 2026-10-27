# Repository Guidelines

This repository contains independently installable MyPaste code extensions. It
does not contain the MyPaste app or its database.

- Each package lives under `plugins/<plugin-id>/` and must have
  `mypaste.plugin.json` directly in that directory.
- Highlighting packages may request only `selection.render` and must return
  bounded token arrays, never HTML or CSS.
- Formatting packages may request only `selection.read` and `clipboard.write`.
  They must return the original input on failure and must never execute user
  code.
- Do not add network, file, process, history or secret capabilities to these
  packages without a new threat model and explicit maintainer review.
- Use `bun test` and `bun run build` before committing.
- Commit each language family or protocol change separately when practical.
- Do not commit `dist/`, `node_modules/`, credentials, or generated archives.
- English identifiers and commit subjects; user-facing plugin descriptions may
  be Chinese.
