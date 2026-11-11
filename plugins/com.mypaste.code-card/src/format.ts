/**
 * formatSource gives a pasted one-liner the shape a reader can scan before the
 * card draws it. The card is a picture, so re-indenting the drawn copy cannot
 * damage the entry itself — but a source that already has line breaks is the
 * author's own layout and is returned untouched, and so is anything this module
 * cannot re-indent confidently: a formatter that guesses is worse than the one
 * line that was pasted.
 *
 * JSON, HTML and CSS have a shape that can be recovered without a parser. The
 * languages whose whitespace is semantic (Python, YAML, Shell, Markdown) and
 * those that need a real parser (JavaScript, TypeScript, Go, Rust, PHP, SQL)
 * are left exactly as they came.
 */

import type { CodeLanguage } from "./tokenize";

const INDENT = "  ";

/** Elements that never take a closing tag, so they never open a level. */
const HTML_VOID = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
]);

/**
 * Elements whose content is raw text rather than markup. Re-indenting would
 * move the text they exist to preserve, so a document holding one is refused.
 */
const HTML_RAW = new Set(["pre", "textarea", "script", "style"]);

/** A text run this short stays on its element's line instead of below it. */
const INLINE_TEXT_MAX = 80;

type HtmlNode =
  | { kind: "text"; text: string }
  | { kind: "opaque"; text: string }
  | { kind: "element"; open: string; close: string; children: HtmlNode[] };

/**
 * formatSource re-indents a single-line source. Anything else — a multi-line
 * source, another language, or a source this module cannot read cleanly — is
 * returned unchanged.
 */
export function formatSource(text: string, language: CodeLanguage): string {
  if (text.includes("\n")) return text;
  if (language === "json") return formatJSON(text);
  if (language === "html") return formatHTML(text);
  if (language === "css") return formatCSS(text);
  return text;
}

/** JSON is re-indented by the standard parser, so key order cannot change. */
function formatJSON(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function formatHTML(text: string): string {
  const nodes = parseHTML(text);
  if (!nodes) return text;
  const lines: string[] = [];
  renderNodes(nodes, 0, lines);
  return lines.join("\n");
}

/**
 * parseHTML builds one tree from the tag stream, or answers null the moment the
 * markup stops making sense: an unclosed tag, a stray close, an unterminated
 * comment or a raw-text element all mean the author wrote something this module
 * should not move.
 */
function parseHTML(source: string): HtmlNode[] | null {
  const root: HtmlNode[] = [];
  const stack: { name: string; open: string; children: HtmlNode[] }[] = [];
  const append = (node: HtmlNode): void => {
    const parent = stack[stack.length - 1];
    (parent ? parent.children : root).push(node);
  };

  let index = 0;
  while (index < source.length) {
    const start = source.indexOf("<", index);
    if (start < 0) {
      append({ kind: "text", text: source.slice(index) });
      break;
    }
    if (start > index) append({ kind: "text", text: source.slice(index, start) });

    if (source.startsWith("<!--", start)) {
      const end = source.indexOf("-->", start + 4);
      if (end < 0) return null;
      append({ kind: "opaque", text: source.slice(start, end + 3) });
      index = end + 3;
      continue;
    }
    const end = tagEnd(source, start);
    if (end < 0) return null;
    const raw = source.slice(start, end + 1);
    if (raw.startsWith("<!") || raw.startsWith("<?")) {
      append({ kind: "opaque", text: raw });
      index = end + 1;
      continue;
    }

    const closing = /^<\s*\//.test(raw);
    const name = (/^<\s*\/?\s*([A-Za-z][\w:.-]*)/.exec(raw)?.[1] ?? "").toLowerCase();
    if (!name) return null;
    if (closing) {
      const element = stack.pop();
      if (!element || element.name !== name) return null;
      append({ kind: "element", open: element.open, close: raw, children: element.children });
    } else if (/\/\s*>$/.test(raw) || HTML_VOID.has(name)) {
      append({ kind: "element", open: raw, close: "", children: [] });
    } else if (HTML_RAW.has(name)) {
      return null;
    } else {
      stack.push({ name, open: raw, children: [] });
    }
    index = end + 1;
  }
  return stack.length === 0 ? root : null;
}

/** tagEnd answers the index of the `>` that closes the tag, quotes included. */
function tagEnd(source: string, start: number): number {
  let quote = "";
  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === ">") return index;
  }
  return -1;
}

function renderNodes(nodes: HtmlNode[], depth: number, lines: string[]): void {
  const pad = INDENT.repeat(depth);
  for (const node of nodes) {
    if (node.kind === "text") {
      const text = collapse(node.text);
      if (text) lines.push(pad + text);
      continue;
    }
    if (node.kind === "opaque") {
      lines.push(pad + node.text.trim());
      continue;
    }
    if (!node.close) {
      lines.push(pad + node.open);
      continue;
    }
    if (node.children.length === 0) {
      lines.push(pad + node.open + node.close);
      continue;
    }
    const inline = inlineText(node.children);
    if (inline !== null) {
      lines.push(pad + node.open + inline + node.close);
      continue;
    }
    lines.push(pad + node.open);
    renderNodes(node.children, depth + 1, lines);
    lines.push(pad + node.close);
  }
}

/** A run of short text children stays on their element's line. */
function inlineText(children: HtmlNode[]): string | null {
  const parts: string[] = [];
  for (const child of children) {
    if (child.kind !== "text") return null;
    const text = collapse(child.text);
    if (!text || text.length > INLINE_TEXT_MAX) return null;
    parts.push(text);
  }
  return parts.length > 0 ? parts.join(" ") : null;
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * formatCSS re-indents by brace depth, one rule or declaration per line. String
 * literals and comments are copied byte for byte, and source whose braces or
 * strings do not close is refused rather than repaired.
 */
function formatCSS(source: string): string {
  const lines: string[] = [];
  let current = "";
  let depth = 0;

  const flush = (): void => {
    const line = current.trim();
    current = "";
    if (line) lines.push(INDENT.repeat(depth) + line);
  };

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === "/" && source[index + 1] === "*") {
      const end = source.indexOf("*/", index + 2);
      if (end < 0) return source;
      current += source.slice(index, end + 2);
      index = end + 1;
      continue;
    }
    if (char === '"' || char === "'") {
      const end = source.indexOf(char, index + 1);
      if (end < 0) return source;
      current += source.slice(index, end + 1);
      index = end;
      continue;
    }
    if (char === "{") {
      const selector = current.trim();
      current = "";
      lines.push(INDENT.repeat(depth) + (selector ? `${selector} ` : "") + "{");
      depth += 1;
      continue;
    }
    if (char === "}") {
      flush();
      if (depth === 0) return source;
      depth -= 1;
      lines.push(INDENT.repeat(depth) + "}");
      continue;
    }
    if (char === ";") {
      current += ";";
      flush();
      continue;
    }
    current += char;
  }
  flush();
  return depth === 0 ? lines.join("\n") : source;
}
