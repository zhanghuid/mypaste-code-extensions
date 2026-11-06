# Architecture

## Two plugin families

MyPaste has two different trust decisions:

1. **Formatting** changes text and then asks the host to write the result to
   the clipboard. It needs `selection.read` + `clipboard.write`.
2. **Highlighting** is presentation-only. It needs only `selection.render` and
   must not write anything.

This split is deliberate. A highlighting plugin cannot silently acquire
clipboard-write authority just because it is installed for preview.

## What a command declares

Every command in `mypaste.plugin.json` (manifest version 2) says which content
forms it acts on, which surface it appears on, and which code languages it
serves:

```json
"commands": [{
  "id": "format",
  "title": "格式化 JSON",
  "description": "...",
  "forms": ["text"],
  "languages": ["json"],
  "surface": "editor",
  "input": ["text/plain"],
  "output": ["text/plain"],
  "capabilities": ["selection.read"]
}]
```

- `forms` names nodes of the host's form tree: `text` (`plain`, `rich`),
  `link`, `color`, `media` (`image`, `audio`, `video`) and `file`
  (`document`, `archive`, `folder`, `other`). A declaration matches its whole
  subtree; an empty list is form-agnostic. MyPaste re-checks the declaration
  before running a command.
- `surface` is `renderer`, `palette` (the default), `editor`, `workbench` or
  `data-action`. The renderer requires `selection.render`; the editor requires
  `selection.read` and a `text/plain` output and never receives a clipboard
  write; a workbench declares forms and starts no process; a data action names
  no forms and no languages.
- `languages` names the code languages the command handles, or `*` for every
  language. Only commands inside the text subtree may declare languages.

The name of the plugin package is therefore free. `mypaste.format-json` is a
convention for readers, not something the host parses.

## Runtime protocol

The host starts a short-lived child process for each invocation, sends one JSON
object on stdin and reads one JSON object from stdout. The adapter reads the
entire request before writing exactly one response. Diagnostics go to stderr
only for the local developer; the host never displays raw stderr.

Every manifest declares `"runtime": {"protocolVersion": 2, ...}`. MyPaste
accepts only protocol 2 (D-1012); a package that still declares 1 is rejected
when the host validates its manifest. The request and response shapes in this
repository are unchanged from the v1 field set — only the declared version and
the adapters' version check moved to 2.

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

Allowed languages: `go`, `html`, `javascript`, `json`, `php`, `python`, `rust`,
`typescript`.

Allowed token kinds: empty string, `keyword`, `string`, `comment`, `number`,
`literal`, `property`, `function`, `tag`, `type`.

Limits: 40 000 tokens and 256 KiB total text (`extension.MaxRenderTokens`
and `extension.MaxTextBytes`). The host owns that ceiling for every
extension text path; an adapter must not enforce a smaller one, or it
rejects text the host has already delivered. MyPaste validates the result twice:
once in Go before it crosses the host boundary, and once in TypeScript before
turning tokens into escaped spans.

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

The host's `clipboard.write` boundary performs the actual write. The adapter
must not create a second history entry and must not claim success when no
formatter is available.

## Declared settings

A plugin may declare up to eight parameters the user can change without
reinstalling. The host renders them on the plugin card; the plugin only reads
the resolved values from the request.

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
- Formatters use system tools already installed by the user.
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
contains only package identity, display metadata, archive file names, SHA-256
digests and each package's declared `runtimeProtocol` (copied from the
manifest by the packager). The app resolves package files relative to the
same fixed directory and rejects redirects, path traversal and digest
mismatches. A host drops catalog entries whose `runtimeProtocol` names a
protocol it does not support before listing them, so the marketplace only
offers packages the scanning host can actually install; entries without the
field (an index that predates it) stay listed and are judged by the manifest
inside the archive at install time.

`dist/index.json` and all referenced `.mypaste-plugin` / `.sha256` files are
committed together. The packaging script writes reproducible ZIP timestamps and
generates the index after every package has passed manifest and size checks.
There is no auto-update path: downloading a package and granting capabilities
remain separate user actions.
