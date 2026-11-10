/**
 * XML → JSON and JSON → XML, without a library.
 *
 * The parser is a small recursive-descent reader for well-formed XML: elements,
 * attributes, text, CDATA, comments and processing instructions. It rejects
 * mismatched tags instead of guessing. The JSON shape is the common one:
 * attributes become `@name`, text becomes `#text`, repeated child names become
 * arrays, and the document root becomes the only top-level key.
 */

import { isJsonObject, type JsonValue } from "./json";

interface XmlElement {
  name: string;
  attributes: [string, string][];
  children: (XmlElement | string)[];
}

const NAME = /^[A-Za-z_:][A-Za-z0-9_.:-]*/;
const SPACE = /\s/;

class XmlReader {
  private index = 0;

  constructor(private readonly source: string) {}

  read(): XmlElement {
    this.skipProlog();
    const root = this.readElement();
    this.skipMisc();
    if (this.index < this.source.length) this.fail("根元素之后还有内容");
    return root;
  }

  private fail(message: string): never {
    throw new Error(`${message}（第 ${this.lineAt(this.index)} 行）`);
  }

  private lineAt(offset: number): number {
    return this.source.slice(0, offset).split("\n").length;
  }

  private startsWith(text: string): boolean {
    return this.source.startsWith(text, this.index);
  }

  private skipSpace(): void {
    while (this.index < this.source.length && SPACE.test(this.source[this.index]!)) {
      this.index += 1;
    }
  }

  private skipMisc(): boolean {
    let skipped = false;
    while (this.index < this.source.length) {
      if (this.startsWith("<!--")) {
        const end = this.source.indexOf("-->", this.index + 4);
        if (end < 0) this.fail("注释没有结束");
        this.index = end + 3;
        skipped = true;
      } else if (this.startsWith("<?")) {
        const end = this.source.indexOf("?>", this.index + 2);
        if (end < 0) this.fail("处理指令没有结束");
        this.index = end + 2;
        skipped = true;
      } else if (this.startsWith("<!DOCTYPE")) {
        const end = this.source.indexOf(">", this.index);
        if (end < 0) this.fail("DOCTYPE 没有结束");
        this.index = end + 1;
        skipped = true;
      } else if (this.index < this.source.length && SPACE.test(this.source[this.index]!)) {
        this.index += 1;
      } else {
        break;
      }
    }
    return skipped;
  }

  private skipProlog(): void {
    if (this.source.charCodeAt(0) === 0xfeff) this.index = 1;
    this.skipSpace();
    this.skipMisc();
  }

  private readName(): string {
    const match = NAME.exec(this.source.slice(this.index));
    if (match === null) this.fail("缺少元素名");
    this.index += match[0].length;
    return match[0];
  }

  private readElement(): XmlElement {
    if (this.source[this.index] !== "<") this.fail("缺少元素");
    this.index += 1;
    const name = this.readName();
    const attributes: [string, string][] = [];
    for (;;) {
      this.skipSpace();
      if (this.startsWith("/>")) {
        this.index += 2;
        return { name, attributes, children: [] };
      }
      if (this.source[this.index] === ">") {
        this.index += 1;
        break;
      }
      const attribute = this.readName();
      this.skipSpace();
      if (this.source[this.index] !== "=") this.fail(`属性 ${attribute} 缺少 =`);
      this.index += 1;
      this.skipSpace();
      const quote = this.source[this.index];
      if (quote !== "\"" && quote !== "'") this.fail(`属性 ${attribute} 的值没有引号`);
      this.index += 1;
      const end = this.source.indexOf(quote, this.index);
      if (end < 0) this.fail(`属性 ${attribute} 的值没有结束`);
      attributes.push([attribute, decodeEntities(this.source.slice(this.index, end), (message) => this.fail(message))]);
      this.index = end + 1;
    }
    const children: (XmlElement | string)[] = [];
    for (;;) {
      if (this.index >= this.source.length) this.fail(`元素 ${name} 没有结束`);
      if (this.startsWith("</")) {
        this.index += 2;
        const closing = this.readName();
        if (closing !== name) this.fail(`结束标签 ${closing} 与开始标签 ${name} 不匹配`);
        this.skipSpace();
        if (this.source[this.index] !== ">") this.fail(`结束标签 ${name} 缺少 >`);
        this.index += 1;
        return { name, attributes, children };
      }
      if (this.startsWith("<!--")) {
        const end = this.source.indexOf("-->", this.index + 4);
        if (end < 0) this.fail("注释没有结束");
        this.index = end + 3;
        continue;
      }
      if (this.startsWith("<![CDATA[")) {
        const end = this.source.indexOf("]]>", this.index + 9);
        if (end < 0) this.fail("CDATA 没有结束");
        children.push(this.source.slice(this.index + 9, end));
        this.index = end + 3;
        continue;
      }
      if (this.startsWith("<?")) {
        const end = this.source.indexOf("?>", this.index + 2);
        if (end < 0) this.fail("处理指令没有结束");
        this.index = end + 2;
        continue;
      }
      if (this.source[this.index] === "<") {
        children.push(this.readElement());
        continue;
      }
      const next = this.source.indexOf("<", this.index);
      const end = next < 0 ? this.source.length : next;
      children.push(decodeEntities(this.source.slice(this.index, end), (message) => this.fail(message)));
      this.index = end;
    }
  }
}

