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

Every command in `mypaste.plugin.json` says what it acts on and which code
languages it serves:

```json
"commands": [{
  "id": "format",
  "title": "格式化 JSON",
  "description": "...",
  "appliesTo": ["text", "rich_text"],
  "languages": ["json"],
  "input": ["text/plain"],
  "output": ["text/plain"],
  "capabilities": ["selection.read", "clipboard.write"]
}]
```

- `appliesTo` is a closed set of clipboard item kinds: `text`, `rich_text`,
  `image`, `link`, `file`, `color`. MyPaste only offers a command for an item
  whose kind it declares, and it re-checks the declaration before running it.
  A command that omits `appliesTo` is treated as kind-agnostic.
- `languages` names the code languages the command handles. Only commands that
  apply to text may declare languages. MyPaste groups the command palette by
  this declaration and binds the preview formatter (`selection.read` +
  `clipboard.write`) and highlighter (`selection.render`) by it. The plugin ID
  is an identity, never a language: a package may be named anything.

The name of the plugin package is therefore free. `mypaste.format-json` is a
convention for readers, not something the host parses.

## Runtime protocol

The host starts a short-lived child process for each invocation, sends one JSON
object on stdin and reads one JSON object from stdout. The adapter reads the
entire request before writing exactly one response. Diagnostics go to stderr
only for the local developer; the host never displays raw stderr.

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
contains only package identity, display metadata, archive file names and
SHA-256 digests. The app resolves package files relative to the same fixed
directory and rejects redirects, path traversal and digest mismatches.

`dist/index.json` and all referenced `.mypaste-plugin` / `.sha256` files are
committed together. The packaging script writes reproducible ZIP timestamps and
generates the index after every package has passed manifest and size checks.
There is no auto-update path: downloading a package and granting capabilities
remain separate user actions.
