#!/usr/bin/env python3
"""Strict JSON formatter shared by formatting adapters."""

from __future__ import annotations

import json
import sys


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
    formatted = json.dumps(value, ensure_ascii=False, indent=2) + "\n"
    print(json.dumps({
        "id": request_id,
        "ok": True,
        "result": {"output": formatted, "effect": "copy"},
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
