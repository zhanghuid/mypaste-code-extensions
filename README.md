# MyPaste Code Extensions

Third-party code formatting and syntax-highlighting extensions for
[MyPaste](https://github.com/zhanghuid/mypaste-go).

This repository is intentionally separate from the MyPaste app. Extensions are
local `.mypaste-plugin` packages that a user installs explicitly and grants
capabilities to one manifest digest at a time. Nothing here auto-updates,
auto-runs, downloads code at runtime, or writes the clipboard directly.

## Packages

Each language has two independently installable packages:

| Language | Formatting | Highlighting |
| --- | --- | --- |
| PHP | `mypaste.format-php` | `mypaste.highlight-php` |
| JSON | `mypaste.format-json` | `mypaste.highlight-json` |
| JavaScript | `mypaste.format-javascript` | `mypaste.highlight-javascript` |
| TypeScript | `mypaste.format-typescript` | `mypaste.highlight-typescript` |
| HTML | `mypaste.format-html` | `mypaste.highlight-html` |
| Python | `mypaste.format-python` | `mypaste.highlight-python` |
| Go | `mypaste.format-go` | `mypaste.highlight-go` |
| Rust | `mypaste.format-rust` | `mypaste.highlight-rust` |

Formatting packages request `selection.read` and `clipboard.write`.
Highlighting packages request only `selection.render`; they cannot write the
clipboard, read history, use files, network, or spawn arbitrary commands.

## Build

Requirements: Bun 1.2+ and Python 3.11+ for the packaging scripts.

```sh
bun test
bun run build
```

`dist/` will contain one ZIP-root `.mypaste-plugin` per package. The archive
root must be `mypaste.plugin.json` plus the entry script.

## Install locally

1. Open MyPaste Go -> Preferences -> Extensions -> Third-party.
2. Choose either:
   - "Import entire folder..." and select the repository root. MyPaste
     recursively discovers the packages in `dist/` and installs each one.
   - "Install / update plugin..." and select one `.mypaste-plugin` file.
3. Refresh the list, grant only the capability each package declares, then use
   the command from the clipboard command palette.
4. For highlighting, select a code item and preview it. If no highlight plugin
   is granted, MyPaste uses its built-in highlighter.

Folder import accepts nested package folders, skips hidden directories,
`node_modules` and `.git`, ignores symbolic links, and reports each package
separately. A partial failure does not roll back packages that were already
installed successfully.

## Formatter dependencies

The source repository does not vendor compiler toolchains. Formatting adapters
use tools already installed by the user and return a visible, actionable error
when a dependency is missing. Current adapters:

- JSON: Python standard library `json`
- JavaScript / TypeScript / HTML: `node` with local, reviewed formatter code
- PHP: `php` (syntax-aware token formatting, no network install)
- Python: `python3` with local formatter module
- Go: `gofmt`
- Rust: `rustfmt`

All formatters read a single JSON request from stdin and return plain text. They
never execute the code being formatted. Before publishing a new version, run
the language fixtures and the archive validator.

## Security model

- Highlighting returns tokens; it never returns HTML.
- MyPaste validates language and token-kind allowlists, token count and total
  bytes again at the host boundary.
- Formatting failures preserve the original text; partial output is rejected.
- No plugin in this repository requests network, file, or process capabilities.
- The app's plugin capability list is a grant ceiling, not an operating-system
  sandbox.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and
[../mypaste-go/docs/PLUGINS.md](../mypaste-go/docs/PLUGINS.md).

## License

MIT. See [LICENSE](LICENSE). Individual toolchain dependencies remain under
their own licenses; formatter adapters call locally installed tools and do not
redistribute them.
