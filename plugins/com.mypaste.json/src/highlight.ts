/**
 * The page's own tokenizer for formatted JSON.
 *
 * The input is Prettier's output, so the scanner only has to recognise JSON's
 * five lexical shapes. It never repairs, reorders or reinterprets the text: a
 * token is exactly a slice of the document it was given.
 */

export type TokenKind = "plain" | "key" | "string" | "number" | "keyword" | "punct";

export interface Token {
  kind: TokenKind;
  text: string;
}

const NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/;
const KEYWORDS = new Set(["true", "false", "null"]);
const LETTER = /[A-Za-z]/;
const SPACE = /\s/;

export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;

  function push(kind: TokenKind, text: string): void {
    if (text === "") return;
    const last = tokens[tokens.length - 1];
    if (last !== undefined && last.kind === kind) {
      last.text += text;
      return;
    }
    tokens.push({ kind, text });
  }

  while (index < source.length) {
    const char = source[index]!;

    if (char === "\"") {
      const start = index;
      index += 1;
      while (index < source.length) {
        const next = source[index]!;
        index += 1;
        if (next === "\\") {
          index += 1;
          continue;
        }
        if (next === "\"") break;
      }
      // A string that is followed by a colon is a member name; everything else
      // is a value. Whitespace between the two is legal JSON.
      let lookahead = index;
      while (lookahead < source.length && SPACE.test(source[lookahead]!)) lookahead += 1;
      push(source[lookahead] === ":" ? "key" : "string", source.slice(start, index));
      continue;
    }

    if (char === "-" || (char >= "0" && char <= "9")) {
      const match = NUMBER.exec(source.slice(index));
      const text = match === null ? char : match[0];
      push("number", text);
      index += text.length;
      continue;
    }

    if (LETTER.test(char)) {
      const start = index;
      while (index < source.length && LETTER.test(source[index]!)) index += 1;
      const text = source.slice(start, index);
      push(KEYWORDS.has(text) ? "keyword" : "plain", text);
      continue;
    }

    if (SPACE.test(char)) {
      const start = index;
      while (index < source.length && SPACE.test(source[index]!)) index += 1;
      push("plain", source.slice(start, index));
      continue;
    }

    push("punct", char);
    index += 1;
  }

  return tokens;
}
