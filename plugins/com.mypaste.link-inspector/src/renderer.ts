/**
 * Which renderer a detected link gets, and how fetched text is shown.
 *
 * This module is pure: it reads the detector document and decides a plan. It
 * never touches the DOM and never performs a request, so its rules run under
 * Node in the package tests. The page executes the plan — `<img>`, `<video>`
 * and `<audio>` load their own source, the page fetches text and passes it back
 * through `formatText`, and anything without a renderer keeps the fallback
 * card and its reason.
 *
 * The page may load remote content only because the official package declares
 * `surface.network` (host D-1100); the host's wider policy still refuses
 * frames, remote styles and remote fonts, and the sandbox has an opaque origin,
 * so a cross-origin `fetch` fails unless the server allows it. That failure is
 * a designed state, not a bug: the page says what it could not get.
 */

import type { DetectorResult } from "./result";

/** How much of a fetched or inline document the page paints at once. */
export const MAX_TEXT_CHARS = 200_000;

/** The largest inline `data:` payload the page decodes itself. */
export const MAX_INLINE_CHARS = 2 * 1024 * 1024;

export type TextFlavor = "json" | "xml" | "html" | "text";

export type RenderPlan =
  | {
      kind: "image" | "video" | "audio";
      url: string;
      mime: string;
      inline: boolean;
    }
  | {
      kind: "text";
      url: string;
      mime: string;
      flavor: TextFlavor;
      inline: boolean;
      /** Present only for an inline data: URL, already decoded. */
      text?: string;
    }
  | {
      kind: "unsupported";
      mime: string;
      reason: string;
    };

export interface FormattedText {
  text: string;
  note: string;
  truncated: boolean;
}

export function schemeOf(url: string): string {
  const match = /^([a-z][a-z0-9+.-]*):/i.exec(url.trim());
  return match?.[1]?.toLowerCase() ?? "";
}

function textFlavor(mime: string): TextFlavor | null {
  if (mime === "application/json" || mime.endsWith("+json")) return "json";
  if (mime === "application/xml" || mime === "text/xml" || mime.endsWith("+xml")) {
    return "xml";
  }
  if (mime === "text/html" || mime === "application/xhtml+xml") return "html";
  if (mime.startsWith("text/")) return "text";
  if (
    mime === "application/javascript" ||
    mime === "application/x-javascript" ||
    mime === "application/ecmascript"
  ) {
    return "text";
  }
  return null;
}

interface DataURL {
  mime: string;
  base64: boolean;
  payload: string;
}

function parseDataURL(url: string): DataURL | null {
  const match = /^data:([^,]*),(.*)$/is.exec(url.trim());
  if (match === null) return null;
  const meta = match[1] ?? "";
  const payload = match[2] ?? "";
  const parts = meta.split(";").map((part) => part.trim());
  const base64 = parts.some((part) => part.toLowerCase() === "base64");
  const mime = (parts[0] ?? "").toLowerCase() || "text/plain";
  return { mime, base64, payload };
}

function decodeBase64(payload: string): Uint8Array | null {
  try {
    const binary = atob(payload.replace(/\s+/g, ""));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return null;
  }
}

/**
 * Decodes the text body of one `data:` URL without a request. A payload over
 * the inline ceiling, malformed base64 or an undecodable byte sequence returns
 * null, which the caller shows as a refusal rather than as empty content.
 */
export function decodeInlineText(url: string, limit = MAX_INLINE_CHARS): string | null {
  const parsed = parseDataURL(url);
  if (parsed === null) return null;
  if (parsed.payload.length > limit) return null;
  if (parsed.base64) {
    const bytes = decodeBase64(parsed.payload);
    if (bytes === null) return null;
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return null;
    }
  }
  try {
    return decodeURIComponent(parsed.payload);
  } catch {
    return null;
  }
}

/**
 * Chooses the renderer for one detector document. The order is: what the URL
 * itself allows, then the MIME. A URL the page may not load never reaches a
 * renderer, whatever the type says.
 */
