/**
 * JSON → TypeScript interfaces.
 *
 * The generator walks the value once and names each object after the key that
 * holds it (array items take the singular of the array's name or `Item`). An
 * object shape that already has a name is reused rather than emitted twice;
 * a different shape under a taken name gets a numeric suffix.
 */

import { isJsonObject, type JsonValue } from "./json";

interface Emitted {
  name: string;
  lines: string[];
}

function baseName(key: string): string {
  const words = key.split(/[^A-Za-z0-9]+/).filter((word) => word !== "");
  const joined = words
    .map((word) => word[0]!.toUpperCase() + word.slice(1).toLowerCase())
    .join("");
  const cleaned = joined === "" ? "Value" : joined;
  return /^[0-9]/.test(cleaned) ? `_${cleaned}` : cleaned;
}

function singular(name: string): string {
  if (name.endsWith("ies")) return `${name.slice(0, -3)}y`;
  if (name.endsWith("ses")) return name.slice(0, -2);
  if (name.endsWith("s") && !name.endsWith("ss")) return name.slice(0, -1);
  return name;
}

function propertyName(key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : JSON.stringify(key);
}

class Generator {
  private readonly byShape = new Map<string, string>();
  private readonly taken = new Set<string>();
  private readonly emitted: Emitted[] = [];

  run(value: JsonValue): string {
    const alias = this.rootAlias(value);
    const body = this.emitted.map((item) => item.lines.join("\n")).join("\n\n");
    return [body, alias].filter((part) => part !== "").join("\n\n");
  }

  private rootAlias(value: JsonValue): string {
    if (isJsonObject(value)) {
      const name = this.nameFor("Root", value);
      return name === "Root" ? "" : `export type Root = ${name};`;
    }
    if (Array.isArray(value)) {
      if (value.length === 0) return "export type Root = unknown[];";
      const members = new Set(value.map((item) => this.typeOf(item, "Item")));
      const element = members.size === 1 ? [...members][0]! : `(${[...members].join(" | ")})`;
      return `export type Root = ${element}[];`;
    }
    return `export type Root = ${this.typeOf(value, "Value")};`;
  }

  /** Registers the shape and returns the type expression to use for it. */
  private typeOf(value: JsonValue, hint: string): string {
    if (value === null) return "null";
    if (typeof value === "string") return "string";
    if (typeof value === "number") return "number";
    if (typeof value === "boolean") return "boolean";
    if (Array.isArray(value)) {
      if (value.length === 0) return "unknown[]";
      const itemHint = singular(baseName(hint));
      const members = new Set(value.map((item) => this.typeOf(item, itemHint)));
      return members.size === 1 ? `${[...members][0]}[]` : `(${[...members].join(" | ")})[]`;
    }
    return this.nameFor(hint, value);
  }

  /** Emits (once per shape) an interface and returns its name. */
  private nameFor(hint: string, value: JsonValue): string {
    const shape = JSON.stringify(value);
    const existing = this.byShape.get(shape);
    if (existing !== undefined) return existing;

    const base = baseName(hint);
    let name = base;
    for (let suffix = 2; this.taken.has(name); suffix += 1) name = `${base}${suffix}`;
    this.taken.add(name);
    this.byShape.set(shape, name);

    if (!isJsonObject(value)) return name;
    const lines = [`export interface ${name} {`];
    for (const [key, item] of Object.entries(value)) {
      lines.push(`  ${propertyName(key)}: ${this.typeOf(item, key)};`);
    }
    lines.push("}");
    this.emitted.push({ name, lines });
    return name;
  }
}

/** Generates a `Root` alias and the interfaces the value needs. */
export function jsonToTypeScript(value: JsonValue): string {
  return new Generator().run(value);
}
