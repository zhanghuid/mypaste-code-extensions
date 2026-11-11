/**
 * Positioned problems for the two code panes.
 *
 * The page already colours a document without a parser; linting needs the
 * same kind of scanner, but one that says where the document stops making
 * sense. JSON is validated against the grammar so the message can name the
 * exact token that is wrong (`对象最后多了一个逗号`) instead of repeating an
 * engine's English text. XML and TypeScript get the one check that is
 * decidable without a full parser: tags, brackets and quotes that never
 * close, and closers that do not match.
 *
 * Every diagnostic carries offsets into the text the pane is showing, so the
 * renderer can mark the token itself, colour its line number and write the
 * message under the pane. Offsets are code units, matching `textarea.value`.
 */

import type { Language } from "./highlight";

export interface Diagnostic {
  /** Offset of the first character to mark. */
  start: number;
  /** Offset just past the marked characters. */
  end: number;
  /** What is wrong, in the reader's words. */
  message: string;
}

export interface TextPosition {
  line: number;
  column: number;
}

/** The 1-based line and column of `offset`, for a reader-facing message. */
export function positionOf(source: string, offset: number): TextPosition {
  const bounded = Math.max(0, Math.min(offset, source.length));
  const before = source.slice(0, bounded);
  return { line: before.split("\n").length, column: bounded - before.lastIndexOf("\n") };
}

/** A character as a message can name it: a control character has no glyph. */
function describeCharacter(character: string): string {
  if (character === "") return "文档末尾";
  if (character === "\n") return "换行";
  if (character === "\r") return "回车";
  if (character === "\t") return "制表符";
  const code = character.codePointAt(0) ?? 0;
  return code < 0x20 ? "控制字符" : character;
}

/** The one error a lint pass reports; `null` means the text is sound. */
class Problem extends Error {
  constructor(readonly start: number, readonly end: number, message: string) {
    super(message);
  }
}

const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const HEX_QUAD = /^[0-9a-fA-F]{4}$/;
const VALID_ESCAPES = '"\\/bfnrt';

/**
 * JSON's grammar, walked with a cursor. The first thing that cannot be true
 * ends the walk, which is what a reader wants to see: one error, at the place
 * it starts.
 */
class JsonScan {
  private index = 0;

  constructor(private readonly source: string) {}

  document(): void {
    this.space();
    if (this.index >= this.source.length) return;
    this.value();
    this.space();
    if (this.index < this.source.length) {
      this.fail(this.index, `文档已经结束，后面还有多余的「${describeCharacter(this.current())}」`);
    }
  }

  private get length(): number {
    return this.source.length;
  }

  private current(): string {
    return this.source.charAt(this.index);
  }

  private fail(start: number, message: string, end = start + 1): never {
    throw new Problem(
      Math.min(start, this.length),
      Math.min(Math.max(end, start + 1), Math.max(this.length, start + 1)),
      message,
    );
  }

  private space(): void {
    while (this.index < this.length && " \t\n\r".includes(this.current())) this.index += 1;
  }

  private value(): void {
    const character = this.current();
    switch (character) {
      case "{":
        this.object();
        return;
      case "[":
        this.array();
        return;
      case '"':
        this.string();
        return;
      case "t":
        this.literal("true");
        return;
      case "f":
        this.literal("false");
        return;
      case "n":
        this.literal("null");
        return;
      default:
        break;
    }
    if (character === "-" || (character >= "0" && character <= "9")) {
      this.number();
      return;
    }
    if (this.index >= this.length) this.fail(this.index, "文档在这里结束了，还缺一个值");
    this.fail(this.index, `这里应该是值，读到的是「${describeCharacter(character)}」`);
  }

  private literal(word: string): void {
    if (this.source.startsWith(word, this.index)) {
      this.index += word.length;
      return;
    }
    const run = /^[A-Za-z]+/.exec(this.source.slice(this.index))?.[0] ?? this.current();
    this.fail(this.index, `这里应该是值，读到的是「${run}」`, this.index + run.length);
  }

  private number(): void {
    NUMBER.lastIndex = this.index;
    const match = NUMBER.exec(this.source);
    if (match === null) this.fail(this.index, "数字格式不对");
    this.index += match[0].length;
    // `01` and `1.2.3` parse as a prefix; what follows gives the rest away.
    const next = this.current();
    if (next === "." || (next >= "0" && next <= "9")) {
      this.fail(this.index, "数字格式不对：不要在整数前面补零，也不要有两个小数点");
    }
  }

