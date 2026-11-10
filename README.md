# MyPaste Code Extensions

English · [简体中文](README.zh-CN.md)

Independent code formatting, syntax-highlighting and sync extensions for
[MyPaste](https://github.com/zhanghuid/mypaste-go).

This repository is intentionally separate from the MyPaste app. Extensions are
local `.mypaste-plugin` packages that a user installs explicitly and grants
capabilities to one manifest digest at a time. Nothing here auto-updates,
auto-runs, downloads code at runtime, or writes the clipboard directly.

## Packages

Every package speaks MyPaste plugin protocol v3. v3 has two roles:

- **Surface** — has UI. It ships one page and draws its own interface, reaching
  the host only through the surface bridge. A surface runs no process unless
  its manifest also declares a `runtime` — code-edit does, for its built-in
  formatting.
- **Capability** — no UI, only commands. The host shows the commands that
  declare a placement, and surfaces reach the rest through the registry.

Every manifest also declares `kind` (`"ui"` or `"command"`), naming the role
the package was built for. The packaging scripts reject a manifest whose `kind`
disagrees with its shape, and the feed (`dist/index.json`) carries the field.

This repository holds:

- **Script capability packages** (`plugins/mypaste.*`) — run-script extensions
  packaged by `scripts/package.py` from plain source; see the language table
  below.
- **Binary capability packages** (`plugins/com.mypaste.ferry`,
  `plugins/com.mypaste.sql`) — compiled Go programs built by
  `scripts/build-official.py`.
- **Settings-page packages** (`plugins/com.mypaste.sync`,
  `plugins/com.mypaste.data-settings`) — a hand-written `panel.html`, plus a
  compiled Go runtime for sync; built by `scripts/build-official.py`.
- **Run-script bridge packages** (`plugins/com.mypaste.boards`,
  `plugins/com.mypaste.saved-searches`, `plugins/com.mypaste.backup-scheduler`)
  — a manifest and a shell entrypoint that forwards one closed host call; the
  host owns the data, dialogs and every write. Built by
  `scripts/build-official.py` (`"script": True`) and shipped verbatim.
- **Surface packages** (`plugins/com.mypaste.code-card`,
  `plugins/com.mypaste.code-edit`, `plugins/com.mypaste.diff-view`,
  `plugins/com.mypaste.image-edit`, `plugins/com.mypaste.json`,
  `plugins/com.mypaste.timestamp`) — a page of their own; code-edit also
  ships a runtime with internal commands, json bundles its engine into the
  page; see "Surface packages" below.
- **Official packages** (`plugins/com.mypaste.*`) — the binaries and surfaces
  above, built by `scripts/build-official.py`; see "Official packages" below.
  `scripts/official_packages.py` is the single owner of the list;
  `scripts/package.py` never packages or validates them.

### Script capability packages

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

Both kinds request only `entity.read`. Formatting answers with text and never
writes the clipboard; highlighting answers with bounded token arrays and never
returns HTML or CSS. Neither can read history, use files, reach the network, or
spawn arbitrary commands. They declare no `placement`, so the host never shows
them directly: a surface integrates them through the registry, and a language
is the package's own internal concept — the host never infers one.

## Manifest version 3

Every manifest is `"manifestVersion": 3`, and every command declares the entity
forms it acts on:

```json
"commands": [{
  "id": "format",
  "title": "格式化 JSON",
  "forms": ["text"],
  "output": ["text"],
  "capabilities": ["entity.read"]
}]
```

`forms` uses the host's entity tree: `text` (`plain`, `rich`), `link`, `color`,
`media` (`image`, `audio`, `video`) and `file` (`document`, `archive`,
`folder`, `other`). A declaration matches its whole subtree, so `text` covers
plain and rich text.

`output` names what the command produces; the host uses it to decide whether
the result can be saved or copied. It defaults to `forms`.

`capabilities` on a command names the services that one command needs. The host
checks it before handing the command the entity, and a surface invocation
passes its buffer as pipe input — so every formatter and highlighter repeats
`entity.read` here. It narrows the package grant and never widens it.

`placement` names where the host itself shows the command:

| placement | where it appears |
| --- | --- |
| `palette` | the Cmd+K command palette |
| `card-action` | the card/preview action row for the current entity |
| `trigger` | a background trigger (host D-1024), no interface |

A command may omit `placement`: it is then a **pure capability**, which the
host never shows and only surfaces reach through the registry (0/1/N, keyed by
entity type alone).

`kind` is `"ui"` for a package that ships a `surface` and `"command"`
otherwise. A manifest may omit it — the host derives it from the shape — but
when present it must agree. A `ui` package may additionally declare a
`runtime` and internal commands with no `placement`; the runtime speaks the v2
line protocol, and only that package's own surface can see or invoke those
commands.

Capabilities use the host's closed service list and should ask for the least
one that does the job: `entity.read`, `entity.save`, `copy`, `clipboard.write`,
`entry.payload`, `secret.read`, `network.outbound`, `storage.plugin`,
`companion.read`, `backup.schedule`, `boards.control`,
`saved-searches.control`, `backup.sync`, `data.read`, `asset.read`,
`settings.data`.

A command the host drives declares a closed `role` on a `trigger` command:
`board-membership`, `board-create`, `board-update`, `board-delete`,
`board-export`, `saved-search-create`, `saved-search-update`,
`saved-search-delete` or `backup-run`, with the capability that role requires.
The host resolves these by role, never by command ID (myPaste D-1096), so a
command may be renamed without breaking its bridge.

`scripts/package.py` rejects a package whose commands omit or misuse these
fields, or whose manifest still names v2 vocabulary (`surface: "editor"`,
`appliesTo`, `global`, `menus`, `workbench`, `languages`), so an unreadable
declaration fails the build instead of shipping.

## Surface packages

`com.mypaste.code-card`, `com.mypaste.code-edit`, `com.mypaste.diff-view`,
`com.mypaste.image-edit`, `com.mypaste.json` and `com.mypaste.timestamp` ship a
page of their own. Code-edit additionally ships a runtime and internal commands
for its built-in formatting (3.3.0). Json (3.0.0) is surface-only: Prettier's
standalone build plus the babel and estree plugins are bundled into the page,
so it formats, converts and filters in the document with no Node and no
runtime. The host reads a surface document up to 1 MiB (D-1091 in the host
repository), which the built page fits. The other four run no process:

```json
"surface": {
  "entry": "preview.html",
  "forms": ["text"],
  "role": "open"
}
```

`forms` names the entities the surface adapts, and `role` is one of:

- `open` — the target of "open this entity" (a double-click on a card when this
  surface is the chosen default). Code-edit, diff-view, image-edit, json and
  timestamp declare it.
- `preview` — drawn into the dock's card preview. Code-card declares it.

The host serves the page to a sandboxed frame and mediates reading this
invocation's item, saving text or an image as a new history entry, copying text
or an image, and closing. Nothing else reaches it — no host binding, no asset
path, no other item. A surface that compares against a neighbour declares the
`companion.read` capability and asks for it; the host chooses the adjacent
item and never gives the page a way to browse history.

v3 removed the host workbench: there is no buffer exchange, no host-drawn
editor toolbar and no host-drawn document action row (host D-1065, D-1068).
Each page draws its own controls. Code-edit's page, for example, draws 复制文本
and 保存为新条目 itself and turns the registry into a header 格式化 menu plus a
高亮 picker. The menu always carries the editor's own built-in operations for
the detected language — Go, JavaScript, TypeScript, Python, Rust, PHP, HTML,
CSS, JSON, YAML, SQL and Shell, plus SQL compression — invoked through this
package's runtime under ids such as `format.go` and `compress.sql`, so
formatting works with no other package installed (Go, Rust, PHP, Python, HTML
and Shell still use the matching tool when the machine has it). Every operation
appears as a
document action and a selection action, grouped 格式化 / 压缩 (an unknown
capability id falls into 其它); keyword casing is
a 本地 action that needs no runtime. A formatting capability from another
package joins the menu as an extra row annotated with its source, but an
operation the built-ins already own for that language is never duplicated: the
built-in wins. A command that declares a placement is the host's card action
and never becomes a row here. When nothing applies — plain text has no
formatter — the menu says that in one line instead of blaming a missing
package. Token commands become the 高亮 picker, where 内置 (the page's own
tokenizer) is the default and the fallback when a capability fails or returns
no usable tokens; highlighting never depends on an installed package. A
selection action slices the buffer, invokes the same whole-text command on that
slice and splices the answer back, so a capability never needs to know about
selections. Actions that do not currently apply (a selection action with no
selection, keyword casing in
a language without keywords) stay in the menu disabled rather than
disappearing. Today the host fills an omitted
output from `forms`, so both shapes arrive as text; code-edit also accepts the
protocol's fixed `format` / `compress` / `highlight` command ids as the
declared shape until the wire carries declaredness.

- `{v: 1, type: "registry", requestId, forms}` → `{v: 1, type: "result",
  requestId, ok, commands: [{pluginId, commandId, title, description?,
  output?}]}` — the capability commands that adapt those entity forms.
- `{v: 1, type: "invoke", requestId, pluginId, commandId, text}` → `{v: 1,
  type: "result", requestId, ok, output?, diagnostics?, render?}` — runs one
  command against the current buffer. `render.tokens`, when the host forwards
  them, are bounded `{text, kind}` pairs; the page accepts them only when they
  add up to the buffer it sent and otherwise keeps its own highlighter.

Text save and copy cross the bridge as exact-key messages
(`{v: 1, type: "save", requestId, text, title}` and
`{v: 1, type: "copy", requestId, text}`); the host validates the text again —
1 MiB, UTF-8, no control characters — and reports the result back per
`requestId`. Saving writes a new history item; it never replaces the original.

The host answers the page's `{v: 1, type: "ready"}` with the `item` and then
`{v: 1, type: "theme", scheme: "light" | "dark", tokens: {"surface": "…"}}`
(host D-1042, D-1043). That scheme is the one MyPaste resolved from its own
appearance setting, which the sandboxed frame's `prefers-color-scheme` cannot
see, so a page paints by `:root[data-scheme]` and uses the media query only as
the value shown before the message arrives. `tokens` carries the values that
scheme resolved to — colours and the two font stacks — keyed by the host's own
CSS custom property names without `--`. Each page mirrors every value as
`--mp-<name>` and prefers it in CSS, keeping its own palette as the fallback
for an older host. The host resends the whole pair when the reader changes the
appearance or theme while the page is open.

The comparison page edits in place: one click anywhere in either pane — its
text, its gutter, its head, or the space below the last line — opens that side's
editor, with the caret under the pointer when the click lands on a rendered
line and at the side's end otherwise; a drag that selects text stays a
selection. While typing, only the other column is repainted, at most every
150 ms (backing off further when a repaint of a long text is itself slow), so
the editor never waits for the diff. Both panes are a two-column grid; each
side owns its own line numbers.

Closing belongs to the host container. MyPaste draws one close control in the
surface chrome, and a page must not draw a second one; a page may still ask the
bridge to close for its Escape key, but Escape first leaves an editing mode
(the comparison page uses it for that). The pages follow the host's visual rule
(host D-1045): no rounded boxes. Cards, panels, buttons and tool chips are
square; a circle is allowed only where roundness is the shape's meaning, such
as a status dot.

Sources:

```
plugins/com.mypaste.code-card/
  mypaste.plugin.json
  src/main.ts          entry, controls, status line
  src/bridge.ts        the host bridge, as the page sees it
  src/card.ts          palettes, layout and canvas drawing
  src/tokenize.ts      the card's own tokenizer and language table
  src/preview.html     markup, styles and the <!--bundle--> placeholder
  preview.html         GENERATED: the page the archive ships

plugins/com.mypaste.code-edit/   the editor (its own tokenizer, language
                                 table and bridge; registry-driven 格式化
                                 and 高亮 pickers; cmd/ is its runtime and
                                 engines/ the formatting scripts it ships)
plugins/com.mypaste.diff-view/   the comparison page (its own diff engine and
                                 language table; reads a companion)
plugins/com.mypaste.image-edit/  the image editor (canvas tools of its own)
plugins/com.mypaste.json/        the JSON editor page (Prettier bundled into
                                 the document, its own XML / YAML / TypeScript
                                 converters and expression evaluator; no
                                 runtime, copy-only)
plugins/com.mypaste.timestamp/   the timestamp page (its own parser and
                                 formatters; copy-only, no runtime)
```

Build every page with `bun run build:surfaces` (esbuild bundles `src/main.ts`
into the complete document). `scripts/build-official.py` runs the same build
into the staging directory, so an archive never contains stale output.

## Official packages

`com.mypaste.ferry` — the cross-device sync extension — ships from this
repository as a compiled binary instead of a run script. Its Go source lives
in `plugins/com.mypaste.ferry/src/` (own `go.mod`); the archive contains only
the manifest and the built `ferry` binary, never the source tree. The relay
service it talks to lives in `servers/mypaste-relay/` (own `go.mod`); it is a
standalone HTTPS server, not a plugin package, and is deployed separately.
Ferry needs capabilities outside the run-script allowlist (`entry.payload`,
`network.outbound` with configured hosts, `storage.plugin`, triggers); MyPaste
lists them in the install confirmation, and the single enable switch is the
whole permission decision (D-1039 in the host repository). There is no
signature or trusted tier to obtain.

`com.mypaste.sync` — the S3 snapshot extension — is a UI package with a
runtime of its own: its settings-window menu (`sync.panel`, order 50) is a
hand-written `panel.html`, and every action runs in the compiled `sync`
runtime. The runtime reads history and assets through the host's read-only
`data.read` / `asset.read`, assembles the same `.mypaste-backup` archive the
host exports, encrypts it as `MYPaste-Sync/1` (PBKDF2-HMAC-SHA256, 210000
iterations, 16-byte salt, AES-256-GCM with the header as AAD), signs
ListObjectsV2 / PutObject / ranged GetObject with SigV4, and performs every
transfer through the host's `backup.sync` service. Credentials, salt and
passphrase live only in the package's private `storage.plugin` directory
(0600) and never reach the page or the log. An interval trigger checks the
saved schedule every 15 minutes; failures back off from 15 minutes up to 24
hours. Both darwin binaries ship under `bin/<goos>/<goarch>/` (host D-1057),
and the archive is the host's `.mypaste-backup` format unchanged, so either
side can restore the other. Go source lives in `plugins/com.mypaste.sync/src/`
(own `go.mod`).

`com.mypaste.data-settings` — the data tab of the settings window — is a menu
page with no runtime at all: the archive holds the manifest and the
hand-written `panel.html` that `data.panel` (order 51) names. The page reaches
the host only through `settings.data`; picking files, inspecting archives and
every write stay on the host side. The page bytes are the ones the app embeds,
so installing this package from the marketplace leaves it first-party.

`com.mypaste.sql` — the SQL toolkit extension (syntax highlighting, syntax
diagnostics, formatting and compression for seven dialects, lexed by
[chroma](https://github.com/alecthomas/chroma)) — ships as a compiled binary
too. It is a pure capability: it exposes `highlight`, `format` and `compress`
commands and has no UI. Compression removes comments and folds whitespace onto
one line while preserving string literals, quoted identifiers and `/*+ */`
optimizer hints; a syntax error refuses the result instead of writing it. Its
Go source lives in `plugins/com.mypaste.sql/src/` (own `go.mod`); the archive
contains only the manifest and the built binaries, never the source tree. Its
spec declares a `targets` list, so the archive nests one binary per platform
under `bin/<goos>/<goarch>/` (`.exe` on windows); the host resolves the declared
entrypoint through that layout (D-1057 in the host repository).

`com.mypaste.code-edit` is a combined official package: `kind` is `"ui"`,
it ships its page and a compiled runtime, and it declares internal formatting
commands with no `placement` and `output: ["text"]`. Protocol v3 exposes those
commands only to the package's own surface; they never appear in the command
palette or another surface's registry. The runtime speaks the same newline
JSON protocol as a v2 process on stdin/stdout. Formatting runs inside the
compiled binary: Go uses `go/format`, JSON `encoding/json`, SQL the shared
`sqlkit` package, CSS a brace-aware re-indenter, and the remaining languages a
whitespace normalizer that never re-nests indentation. No gofmt, rustfmt, php,
python3, tidy, shfmt or Prettier CLI is looked up on the machine, so every
command works on a machine with no formatter installed. When Node happens to
exist, the runtime may use the archive's own helper scripts instead: the
reviewed `js_format.mjs` (from `shared/`, which a test keeps byte-identical)
and a pinned Prettier 3.6.2 standalone build for CSS and YAML
(`engines/prettier/`, MIT, see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md));
without Node the in-process engines answer. Request text travels on stdin,
never through a shell, and the runtime reads nothing outside its own directory. SQL has one owner: `shared/sqlkit` is
a Go module that both `com.mypaste.sql` and the code-edit runtime `replace` to
the same source tree, so the two packages compile and ship the same analyzer,
formatter and compressor rather than drifting apart.

`com.mypaste.json` is surface-only (3.0.0): the archive is its manifest and one
`preview.html`, and no process runs. The page is an editable JSON editor;
Prettier's standalone build with the babel and estree plugins is bundled into
it, so beautifying never leaves the document and needs no Node. The host reads
surface documents up to 1 MiB (D-1091 in the host repository), which the built
page fits. Pasting URL parameters, XML or YAML converts to JSON in the page;
minify, escape, JSON→XML and JSON→TypeScript write a derived result panel, and
a bottom filter bar evaluates a small JavaScript subset (member access,
indexing, array methods, comparisons, a leading-dot shorthand) against the
current JSON. The page holds no database or file access and makes no network
request; copying is a `copy` bridge message the host performs.

Supply chain: Prettier 3.6.2 is the only third-party library in this package
(it was already pinned and vendored for code-edit; see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)). The XML reader/writer, the
YAML subset reader, the TypeScript interface generator and the expression
evaluator are written here rather than pulled in, because each is small, the
page cannot use `eval` under its CSP, and a parser library would add a larger
review surface than the code it replaces. The evaluator has its own tokenizer
and parser, allows only named array and string methods, refuses
`__proto__`/`constructor`-style keys, and stops after a fixed step budget.

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
bun run typecheck                                          # every package's TS
bun run build:surfaces                                     # every surface page
bun run build                                              # script packages
python3 scripts/build-official.py                          # official packages
sh scripts/release.sh                                      # build, test, publish
```

`dist/` will contain one ZIP-root `.mypaste-plugin` per package. The archive
root must be `mypaste.plugin.json` plus the entry script, or — for a surface
package — the manifest plus the one page `surface.entry` names.

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
package, page and manifest changes first: the script amends the current
commit, so it becomes the release commit. A surface package still needs the
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
4. For highlighting, open a code item in a surface that integrates the
   registry, or use a highlight command from the palette.

Folder import accepts nested package folders, skips hidden directories,
`node_modules` and `.git`, ignores symbolic links, and reports each package
separately. A partial failure does not roll back packages that were already
installed successfully.

## Formatter dependencies

Standalone formatting capability packages (`mypaste.format-*`) use tools already
installed by the user and return a visible, actionable error when a dependency
is missing. Current adapters:

- JSON: Python standard library `json`
- JavaScript / TypeScript / HTML: `node` with local, reviewed formatter code
- PHP: `php` (syntax-aware token formatting, no network install)
- Python: `python3` with local formatter module
- Go: `gofmt`
- Rust: `rustfmt`

The combined `com.mypaste.code-edit` package does not depend on any of these:
its formatting is compiled into its own runtime, and Node only enables the
optional helpers shipped inside its archive (see above). All formatters read a
single JSON request from stdin and return plain text. They never execute the
code being formatted. Before publishing a new version, run the language
fixtures and the archive validator.

## Security model

- Highlighting returns tokens; it never returns HTML.
- MyPaste validates entity forms and token-kind allowlists, token count and
  total bytes again at the host boundary.
- Formatting failures preserve the original text; partial output is rejected.
- No script package in this repository requests network, file, or process
  capabilities. The official sync package does request `network.outbound`
  (HTTPS, configured hosts) and `storage.plugin`; MyPaste shows both in the
  install dialog.
- The app's plugin capability list is a grant ceiling, not an operating-system
  sandbox.

The committed `dist/` directory is the fixed raw-GitHub feed used by MyPaste:

```text
dist/
  index.json
  mypaste.format-go-3.0.0.mypaste-plugin
  mypaste.format-go-3.0.0.mypaste-plugin.sha256
  ...
```

`index.json` is generated deterministically: `scripts/package.py` writes the
script-package entries and carries official entries over, and
`scripts/build-official.py` writes (or refreshes) the official entries.
Each entry lists the package's ID, display name, version, kind, description,
archive file name, SHA-256 and runtime protocol, and every entry carries the
project's `repository` address
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
| `kind` | yes | `ui` or `command`, matching the package's shape. |
| `description` | yes | One-line description. |
| `fileName` | yes | Archive name inside `dist/`. |
| `sha256` | yes | Digest of the archive the host verifies before installing. |
| `runtimeProtocol` | yes | Runtime protocol the package speaks (`2`, or `0` for a package with no runtime). |
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
their own licenses; the standalone formatter adapters call locally installed
tools and do not redistribute them, while the only redistributed dependency is
the pinned Prettier build inside code-edit and bundled into the json page,
noted above.
