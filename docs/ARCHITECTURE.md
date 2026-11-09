# Architecture

## Two plugin roles

MyPaste plugin protocol v3 has two roles:

1. **Surface** — has UI. It ships one page, runs no process, and draws its own
   interface (highlighting, formatting and syntax checking included). It reaches
   the host only through the surface bridge: the container, the closed service
   list, and the registry.
2. **Capability** — no UI, only commands. The host shows the commands that
   declare a `placement`; a command without one is a pure capability that a
   surface integrates through the registry.

This split is deliberate. A highlighting capability can only return tokens; it
cannot silently acquire clipboard-write authority. A surface that offers saving
or copying declares `entity.save` and `clipboard.write` itself, and the host
performs the write.

Every manifest names its role as `kind`: `"ui"` for a package with a `surface`,
`"command"` for one without. The field may be omitted, in which case the host
derives it from the shape, but an explicit value must match. A `ui` package may
also declare a `runtime` and internal commands that carry no `placement`; only
that package's own surface sees or invokes them, and they never reach the
command palette or another surface's registry. Code-edit uses this to ship its
built-in formatting without depending on the capability packages.

## What a command declares

Every command in `mypaste.plugin.json` (manifest version 3) declares the entity
forms it acts on, what it produces, and optionally where the host shows it:

```json
"commands": [{
  "id": "format",
  "title": "格式化 JSON",
  "forms": ["text"],
  "output": ["text"]
}]
```

- `forms` names nodes of the host's entity tree: `text` (`plain`, `rich`),
  `link`, `color`, `media` (`image`, `audio`, `video`) and `file`
  (`document`, `archive`, `folder`, `other`). A declaration matches its whole
  subtree. MyPaste re-checks the declaration before running a command.
- `output` names the entity types the command produces; the host uses it to
  decide whether the result can be saved or copied. It defaults to `forms`.
- `placement` is `palette` (the command palette), `card-action` (the card or
  preview action row) or `trigger` (a background trigger). A command with no
  `placement` is a pure capability the host never shows.

Languages are the package's own internal concept. The host never infers a
language from the package ID or from the text; v3 has no `languages` field. The
name `mypaste.format-json` is a convention for readers, not something the host
parses.

## Runtime protocol

A command package runs in a short-lived child process: the host writes one JSON
request on stdin and reads one JSON response on stdout. The manifest declares
this with `"runtime": {"mode": "command", "entrypoint": "run"}`; `mode` is
`command` (start per invocation) or `resident` (kept alive with backoff). The
same runtime block may sit beside a `surface` in a `ui` package: code-edit
declares one for its internal `format.*` / `compress.sql` commands, and only
its own page can invoke them. The process protocol itself is unchanged from v2:
the request carries `"protocolVersion": 2`, and the adapter reads the entire
request before writing exactly one response. Diagnostics go to stderr only for
the local developer; the host never displays raw stderr.

### Highlight response

```json
{
  "id": "same request id",
  "ok": true,
  "result": {
    "render": {
      "language": "typescript",
      "tokens": [
        {"text": "const", "kind": "keyword"},
        {"text": " value", "kind": ""}
      ]
    }
  }
}
```

The surface that integrates a highlight command turns these tokens into escaped
spans; a token is text plus a kind, never HTML. Allowed token kinds: empty
string, `keyword`, `string`, `comment`, `number`, `literal`, `property`,
`function`, `tag`, `type`.

An adapter bounds its own output (token count and total text) because the
surface consumes it directly. The host's text ceiling for the surrounding
buffer is 1 MiB, UTF-8 and no NUL; an adapter must not enforce a smaller ceiling
on the input, or it rejects text the host has already delivered.

### Format response

```json
{
  "id": "same request id",
  "ok": true,
  "result": {
    "output": "formatted source",
    "effect": "copy"
  }
}
```

A formatting capability returns text; it never writes the clipboard. When the
host invokes it from a placement, the host's `clipboard.write` boundary performs
the actual write, and a command result that cannot be resolved into an entity is
not written at all. A surface that integrates a formatter through the registry
applies the returned text to its own page instead.

## Declared settings

A plugin may declare settings the user can change without reinstalling. The
host renders them on the plugin card; the plugin only reads the resolved values
from the request.

```json
"settings": [{
  "key": "indent",
  "type": "integer",
  "title": "缩进空格",
  "description": "格式化结果的每级缩进宽度。",
  "min": 1,
  "max": 8,
  "default": 2
}]
```

The declaration is closed: `boolean`, `enum` (2–16 `values`), `integer`
(`min`/`max`) and `string` (`maxLength`). Keys are lowercase names such as
`indent`. There is no nested object, free-form JSON Schema, HTML or path — a
settings block is not a second UI language.

The host stores values against the exact manifest digest. Replacing a package
starts the new manifest from its own defaults, so a value never carries over
into a declaration it was not chosen for. A resolved request carries them as
one object:

```json
{"id": "…", "method": "invoke", "commandId": "format",
 "settings": {"indent": 6}}
```

A plugin that declares nothing sees no `settings` field at all. Read it
defensively anyway: the host validates first, but an adapter that receives no
settings should apply its manifest default rather than fail.

## Adapter execution

The host provides a minimal environment (`HOME`, `TMPDIR`, `PATH`, `LANG`,
`LC_ALL`). Format adapters may invoke only a fixed local command path discovered
from that environment; plugin commands cannot inject arbitrary command names or
arguments. There is no shell interpolation of user clipboard text.

## Dependency policy

- Highlighters are dependency-free local tokenizers.
- Formatters use system tools already installed by the user; SQL, JSON, CSS
  and YAML ship their own engines inside code-edit's archive. CSS and YAML use
  a pinned Prettier standalone build, copied from node_modules at package time
  by `scripts/vendor_prettier.py`.
- No package downloads a formatter at runtime.
- A missing dependency returns a clear failure and leaves the clipboard
  unchanged.
- Any future vendored dependency must include version, license and provenance
  in `THIRD_PARTY_NOTICES.md`.

## Distribution

The app reads one fixed index (shown with a placeholder host for portability):

```text
https://raw.githubusercontent.com/<owner>/mypaste-code-extensions/main/dist/index.json
```

The index is versioned repository metadata, not a dynamic marketplace API. It
contains only package identity, display metadata, each package's `kind` (`ui`
or `command`), archive file names, SHA-256 digests, the project address, and
`runtimeProtocol` (2 for a package with a runtime, 0 for a package with none —
including the surface packages that ship no process). The app resolves
package files relative to the same fixed directory and rejects redirects, path
traversal and digest mismatches. A host drops catalog entries whose
`runtimeProtocol` names a protocol it does not support before listing them, so
the marketplace only offers packages the scanning host can actually install;
entries without the field (an index that predates it) stay listed and are
judged by the manifest inside the archive at install time.

`dist/index.json` and all referenced `.mypaste-plugin` / `.sha256` files are
committed together. The packaging script writes reproducible ZIP timestamps and
generates the index after every package has passed manifest and size checks.
There is no auto-update path: downloading a package and granting capabilities
remain separate user actions.
