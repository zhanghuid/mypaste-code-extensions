/**
 * A YAML subset reader, enough for pasted configuration and API samples.
 *
 * Supported: block mappings and sequences, nested indentation, quoted and
 * plain scalars, numbers / booleans / null, flow arrays and maps, `|` and `>`
 * block scalars, comments, and one document with an optional `---` prologue.
 * Not supported (and refused with a readable error): anchors, aliases, tags,
 * merge keys and multiple documents. The page only converts the user's paste;
 * an unsupported document stays untouched in the editor.
 */

import type { JsonValue } from "./json";

interface Line {
  indent: number;
  content: string;
  raw: string;
}

const BOOLEAN = new Set(["true", "false"]);
const NULLS = new Set(["null", "Null", "NULL", "~"]);
const INTEGER = /^[-+]?\d+$/;
const FLOAT = /^[-+]?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][-+]?\d+)?$/;

function stripComment(text: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (char === "'" && !inDouble) inSingle = !inSingle;
    else if (char === "\"" && !inSingle && text[index - 1] !== "\\") inDouble = !inDouble;
    else if (char === "#" && !inSingle && !inDouble &&
      (index === 0 || /\s/.test(text[index - 1]!))) {
      return text.slice(0, index).trimEnd();
    }
  }
  return text.trimEnd();
}

/** Splits `key: value` at the first colon that ends the key. */
function splitPair(text: string): [string, string] | null {
  let inSingle = false;
  let inDouble = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (char === "'" && !inDouble) inSingle = !inSingle;
    else if (char === "\"" && !inSingle && text[index - 1] !== "\\") inDouble = !inDouble;
    else if (char === ":" && !inSingle && !inDouble) {
      const next = text[index + 1];
      if (next === undefined || /\s/.test(next)) {
        return [text.slice(0, index).trim(), text.slice(index + 1).trim()];
      }
    }
  }
  return null;
}

function unquote(text: string): string {
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) {
    return text.slice(1, -1).replace(/''/g, "'");
  }
  if (text.length >= 2 && text.startsWith("\"") && text.endsWith("\"")) {
    try {
      return JSON.parse(text) as string;
    } catch {
      return text.slice(1, -1);
    }
  }
  return text;
}

/** Splits a flow collection body at top-level commas. */
function splitFlow(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let start = 0;
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index]!;
    if (char === "'" && !inDouble) inSingle = !inSingle;
    else if (char === "\"" && !inSingle && body[index - 1] !== "\\") inDouble = !inDouble;
    else if (!inSingle && !inDouble) {
      if (char === "[" || char === "{") depth += 1;
      else if (char === "]" || char === "}") depth -= 1;
      else if (char === "," && depth === 0) {
        parts.push(body.slice(start, index));
        start = index + 1;
      }
    }
  }
  parts.push(body.slice(start));
  return parts.map((part) => part.trim()).filter((part) => part !== "");
}

function inlineValue(text: string): JsonValue {
  const value = stripComment(text).trim();
  if (value === "") return null;
  if (value.startsWith("&") || value.startsWith("*")) {
    throw new Error("不支持 YAML 的锚点与别名");
  }
  if (value.startsWith("!")) throw new Error("不支持 YAML 标签");
  if (value.startsWith("[") && value.endsWith("]")) {
    return splitFlow(value.slice(1, -1)).map(inlineValue);
  }
  if (value.startsWith("{") && value.endsWith("}")) {
    const object: { [key: string]: JsonValue } = {};
    for (const part of splitFlow(value.slice(1, -1))) {
      const pair = splitPair(part);
      if (pair === null) throw new Error(`无法解析流式映射项 ${part}`);
      object[String(inlineValue(pair[0]) ?? pair[0])] = inlineValue(pair[1]);
    }
    return object;
  }
  const plain = unquote(value);
  if (NULLS.has(plain)) return null;
  if (BOOLEAN.has(plain)) return plain === "true";
  if (INTEGER.test(plain)) return Number(plain);
  if (FLOAT.test(plain)) return Number(plain);
  return plain;
}

class YamlReader {
  private index = 0;
  private readonly lines: Line[] = [];

  constructor(source: string) {
    const normalized = source.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
    for (const raw of normalized.split("\n")) {
      if (raw.trim() === "") {
        this.lines.push({ indent: -1, content: "", raw });
        continue;
      }
      const content = stripComment(raw);
      if (content.trim() === "") {
        this.lines.push({ indent: -1, content: "", raw });
        continue;
      }
      const indent = raw.length - raw.trimStart().length;
      this.lines.push({ indent, content: content.trimStart(), raw });
    }
  }

