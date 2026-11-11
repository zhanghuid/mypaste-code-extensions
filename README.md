# MyPaste Code Extensions

English · [简体中文](README.zh-CN.md)

Independent code formatting and sync extensions for
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
  `plugins/com.mypaste.sql`, `plugins/com.mypaste.link-mime`) — compiled Go
  programs built by `scripts/build-official.py`.
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
  `plugins/com.mypaste.timestamp`, `plugins/com.mypaste.link-inspector`) — a
  page of their own; code-edit also ships a runtime with internal commands,
  json bundles its engine into the page, link-inspector calls the link
  detector through the registry and renders what it finds; see "Surface
  packages" below.
- **Official packages** (`plugins/com.mypaste.*`) — the binaries and surfaces
  above, built by `scripts/build-official.py`; see "Official packages" below.
  `scripts/official_packages.py` is the single owner of the list;
  `scripts/package.py` never packages or validates them.

### Script capability packages

Each language has one formatting package:

| Language | Formatting |
| --- | --- |
| PHP | `mypaste.format-php` |
| JSON | `mypaste.format-json` |
| JavaScript | `mypaste.format-javascript` |
| TypeScript | `mypaste.format-typescript` |
| HTML | `mypaste.format-html` |
| Python | `mypaste.format-python` |
| Go | `mypaste.format-go` |
| Rust | `mypaste.format-rust` |

Each requests only `entity.read`. Formatting answers with text and never writes
the clipboard. It cannot read history, use files, reach the network, or spawn
arbitrary commands. It declares no `placement`, so the host never shows it
directly: a surface integrates it through the registry, and a language is the
package's own internal concept — the host never infers one. Syntax highlighting
is no longer a capability package: the code-edit and code-card surfaces render
it with their own tokenizers (see "Surface packages"), and `com.mypaste.sql`
still returns SQL tokens.

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
passes its buffer as pipe input — so every formatter repeats `entity.read`
here. It narrows the package grant and never widens it.

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
`settings.data`. `surface.network` is the one official-only page grant: it
widens that package's own surface document so it can load the content it
renders (myPaste D-1100).

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
`com.mypaste.image-edit`, `com.mypaste.json`, `com.mypaste.timestamp` and
`com.mypaste.link-inspector` ship a page of their own. Code-edit additionally
ships a runtime and internal commands for its built-in formatting (3.3.0). Json
(3.3.1) is surface-only: Prettier's standalone build plus the babel and estree
plugins are bundled into the page, so it formats, converts and filters in the
document with no Node and no runtime. Its workbench is two columns: the entry as
it arrived sits read-only on the left, and every result (beautify on open,
minify, escape, XML, TypeScript, a filter result, a paste conversion) lands in
the right pane, so the original is never rewritten and never covered by its own
result. Link-inspector is surface-only too: it invokes `com.mypaste.link-mime`
through the registry and then renders the link with the element its MIME calls
for (see "Link type" below).
The host reads a surface document up to 1 MiB (D-1091 in the host repository),
which every built page fits. The others run no process:

```json
"surface": {
  "entry": "preview.html",
  "forms": ["text"],
  "role": "open",
  "chrome": "page"
}
```

`forms` names the entities the surface adapts, and `role` is one of:

- `open` — the target of "open this entity" (a double-click on a card when this
  surface is the chosen default). Code-card (6.3.0), code-edit, diff-view,
  image-edit, json, timestamp and link-inspector declare it.
- `preview` — drawn into the dock's card preview. No package declares it today:
  code-card drew it until 6.0.0 and now opens as a page of its own.

`chrome` is optional, and only an `open` surface may set `"page"`: the page
draws the whole card, so the host hides its own header and footer and the page
closes through the bridge's `close` request. Omitting it keeps the host card
(`"host"`). Code-card (6.3.0), code-edit (3.7.2), diff-view (3.2.2), json
(3.3.1) and link-inspector (1.0.1) declare `"page"`; image-edit and timestamp
keep the host card.

### Link type

