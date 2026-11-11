/**
 * Escape shaping for the JSON page.
 *
 * JSON's writer is allowed to spell a character either literally or as an
 * escape (`任`, `\/`). Prettier keeps whatever the source spelled, so a
 * document pasted from a PHP backend shows `任务` where the reader
 * wants 任务. The page has one toggle for that choice: off decodes the escapes
 * the reader can safely see, on re-escapes everything outside ASCII so the
 * text matches the wire form. Both directions keep the document valid JSON:
 * a code point that must stay escaped (a quote, a backslash, a control
 * character, a lone surrogate) is never decoded.
 */

const HEX4 = /^[0-9a-fA-F]{4}$/;

function isHex4(text: string, index: number): boolean {
  return HEX4.test(text.slice(index, index + 4));
}

/** True when the code point cannot appear literally inside a JSON string. */
function mustStayEscaped(codePoint: number): boolean {
  if (codePoint < 0x20) return true;
  if (codePoint === 0x22 || codePoint === 0x5c) return true;
  // A lone surrogate is not a character; emitting it would produce invalid
  // UTF-8 in the document and in the copied text.
  return codePoint >= 0xd800 && codePoint <= 0xdfff;
}

/**
 * decodeEscapes rewrites the escapes a reader can see back into characters:
 * `\uXXXX` (including a surrogate pair) and `\/`. Every other escape is left
 * exactly as written, and a backslash that is itself escaped (`\\u4efb`) is
 * left alone, so text that merely mentions an escape is not rewritten.
 */
export function decodeEscapes(text: string): string {
  let out = "";
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char !== "\\" || index + 1 >= text.length) {
      out += char;
      index += 1;
      continue;
    }
    const next = text[index + 1];
    if (next === "/") {
      out += "/";
      index += 2;
      continue;
    }
    if (next !== "u" || !isHex4(text, index + 2)) {
      // `\\`, `\"`, `\n` and anything malformed keep their spelling.
      out += char + next;
      index += 2;
      continue;
    }
    const unit = Number.parseInt(text.slice(index + 2, index + 6), 16);
    let codePoint = unit;
    let consumed = 6;
    const paired = text.startsWith("\\u", index + 6) && isHex4(text, index + 8);
    if (unit >= 0xd800 && unit <= 0xdbff && paired) {
      const low = Number.parseInt(text.slice(index + 8, index + 12), 16);
      if (low >= 0xdc00 && low <= 0xdfff) {
        codePoint = 0x10000 + ((unit - 0xd800) << 10) + (low - 0xdc00);
        consumed = 12;
      }
    }
    out += mustStayEscaped(codePoint)
      ? text.slice(index, index + consumed)
      : String.fromCodePoint(codePoint);
    index += consumed;
  }
  return out;
}

/** escapeNonAscii spells every non-ASCII code point as `\uXXXX`. */
export function escapeNonAscii(text: string): string {
  let out = "";
  for (const char of text) {
    const codePoint = char.codePointAt(0) ?? 0;
    if (codePoint < 0x80) {
      out += char;
      continue;
    }
    if (codePoint > 0xffff) {
      const offset = codePoint - 0x10000;
      out += `\\u${(0xd800 + (offset >> 10)).toString(16).padStart(4, "0")}`;
      out += `\\u${(0xdc00 + (offset & 0x3ff)).toString(16).padStart(4, "0")}`;
      continue;
    }
    out += `\\u${codePoint.toString(16).padStart(4, "0")}`;
  }
  return out;
}
