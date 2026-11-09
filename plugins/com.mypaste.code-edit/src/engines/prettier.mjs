#!/usr/bin/env node
// Package-internal Prettier adapter for CSS and YAML.
//
// The files under ./prettier/ are copied from the pinned Prettier build
// dependency at package time; this wrapper is the only entry the runtime
// executes. It keeps the same newline-JSON contract as the other engines:
// one request on stdin, one response on stdout, user text never in argv or a
// shell.

import { readFileSync } from "node:fs";
import prettier from "./prettier/standalone.mjs";
import postcss from "./prettier/plugins/postcss.mjs";
import yaml from "./prettier/plugins/yaml.mjs";

const parser = process.argv[2];
const plugins = parser === "css" ? [postcss] : parser === "yaml" ? [yaml] : null;
const request = JSON.parse(readFileSync(0, "utf8"));
const id = typeof request.id === "string" ? request.id : "";
if (!plugins) fail(`unsupported prettier parser: ${String(parser)}`);
const selection = request.selection;
const source = selection && typeof selection.text === "string"
  ? selection.text : "";
if (!source.trim()) fail("selected text is empty");
// The host owns the text ceiling (extension.MaxTextBytes) for the request and
// for the response it accepts, so this adapter adds no bound of its own.

try {
  const output = await prettier.format(source, { parser, plugins });
  process.stdout.write(JSON.stringify({
    id,
    ok: true,
    result: { output, effect: "copy" },
  }) + "\n");
} catch (error) {
  const message = String(error?.message ?? error).split("\n")[0].slice(0, 160);
  fail(message || "prettier failed");
}

function fail(message) {
  process.stdout.write(JSON.stringify({
    id,
    ok: false,
    error: { code: "format-failed", message },
  }) + "\n");
  process.exit(0);
}
