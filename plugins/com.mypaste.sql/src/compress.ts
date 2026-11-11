/**
 * The page's compressor.
 *
 * Comments are removed and whitespace runs collapse to one space only where
 * the neighbouring tokens would otherwise merge. Strings, quoted identifiers
 * and numbers are copied exactly. `/*+ … *\/` is kept: in dialects that
 * support optimizer hints the comment changes the plan, so a compressor must
 * not silently drop it.
 */

import type { Analysis } from "./analyze";

export type CompressResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly message: string };

function isWordRune(char: string): boolean {
  return char === "_" || char === "$" || char === "'" || char === '"' ||
    char === "`" || /[\p{L}\p{N}]/u.test(char);
}

function isClosingPunctuation(char: string): boolean {
  return ",;)].}".includes(char);
}

function isOpeningPunctuation(char: string): boolean {
  return "([{.".includes(char);
}

function needsSeparator(previous: string, next: string): boolean {
  const last = previous.charAt(previous.length - 1);
  const first = next.charAt(0);
  if (isClosingPunctuation(first) || isOpeningPunctuation(last)) return false;
  if (first === "(") return false;
  if (
    (last === "-" && first === "-") ||
    (last === "/" && first === "*") ||
    (last === "*" && first === "/")
  ) {
    return true;
  }
  return isWordRune(last) || isWordRune(first);
}

export function compressSql(analysis: Analysis): CompressResult {
  const units: string[] = [];
  for (const token of analysis.tokens) {
    if (token.kind === "comment") {
      if (token.text.startsWith("/*+")) units.push(token.text);
      continue;
    }
    if (token.text.trim() === "") continue;
    units.push(token.text);
  }
  if (units.length === 0) {
    return { ok: false, message: "没有可压缩的 SQL 文本" };
  }

  let output = "";
  let previous = "";
  for (const unit of units) {
    if (previous !== "" && needsSeparator(previous, unit)) output += " ";
    output += unit;
    previous = unit;
  }

  const compressed = output.trim();
  if (compressed === "") {
    return { ok: false, message: "没有可压缩的 SQL 文本" };
  }
  return { ok: true, text: compressed };
}