`com.mypaste.link-inspector` and `com.mypaste.link-mime` are the two halves of
one feature, and show the composition path of v3: the detector is a binary
package with no `placement`, so the host lists it to no menu and calls it only
when another surface asks. The inspector opens a `link` entry, asks the
registry which capabilities adapt links, finds the detector's `{pluginId,
commandId}` pair in that answer, and invokes it with the link text. It never
composes the id itself; a missing or disabled detector is a visible state on
the page, not a failed call.

The detector infers the MIME type offline, from what the URL itself says, in
this order: a `data:` URL's own media type, the scheme (`mailto:` →
`message/rfc822`, `magnet:` → `application/x-bittorrent`), the path extension
(`.png` → `image/png`, `.docx` → the OOXML wordprocessing type), a known host
only when no extension was recognized, a filename hint in the query
(`?filename=…`, `?format=…`), and finally the page default for `http(s)` or
`application/octet-stream` for `file:`. Types, hosts, schemes and their labels
live in one data file (`src/internal/linkmime/mime-types.json`), embedded into
the binary; the Go code owns precedence and the result document. It does not
fetch the link: `network.outbound` only reaches declared hosts, and a guess
from the URL is what can honestly be offered without one. The result carries
`confidence` and an `evidence` list, and the page renders those words through
its own lookup tables — a changed or newer document is refused whole rather
than half-painted.

Once the type is known the inspector renders it. It declares the host's
official-only `surface.network` capability (host D-1100), which widens this one
surface document's policy — no other page, menu or plugin path changes — so the
page can load the link itself. Images, video and audio go to the browser's own
`<img>`, `<video>` and `<audio>` elements, `data:` content is decoded locally
and never touches the network, and JSON, XML, HTML, CSV and other text is
fetched, formatted and painted as text: JSON is indented when it parses, HTML
is shown as source and never executed, and every document is capped at 200,000
characters. A PDF or an archive has no in-page renderer, a cross-origin JSON
endpoint may refuse the read (CORS), and an unreachable host may time out;
each of those replaces the stage with a card that names the attempt and the
reason, plus a retry and a copy-link action. Before choosing any of those
renderers the page asks the server what it is about to send: one `HEAD` reads
`Content-Type`, and when the header names a different type — an extensionless
path the detector could only call a web page, for example — the measured type
wins and the link is rendered as what it actually is. The preview header shows
the measured type beside the renderer, so a disagreement between the guess and
the server stays visible; a server that refuses `HEAD` or blocks the
cross-origin read leaves the detection in place. The detector still never
fetches anything: the two halves stay separate, and only the page that was
asked to show a link does.

### Code card

Code-card draws the entry on a canvas and exports one PNG; nothing is fetched
and the page holds no host binding. 6.0.0 makes the page the card: it declares
`"role": "open"` with `"chrome": "page"`, so the host paints no header and no
bottom action row, and the page draws its own close control (a square X at the
far right) and answers Escape — one Escape closes an open popup first, the next
asks the bridge to close. The workbench is Carbon's editor (carbon.now.sh) from
5.0.0: a 40 px toolbar with the theme and language dropdowns, settings and
copy, the export split button and the close control; a centred stage that
carries the card inside its export padding; and a 316 px settings popout — the
background strip (the host's ground, transparent and Carbon's eight colours)
with a hex field under it, over a 窗口 / 编辑器 rail. Background is chosen in
that popout only; 5.0.0's second toolbar swatch repeated the same ten choices
and is gone. The card keeps Carbon's metrics: a 48 px window band, 16 / 18 /
18 px inner padding, a 133 % line box and a 20 px / 68 px shadow, with the
corners taken from the host's ladder. 4.0.0's host-following palette is still
the default: "跟随宿主" reads the host's own code surface and syntax tokens, so
the exported image matches the editor the reader is looking at, and seven
stored palettes (three light, four dark) remain for a deliberate look. The rail
selects a macOS, Windows or headless window, line numbers, 11–20 px type,
100–200 % line height, 16–128 px padding per axis, shadow offset and blur, auto
or fixed width and a transparent or hex background; the export is 1× or 2×.

6.0.0 also fixes how the text itself reaches the card. The line splitter used to
drop every token's kind while wrapping, so the renderer painted each card in
one colour; the kind now survives, and the palette colour of that kind is what
reaches the canvas. A wide character (CJK, fullwidth, emoji) takes two cells
when the line is measured and drawn, so a Chinese run no longer overlaps the
text that follows it or wraps late. Each entry is read on its own terms: the
language picker returns to detection when a new item arrives, instead of
scanning it with the language chosen for the previous one. And a one-line
source is re-indented for the drawing — JSON through its own parser, HTML and
CSS through a conservative brace-and-tag re-indenter that refuses unbalanced
markup and raw-text elements (`script`, `style`, `pre`, `textarea`) rather
than repairing them; a source that already has line breaks is the author's
layout and is drawn exactly as it arrived, and JavaScript, TypeScript, Go, Rust,
PHP, SQL and the whitespace-sensitive languages are never re-nested. The
document is one page and one bundled script: no runtime, no network, no font
download. Not taken from Carbon: SVG export (the card is measured and drawn
once on a canvas), image or gradient backgrounds (a file input would add a
second data path), downloaded fonts and a hundred-language pack (each language
here is a small keyword table the page owns).

6.1.0 sizes the window from the glyphs it paints. Auto width used to multiply
the character count by a fixed 0.602 em advance, so a card was wider than its
code whenever the resolved font was narrower than that and the right padding
could shrink when it was wider; the layout now takes the canvas's own
`measureText` per token and draws each token forward by that same measurement, so
the card is the text plus its 16 / 18 px padding, and a very short source keeps
only the 96 px floor the window's own controls need. The toolbar follows the
same rule: a picker is as wide as its widest option instead of a fixed 216 / 168
px box, so its label no longer sits in a band of empty chrome, and choosing an
option no longer leaves the browser's 2 px accent ring inside the 40 px control
— a focused picker shows a raised surface and a lit glyph, one indicator and no
border.

6.2.0 wraps a long line instead of widening the page. The workbench lays the
card out to the width the stage actually reports, so the text breaks where the
pane ends — at a space when the line has one, mid-word only when a word is
longer than the whole line — and the surface never grows a horizontal
scrollbar; the Editor rail's 自动换行 switch turns it off for a card that should
keep one wide line. The content is editable in the same release: the pencil in
the toolbar opens a pane above the card, every keystroke redraws the export, Tab
indents by two spaces and Escape closes the pane rather than the surface. What
is typed belongs to this invocation — it is never written back to the entry, so
closing leaves the history as it was.

The host serves the page to a sandboxed frame and mediates reading this
invocation's item, saving text or an image as a new history entry, copying text
or an image, and closing. Nothing else reaches it — no host binding, no asset
path, no other item. A surface that compares against a neighbour declares the
`companion.read` capability and asks for it; the host chooses the adjacent
item and never gives the page a way to browse history.

6.3.0 makes the card itself the editor. A click puts the caret where it landed —
the layout records where each drawn line begins in the source, so a click on a
wrapped line still finds the right character — and the card becomes the same
card with a transparent textarea over its own token-coloured text, so nothing
shifts and no second pane opens; Tab indents two spaces, Escape or a click
beside the card puts the canvas back. The toolbar's pencil enters the same
place, and the width still follows what is typed.

v3 removed the host workbench: there is no buffer exchange, no host-drawn
editor toolbar and no host-drawn document action row (host D-1065, D-1068).
Each page draws its own controls. Code-edit's page, for example, draws a
GitHub-style editor chrome: an editable title tab, a toolbar with two dropdowns
(语言 and 格式化) plus copy and save icons, a line-number gutter and a status
bar. Diff-view reuses that chrome for its own actions: the language badge plus
copy and save. Json keeps the same band but flattens it into one row of icons —
beautify, minify, escape as string, XML, TypeScript and copy — and ends the row
with the 保留转义 chip, which decides whether the right pane reads `\uXXXX` and
`\/` as characters or re-derives them in the escaped spelling; its expression
field sits in the original pane's
head. The 格式化 dropdown
turns the registry into a flat menu, and the 语言
dropdown picks the tokenizer and the built-in operations. The menu always
carries the editor's own built-in operations for
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
package. Syntax highlighting is this page's own tokenizer for all twelve
languages — the same one the card preview uses — so it never depends on an
installed package. A
selection action slices the buffer, invokes the same whole-text command on that
slice and splices the answer back, so a capability never needs to know about
selections. Actions that do not currently apply (a selection action with no
selection, keyword casing in
a language without keywords) stay in the menu disabled rather than
disappearing. Today the host fills an omitted
output from `forms`, so a token command also arrives as text; code-edit still
filters the protocol's fixed `highlight` id out of the format list (a
`highlight` command returns render tokens, not text — `com.mypaste.sql`) and
treats `format` / `compress` as text until the wire carries declaredness.

- `{v: 1, type: "registry", requestId, forms}` → `{v: 1, type: "result",
  requestId, ok, commands: [{pluginId, commandId, title, description?,
  output?}]}` — the capability commands that adapt those entity forms.
- `{v: 1, type: "invoke", requestId, pluginId, commandId, text}` → `{v: 1,
  type: "result", requestId, ok, output?, diagnostics?, render?}` — runs one
  command against the current buffer. Formatting consumes `output`; `render`,
  when the host forwards it, carries bounded `{text, kind}` tokens that this
  page leaves unused because its own tokenizer is the only highlighter.

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

Closing belongs to whichever side draws the card. Under the default host
chrome MyPaste draws one close control and a page must not draw a second; the
page-chrome surfaces draw their own close control (a square X at the end of
their own toolbar or tab strip) and ask the bridge to close. Escape asks the
bridge too, but
first leaves the page's own mode: an open dropdown, or the comparison's editing
pane. The pages carry the host's corner ladder (host D-1099) as their own
`--radius-*` tokens: controls are 6px, cards, menus and list groups 10px,
floating sheets 14px, and an indicator is a capsule. A page never writes a
pixel radius; `50%` stays for shapes whose meaning is round, such as a status
dot. Code areas that fill the card stay square inside the host's rounded frame.

Sources:

```
plugins/com.mypaste.code-card/
  mypaste.plugin.json
  src/main.ts          entry, controls, status line
  src/bridge.ts        the host bridge, as the page sees it
  src/card.ts          palettes, layout and canvas drawing
  src/tokenize.ts      the card's own tokenizer and language table
  src/format.ts        single-line re-indent for JSON, HTML and CSS
  src/preview.html     markup, styles and the <!--bundle--> placeholder
  preview.html         GENERATED: the page the archive ships

