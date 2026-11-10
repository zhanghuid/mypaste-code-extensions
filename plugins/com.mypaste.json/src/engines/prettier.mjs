#!/usr/bin/env node
// Package-internal Prettier adapter for the JSON surface.
//
// The files under ./prettier/ are copied from the pinned Prettier build
// dependency at package time; this wrapper is the only entry the runtime
// executes. It keeps the same newline-JSON contract as the other engines: one
// request on stdin, one response on stdout, user text never in argv or a
// shell. Prettier's `json` parser is the only authority — nothing here
// pre-validates with JSON.parse, so the layout and the error position are
// exactly what Prettier reports.

import { readFileSync } from "node:fs";
import prettier from "./prettier/standalone.mjs";
import babel from "./prettier/plugins/babel.mjs";
import estree from "./prettier/plugins/estree.mjs";

const request = JSON.parse(readFileSync(0, "utf8"));
const id = typeof request.id === "string" ? request.id : "";
const selection = request.selection;
const input = request.input;
const source = selection && typeof selection.text === "string"
  ? selection.text
  : input && typeof input.text === "string" ? input.text : "";
if (!source.trim()) fail("没有可格式化的文本");

try {
  const output = await prettier.format(source.replace(/^\uFEFF/, ""), {
    parser: "json",
    plugins: [babel, estree],
  });
  process.stdout.write(JSON.stringify({ id, ok: true, result: { output } }) + "\n");
} catch (error) {
  fail(describe(error));
}

/**
 * Prettier's message carries a multi-line code frame and ends its first line
 * with "(line:column)". The panel reports the position itself and has no room
 * for the frame, so only the first line's reason survives here.
 */
function describe(error) {
  if (!(error instanceof Error)) return "无法解析为 JSON";
  const firstLine = (error.message.split("\n")[0] ?? "").trim();
  const message = firstLine.replace(/\s*\(\d+:\d+\)\s*$/, "").trim();
  const line = error.loc?.start?.line;
  const column = error.loc?.start?.column;
  if (typeof line === "number" && typeof column === "number") {
    return `第 ${line} 行第 ${column} 列附近无法解析${message === "" ? "" : `（${message}）`}`;
  }
  return message === "" ? "无法解析为 JSON" : message;
}

function fail(message) {
  process.stdout.write(JSON.stringify({
    id,
    ok: false,
    error: { code: "format-failed", message },
  }) + "\n");
  process.exit(0);
}