  private string(): void {
    const start = this.index;
    this.index += 1;
    while (this.index < this.length) {
      const character = this.current();
      if (character === '"') {
        this.index += 1;
        return;
      }
      if (character === "\\") {
        const escape = this.source.charAt(this.index + 1);
        if (escape === "") break;
        if (escape === "u") {
          const digits = this.source.slice(this.index + 2, this.index + 6);
          if (!HEX_QUAD.test(digits)) this.fail(this.index, "\\u 后面要跟四位十六进制数", this.index + 6);
          this.index += 6;
          continue;
        }
        if (!VALID_ESCAPES.includes(escape)) this.fail(this.index, `无效的转义「\\${escape}」`, this.index + 2);
        this.index += 2;
        continue;
      }
      if (character < " ") {
        this.fail(this.index, `字符串里不能直接出现${describeCharacter(character)}`);
      }
      this.index += 1;
    }
    this.fail(start, "字符串没有闭合，少了结尾的引号", Math.max(start + 1, this.length));
  }

  private object(): void {
    this.index += 1;
    this.space();
    if (this.current() === "}") {
      this.index += 1;
      return;
    }
    while (true) {
      this.space();
      if (this.index >= this.length) this.fail(this.index, "对象还没有闭合，少了 }");
      const character = this.current();
      if (character === "}") this.fail(this.index, "对象最后多了一个逗号");
      if (character !== '"') {
        this.fail(this.index, `属性名要用引号包住，读到的是「${describeCharacter(character)}」`);
      }
      this.string();
      this.space();
      if (this.current() !== ":") {
        if (this.index >= this.length) this.fail(this.index, "属性名后面少了冒号");
        this.fail(this.index, `属性名后面少了冒号，读到的是「${describeCharacter(this.current())}」`);
      }
      this.index += 1;
      this.space();
      this.value();
      this.space();
      const separator = this.current();
      if (separator === ",") {
        this.index += 1;
        this.space();
        if (this.current() === "}") this.fail(this.index, "对象最后多了一个逗号");
        continue;
      }
      if (separator === "}") {
        this.index += 1;
        return;
      }
      if (this.index >= this.length) this.fail(this.index, "对象还没有闭合，少了 }");
      this.fail(this.index, `属性值后面少了逗号，读到的是「${describeCharacter(separator)}」`);
    }
  }

  private array(): void {
    this.index += 1;
    this.space();
    if (this.current() === "]") {
      this.index += 1;
      return;
    }
    while (true) {
      this.space();
      if (this.index >= this.length) this.fail(this.index, "数组还没有闭合，少了 ]");
      this.value();
      this.space();
      const separator = this.current();
      if (separator === ",") {
        this.index += 1;
        this.space();
        if (this.current() === "]") this.fail(this.index, "数组最后多了一个逗号");
        continue;
      }
      if (separator === "]") {
        this.index += 1;
        return;
      }
      if (this.index >= this.length) this.fail(this.index, "数组还没有闭合，少了 ]");
      this.fail(this.index, `数组元素后面少了逗号，读到的是「${describeCharacter(separator)}」`);
    }
  }
}

function lintJson(source: string): Problem | null {
  try {
    new JsonScan(source).document();
    return null;
  } catch (error) {
    if (error instanceof Problem) return error;
    throw error;
  }
}

/** The end of a quoted run; `-1` when the closing quote never arrives. */
function quoteEnd(source: string, start: number): number {
  const quote = source.charAt(start);
  let index = start + 1;
  while (index < source.length) {
    const character = source.charAt(index);
    if (character === "\\") {
      index += 2;
      continue;
    }
    if (character === quote) return index + 1;
    index += 1;
  }
  return -1;
}

const OPENER_OF: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
const PAIR_OF: Record<string, string> = { "(": ")", "[": "]", "{": "}" };

/**
 * TypeScript without a parser still answers one question: do the brackets,
 * quotes and comments close, and does every closer match the opener it
 * belongs to? Comments and quoted text are skipped, so braces inside a string
 * are not structure.
 */
