/**
 * The host's workbench bridge, as seen from inside the editor document. The
 * document runs in a sandboxed frame with an opaque origin: it holds no host
 * binding and can reach the host only through these messages. Each one carries
 * exactly the fields it needs, and the host answers every save and copy with a
 * result the document shows on its own status line.
 *
 * D-1040: this document writes text. It never writes HTML, never runs a
 * process, and never asks for a file.
 *
 * D-1042/D-1043: the host also sends the application's resolved colour scheme
 * and the design tokens that scheme resolved to; the document paints by them
 * instead of by the system's appearance or a palette of its own.
 *
 * D-1065: the document advertises the optional `buffer` feature, answers the
 * host's `buffer-request` with its whole buffer and revision, and applies a
 * host `replace` as one edit when that revision is still current. The host
 * draws the editor toolbar; this document never asks for or names a command,
 * and it still never calls the host's format or highlight extensions.
 */

export type WorkbenchTextItem = { kind: "text"; title: string; text: string };

export interface BridgeResult {
  ok: boolean;
  id?: number;
  message?: string;
}

/** A result carries the request it answers; only the bridge reads that field. */
interface ResultMessage extends BridgeResult {
  requestId: number;
}

export interface WorkbenchBridge {
  /** The item this invocation was opened on, once the host has delivered it. */
  readonly item: WorkbenchTextItem | null;
  /** Registers the one receiver for the item; it fires at most once. */
  onItem(listener: (item: WorkbenchTextItem) => void): void;
  save(text: string, title: string): Promise<BridgeResult>;
  copy(text: string): Promise<BridgeResult>;
  close(): void;
  /**
   * Answers the host's `buffer-request` with the document's whole buffer and
   * its current revision (D-1065). This document advertises the feature, so
   * the host's toolbar may ask; nothing is granted to the document by it.
   */
  onBufferRequest(listener: () => BufferSnapshot): void;
  /**
   * Applies the host's `replace` as one edit, but only while the document's
   * revision still equals the one the replace names. A mismatch changes
   * nothing and reports why.
   */
  onReplace(
    listener: (text: string, revision: number) => BridgeResult,
  ): void;
  /**
   * Receives one press of an action this document declared in `ready`
   * (D-1068). The host draws the buttons and forwards only the id it was
   * given; the document decides what each id means.
   */
  onAction(listener: (id: string) => void): void;
}

/**
 * One button this document asks the host to draw in the workbench card's
 * action row. The host owns the material; `emphasis` and `enabled` only pick
 * which of its own looks the button gets (D-1068).
 */
export interface WorkbenchActionDeclaration {
  id: string;
  title: string;
  emphasis?: boolean;
  enabled?: boolean;
}

/** The document's buffer and the revision it is at. */
export interface BufferSnapshot {
  text: string;
  revision: number;
}

/** The same ceiling the host applies to every edited buffer. */
const TEXT_LIMIT = 1 << 20;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasExactKeys(message: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(message).sort();
  return actual.length === keys.length &&
    actual.every((key, index) => key === keys[index]);
}

