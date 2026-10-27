#!/usr/bin/env python3
"""Small, dependency-free tokenizer used by every highlighting package."""

from __future__ import annotations

import json
import re
import sys

LANGUAGES = {
    "go", "html", "javascript", "json", "php", "python", "rust", "typescript",
}
SAFE_KINDS = {
    "", "keyword", "string", "comment", "number", "literal", "property",
    "function", "tag", "type",
}
KEYWORDS = {
    "go": set("break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var".split()),
    "javascript": set("async await break case catch class const continue default delete do else export extends finally for from function if import in instanceof let new of return static super switch throw try typeof var void while with yield".split()),
    "typescript": set("abstract any as async await boolean break case catch class const continue declare default delete do else enum export extends finally for from function if implements import in infer instanceof interface keyof let namespace never new number of private protected public readonly return satisfies static string super switch throw try type typeof unknown var void while yield".split()),
    "php": set("abstract and array as break callable case catch class clone const continue declare default do echo else elseif empty enddeclare endfor endforeach endif endswitch endwhile enum extends final finally fn for foreach function global goto if implements include include_once instanceof insteadof interface isset list match namespace new or print private protected public readonly require require_once return static switch throw trait try unset use var while xor yield".split()),
    "python": set("and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield".split()),
    "rust": set("as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while".split()),
}
LITERALS = {"false", "nil", "null", "none", "true", "undefined"}


def add(tokens: list[dict[str, str]], text: str, kind: str = "") -> None:
    if text:
        tokens.append({"text": text, "kind": kind})


def comment_end(source: str, index: int, language: str) -> int:
    pair = source[index:index + 2]
    if pair == "/*":
        if language in {"json", "html", "python"}:
            return index
        end = source.find("*/", index + 2)
        return len(source) if end < 0 else end + 2
    if pair == "//":
        if language in {"json", "html", "python", "php"}:
            return index
        end = source.find("\n", index + 2)
        return len(source) if end < 0 else end
    if source[index] == "#" and language in {"python", "php", "rust"}:
        end = source.find("\n", index + 1)
        return len(source) if end < 0 else end
    if language == "html" and source.startswith("<!--", index):
        end = source.find("-->", index + 4)
        return len(source) if end < 0 else end + 3
    return index


def string_end(source: str, index: int, language: str) -> int:
    quote = source[index]
    if quote not in {'"', "'", "`"}:
        return index
    if language == "json" and quote != '"':
        return index
    cursor = index + 1
    while cursor < len(source):
        if source[cursor] == "\\":
            cursor += 2
            continue
        if source[cursor] == quote:
            return cursor + 1
        cursor += 1
    return len(source)


def kind_for(source: str, start: int, end: int, language: str) -> str:
    word = source[start:end]
    lower = word.lower()
    if lower in KEYWORDS.get(language, set()):
        return "keyword"
    if lower in LITERALS:
        return "literal"
    cursor = end
    while cursor < len(source) and source[cursor].isspace():
        cursor += 1
    nxt = source[cursor:cursor + 1]
    if nxt == ":" and language in {"json", "javascript", "typescript", "php"}:
        return "property"
    if language == "html" and nxt == "=":
        return "property"
    if nxt == "(":
        return "function"
    if language in {"javascript", "typescript"} and word[:1].isupper():
        return "type"
    return ""


def highlight(source: str, language: str) -> list[dict[str, str]]:
    tokens: list[dict[str, str]] = []
    cursor = 0
    emitted = 0
    while cursor < len(source):
        end = comment_end(source, cursor, language)
        kind = "comment" if end > cursor else ""
        if not kind:
            end = string_end(source, cursor, language)
            if end > cursor:
                kind = "string"
        if not kind:
            match = re.match(r"0x[\da-f]+|\d+(?:\.\d+)?(?:e[+-]?\d+)?", source[cursor:], re.I)
            if match:
                end = cursor + len(match.group(0))
                kind = "number"
        if not kind and language == "html" and source[cursor] == "<":
            match = re.match(r"</?([A-Za-z][\w:-]*)", source[cursor:])
            if match:
                add(tokens, source[emitted:cursor])
                prefix = "</" if match.group(0).startswith("</") else "<"
                add(tokens, prefix)
                add(tokens, match.group(1), "tag")
                cursor += len(match.group(0))
                emitted = cursor
                continue
        if not kind:
            match = re.match(r"[A-Za-z_$][\w$-]*", source[cursor:])
            if match:
                end = cursor + len(match.group(0))
                kind = kind_for(source, cursor, end, language)
        if not kind:
            cursor += 1
            continue
        add(tokens, source[emitted:cursor])
        add(tokens, source[cursor:end], kind)
        emitted = end
        cursor = end
    add(tokens, source[emitted:])
    return tokens


def fail(request_id: str, message: str) -> None:
    json.dump({
        "id": request_id,
        "ok": False,
        "error": {"code": "invalid-request", "message": message},
    }, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")


def main() -> int:
    language = sys.argv[1] if len(sys.argv) > 1 else ""
    try:
        request = json.loads(sys.stdin.readline())
    except Exception:
        fail("", "invalid JSON request")
        return 0
    request_id = request.get("id", "")
    if request.get("protocolVersion") != 1 or request.get("render") is not True:
        fail(request_id, "selection.render is required")
        return 0
    selection = request.get("selection")
    if not isinstance(selection, dict) or not isinstance(selection.get("text"), str):
        fail(request_id, "selected text is required")
        return 0
    source = selection["text"]
    if language not in LANGUAGES:
        fail(request_id, "unsupported language")
        return 0
    tokens = highlight(source, language)
    if not tokens:
        fail(request_id, "nothing to highlight")
        return 0
    if len(tokens) > 4000 or sum(len(t["text"].encode()) for t in tokens) > 64 * 1024:
        fail(request_id, "render output exceeds limits")
        return 0
    json.dump({
        "id": request_id,
        "ok": True,
        "result": {
            "render": {"language": language, "tokens": tokens},
        },
    }, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
