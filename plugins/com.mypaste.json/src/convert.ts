/**
 * Paste recognition: JSON, URL parameters, XML and YAML become a formatted
 * JSON document.
 *
 * The order matters: a complete JSON document wins, then URL parameters, then
 * XML and finally the YAML subset. A document that is recognized but cannot be
 * converted reports the parser's message, so the page can insert the original
 * text and explain why instead of silently changing it.
 */

import { formatJson } from "./format";
import { parseJson, type JsonValue } from "./json";
import { xmlToJson } from "./xml";
import { yamlToJson } from "./yaml";

export type PasteKind = "json" | "url-params" | "xml" | "yaml";

export type PasteAttempt =
  | { status: "converted"; kind: PasteKind; text: string }
  | { status: "failed"; kind: PasteKind; message: string }
  | { status: "unrecognized" };

function looksLikeUrlParams(text: string): boolean {
  if (/^[[{<]/.test(text)) return false;
  const body = text.startsWith("?") ? text.slice(1) : text;
  if (!body.includes("=")) return false;
  const pairs = body.split("&");
  return pairs.length > 0 && pairs.every((pair) => /^[^=&\s]+=/.test(pair));
}

function decode(text: string): string {
  return decodeURIComponent(text.replace(/\+/g, " "));
}

function urlParamsToJson(text: string): JsonValue {
  const body = text.startsWith("?") ? text.slice(1) : text;
  const object: { [key: string]: JsonValue } = {};
  for (const pair of body.split("&")) {
    const equal = pair.indexOf("=");
    const key = decode(pair.slice(0, equal));
    const value = decode(pair.slice(equal + 1));
    const existing = object[key];
    if (existing === undefined) object[key] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else object[key] = [existing, value];
  }
  return object;
}

function looksLikeXml(text: string): boolean {
  return /^<(\?xml|[A-Za-z_:])/.test(text);
}

function looksLikeYaml(text: string): boolean {
  if (text.startsWith("---")) return true;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    if (trimmed === "-" || trimmed.startsWith("- ")) return true;
    // A mapping key ends at a colon followed by whitespace or the line end.
    return /^[^:#\s][^:#]*:(\s|$)/.test(line);
  }
  return false;
}

async function formatted(value: JsonValue): Promise<string> {
  return formatJson(JSON.stringify(value, null, 2));
}

export async function convertPaste(source: string): Promise<PasteAttempt> {
  const text = source.replace(/\r\n?/g, "\n").trim();
  if (text === "") return { status: "unrecognized" };

  try {
    parseJson(text);
    return { status: "converted", kind: "json", text: await formatJson(text) };
  } catch {
    // Not a complete JSON document; try the other shapes.
  }

  if (looksLikeUrlParams(text)) {
    try {
      return { status: "converted", kind: "url-params", text: await formatted(urlParamsToJson(text)) };
    } catch (error) {
      return {
        status: "failed", kind: "url-params",
        message: error instanceof Error ? error.message : "URL 参数无法解码",
      };
    }
  }

  if (looksLikeXml(text)) {
    try {
      return { status: "converted", kind: "xml", text: await formatted(xmlToJson(text)) };
    } catch (error) {
      return {
        status: "failed", kind: "xml",
        message: error instanceof Error ? error.message : "XML 无法解析",
      };
    }
  }

  if (looksLikeYaml(text)) {
    try {
      return { status: "converted", kind: "yaml", text: await formatted(yamlToJson(text)) };
    } catch (error) {
      return {
        status: "failed", kind: "yaml",
        message: error instanceof Error ? error.message : "YAML 无法解析",
      };
    }
  }

  return { status: "unrecognized" };
}