/** UTF-16 text is well formed when no surrogate is unpaired. */
function isWellFormedText(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

/**
 * textRefusal mirrors the host's rules early: the host decides, but a buffer
 * this document already knows is unusable does not need to cross the frame.
 */
export function textRefusal(text: string): string {
  if (new TextEncoder().encode(text).length > TEXT_LIMIT) {
    return "内容超过 1 MiB 上限";
  }
  if (!isWellFormedText(text)) return "内容不是有效的 UTF-8";
  if (text.includes("\u0000")) return "内容包含无法处理的字符";
  return "";
}

/**
 * The revision rule for a host `replace` (D-1065). The host reads the buffer at
 * one revision and tags its replacement with that number; the document applies
 * it only while its own counter still matches, so a reader who typed while the
 * command ran keeps their text.
 */
export const REVISION_REFUSAL = "内容已变化，未替换";

/** Empty when a replacement may apply, otherwise the sentence to report. */
export function replaceRefusal(
  currentRevision: number,
  expectedRevision: number,
): string {
  return currentRevision === expectedRevision ? "" : REVISION_REFUSAL;
}

function parseBufferRequest(data: unknown): number | null {
  if (!isRecord(data) || data.v !== 1 || data.type !== "buffer-request") return null;
  if (!hasExactKeys(data, ["requestId", "type", "v"])) return null;
  if (typeof data.requestId !== "number" || !Number.isInteger(data.requestId)) {
    return null;
  }
  return data.requestId;
}

function parseReplace(data: unknown): { requestId: number; text: string; revision: number } | null {
  if (!isRecord(data) || data.v !== 1 || data.type !== "replace") return null;
  if (!hasExactKeys(data, ["requestId", "revision", "text", "type", "v"])) return null;
  if (typeof data.requestId !== "number" || !Number.isInteger(data.requestId)) {
    return null;
  }
  if (typeof data.text !== "string") return null;
  if (typeof data.revision !== "number" || !Number.isInteger(data.revision)) {
    return null;
  }
  if (data.revision < 0) return null;
  return { requestId: data.requestId, text: data.text, revision: data.revision };
}

/** The application's resolved colour scheme (D-1042). */
type WorkbenchScheme = "light" | "dark";

/** Resolved host tokens; keys are the host's CSS names without `--` (D-1043). */
type WorkbenchTokens = Record<string, string>;

interface ParsedTheme {
  scheme: WorkbenchScheme;
  tokens: WorkbenchTokens;
}

/** The only shape a token name may take once it is prefixed with `--mp-`. */
const TOKEN_NAME = /^[a-z][a-z0-9-]*$/;

/**
 * parseTheme reads the scheme the host resolved from the application's
 * appearance. The frame's own prefers-color-scheme follows the system, so it
 * cannot answer this question on its own.
 */
function parseTheme(data: unknown): ParsedTheme | null {
  if (!isRecord(data) || data.v !== 1 || data.type !== "theme") return null;
  if (data.scheme !== "light" && data.scheme !== "dark") return null;
  const tokens: WorkbenchTokens = {};
  // Unknown keys are ignored: the document has no registry of the host's
  // theme, and a value it has no rule for sets a variable nothing reads. Only
  // non-empty strings reach CSS.
  if (isRecord(data.tokens)) {
    for (const [name, value] of Object.entries(data.tokens)) {
      if (typeof value === "string" && value !== "" && TOKEN_NAME.test(name)) {
        tokens[name] = value;
      }
    }
  }
  return { scheme: data.scheme, tokens };
}

/**
 * applyTheme writes the host's resolved values onto this document's root as
 * `--mp-<name>` (D-1043). The stylesheet prefers those variables and keeps
 * its own palette as the fallback, so an older host that sends no tokens still
 * paints, and a new host repaints whenever the pair changes.
 */
function applyTheme(theme: ParsedTheme): void {
  const root = document.documentElement;
  root.dataset.scheme = theme.scheme;
  for (const [name, value] of Object.entries(theme.tokens)) {
    root.style.setProperty(`--mp-${name}`, value);
  }
}

function parseItem(data: unknown): WorkbenchTextItem | null {
  if (!isRecord(data) || data.v !== 1 || data.type !== "item") return null;
  const item = data.item;
  if (!isRecord(item) || item.kind !== "text" ||
    typeof item.title !== "string" || typeof item.text !== "string") {
    return null;
  }
  return { kind: "text", title: item.title, text: item.text };
}

/** parseAction accepts exactly the action message the host sends (D-1068). */
function parseAction(data: unknown): string | null {
  if (!isRecord(data) || !hasExactKeys(data, ["id", "type", "v"])) return null;
  if (data.v !== 1 || data.type !== "action") return null;
  if (typeof data.id !== "string" || data.id === "") return null;
  return data.id;
}

/**
 * connectWorkbench wires the bridge and tells the host the document is ready.
 * The host sends the item only after that; a document that renders first and
 * asks later would race a host that already delivered.
 */
export function connectWorkbench(
  actions: readonly WorkbenchActionDeclaration[] = [],
): WorkbenchBridge {
  let item: WorkbenchTextItem | null = null;
  const listeners: ((item: WorkbenchTextItem) => void)[] = [];
  const pending = new Map<number, (result: BridgeResult) => void>();
  let nextRequest = 1;
  let bufferListener: (() => BufferSnapshot) | null = null;
  let replaceListener: ((text: string, revision: number) => BridgeResult) | null = null;
  const actionListeners: ((id: string) => void)[] = [];

  function post(message: unknown): void {
    parent.postMessage(message, "*");
  }

  function request(message: Record<string, unknown>): Promise<BridgeResult> {
    const requestId = nextRequest++;
    return new Promise((resolve) => {
      pending.set(requestId, resolve);
      post({ ...message, v: 1, requestId });
    });
  }

  // The system appearance only covers the moment before the host speaks: the
  // host sends the scheme the application actually resolved (D-1042).
  document.documentElement.dataset.scheme =
    matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";

  window.addEventListener("message", (event) => {
    if (event.source !== parent) return;
    const data = event.data;
    const delivered = parseItem(data);
    if (delivered) {
      item = delivered;
      for (const listener of listeners.splice(0)) listener(delivered);
      return;
    }
    const theme = parseTheme(data);
    if (theme) {
      applyTheme(theme);
      return;
    }
    const action = parseAction(data);
    if (action !== null) {
      for (const listener of actionListeners) listener(action);
      return;
    }
    const bufferRequest = parseBufferRequest(data);
    if (bufferRequest !== null) {
      // Only answer a question this document can actually answer; a missing
      // listener means the page has not wired its buffer yet.
      const buffer = bufferListener?.();
      if (buffer) {
        post({
          v: 1,
          type: "buffer",
          requestId: bufferRequest,
          text: buffer.text,
          revision: buffer.revision,
        });
      }
      return;
    }
    const replacement = parseReplace(data);
    if (replacement) {
      const refusal = textRefusal(replacement.text);
      const result = refusal !== ""
        ? { ok: false, message: refusal }
        : replaceListener?.(replacement.text, replacement.revision);
      if (!result) return;
      const answer: Record<string, unknown> = {
        v: 1,
        type: "result",
        requestId: replacement.requestId,
        ok: result.ok,
      };
      if (result.message !== undefined) answer.message = result.message;
      post(answer);
      return;
    }
    if (!isRecord(data) || data.v !== 1 || data.type !== "result") return;
    const result = data as unknown as ResultMessage;
    const resolve = pending.get(result.requestId);
    if (!resolve) return;
    pending.delete(result.requestId);
    resolve({ ok: Boolean(result.ok), id: result.id, message: result.message });
  });

  // D-1065: the host draws an editor toolbar only for a document that says it
  // can hand over its buffer. Nothing else about the channel changes.
  post({
    v: 1,
    type: "ready",
    features: ["buffer"],
    ...(actions.length > 0 ? { actions: actions.map((action) => ({ ...action })) } : {}),
  });

  return {
    get item() {
      return item;
    },
    onAction(listener) {
      actionListeners.push(listener);
    },
    onItem(listener) {
      if (item) {
        listener(item);
        return;
      }
      listeners.push(listener);
    },
    save(text, title) {
      return request({ type: "save", text, title });
    },
    copy(text) {
      return request({ type: "copy", text });
    },
    close() {
      post({ v: 1, type: "close" });
    },
    onBufferRequest(listener) {
      bufferListener = listener;
    },
    onReplace(listener) {
      replaceListener = listener;
    },
  };
}
