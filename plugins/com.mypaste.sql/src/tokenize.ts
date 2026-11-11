/**
 * The page's SQL scanner.
 *
 * Highlighting, diagnostics and formatting all work from this one token
 * stream, so a character is classified exactly once. The scanner never throws:
 * broken input is covered by an error token and the caller reports it at the
 * position the token started. Every token carries its offsets into the source,
 * and concatenating their text reconstructs the input byte for byte.
 */

import type { DialectInfo } from "./dialect";

export type TokenKind =
  | ""
  | "keyword"
  | "type"
  | "literal"
  | "property"
  | "function"
  | "string"
  | "number"
  | "comment";

export interface SqlToken {
  readonly text: string;
  readonly kind: TokenKind;
  readonly start: number;
  readonly end: number;
  /** The scanner could not close a construct that starts here. */
  readonly error?: boolean;
}

export interface Diagnostic {
  /** 1-based line, column and rune length, matching the host's result shape. */
  readonly line: number;
  readonly column: number;
  readonly length: number;
  readonly severity: "error" | "warning";
  readonly message: string;
}

const OPERATORS = [
  "->>", "!~*", "#>>", "::", ">=", "<=", "<>", "!=", "||", "->", "!~", "~*",
  "#>", ":=", "=>", "<<", ">>", "..", "&&", "@>", "<@", "?|", "?&", "%%",
];

function isSpace(char: string): boolean {
  return /\s/u.test(char);
}

function isDigit(char: string): boolean {
  return char >= "0" && char <= "9";
}

function isWordStart(char: string): boolean {
  return char === "_" || /[\p{L}]/u.test(char);
}

function isWordPart(char: string): boolean {
  return char === "_" || char === "$" || /[\p{L}\p{N}]/u.test(char);
}

function upper(value: string): string {
  return value.toUpperCase();
}

/** Scans the run that starts with a quote and returns its end (exclusive). */
function scanQuoted(
  text: string,
  start: number,
  quote: string,
  doubledEscape: boolean,
  backslashEscapes: boolean,
): { end: number; closed: boolean } {
  let index = start + quote.length;
  while (index < text.length) {
    const char = text.charAt(index);
    if (backslashEscapes && char === "\\") {
      index += 2;
      continue;
    }
    if (text.startsWith(quote, index)) {
      if (doubledEscape && text.startsWith(quote + quote, index)) {
        index += quote.length * 2;
        continue;
      }
      return { end: index + quote.length, closed: true };
    }
    index += 1;
  }
  return { end: text.length, closed: false };
}

/** The delimiter `$tag$` at this position, or null. */
function dollarDelimiterAt(text: string, start: number): string | null {
  const match = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(text.slice(start));
  return match === null ? null : match[0];
}

/**
 * Scans one piece of SQL into tokens. The result always covers the input:
 * whitespace becomes `""` tokens, and anything the scanner cannot finish is
 * marked `error` and extends to the end of the text.
 */