  read(): JsonValue {
    this.skipPrologue();
    const value = this.readNode(0);
    if (this.peek() !== null) throw new Error("无法解析的 YAML 结构");
    return value;
  }

  private skipBlank(): void {
    while (this.index < this.lines.length && this.lines[this.index]!.indent < 0) {
      this.index += 1;
    }
  }

  private peek(): Line | null {
    this.skipBlank();
    return this.index < this.lines.length ? this.lines[this.index]! : null;
  }

  private skipPrologue(): void {
    this.skipBlank();
    const line = this.peek();
    if (line !== null && line.content === "---") this.index += 1;
  }

  private readNode(minimumIndent: number): JsonValue {
    const line = this.peek();
    if (line === null || line.indent < minimumIndent) return null;
    if (line.content === "---") throw new Error("不支持多文档 YAML");
    if (line.content === "-" || line.content.startsWith("- ")) {
      return this.readSequence(line.indent);
    }
    return this.readMapping(line.indent);
  }

  private readMapping(indent: number): { [key: string]: JsonValue } {
    const object: { [key: string]: JsonValue } = {};
    for (;;) {
      const line = this.peek();
      if (line === null || line.indent < indent) return object;
      if (line.indent > indent) throw new Error(`第 ${this.lineNumber()} 行的缩进不匹配`);
      if (line.content === "-" || line.content.startsWith("- ")) {
        throw new Error(`第 ${this.lineNumber()} 行：映射里出现了序列项`);
      }
      if (line.content === "---" || line.content === "...") return object;
      this.readPair(object, line.content, indent);
    }
  }

  private readPair(
    object: { [key: string]: JsonValue }, content: string, indent: number,
  ): void {
    const pair = splitPair(content);
    if (pair === null) throw new Error(`第 ${this.lineNumber()} 行缺少键值分隔的冒号`);
    const key = unquote(pair[0]);
    if (key === "" || key.startsWith("<<")) throw new Error("不支持 YAML 合并键");
    this.index += 1;
    object[key] = this.readValue(pair[1], indent, false);
  }

  private readSequence(indent: number): JsonValue[] {
    const items: JsonValue[] = [];
    for (;;) {
      const line = this.peek();
      if (line === null || line.indent < indent) return items;
      if (line.indent > indent) throw new Error(`第 ${this.lineNumber()} 行的缩进不匹配`);
      if (line.content !== "-" && !line.content.startsWith("- ")) return items;
      const rest = line.content === "-" ? "" : line.content.slice(2).trim();
      if (rest === "") {
        this.index += 1;
        const next = this.peek();
        items.push(next === null || next.indent <= indent ? null : this.readNode(indent + 1));
        continue;
      }
      if (rest === "---") throw new Error("不支持多文档 YAML");
      const pair = splitPair(rest);
      if (pair !== null) {
        const object: { [key: string]: JsonValue } = {};
        this.readPair(object, rest, indent + 2);
        const next = this.peek();
        if (next !== null && next.indent > indent && next.content !== "-" &&
          !next.content.startsWith("- ")) {
          Object.assign(object, this.readMapping(next.indent));
        }
        items.push(object);
        continue;
      }
      this.index += 1;
      items.push(inlineValue(rest));
    }
  }

  private readValue(rest: string, indent: number, inSequence: boolean): JsonValue {
    const value = stripComment(rest).trim();
    if (value === "|" || value === ">" || value === "|-" || value === ">-") {
      return this.readBlockScalar(indent, value);
    }
    if (value !== "") return inlineValue(value);
    const next = this.peek();
    if (next === null || next.indent <= indent) {
      if (inSequence) return null;
      return null;
    }
    return this.readNode(indent + 1);
  }

  private readBlockScalar(indent: number, marker: string): string {
    const collected: string[] = [];
    let blockIndent = -1;
    while (this.index < this.lines.length) {
      const line = this.lines[this.index]!;
      if (line.raw.trim() === "") {
        collected.push("");
        this.index += 1;
        continue;
      }
      const lineIndent = line.raw.length - line.raw.trimStart().length;
      if (lineIndent <= indent) break;
      if (blockIndent < 0) blockIndent = lineIndent;
      collected.push(line.raw.slice(Math.min(blockIndent, lineIndent)));
      this.index += 1;
    }
    while (collected.length > 0 && collected[collected.length - 1] === "") collected.pop();
    const body = marker.startsWith(">")
      ? collected.join(" ").replace(/ +/g, " ").trim()
      : collected.join("\n");
    return marker.endsWith("-") ? body : `${body}\n`;
  }

  private lineNumber(): number {
    return this.index + 1;
  }
}

/** Parses one YAML document into a JSON value. */
export function yamlToJson(source: string): JsonValue {
  return new YamlReader(source).read();
}
