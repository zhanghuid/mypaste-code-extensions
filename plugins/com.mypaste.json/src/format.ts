/**
 * The page's formatter.
 *
 * Prettier's browser build is bundled into this page, so formatting needs no
 * runtime, node or network. Only the JSON parser and the estree printer are
 * imported; the CSS, YAML and Markdown parsers never enter the bundle.
 */

import { format } from "prettier/standalone";
import type { Plugin } from "prettier";
import * as babelPlugin from "prettier/plugins/babel";
import * as estreePlugin from "prettier/plugins/estree";

/** Formats JSON text with Prettier's canonical two-space layout. */
export async function formatJson(text: string): Promise<string> {
  return format(text, {
    parser: "json",
    // The estree package ships no type declarations, only the printer plugin.
    plugins: [babelPlugin, estreePlugin as unknown as Plugin],
    tabWidth: 2,
    printWidth: 80,
  });
}

export interface JsonPosition {
  line: number;
  column: number;
}

/**
 * Reads the line and column from a JSON parse or Prettier error. Prettier
 * attaches `loc.start`; native `JSON.parse` messages name a character offset.
 * Columns are 1-based in both branches, because they are user-facing.
 */
export function jsonErrorPosition(error: unknown, source: string): JsonPosition | null {
  if (typeof error !== "object" || error === null) return null;
  const candidate = error as { loc?: { start?: { line?: unknown; column?: unknown } } };
  const start = candidate.loc?.start;
  if (typeof start?.line === "number" && typeof start.column === "number") {
    return { line: start.line, column: start.column + 1 };
  }
  const message = error instanceof Error ? error.message : "";
  const match = /position (\d+)/.exec(message);
  if (match === null) return null;
  const offset = Math.min(Number(match[1]), source.length);
  const before = source.slice(0, offset);
  const line = before.split("\n").length;
  const column = offset - before.lastIndexOf("\n");
  return { line, column };
}

/** A user-facing one-line description of a parse or format failure. */
export function describeJsonError(error: unknown, source: string): string {
  const place = jsonErrorPosition(error, source);
  const message = error instanceof Error && error.message !== ""
    ? error.message.split("\n")[0] ?? "内容无法解析"
    : "内容无法解析";
  return place === null ? message : `第 ${place.line} 行第 ${place.column} 列：${message}`;
}