export function tokenizeSql(text: string, dialect: DialectInfo): SqlToken[] {
  const tokens: SqlToken[] = [];
  let index = 0;

  const push = (start: number, end: number, kind: TokenKind, error = false): void => {
    const token: SqlToken = { text: text.slice(start, end), kind, start, end };
    if (error) tokens.push({ ...token, error: true });
    else tokens.push(token);
  };

  while (index < text.length) {
    const start = index;
    const char = text.charAt(index);

    if (isSpace(char)) {
      while (index < text.length && isSpace(text.charAt(index))) index += 1;
      push(start, index, "");
      continue;
    }

    if (text.startsWith("--", index) || (dialect.hashComment && char === "#")) {
      const newline = text.indexOf("\n", index);
      index = newline === -1 ? text.length : newline;
      push(start, index, "comment");
      continue;
    }

    if (text.startsWith("/*", index)) {
      const close = text.indexOf("*/", index + 2);
      if (close === -1) {
        push(start, text.length, "comment", true);
        index = text.length;
      } else {
        index = close + 2;
        push(start, index, "comment");
      }
      continue;
    }

    // E'…' (PostgreSQL) and N'…' (national strings) keep the prefix as part of
    // the literal so the formatter copies it untouched.
    if (isWordStart(char)) {
      const prefix = /^[ENen]/.exec(text.slice(index));
      if (
        prefix !== null &&
        (prefix[0].toUpperCase() === "E" ? dialect.escapeStringPrefix : dialect.nationalStringPrefix) &&
        text.charAt(index + 1) === "'"
      ) {
        const scanned = scanQuoted(text, index + 1, "'", true, dialect.backslashEscapes);
        index = scanned.end;
        push(start, index, "string", !scanned.closed);
        continue;
      }
    }

    if (char === "'") {
      const scanned = scanQuoted(text, index, "'", true, dialect.backslashEscapes);
      index = scanned.end;
      push(start, index, "string", !scanned.closed);
      continue;
    }

    if (char === '"') {
      if (dialect.doubleQuotedIdentifier) {
        const scanned = scanQuoted(text, index, '"', true, false);
        index = scanned.end;
        push(start, index, "property", !scanned.closed);
      } else {
        const scanned = scanQuoted(text, index, '"', true, dialect.backslashEscapes);
        index = scanned.end;
        push(start, index, "string", !scanned.closed);
      }
      continue;
    }

    // A backtick quotes a name in every dialect this page understands. A
    // dialect that does not use backticks would otherwise split the run into
    // a symbol and a word, and the formatter would put spaces inside the
    // name — the name would change.
    if (char === "`") {
      const scanned = scanQuoted(text, index, "`", true, false);
      index = scanned.end;
      push(start, index, "property", !scanned.closed);
      continue;
    }

    if (char === "[" && dialect.bracketIdentifier === "[") {
      let cursor = index + 1;
      let closed = false;
      while (cursor < text.length) {
        if (text.charAt(cursor) === "]") {
          if (text.charAt(cursor + 1) === "]") {
            cursor += 2;
            continue;
          }
          cursor += 1;
          closed = true;
          break;
        }
        cursor += 1;
      }
      index = closed ? cursor : text.length;
      push(start, index, "property", !closed);
      continue;
    }

    if (char === "$" && dialect.dollarQuoted) {
      const delimiter = dollarDelimiterAt(text, index);
      if (delimiter !== null) {
        const close = text.indexOf(delimiter, index + delimiter.length);
        if (close === -1) {
          index = text.length;
          push(start, index, "string", true);
        } else {
          index = close + delimiter.length;
          push(start, index, "string");
        }
        continue;
      }
    }

    if (isDigit(char) || (char === "." && isDigit(text.charAt(index + 1)))) {
      if (text.startsWith("0x", index) || text.startsWith("0X", index)) {
        index += 2;
        while (index < text.length && /[0-9A-Fa-f]/.test(text.charAt(index))) index += 1;
      } else {
        if (char === ".") index += 1;
        while (index < text.length && isDigit(text.charAt(index))) index += 1;
        if (text.charAt(index) === "." && isDigit(text.charAt(index + 1))) {
          index += 1;
          while (index < text.length && isDigit(text.charAt(index))) index += 1;
        }
        if (/[eE]/.test(text.charAt(index))) {
          let cursor = index + 1;
          if (/[+-]/.test(text.charAt(cursor))) cursor += 1;
          if (isDigit(text.charAt(cursor))) {
            cursor += 1;
            while (cursor < text.length && isDigit(text.charAt(cursor))) cursor += 1;
            index = cursor;
          }
        }
      }
      push(start, index, "number");
      continue;
    }

    // Parameters and variables: :name, @name, $1, ?.
    if ((char === ":" || char === "@" || char === "$") && isWordStart(text.charAt(index + 1))) {
      index += 2;
      while (index < text.length && isWordPart(text.charAt(index))) index += 1;
      push(start, index, "property");
      continue;
    }
    if ((char === "$" || char === "@") && isDigit(text.charAt(index + 1))) {
      index += 2;
      while (index < text.length && isDigit(text.charAt(index))) index += 1;
      push(start, index, "property");
      continue;
    }
    // A lone `?` is a positional parameter; `?|` and `?&` are operators and
    // are matched below with the rest of the multi-character list.
    if (char === "?" && text.charAt(index + 1) !== "|" && text.charAt(index + 1) !== "&") {
      index += 1;
      push(start, index, "property");
      continue;
    }

    if (isWordStart(char)) {
      index += 1;
      while (index < text.length && isWordPart(text.charAt(index))) index += 1;
      const word = text.slice(start, index);
      const key = upper(word);
      let kind: TokenKind;
      if (dialect.literals.has(key)) kind = "literal";
      else if (dialect.types.has(key)) kind = "type";
      else if (dialect.keywords.has(key)) kind = "keyword";
      else {
        let ahead = index;
        while (ahead < text.length && isSpace(text.charAt(ahead))) ahead += 1;
        kind = text.charAt(ahead) === "(" ? "function" : "property";
      }
      push(start, index, kind);
      continue;
    }

    const operator = OPERATORS.find((candidate) => text.startsWith(candidate, index));
    if (operator !== undefined) {
      index += operator.length;
      push(start, index, "");
      continue;
    }

    index += 1;
    push(start, index, "");
  }

  return tokens;
}

/** The 1-based rune position of one UTF-16 offset. */
export function positionOf(text: string, offset: number): { line: number; column: number } {
  const limit = Math.max(0, Math.min(offset, text.length));
  let line = 1;
  let column = 1;
  for (let index = 0; index < limit; ) {
    const code = text.codePointAt(index);
    if (code === undefined) break;
    const width = code > 0xffff ? 2 : 1;
    if (code === 10) {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
    index += width;
  }
  return { line, column };
}

/** The number of runes in a UTF-16 slice. */
export function runeLength(text: string, start: number, end: number): number {
  let count = 0;
  for (let index = start; index < end; ) {
    const code = text.codePointAt(index);
    if (code === undefined) break;
    index += code > 0xffff ? 2 : 1;
    count += 1;
  }
  return count;
}
