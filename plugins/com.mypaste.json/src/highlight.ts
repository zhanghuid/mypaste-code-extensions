/**
 * Syntax colour for the two panes.
 *
 * A highlighter is usually a parser, a grammar and a theme bundled as one
 * dependency; this page needs three small languages, so each scanner is
 * written here. A scanner returns runs of text and a colour role, and the
 * renderer writes them as spans whose text is only ever set through
 * `textContent`: a document that contains markup can never become markup.
 *
 * Colours are CSS classes (`tok-*`). The stylesheet maps each role to the
 * host's `--mp-code-*` token and keeps this document's own palette as the
 * fallback for a host that forwards no code colours.
 */

export type Language = "json" | "xml" | "typescript" | "plain";

export type TokenRole =
  | "keyword"
  | "string"
  | "number"
  | "property"
  | "comment"
  | "tag"
  | "type";

export interface Token {
  text: string;
  role: TokenRole | null;
}

const ROLE_CLASS: Record<TokenRole, string> = {
  keyword: "tok-keyword",
  string: "tok-string",
  number: "tok-number",
  property: "tok-property",
  comment: "tok-comment",
  tag: "tok-tag",
  type: "tok-type",
};

/**
 * Past this size the pane shows plain ink. A document this long is being
 * scrolled, not read token by token, and repainting it on every keystroke
 * would cost more than the colour is worth.
 */
const MAX_HIGHLIGHTED_LENGTH = 400_000;

const JSON_PUNCTUATION = "{}[],:";
const JSON_LITERALS = ["true", "false", "null"] as const;
const JSON_NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

/** A keyword word boundary: `truex` is a word, `true,` is the literal. */
function endsWord(source: string, index: number): boolean {
  return index >= source.length || !/[A-Za-z0-9_$]/.test(source.charAt(index));
}

function literalAt(source: string, index: number): string | null {
  for (const literal of JSON_LITERALS) {
    if (source.startsWith(literal, index) && endsWord(source, index + literal.length)) {
      return literal;
    }
  }
  return null;
}

function numberAt(source: string, index: number): string | null {
  JSON_NUMBER.lastIndex = index;
  const match = JSON_NUMBER.exec(source);
  return match === null ? null : match[0];
}

/** The string that starts at `index`; `end` is just past its closing quote. */
function stringEnd(source: string, index: number): number {
  let end = index + 1;
  while (end < source.length) {
    const character = source.charAt(end);
    end += 1;
    if (character === "\\") end += 1;
    else if (character === '"') break;
  }
  return end;
}

function scanJson(source: string): Token[] {
  const tokens: Token[] = [];
  const push = (text: string, role: TokenRole | null): void => {
    if (text !== "") tokens.push({ text, role });
  };
  let index = 0;
  while (index < source.length) {
    const character = source.charAt(index);
    if (character === '"') {
      // A key is a string that is followed by a colon; the colour follows the
      // position, never the spelling.
      const end = stringEnd(source, index);
      let lookahead = end;
      while (lookahead < source.length && /\s/.test(source.charAt(lookahead))) lookahead += 1;
      push(source.slice(index, end), source.charAt(lookahead) === ":" ? "property" : "string");
      index = end;
      continue;
    }
    if (JSON_PUNCTUATION.includes(character)) {
      push(character, null);
      index += 1;
      continue;
    }
    const number = numberAt(source, index);
    if (number !== null) {
      push(number, "number");
      index += number.length;
      continue;
    }
    const literal = literalAt(source, index);
    if (literal !== null) {
      push(literal, "keyword");
      index += literal.length;
      continue;
    }
    // Whitespace and anything the scanner does not recognise stays plain, one
    // run at a time, so the pane's text is never reordered.
    let end = index;
    while (end < source.length) {
      const next = source.charAt(end);
      if (next === '"' || JSON_PUNCTUATION.includes(next)) break;
      if (numberAt(source, end) !== null || literalAt(source, end) !== null) break;
      end += 1;
    }
    push(source.slice(index, end === index ? index + 1 : end), null);
    index = end === index ? index + 1 : end;
  }
  return tokens;
}

const XML_TAG = /^(<\/?)([A-Za-z_:][\w.:-]*)([\s\S]*?)(\/?>)$/;
const XML_ATTRIBUTE = /(\s+)([A-Za-z_:][\w.:-]*)(\s*=\s*)("[^"]*"|'[^']*')/g;

/** One `<name attr="value">`, `</name>` or `<?target?>` as coloured runs. */
function pushTag(tokens: Token[], tag: string): void {
  const match = XML_TAG.exec(tag);
  if (match === null) {
    tokens.push({ text: tag, role: null });
    return;
  }
  const open = match[1] ?? "";
  const name = match[2] ?? "";
  const body = match[3] ?? "";
  const close = match[4] ?? "";
  tokens.push({ text: open, role: null });
  tokens.push({ text: name, role: "tag" });
  let cursor = 0;
  XML_ATTRIBUTE.lastIndex = 0;
  let attribute = XML_ATTRIBUTE.exec(body);
  while (attribute !== null) {
    const [whole, space = "", key = "", equals = "", value = ""] = attribute;
    if (attribute.index > cursor) {
      tokens.push({ text: body.slice(cursor, attribute.index), role: null });
    }
    tokens.push({ text: space, role: null });
    tokens.push({ text: key, role: "property" });
    tokens.push({ text: equals, role: null });
    tokens.push({ text: value, role: "string" });
    cursor = attribute.index + whole.length;
    attribute = XML_ATTRIBUTE.exec(body);
  }
  if (cursor < body.length) tokens.push({ text: body.slice(cursor), role: null });
  tokens.push({ text: close, role: null });
}