function decodeEntities(text: string, fail: (message: string) => never): string {
  return text.replace(/&(#x?[0-9A-Fa-f]+|[A-Za-z]+);/g, (whole, body: string) => {
    switch (body) {
      case "lt": return "<";
      case "gt": return ">";
      case "amp": return "&";
      case "quot": return "\"";
      case "apos": return "'";
    }
    if (body.startsWith("#x") || body.startsWith("#X")) {
      return String.fromCodePoint(Number.parseInt(body.slice(2), 16));
    }
    if (body.startsWith("#")) {
      return String.fromCodePoint(Number.parseInt(body.slice(1), 10));
    }
    return fail(`未知的实体 &${body};`);
  });
}

function elementValue(element: XmlElement): JsonValue {
  const object: { [key: string]: JsonValue } = {};
  for (const [name, value] of element.attributes) object[`@${name}`] = value;

  const elements = element.children.filter(
    (child): child is XmlElement => typeof child !== "string",
  );
  const text = element.children
    .filter((child): child is string => typeof child === "string")
    .join("")
    .trim();

  if (elements.length === 0) {
    if (element.attributes.length === 0) return text;
    if (text !== "") object["#text"] = text;
    return object;
  }

  const groups = new Map<string, XmlElement[]>();
  for (const child of elements) {
    const group = groups.get(child.name) ?? [];
    group.push(child);
    groups.set(child.name, group);
  }
  for (const [name, group] of groups) {
    object[name] = group.length === 1
      ? elementValue(group[0]!)
      : group.map(elementValue);
  }
  if (text !== "") object["#text"] = text;
  return object;
}

/** Parses one XML document into `{ rootName: value }`. */
export function xmlToJson(source: string): JsonValue {
  const root = new XmlReader(source).read();
  return { [root.name]: elementValue(root) };
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function attributeText(value: JsonValue): string {
  if (isJsonObject(value) || Array.isArray(value)) {
    throw new Error("XML 属性只能来自字符串、数字或布尔值");
  }
  return value === null ? "" : String(value);
}

const ELEMENT_NAME = /^[A-Za-z_:][A-Za-z0-9_.:-]*$/;

function assertElementName(name: string): void {
  if (!ELEMENT_NAME.test(name)) throw new Error(`键 ${name} 不能作为 XML 元素名`);
}

function serializeNode(name: string, value: JsonValue, indent: string): string[] {
  assertElementName(name);
  if (Array.isArray(value)) {
    return value.flatMap((item) => serializeNode(name, item, indent));
  }
  if (isJsonObject(value)) {
    const attributes: string[] = [];
    let text = "";
    const children: string[] = [];
    for (const [key, item] of Object.entries(value)) {
      if (key.startsWith("@")) {
        assertElementName(key.slice(1));
        attributes.push(` ${key.slice(1)}="${escapeXml(attributeText(item))}"`);
      } else if (key === "#text") {
        text = attributeText(item);
      } else {
        children.push(...serializeNode(key, item, `${indent}  `));
      }
    }
    const open = `${indent}<${name}${attributes.join("")}`;
    if (children.length === 0) {
      return [text === "" ? `${open}/>` : `${open}>${escapeXml(text)}</${name}>`];
    }
    return [
      `${open}>`,
      ...(text === "" ? [] : [`${indent}  ${escapeXml(text)}`]),
      ...children,
      `${indent}</${name}>`,
    ];
  }
  const body = value === null ? "" : String(value);
  return [body === "" ? `${indent}<${name}/>` : `${indent}<${name}>${escapeXml(body)}</${name}>`];
}

/**
 * Serializes JSON as XML. A single-key object names the root element;
 * anything else is wrapped in `<root>`.
 */
export function jsonToXml(value: JsonValue): string {
  if (isJsonObject(value)) {
    const keys = Object.keys(value);
    if (keys.length === 1 && !keys[0]!.startsWith("@") && keys[0] !== "#text") {
      const name = keys[0]!;
      return serializeNode(name, value[name]!, "").join("\n");
    }
  }
  return serializeNode("root", value, "").join("\n");
}
