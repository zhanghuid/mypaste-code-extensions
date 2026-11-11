/**
 * Folding a pretty-printed JSON document into an outline.
 *
 * The right pane shows a result as text, and folding is a way to read that
 * text, never a rewrite of it: the root stays open, every nested object or
 * array becomes one `{ … }` / `[ … ]` line, and copying still sends the
 * complete result. Scanning is string-aware, so braces inside strings and
 * escaped quotes never move the depth; no value is re-serialised, so duplicate
 * keys, key order and the source's own spelling all survive.
 */

import { parseJson } from "./json";

export interface FoldedDocument {
  /** The document with every nested container collapsed onto one line. */
  text: string;
  /** How many containers became one line. */
  count: number;
}

interface Span {
  open: number;
  close: number;
}

/** A line the scanner has already counted, so the index is always in range. */
function lineAt(lines: string[], index: number): string {
  const line = lines[index];
  if (line === undefined) throw new Error(`fold: line ${index} is out of range`);
  return line;
}

/** Reads one line's effect on the bracket depth, ignoring string contents. */
function scanLine(line: string, depth: number): number {
  let inString = false;
  let escaped = false;
  for (const character of line) {
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
    } else if (character === "{" || character === "[") {
      depth += 1;
    } else if (character === "}" || character === "]") {
      depth -= 1;
    }
  }
  return depth;
}

/** The line that opens a container at `open`, collapsed to `{ … }`. */
function foldedLine(lines: string[], span: Span): string {
  const openLine = lineAt(lines, span.open);
  const body = openLine.trimEnd();
  const indent = openLine.slice(0, openLine.length - openLine.trimStart().length);
  const bracket = body.slice(-1);
  const closeBracket = bracket === "{" ? "}" : "]";
  const head = body.slice(0, -1).trim();
  const closeLine = lineAt(lines, span.close).trim();
  // A container that is not the last member of its parent keeps the comma the
  // closing line carried; the marker line owns it now.
  const trailing = closeLine.startsWith(closeBracket) ? closeLine.slice(1) : "";
  return `${indent}${head === "" ? "" : `${head} `}${bracket} … ${closeBracket}${trailing}`;
}

/**
 * Collapses every nested container of a pretty-printed JSON document.
 *
 * Returns `null` when the document has nothing to fold — it is not JSON, it is
 * a single line, or every container already fits on one. The caller can then
 * leave the control disabled rather than offering an action that changes
 * nothing.
 */
export function foldJson(source: string): FoldedDocument | null {
  try {
    parseJson(source);
  } catch {
    return null;
  }
  const trailingNewline = source.endsWith("\n");
  const lines = source.split("\n");
  if (trailingNewline) lines.pop();
  if (lines.length < 2) return null;

  const depthBefore: number[] = [];
  const depthAfter: number[] = [];
  let depth = 0;
  for (const line of lines) {
    depthBefore.push(depth);
    depth = scanLine(line, depth);
    depthAfter.push(depth);
  }

  const stack: number[] = [];
  const spans: Span[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const before = depthBefore[index] ?? 0;
    const after = depthAfter[index] ?? 0;
    const delta = after - before;
    if (delta === 1) {
      stack.push(index);
    } else if (delta === -1) {
      const open = stack.pop();
      if (open === undefined) return null;
      spans.push({ open, close: index });
    } else if (delta !== 0) {
      // Prettier puts one bracket per line in JSON; anything else is not the
      // shape this view knows how to fold.
      return null;
    }
  }
  if (stack.length !== 0) return null;

  const nested = new Map<number, Span>();
  for (const span of spans) {
    const before = depthBefore[span.open] ?? 0;
    if (before >= 1) nested.set(span.open, span);
  }
  if (nested.size === 0) return null;

  const folded: string[] = [];
  let count = 0;
  let index = 0;
  while (index < lines.length) {
    const span = nested.get(index);
    if (span === undefined) {
      folded.push(lineAt(lines, index));
      index += 1;
      continue;
    }
    folded.push(foldedLine(lines, span));
    count += 1;
    index = span.close + 1;
  }
  return {
    text: folded.join("\n") + (trailingNewline ? "\n" : ""),
    count,
  };
}
