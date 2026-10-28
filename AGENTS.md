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
- Every command must declare `appliesTo` (a non-empty subset of `text`,
  `rich_text`, `image`, `link`, `file`, `color`) and `languages` (lowercase
  tokens matching `^[a-z][a-z0-9+#-]*$`). Languages are allowed only for text
  commands. The host filters the command palette and binds the preview
  formatter/highlighter by this declaration; it never infers a language from the
  plugin ID, so keep the IDs conventional for readers only.
- Adding a command target, capability or runtime field means bumping the package
  version and rebuilding `dist/`, because grants bind to the manifest digest:
  existing installs keep working until the user installs the new package.
- Do not add network, file, process, history or secret capabilities to these
  packages without a new threat model and explicit maintainer review.
- Use `bun test` and `bun run build` before committing.
- Commit each language family or protocol change separately when practical.
- Commit `dist/` because it is the fixed raw-GitHub feed consumed by MyPaste.
  It must contain only verified packages, their `.sha256` files, and
  `index.json`.
- Do not commit `node_modules/`, credentials, or temporary build files.
- English identifiers and commit subjects; user-facing plugin descriptions may
  be Chinese.