plugins/com.mypaste.code-edit/   the editor (its own tokenizer, language
                                 table and bridge; an editable title tab plus
                                 语言 and 格式化 dropdowns, the latter driven
                                 by the registry; cmd/ is its runtime and
                                 engines/ the formatting scripts it ships)
plugins/com.mypaste.diff-view/   the comparison page (its own diff engine and
                                 language table; reads a companion)
plugins/com.mypaste.image-edit/  the image editor (canvas tools of its own)
plugins/com.mypaste.json/        the JSON editor page (Prettier bundled into
                                 the document, its own XML / YAML / TypeScript
                                 converters and expression evaluator; no
                                 runtime, copy-only)
plugins/com.mypaste.link-inspector/ the link type page (opens a link, looks the
                                 detector up in the registry, paints its
                                 document, renders the link; no runtime,
                                 copy-only, loads remote content)
plugins/com.mypaste.link-mime/   the link detector (Go, no placement: infers a
                                 MIME type from the URL text only; the type
                                 table and host list are one embedded JSON
                                 file)
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

`com.mypaste.link-mime` is the smallest binary package: a command runtime that
reads one `{type, text}` invocation, decodes the URL and exits, declaring only
`entity.read` and running on the host's first shipping platform. Its `detect`
command has no `placement`, so no menu lists it; `com.mypaste.link-inspector`
is the surface-only package that calls it through the registry. The type table
is embedded in the binary, so the archive is the manifest and one executable.

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