function scanXml(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    if (source.startsWith("<!--", index)) {
      const end = source.indexOf("-->", index + 4);
      const stop = end === -1 ? source.length : end + 3;
      tokens.push({ text: source.slice(index, stop), role: "comment" });
      index = stop;
      continue;
    }
    if (source.charAt(index) === "<") {
      const end = source.indexOf(">", index);
      const stop = end === -1 ? source.length : end + 1;
      pushTag(tokens, source.slice(index, stop));
      index = stop;
      continue;
    }
    const end = source.indexOf("<", index);
    const stop = end === -1 ? source.length : end;
    tokens.push({ text: source.slice(index, stop), role: null });
    index = stop;
  }
  return tokens;
}

const TS_KEYWORDS = new Set([
  "as",
  "class",
  "const",
  "declare",
  "default",
  "enum",
  "export",
  "extends",
  "from",
  "function",
  "implements",
  "import",
  "in",
  "interface",
  "is",
  "keyof",
  "let",
  "module",
  "namespace",
  "new",
  "of",
  "readonly",
  "return",
  "type",
  "var",
]);

const TS_PRIMITIVES = new Set([
  "any",
  "bigint",
  "boolean",
  "never",
  "null",
  "number",
  "object",
  "string",
  "symbol",
  "undefined",
  "unknown",
  "void",
]);

const TS_NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const TS_WORD = /[A-Za-z_$][A-Za-z0-9_$]*/y;

function wordAt(source: string, index: number): string | null {
  TS_WORD.lastIndex = index;
  const match = TS_WORD.exec(source);
  return match === null ? null : match[0];
}

function numberIn(source: string, index: number): string | null {
  TS_NUMBER.lastIndex = index;
  const match = TS_NUMBER.exec(source);
  return match === null ? null : match[0];
}

function skipSpace(source: string, index: number): number {
  let cursor = index;
  while (cursor < source.length && /\s/.test(source.charAt(cursor))) cursor += 1;
  return cursor;
}

/** A quoted string, template literal included; `end` is just past the close. */
function quotedEnd(source: string, index: number): number {
  const quote = source.charAt(index);
  let end = index + 1;
  while (end < source.length) {
    const character = source.charAt(end);
    end += 1;
    if (character === "\\") end += 1;
    else if (character === quote) break;
  }
  return end;
}

function scanTypeScript(source: string): Token[] {
  const tokens: Token[] = [];
  const push = (text: string, role: TokenRole | null): void => {
    if (text !== "") tokens.push({ text, role });
  };
  let index = 0;
  while (index < source.length) {
    const character = source.charAt(index);
    if (source.startsWith("//", index)) {
      const end = source.indexOf("\n", index);
      const stop = end === -1 ? source.length : end;
      push(source.slice(index, stop), "comment");
      index = stop;
      continue;
    }
    if (source.startsWith("/*", index)) {
      const end = source.indexOf("*/", index + 2);
      const stop = end === -1 ? source.length : end + 2;
      push(source.slice(index, stop), "comment");
      index = stop;
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      const end = quotedEnd(source, index);
      const lookahead = skipSpace(source, end);
      push(source.slice(index, end), source.charAt(lookahead) === ":" ? "property" : "string");
      index = end;
      continue;
    }
    const number = numberIn(source, index);
    if (number !== null) {
      push(number, "number");
      index += number.length;
      continue;
    }
    const word = wordAt(source, index);
    if (word !== null) {
      const lookahead = skipSpace(source, index + word.length);
      let role: TokenRole | null = null;
      if (TS_KEYWORDS.has(word) || word === "true" || word === "false") role = "keyword";
      else if (TS_PRIMITIVES.has(word)) role = "type";
      else if (source.charAt(lookahead) === ":") role = "property";
      else if (/^[A-Z]/.test(word)) role = "type";
      push(word, role);
      index += word.length;
      continue;
    }
    // Everything else is punctuation or whitespace: one character at a time
    // keeps the pane's text in the document's own order.
    push(character, null);
    index += 1;
  }
  return tokens;
}

function scan(source: string, language: Language): Token[] {
  switch (language) {
    case "json":
      return scanJson(source);
    case "xml":
      return scanXml(source);
    case "typescript":
      return scanTypeScript(source);
    case "plain":
      return [{ text: source, role: null }];
  }
}

function appendToken(fragment: DocumentFragment, token: Token): void {
  if (token.role === null) {
    fragment.append(document.createTextNode(token.text));
    return;
  }
  const span = document.createElement("span");
  span.className = ROLE_CLASS[token.role];
  span.textContent = token.text;
  fragment.append(span);
}

/**
 * Repaints `target` with `source` coloured as `language`. The text is exactly
 * `source`: the pane's own text content is the document, never a rendering of
 * it, so copying from the pane and folding it both see the same bytes.
 */
export function highlightInto(target: Element, source: string, language: Language): void {
  const fragment = document.createDocumentFragment();
  if (source.length > MAX_HIGHLIGHTED_LENGTH) {
    fragment.append(document.createTextNode(source));
  } else {
    for (const token of scan(source, language)) appendToken(fragment, token);
  }
  target.replaceChildren(fragment);
}
