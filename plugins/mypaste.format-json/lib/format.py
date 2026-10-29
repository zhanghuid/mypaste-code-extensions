#!/usr/bin/env python3
"""Strict JSON formatter shared by formatting adapters."""

from __future__ import annotations

import json
import sys

DEFAULT_INDENT = 2
MIN_INDENT = 1
MAX_INDENT = 8


def indent_width(request: dict) -> int:
    """Read the declared indent, falling back to the manifest default.

    The host validates before launching, so this is a second boundary rather
    than the first one: a host that sends nothing, or a value outside the
    declared range, still formats instead of failing the command.
    """
    settings = request.get("settings")
    value = settings.get("indent") if isinstance(settings, dict) else None
    if isinstance(value, bool) or not isinstance(value, int):
        return DEFAULT_INDENT
    return value if MIN_INDENT <= value <= MAX_INDENT else DEFAULT_INDENT


def main() -> int:
    try:
        request = json.loads(sys.stdin.readline())
    except Exception:
        print(json.dumps({"id": "", "ok": False, "error": {
            "code": "invalid-request", "message": "invalid JSON request",
        }}))
        return 0
    request_id = request.get("id", "")
    selection = request.get("selection")
    source = selection.get("text") if isinstance(selection, dict) else None
    if not isinstance(source, str) or not source.strip():
        print(json.dumps({"id": request_id, "ok": False, "error": {
            "code": "empty", "message": "selected text is empty",
        }}))
        return 0
    try:
        value = json.loads(source)
    except json.JSONDecodeError as error:
        print(json.dumps({"id": request_id, "ok": False, "error": {
            "code": "invalid-source",
            "message": f"invalid JSON at line {error.lineno}, column {error.colno}",
        }}))
        return 0
    formatted = json.dumps(
        value, ensure_ascii=False, indent=indent_width(request)
    ) + "\n"
    print(json.dumps({
        "id": request_id,
        "ok": True,
        "result": {"output": formatted, "effect": "copy"},
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