`com.mypaste.json` is surface-only (3.5.1): the archive is its manifest and one
`preview.html`, and no process runs. The page holds the entry on the left and
every result on the right, and both panes are the same surface: editable, with
line numbers and syntax colour. Long lines wrap inside the pane by default
(the head's 自动换行 chip turns wrapping off and brings back horizontal
scrolling; a wrapped line is numbered once and its continuation rows stay
blank, so the gutter still names the line). The right pane previews the left
one: editing
the entry re-derives the chosen result after a short pause, and a hand edit on
the right makes it its own document until an action is chosen again. Both panes
lint what they hold at the position of the problem — the wrong token is
squiggled, its line number is marked, and the message sits under the pane —
while an entry that does not parse keeps the last good preview. Prettier's
standalone build with the
babel and estree plugins is bundled into
it, so beautifying never leaves the document and needs no Node. Prettier keeps
whatever escapes the source spelled, so the page shapes them itself: `\uXXXX`
and `\/` read as characters, and the 保留转义 chip re-derives the right pane in
the escaped spelling instead. The host reads
surface documents up to 1 MiB (D-1091 in the host repository), which the built
page fits. Pasting URL parameters, XML or YAML, minify, fold, escape, JSON→XML and
JSON→TypeScript all write that result pane, and
the filter box in the left pane's head evaluates a small JavaScript subset
(member access,
indexing, array methods, comparisons, a leading-dot shorthand) against the
entry. The page holds no database or file access and makes no network
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
4. For syntax highlighting, open a code item in the code-edit or code-card
   surface; each renders it with its own tokenizer.

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
