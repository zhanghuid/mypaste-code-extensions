# MyPaste Code Extensions

Independent code formatting, syntax-highlighting and sync extensions for
[MyPaste](https://github.com/zhanghuid/mypaste-go).

This repository is intentionally separate from the MyPaste app. Extensions are
local `.mypaste-plugin` packages that a user installs explicitly and grants
capabilities to one manifest digest at a time. Nothing here auto-updates,
auto-runs, downloads code at runtime, or writes the clipboard directly.

## Packages

This repository holds three kinds of packages:

- **Script packages** (`plugins/mypaste.*`) — run-script extensions packaged by
  `scripts/package.py` from plain source; see the language table below.
- **Workbench packages** (`plugins/com.mypaste.code-card`,
  `plugins/com.mypaste.code-edit`, `plugins/com.mypaste.diff-view`,
  `plugins/com.mypaste.image-edit`) — one HTML document that MyPaste shows in
  its workbench card. They run no process and declare no capabilities; see
  "Workbench packages" below.
- **Official packages** (`plugins/com.mypaste.*`) — compiled Go binaries and
  workbench documents with broader capabilities, built by
  `scripts/build-official.py`; see "Official packages" below.
  `scripts/official_packages.py` is the single owner of the list;
  `scripts/package.py` never packages or validates them.

### Script packages

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

## Command declaration

Every package declares what its command acts on:

```json
"commands": [{
  "id": "format",
  "appliesTo": ["text", "rich_text"],
  "languages": ["go"],
  "capabilities": ["selection.read", "clipboard.write"],
  "...": "..."
}]
```

`appliesTo` is a closed set — `text`, `rich_text`, `image`, `link`, `file`,
`color` — and `languages` lists the code languages the command handles. Only
text commands may declare languages. MyPaste offers the command in the Cmd+K
command palette only for matching items, groups it under the declared language,
and re-checks the declaration before running it. Without the declaration a
package is discovered and can be installed, but its command is not offered.

`scripts/package.py` rejects a package whose commands omit or misuse these
fields, so an unreadable declaration fails the build instead of shipping.

## Workbench packages

`com.mypaste.code-card`, `com.mypaste.code-edit`, `com.mypaste.diff-view` and
`com.mypaste.image-edit` ship a document instead of a process. MyPaste reads
the manifest's `workbench.document`, wraps it in its own CSP and shows it in a
sandboxed frame; the document can only read the item the command was invoked
on, save text or an image as a new history item, copy text or an image, and
close. Nothing else reaches it — no host binding, no asset path, no other item.

The documents follow the host's visual rule (host D-1045): no rounded boxes.
Cards, panels, buttons and tool chips are square; a circle is allowed only
where roundness is the shape's meaning, such as a status dot.

```json
"workbench": {"title": "代码卡片", "document": "workbench.html"},
"commands": [{
  "id": "clipboard.code-card",
  "title": "导出代码卡片",
  "appliesTo": ["text", "rich_text"],
  "workbench": true
}]
```

A document that needs a second text to work on declares it in the workbench
block, and the host delivers the neighbour itself:

```json
"workbench": {
  "title": "高亮对比",
  "document": "workbench.html",
  "companion": "previous-text"
}
```

`"previous-text"` is the only accepted word (D-1040). The host picks the
adjacent item from the visible list — one that has text, is not an image and is
not the invoked item — preferring the previous item and otherwise the next, and
delivers it in the same `item` message as `companion`; it never hands the
document a way to browse history. With no such neighbour the host refuses to
open the document and says so. A companion over 1 MiB is skipped.

A document that edits its item declares `"editor": true` (D-1041). MyPaste
opens only such a workbench on a preview double-click, for the kinds its
command declares; export cards and comparisons stay on the command palette:

```json
"workbench": {"title": "代码编辑", "document": "workbench.html", "editor": true}
```

`com.mypaste.code-edit` and `com.mypaste.image-edit` declare it;
`com.mypaste.code-card` and `com.mypaste.diff-view` deliberately do not.

Each package keeps its own `src/` and shares no code with the others; every
package declares the bridge protocol and its own highlighting or diff engine
from its own side. Text save and copy cross the bridge as exact-key messages
(`{v: 1, type: "save", requestId, text, title}` and
`{v: 1, type: "copy", requestId, text}`); the host validates the text again —
1 MiB, UTF-8, no control characters — and reports the result back per
`requestId`. Saving writes a new history item; it never replaces the original.

The host answers `ready` with the `item` (carrying `companion` when declared)
and immediately after with
`{v: 1, type: "theme", scheme: "light" | "dark", tokens: {"surface": "…"}}`
(D-1042, D-1043). That scheme is the one MyPaste resolved from its own
appearance setting, which the sandboxed frame's `prefers-color-scheme` cannot
see, so a document paints by `:root[data-scheme]` and uses the media query only
as the value shown before the message arrives. `tokens` carries the values that
scheme resolved to — colours and the two font stacks — keyed by the host's own
CSS custom property names without `--`. Both documents mirror each value as
`--mp-<name>` and prefer it in CSS, keeping their own palette as the fallback
for an older host. The host resends the whole pair when the reader changes the
appearance or theme while the document is open.

The comparison document edits in place: one click anywhere in either pane —
its text, its gutter, its head, or the space below the last line — opens that
side's editor, with the caret under the pointer when the click lands on a
rendered line and at the side's end otherwise; a drag that selects text stays
a selection. While typing, only the other column is
repainted, at most every 150 ms (backing off further when a repaint of a long
text is itself slow), so the editor never waits for the diff. Both panes are a
two-column grid; each side owns its own line numbers.

Closing belongs to the host card. MyPaste draws one close control in the
workbench chrome, and a document must not draw a second one; a document may
still ask the bridge to close for its Escape key, but Escape first leaves an
editing mode (the comparison document uses it for that).

Sources:

```
plugins/com.mypaste.code-card/
  mypaste.plugin.json
  src/main.ts          entry, controls, status line
  src/bridge.ts        the host bridge, as the document sees it
  src/card.ts          palettes, layout and canvas drawing
  src/tokenize.ts      the card's own tokenizer and language table
  src/workbench.html   markup, styles and the <!--bundle--> placeholder
  workbench.html       GENERATED: the document the archive ships

plugins/com.mypaste.code-edit/   the overlay editor (its own tokenizer,
                                 language table and bridge)
plugins/com.mypaste.diff-view/   the comparison document (its own diff engine
                                 and language table; declares a companion)
```

Build one document with `bun run build:workbenches` (esbuild bundles
`src/main.ts` into the fragment). `scripts/build-official.py` runs the same
build into the staging directory, so an archive never contains stale output.

## Official packages


`com.mypaste.ferry` — the cross-device sync extension — ships from this
repository as a compiled binary instead of a run script. Its Go source lives
in `plugins/com.mypaste.ferry/src/` (own `go.mod`); the archive contains only
the manifest, `menu.html` and the built `ferry` binary, never the source tree.
The relay service it talks to lives in `servers/mypaste-relay/` (own
`go.mod`); it is a standalone HTTPS server, not a plugin package, and is
deployed separately. Ferry needs capabilities outside the run-script allowlist
(`entry.payload`, `network.outbound` with configured hosts, `storage.plugin`,
triggers); MyPaste lists them in the install confirmation, and the single
enable switch is the whole permission decision (D-1039 in the host
repository). There is no signature or trusted tier to obtain.

`com.mypaste.sql` — the SQL toolkit extension (syntax highlighting, syntax
diagnostics and formatting for seven dialects, lexed by
[chroma](https://github.com/alecthomas/chroma)) — ships as a compiled binary
too. Its Go source lives in `plugins/com.mypaste.sql/src/` (own `go.mod`);
the archive contains only the manifest and the built binaries, never the
source tree. Its spec declares a `targets` list, so the archive nests one
binary per platform under `bin/<goos>-<goarch>/` (`.exe` on windows); the
host resolves the declared entrypoint through that layout (D-1057 in the
host repository).

Build the official packages locally:

```sh
python3 scripts/build-official.py
python3 scripts/build-official.py --only com.mypaste.ferry
```

To build, test and publish in one step, use `sh scripts/release.sh`
(see [Release](#release)).

The build is deterministic — fixed Go flags, fixed zip timestamps, one entry
per package — so the same source produces the same archive and the same
SHA-256 for review. The feed carries that digest; it does not carry a
signature, and MyPaste ignores one if an older feed still has it.

Official binaries are built for macOS arm64 (`CGO_ENABLED=0`, `-trimpath`),
matching the app's first shipping platform; packages that declare a
`targets` list build every listed platform the same way. Additional targets
are added to `scripts/official_packages.py` when the app ships them.

## Build

Requirements: Bun 1.2+ and Python 3.11+ for the packaging scripts; Go 1.27+
for the official packages.

```sh
bun install                                                # esbuild + tsc
bun run test                                               # Python suite
bun run typecheck                                          # both packages' TS
bun run build:workbenches                                  # both documents
bun run build                                              # script packages
python3 scripts/build-official.py                          # official packages
sh scripts/release.sh                                      # build, test, publish
```

`dist/` will contain one ZIP-root `.mypaste-plugin` per package. The archive
root must be `mypaste.plugin.json` plus the entry script, or — for a workbench
package — the manifest plus the one document it declares.

## Release

There is no signing key: installation is the trust decision, and MyPaste
grants the capabilities listed in the install confirmation until the extension
is disabled (D-1039 in the host repository). Publishing is one command:

```sh
sh scripts/release.sh
```

It builds the official packages, runs `bun run test` against the feed, folds
`dist/` into the current commit, fast-forwards `main`, and pushes it — the
feed MyPaste reads is `main/dist/index.json`. Add `--no-push` to stop before
publishing.

The script refuses to start unless the work tree is clean on a branch that
descends from `main`. It stops at the first failure, so a failing test leaves
the rebuilt `dist/` in the tree but commits and pushes nothing. Commit the
package, document and manifest changes first: the script amends the current
commit, so it becomes the release commit. A workbench package still needs the
host's install confirmation before it can run, exactly like every other
package.

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
- No script package in this repository requests network, file, or process
  capabilities. The official sync package does request `network.outbound`
  (HTTPS, configured hosts) and `storage.plugin`; MyPaste gates both behind
  trusted provenance and shows them in the install dialog.
- The app's plugin capability list is a grant ceiling, not an operating-system
  sandbox.

The committed `dist/` directory is the fixed raw-GitHub feed used by MyPaste:

```text
dist/
  index.json
  mypaste.format-go-2.0.0.mypaste-plugin
  mypaste.format-go-2.0.0.mypaste-plugin.sha256
  ...
```

`index.json` is generated deterministically: `scripts/package.py` writes the
script-package entries and carries official entries over, and
`scripts/build-official.py` writes (or refreshes) the official entries.
Each entry lists the package's ID, display name, version, description, archive
file name, SHA-256 and runtime protocol, and every entry carries the project's
`repository` address
(`https://github.com/zhanghuid/mypaste-code-extensions`, owned by
`scripts/index_metadata.py`) so the marketplace detail page can link back to the
sources. The feed carries no signature (D-1039). `repository` lives in the
index only, never in a package manifest: a host validates manifests strictly,
so a manifest field an older host does not know would make the whole package
invalid there. For the same reason hosts ignore index fields they do not
know — an older MyPaste simply does not show the repository link.

| Field | Required | Meaning |
| --- | --- | --- |
| `id` | yes | Plugin ID the host installs under. |
| `name` | yes | Display name. |
| `version` | yes | Package version. |
| `description` | yes | One-line description. |
| `fileName` | yes | Archive name inside `dist/`. |
| `sha256` | yes | Digest of the archive the host verifies before installing. |
| `runtimeProtocol` | yes | Runtime protocol the package speaks (`2`, or `0` for a workbench package with no runtime). |
| `repository` | no | Project address, HTTPS, shown on the marketplace detail page. The host opens it only after resolving the address from its own copy of this index, keyed by plugin ID — the page never supplies a URL. |

The app fetches only
`https://raw.githubusercontent.com/zhanghuid/mypaste-code-extensions/main/dist/index.json`,
then resolves packages inside that fixed directory; it never accepts a URL or
filesystem path from the page. Commit `dist/` after every package change and
publish it with the annotated repository tag.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and
[../mypaste-go/docs/PLUGINS.md](../mypaste-go/docs/PLUGINS.md).

## License

MIT. See [LICENSE](LICENSE). Individual toolchain dependencies remain under
their own licenses; formatter adapters call locally installed tools and do not
redistribute them.
