#!/usr/bin/env node
// Conservative JavaScript/TypeScript validator and indentation normalizer.
// This is not a parser rewrite: it only changes whitespace outside strings,
// comments, template literals and regular expressions. Invalid delimiter
// structure is rejected so a bad source never gets a partial "formatted" copy.

const fs = await import("node:fs");
const language = process.argv[2] === "typescript" ? "typescript" : "javascript";
const request = JSON.parse(fs.readFileSync(0, "utf8"));
const id = typeof request.id === "string" ? request.id : "";
const source = request.selection && typeof request.selection.text === "string"
  ? request.selection.text : "";
if (!source.trim()) fail("selected text is empty");
if (Buffer.byteLength(source) > 32 * 1024) fail("source exceeds 32 KiB");

const tokens = [];
let i = 0;
let quote = "";
let escaped = false;
let regex = false;
while (i < source.length) {
  const c = source[i];
  const next = source[i + 1] ?? "";
  if (quote) {
    if (escaped) escaped = false;
    else if (c === "\\") escaped = true;
    else if (c === quote) quote = "";
    i += 1;
    continue;
  }
  if (c === "/" && next === "/") {
    while (i < source.length && source[i] !== "\n") i += 1;
    continue;
  }
  if (c === "/" && next === "*") {
    const end = source.indexOf("*/", i + 2);
    if (end < 0) fail("unterminated block comment");
    i = end + 2;
    continue;
  }
  if (c === '"' || c === "'" || c === "`") { quote = c; escaped = false; i += 1; continue; }
  if (c === "/" && /[(=,:;!&|?{}[\n]/.test(source[i - 1] ?? "\n")) {
    regex = true;
    i += 1;
    while (i < source.length) {
      if (source[i] === "\\") i += 2;
      else if (source[i] === "/") { regex = false; i += 1; break; }
      else i += 1;
    }
    continue;
  }
  if (c === "(" || c === "[" || c === "{") tokens.push(c);
  else if (c === ")" || c === "]" || c === "}") {
    const open = tokens.pop();
    if (!open || "([{".indexOf(open) !== ")]}".indexOf(c)) fail("unbalanced delimiters");
  }
  i += 1;
}
if (quote) fail("unterminated string");
if (tokens.length) fail("unbalanced delimiters");

// Normalize only line trailing whitespace and leading indentation using
// brace depth. Preserve the user's token spacing exactly.
const lines = source.replace(/\r\n/g, "\n").split("\n");
let depth = 0;
const output = [];
for (const raw of lines) {
  const line = raw.trimEnd();
  if (!line.trim()) { output.push(""); continue; }
  const stripped = line.trimStart();
  const close = (stripped.match(/^[}\])]/) ?? [""])[0].length;
  const indent = Math.max(0, depth - close);
  output.push("  ".repeat(indent) + stripped);
  const opens = (stripped.match(/[([{]/g) ?? []).length;
  const closes = (stripped.match(/[)\]}]/g) ?? []).length;
  depth = Math.max(0, depth + opens - closes);
}
const formatted = output.join("\n").replace(/\n+$/, "") + "\n";
if (Buffer.byteLength(formatted) > 32 * 1024) fail("formatted output exceeds 32 KiB");
process.stdout.write(JSON.stringify({
  id,
  ok: true,
  result: { output: formatted, effect: "copy" },
}) + "\n");

function fail(message) {
  process.stdout.write(JSON.stringify({
    id,
    ok: false,
    error: { code: "format-failed", message },
  }) + "\n");
  process.exit(0);
}
