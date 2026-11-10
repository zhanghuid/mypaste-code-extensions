/**
 * JSON formatting through the Prettier build bundled into this page.
 *
 * The package ships Prettier's standalone API plus the babel and estree
 * plugins; the page has no runtime process and no network access, so parsing
 * happens here, in the document the host serves. Prettier's `json` parser is
 * the only authority — the page does not pre-validate with `JSON.parse`, so
 * the layout and the error position are exactly what Prettier reports.
 */

import { format } from "prettier/standalone";
import * as babel from "prettier/plugins/babel";
import * as estree from "prettier/plugins/estree";
import type { Plugin } from "prettier";

export type JSONFormatResult =
  | { ok: true; text: string }
  | { ok: false; reason: string };

interface ParseError extends Error {
  loc?: { start?: { line?: number; column?: number } };
}

/**
 * Prettier's message carries a multi-line code frame and ends its first line
 * with "(line:column)". The page reports the position itself and has no room
 * for the frame, so only the first line's reason survives here.
 */
function describe(error: unknown): string {
  if (!(error instanceof Error)) return "无法解析为 JSON";
  const { loc } = error as ParseError;
  const firstLine = (error.message.split("\n")[0] ?? "").trim();
  const message = firstLine.replace(/\s*\(\d+:\d+\)\s*$/, "").trim();
  const line = loc?.start?.line;
  const column = loc?.start?.column;
  if (typeof line === "number" && typeof column === "number") {
    return `第 ${line} 行第 ${column} 列附近无法解析${message === "" ? "" : `（${message}）`}`;
  }
  return message === "" ? "无法解析为 JSON" : message;
}

export async function formatJSON(source: string): Promise<JSONFormatResult> {
  try {
    const text = await format(source.replace(/^\uFEFF/, ""), {
      parser: "json",
      plugins: [babel as Plugin, estree as Plugin],
    });
    return { ok: true, text };
  } catch (error) {
    return { ok: false, reason: describe(error) };
  }
}
