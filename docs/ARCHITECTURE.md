# Architecture

## Two plugin families

MyPaste has two different trust decisions:

1. **Formatting** changes text and then asks the host to write the result to
   the clipboard. It needs `selection.read` + `clipboard.write`.
2. **Highlighting** is presentation-only. It needs only `selection.render` and
   must not write anything.

This split is deliberate. A highlighting plugin cannot silently acquire
clipboard-write authority just because it is installed for preview.

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

Limits: 4000 tokens and 64 KiB total text. MyPaste validates the result twice:
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