export function planFor(result: DetectorResult): RenderPlan {
  const url = result.url.trim();
  const declared = (result.mime ?? "").trim().toLowerCase();
  const parsed = url.startsWith("data:") ? parseDataURL(url) : null;
  const mime = declared !== "" ? declared : (parsed?.mime ?? "");
  const scheme = schemeOf(url);

  if (mime === "") {
    return {
      kind: "unsupported",
      mime,
      reason: "识别结果没有 MIME 类型，页面无法选择渲染方式。",
    };
  }

  if (scheme === "data") {
    if (parsed === null) {
      return { kind: "unsupported", mime, reason: "这条 data: 链接的格式无法解析。" };
    }
    const inline = url;
    if (mime.startsWith("image/") || mime.startsWith("video/") || mime.startsWith("audio/")) {
      return { kind: mediaKind(mime), url: inline, mime, inline: true };
    }
    const flavor = textFlavor(mime);
    if (flavor !== null) {
      const text = decodeInlineText(url);
      if (text === null) {
        return {
          kind: "unsupported",
          mime,
          reason: "内联内容无法解码，或超过了页面一次显示的上限。",
        };
      }
      return { kind: "text", url, mime, flavor, inline: true, text };
    }
    return {
      kind: "unsupported",
      mime,
      reason: `「${mime}」没有可用的渲染方式，内联内容同样无法显示。`,
    };
  }

  if (scheme !== "http" && scheme !== "https") {
    return {
      kind: "unsupported",
      mime,
      reason: scheme === ""
        ? "这条链接没有可识别的协议，页面不会请求它。"
        : `页面只加载 http、https 与 data: 链接；这条链接的协议是 ${scheme}:。`,
    };
  }

  if (mime.startsWith("image/")) return { kind: "image", url, mime, inline: false };
  if (mime.startsWith("video/")) return { kind: "video", url, mime, inline: false };
  if (mime.startsWith("audio/")) return { kind: "audio", url, mime, inline: false };

  if (mime === "application/pdf") {
    return {
      kind: "unsupported",
      mime,
      reason: "PDF 需要系统阅读器，页面沙箱不内嵌它；复制链接后可在浏览器中打开。",
    };
  }

  const flavor = textFlavor(mime);
  if (flavor !== null) return { kind: "text", url, mime, flavor, inline: false };

  const category = result.categoryLabel ?? result.category;
  return {
    kind: "unsupported",
    mime,
    reason: `「${mime}」${category === "" ? "" : `（${category}）`}不能在页面内渲染；没有可用的解码器。`,
  };
}

/**
 * The MIME a response header reports, reduced to its `type/subtype`. Servers
 * append parameters (`video/mp4; charset=utf-8`) and occasionally send nothing
 * usable; an empty return means "no measurement", never a guess.
 */
export function mimeFromContentType(header: string | null | undefined): string {
  const value = (header ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(value) ? value : "";
}

/**
 * Re-plans from what the server says it is sending. The detector reads the
 * link text alone, so an extensionless path always looks like a web page; a
 * measured type decides instead whenever the header carries one, because it is
 * what the server will actually send. A header with no usable type changes
 * nothing, and the detector's plan stands.
 */
export function replanWithMime(result: DetectorResult, header: string): RenderPlan | null {
  const measured = mimeFromContentType(header);
  if (measured === "") return null;
  return planFor({ ...result, mime: measured });
}

function mediaKind(mime: string): "image" | "video" | "audio" {
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  return "image";
}

/** The one-word badge the stage shows for a plan. */
export function planWord(plan: RenderPlan): string {
  switch (plan.kind) {
    case "image":
      return "图片";
    case "video":
      return "视频";
    case "audio":
      return "音频";
    case "text":
      return plan.flavor === "json" ? "JSON" : plan.flavor === "html" ? "HTML 源码" : "文本";
    case "unsupported":
      return "无预览";
  }
}

/**
 * Turns fetched or inline text into what the page paints. JSON is formatted
 * when it parses; everything else stays its own bytes, and HTML is labelled as
 * source because the page never injects it. The result is always bounded by
 * `MAX_TEXT_CHARS`.
 */
export function formatText(
  flavor: TextFlavor,
  text: string,
  limit = MAX_TEXT_CHARS,
): FormattedText {
  let shown = text;
  let note = "";
  if (flavor === "json") {
    try {
      shown = JSON.stringify(JSON.parse(text), null, 2);
      note = "已格式化为 JSON。";
    } catch {
      note = "服务器返回的内容不是有效 JSON，下面显示原文。";
    }
  } else if (flavor === "html") {
    note = "HTML 只显示源码，页面脚本不会执行。";
  } else if (flavor === "xml") {
    note = "XML 以原文显示。";
  }

  const truncated = shown.length > limit;
  if (truncated) {
    shown = shown.slice(0, limit);
    const suffix = `内容过长，只显示前 ${limit.toLocaleString("zh-CN")} 个字符。`;
    note = note === "" ? suffix : `${note} ${suffix}`;
  }
  return { text: shown, note, truncated };
}
