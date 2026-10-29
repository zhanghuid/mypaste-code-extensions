#!/usr/bin/env python3
"""Safe formatting adapters for locally installed language tools.

This file is intentionally dependency-free. It reads the MyPaste runtime
request from stdin and invokes only a fixed tool selected by the package's
language argument. User text travels via stdin, never through shell syntax.
"""

from __future__ import annotations

import html
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


def respond(request_id: str, ok: bool, output: str = "", message: str = "") -> None:
    if ok:
        payload = {"id": request_id, "ok": True, "result": {"output": output, "effect": "copy"}}
    else:
        payload = {"id": request_id, "ok": False, "error": {"code": "format-failed", "message": message}}
    print(json.dumps(payload, ensure_ascii=False))
    sys.stdout.flush()


def fail(request_id: str, message: str) -> int:
    respond(request_id, False, message=message)
    return 0


def find_tool(name: str) -> str | None:
    for directory in ("/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"):
        candidate = Path(directory) / name
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return str(candidate)
    return shutil.which(name)


def run_tool(tool: str, args: list[str], source: str) -> str:
    result = subprocess.run(
        [tool, *args],
        input=source,
        text=True,
        capture_output=True,
        timeout=8,
        check=False,
    )
    if result.returncode != 0:
        detail = (result.stderr or result.stdout).strip().splitlines()
        reason = detail[0][:160] if detail else "formatter failed"
        raise RuntimeError(reason)
    return result.stdout


def format_go(source: str) -> str:
    tool = find_tool("gofmt")
    if not tool:
        raise RuntimeError("gofmt is not installed")
    return run_tool(tool, [], source)


def format_rust(source: str) -> str:
    tool = find_tool("rustfmt")
    if not tool:
        raise RuntimeError("rustfmt is not installed")
    return run_tool(tool, ["--emit", "stdout", "--edition", "2021"], source)


def js_format(source: str) -> str:
    tool = find_tool("node")
    if not tool:
        raise RuntimeError("node is not installed")
    script = r"""
const fs = require("fs");
let source = fs.readFileSync(0, "utf8");
let out = "";
let depth = 0;
let quote = "";
let escaped = false;
let lineStart = true;
const emitIndent = () => {
  if (lineStart) { out += "  ".repeat(depth); lineStart = false; }
};
const emitSpace = () => {
  if (out.length && !out.endsWith(" ") && !out.endsWith("\n")) out += " ";
};
const trimSpaces = () => { out = out.replace(/[ \t]+$/gm, ""); };
for (let i = 0; i < source.length; i += 1) {
  const c = source[i];
  if (quote) {
    out += c;
    if (escaped) escaped = false;
    else if (c === "\\") escaped = true;
    else if (c === quote) quote = "";
    continue;
  }
  if (c === '"' || c === "'" || c === "`") { emitIndent(); quote = c; out += c; continue; }
  if (c === "{" || c === "[" || c === "(") {
    emitIndent(); out += c; depth += 1; out += "\n"; lineStart = true; continue;
  }
  if (c === "}" || c === "]" || c === ")") {
    trimSpaces(); depth = Math.max(0, depth - 1);
    if (!out.endsWith("\n")) out += "\n";
    out += "  ".repeat(depth) + c; lineStart = false; continue;
  }
  if (c === ";") { emitIndent(); out += c + "\n"; lineStart = true; continue; }
  if (c === "\n" || c === "\r") { if (!lineStart) { out += "\n"; lineStart = true; } continue; }
  if (c === " " || c === "\t") { emitSpace(); continue; }
  emitIndent(); out += c;
}
trimSpaces();
if (!out.endsWith("\n")) out += "\n";
process.stdout.write(out);
"""
    result = subprocess.run([tool, "-e", script], input=source, text=True,
                            capture_output=True, timeout=8, check=False)
    if result.returncode != 0:
        raise RuntimeError((result.stderr or "JavaScript formatter failed").strip()[:160])
    return result.stdout


def simple_js_like(source: str) -> str:
    # A reviewed local formatter is intentionally conservative. It does not
    # rewrite whitespace inside strings, comments, regex literals or templates.
    return js_format(source)


def format_php(source: str) -> str:
    tool = find_tool("php")
    if not tool:
        raise RuntimeError("php is not installed")
    lint = subprocess.run([tool, "-l"], input=source, text=True,
                          capture_output=True, timeout=8, check=False)
    if lint.returncode != 0:
        raise RuntimeError((lint.stdout or lint.stderr).strip()[:160])
    # PHP has no standard formatter in the base distribution. Normalize only
    # indentation outside strings/comments and preserve every token.
    lines = source.replace("\r\n", "\n").split("\n")
    depth = 0
    result = []
    for line in lines:
        stripped = line.strip()
        if stripped.startswith("}"):
            depth = max(0, depth - 1)
        result.append("  " * depth + stripped if stripped else "")
        if stripped.endswith("{"):
            depth += 1
    return "\n".join(result).rstrip() + "\n"