function lintTypeScript(source: string): Problem | null {
  const openers: { character: string; index: number }[] = [];
  let index = 0;
  while (index < source.length) {
    if (source.startsWith("//", index)) {
      const newline = source.indexOf("\n", index);
      index = newline === -1 ? source.length : newline;
      continue;
    }
    if (source.startsWith("/*", index)) {
      const close = source.indexOf("*/", index + 2);
      if (close === -1) return new Problem(index, source.length, "块注释没有闭合，少了 */");
      index = close + 2;
      continue;
    }
    const character = source.charAt(index);
    if (character === '"' || character === "'" || character === "`") {
      const end = quoteEnd(source, index);
      if (end === -1) return new Problem(index, source.length, "字符串的引号没有闭合");
      index = end;
      continue;
    }
    if (PAIR_OF[character] !== undefined) {
      openers.push({ character, index });
      index += 1;
      continue;
    }
    const opener = OPENER_OF[character];
    if (opener !== undefined) {
      const top = openers.pop();
      if (top === undefined) return new Problem(index, index + 1, `多了一个「${character}」`);
      if (top.character !== opener) {
        const line = positionOf(source, top.index).line;
        return new Problem(index, index + 1, `「${character}」与第 ${line} 行的「${opener}」不匹配`);
      }
      index += 1;
      continue;
    }
    index += 1;
  }
  const open = openers.pop();
  if (open === undefined) return null;
  return new Problem(open.index, open.index + 1, `「${open.character}」没有闭合`);
}

/** The end of a tag, quotes respected; `-1` when `>` never arrives. */
function tagEnd(source: string, start: number): number {
  let index = start + 1;
  let quote = "";
  while (index < source.length) {
    const character = source.charAt(index);
    if (quote !== "") {
      if (character === quote) quote = "";
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === ">") {
      return index + 1;
    }
    index += 1;
  }
  return -1;
}

const XML_TAG_NAME = /^<(\/?)([^\s/>]+)/;

/** XML structure: every element closes, and closes in the right order. */
function lintXml(source: string): Problem | null {
  const open: { name: string; index: number }[] = [];
  let index = 0;
  while (index < source.length) {
    const start = source.indexOf("<", index);
    if (start === -1) break;
    if (source.startsWith("<!--", start)) {
      const close = source.indexOf("-->", start + 4);
      if (close === -1) return new Problem(start, source.length, "注释没有闭合，少了 -->");
      index = close + 3;
      continue;
    }
    const end = tagEnd(source, start);
    if (end === -1) return new Problem(start, source.length, "标签没有闭合，少了 >");
    const tag = source.slice(start, end);
    index = end;
    if (tag.startsWith("<?") || tag.startsWith("<!")) continue;
    const match = XML_TAG_NAME.exec(tag);
    if (match === null) continue;
    const name = match[2] ?? "";
    if (match[1] === "/") {
      const top = open.pop();
      if (top === undefined) return new Problem(start, end, `多了一个结束标签 </${name}>`);
      if (top.name !== name) {
        const line = positionOf(source, top.index).line;
        return new Problem(start, end, `结束标签 </${name}> 与第 ${line} 行的 <${top.name}> 不匹配`);
      }
      continue;
    }
    if (!tag.endsWith("/>")) open.push({ name, index: start });
  }
  const unclosed = open.pop();
  if (unclosed === undefined) return null;
  return new Problem(unclosed.index, unclosed.index + unclosed.name.length + 1, `标签 <${unclosed.name}> 没有闭合`);
}

/** A mark must cover at least one character the pane actually contains. */
function fit(source: string, problem: Problem): Diagnostic {
  const start = Math.max(0, Math.min(problem.start, source.length - 1));
  const end = Math.max(start + 1, Math.min(problem.end, source.length));
  return { start, end, message: problem.message };
}

/**
 * The first problem in `source` read as `language`, or `null`. Whitespace
 * alone is not a problem: an empty pane is waiting, not broken.
 */
export function lint(source: string, language: Language): Diagnostic | null {
  if (source.trim() === "" || source.length === 0) return null;
  const problem = language === "json"
    ? lintJson(source)
    : language === "xml"
      ? lintXml(source)
      : language === "typescript"
        ? lintTypeScript(source)
        : null;
  return problem === null ? null : fit(source, problem);
}
