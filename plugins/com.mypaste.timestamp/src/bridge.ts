/**
 * The host's surface bridge, as seen from inside the timestamp document.
 * The document runs in a sandboxed frame with an opaque origin and holds no
 * host binding: it can only read the invoked item, receive the application's
 * resolved theme, and ask the host to perform a copy (the host owns the
 * clipboard write). Every request carries exactly the fields it needs.
 */

export type SurfaceTextItem = { kind: "text"; title: string; text: string };

export interface BridgeResult {
  ok: boolean;
  id?: number;
  message?: string;
}

interface ResultMessage extends BridgeResult {
  requestId: number;
}

export interface SurfaceDelivery {
  item: SurfaceTextItem;
}

export interface SurfaceBridge {
  readonly delivery: SurfaceDelivery | null;
  /** Registers the one receiver for the delivery; it fires at most once. */
  onItem(listener: (delivery: SurfaceDelivery) => void): void;
  copy(text: string): Promise<BridgeResult>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** The application's resolved colour scheme (D-1042). */
type SurfaceScheme = "light" | "dark";

/** Resolved host tokens; keys are the host's CSS names without `--` (D-1043). */
type SurfaceTokens = Record<string, string>;

interface ParsedTheme {
  scheme: SurfaceScheme;
  tokens: SurfaceTokens;
}

/** The only shape a token name may take once it is prefixed with `--mp-`. */
const TOKEN_NAME = /^[a-z][a-z0-9-]*$/;

function parseTheme(data: unknown): ParsedTheme | null {
  if (!isRecord(data) || data.v !== 1 || data.type !== "theme") return null;
  if (data.scheme !== "light" && data.scheme !== "dark") return null;
  const tokens: SurfaceTokens = {};
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
 * Writes the host's resolved values onto this document's root as
 * `--mp-<name>`; the stylesheet prefers them and keeps its own palette as the
 * fallback for an older host. The frame's own prefers-color-scheme follows the
 * system, not the appearance chosen in MyPaste, so the message is authoritative.
 */
function applyTheme(theme: ParsedTheme): void {
  const root = document.documentElement;
  root.dataset.scheme = theme.scheme;
  for (const [name, value] of Object.entries(theme.tokens)) {
    root.style.setProperty(`--mp-${name}`, value);
  }
}

function parseTextItem(value: unknown): SurfaceTextItem | null {
  if (!isRecord(value) || value.kind !== "text" ||
    typeof value.title !== "string" || typeof value.text !== "string") {
    return null;
  }
  return { kind: "text", title: value.title, text: value.text };
}

function parseItem(data: unknown): SurfaceTextItem | null {
  if (!isRecord(data) || data.v !== 1 || data.type !== "item") return null;
  return parseTextItem(data.item);
}

/**
 * connectSurface wires the bridge and tells the host the document is ready.
 * The host delivers the item only after that, so a document that renders first
 * and asks later would race a host that already delivered.
 */
export function connectSurface(): SurfaceBridge {
  let delivery: SurfaceDelivery | null = null;
  const listeners: ((delivery: SurfaceDelivery) => void)[] = [];
  const pending = new Map<number, (result: ResultMessage) => void>();
  let nextRequest = 1;
  let delivering = false;

  function post(message: unknown): void {
    parent.postMessage(message, "*");
  }

  function request(message: Record<string, unknown>): Promise<ResultMessage> {
    const requestId = nextRequest++;
    return new Promise((resolve) => {
      pending.set(requestId, resolve);
      post({ ...message, v: 1, requestId });
    });
  }

  function deliver(item: SurfaceTextItem): void {
    if (delivering) return;
    delivering = true;
    delivery = { item };
    for (const listener of listeners.splice(0)) listener(delivery);
  }

  document.documentElement.dataset.scheme =
    matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";

  window.addEventListener("message", (event) => {
    if (event.source !== parent) return;
    const data = event.data;
    const item = parseItem(data);
    if (item) {
      deliver(item);
      return;
    }
    const theme = parseTheme(data);
    if (theme) {
      applyTheme(theme);
      return;
    }
    if (!isRecord(data) || data.v !== 1 || data.type !== "result") return;
    if (typeof data.requestId !== "number") return;
    const resolve = pending.get(data.requestId);
    if (!resolve) return;
    pending.delete(data.requestId);
    resolve({
      requestId: data.requestId,
      ok: data.ok === true,
      id: typeof data.id === "number" ? data.id : undefined,
      message: typeof data.message === "string" ? data.message : undefined,
    });
  });

  post({ v: 1, type: "ready" });

  return {
    get delivery() {
      return delivery;
    },
    onItem(listener) {
      if (delivery !== null) listener(delivery);
      else listeners.push(listener);
    },
    copy(text) {
      return request({ type: "copy", text });
    },
  };
}