def html_nesting_error(source: str) -> bool:
    tokens = re.findall(r"<!--[\s\S]*?-->|<![^>]*>|</?[A-Za-z][^>]*>", source)
    stack: list[str] = []
    void = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link",
            "meta", "param", "source", "track", "wbr", "!doctype"}
    for token in tokens:
        if token.startswith("<!") or token.startswith("<!"):
            continue
        match = re.match(r"</?([A-Za-z][\w:-]*)", token)
        if not match:
            continue
        name = match.group(1).lower()
        if token.startswith("</"):
            if not stack or stack.pop() != name:
                return True
        elif not token.rstrip().endswith("/>") and name not in void:
            stack.append(name)
    return bool(stack)


def tidy_added_structure(source: str, output: str) -> bool:
    # Allow Tidy to insert doctype/html/head/title/meta for a fragment, but not
    # to insert a missing closing tag around content. Compare text-node words
    # and a small set of required top-level elements.
    text = lambda value: re.sub(r"<[^>]+>", " ", value).split()
    if text(source) != text(output):
        return True
    source_tags = {m.lower() for m in re.findall(r"<([A-Za-z][\w:-]*)\b", source)}
    output_tags = {m.lower() for m in re.findall(r"<([A-Za-z][\w:-]*)\b", output)}
    allowed = {"!doctype", "html", "head", "body", "title", "meta"}
    added = output_tags - source_tags - allowed
    return bool(added)


def format_html(source: str) -> str:
    tool = find_tool("tidy")
    if not tool:
        raise RuntimeError("HTML Tidy is not installed")
    result = subprocess.run(
        [tool, "-q", "-utf8", "-i", "-w", "0"],
        input=source, text=True, capture_output=True, timeout=8, check=False,
    )
    if html_nesting_error(source):
        raise RuntimeError("HTML has mismatched or incomplete tags")
    if result.returncode >= 2:
        raise RuntimeError((result.stderr or "HTML Tidy rejected the document").strip()[:160])
    if not result.stdout.strip():
        raise RuntimeError("HTML Tidy returned empty output")
    if tidy_added_structure(source, result.stdout):
        raise RuntimeError("HTML Tidy would add or remove document structure")
    return result.stdout


def format_python(source: str) -> str:
    tool = find_tool("python3")
    if not tool:
        raise RuntimeError("python3 is not installed")
    # Compile first; never produce partial output for invalid source.
    check = subprocess.run([tool, "-c", "import sys; compile(sys.stdin.read(), '<clipboard>', 'exec')"],
                           input=source, text=True, capture_output=True, timeout=8, check=False)
    if check.returncode != 0:
        raise RuntimeError((check.stderr or "Python syntax error").strip().splitlines()[-1][:160])
    # Use a deterministic indentation/trailing-whitespace normalizer. A full
    # Python formatter is optional and not silently downloaded.
    lines = source.replace("\r\n", "\n").split("\n")
    normalized = []
    for line in lines:
        if not line.strip():
            normalized.append("")
        else:
            normalized.append(line.replace("\t", "    ").rstrip())
    return "\n".join(normalized).rstrip() + "\n"


FORMATTERS = {
    "go": format_go,
    "rust": format_rust,
    "javascript": simple_js_like,
    "typescript": simple_js_like,
    "php": format_php,
    "html": format_html,
    "python": format_python,
}


def main() -> int:
    language = sys.argv[1] if len(sys.argv) > 1 else ""
    try:
        request = json.loads(sys.stdin.readline())
    except Exception:
        return fail("", "invalid JSON request")
    request_id = request.get("id", "")
    if language not in FORMATTERS:
        return fail(request_id, "unsupported language")
    selection = request.get("selection")
    source = selection.get("text") if isinstance(selection, dict) else None
    if not isinstance(source, str) or not source.strip():
        return fail(request_id, "selected text is empty")
    # The host owns the text ceiling (extension.MaxTextBytes, 256 KiB) for the
    # request and for the response it accepts. A second, smaller bound here
    # rejects text the host already delivered, so this adapter keeps none.
    try:
        output = FORMATTERS[language](source)
    except Exception as error:
        return fail(request_id, str(error))
    if not output.strip():
        return fail(request_id, "formatter returned empty output")
    respond(request_id, True, output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
