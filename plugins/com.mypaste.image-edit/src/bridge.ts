/**
 * The host's surface bridge, as seen from inside this document. It is a copy
 * of the same channel the code-card package uses: the packages share nothing,
 * so each declares the protocol from its own side. The host is the only
 * owner; a change there reaches both packages by a version update.
 */

export type SurfaceItem =
  | { kind: "text"; title: string; text: string }
  | { kind: "image"; title: string; mime: string; dataURL: string };

export interface BridgeResult {
  ok: boolean;
  id?: number;
  message?: string;
}

/** A result carries the request it answers; only the bridge reads that field. */
interface ResultMessage extends BridgeResult {
  requestId: number;
}

export interface SurfaceBridge {
  /** The item this invocation was opened on, once the host has delivered it. */
  readonly item: SurfaceItem | null;
  /** Registers the one receiver for the item; it fires at most once. */
  onItem(listener: (item: SurfaceItem) => void): void;
  save(dataURL: string, title: string): Promise<BridgeResult>;
  copy(dataURL: string): Promise<BridgeResult>;
  close(): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseItem(data: unknown): SurfaceItem | null {
  if (!isRecord(data) || data.v !== 1 || data.type !== "item") return null;
  const item = data.item;
  if (!isRecord(item) || typeof item.title !== "string") return null;
  if (item.kind === "text") {
    return typeof item.text === "string"
      ? { kind: "text", title: item.title, text: item.text }
      : null;
  }
  if (item.kind === "image") {
    if (typeof item.mime !== "string" || typeof item.dataURL !== "string") return null;
    return {
      kind: "image", title: item.title, mime: item.mime, dataURL: item.dataURL,
    };
  }
  return null;
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

/**
 * parseTheme reads the scheme the host resolved from the application's
 * appearance. The frame's own prefers-color-scheme follows the system, so it
 * cannot answer this question on its own.
 */
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

/**
 * connectSurface wires the bridge and tells the host the document is ready.
 * The host delivers the item only after that message, so nothing may be drawn
 * before it arrives.
 */
export function connectSurface(): SurfaceBridge {
  let item: SurfaceItem | null = null;
  let itemListener: ((item: SurfaceItem) => void) | null = null;
  let nextRequest = 1;
  const pending = new Map<number, (result: BridgeResult) => void>();
  // Until the host sends its theme, the system appearance is the best guess;
  // a dark system with a light application would otherwise flash this page's
  // light palette for the first frame.
  document.documentElement.dataset.scheme =
    window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";

  function settle(result: ResultMessage): void {
    const resolve = pending.get(result.requestId);
    if (!resolve) return;
    pending.delete(result.requestId);
    resolve(result);
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window.parent) return;
    const theme = parseTheme(event.data);
    if (theme) {
      applyTheme(theme);
      return;
    }
    const parsed = parseItem(event.data);
    if (parsed) {
      if (item) return;
      item = parsed;
      itemListener?.(parsed);
      return;
    }
    if (!isRecord(event.data) || event.data.v !== 1 || event.data.type !== "result") return;
    const { requestId, ok } = event.data;
    if (typeof requestId !== "number" || typeof ok !== "boolean") return;
    settle({
      ok,
      requestId,
      id: typeof event.data.id === "number" ? event.data.id : undefined,
      message: typeof event.data.message === "string" ? event.data.message : undefined,
    });
  });

  function request(message: Record<string, unknown>): Promise<BridgeResult> {
    const requestId = nextRequest++;
    return new Promise((resolve) => {
      pending.set(requestId, resolve);
      window.parent.postMessage({ v: 1, ...message, requestId }, "*");
    });
  }

  const bridge: SurfaceBridge = {
    get item() {
      return item;
    },
    onItem(listener) {
      itemListener = listener;
      if (item) listener(item);
    },
    save(dataURL, title) {
      return request({ type: "save", image: { dataURL, title } });
    },
    copy(dataURL) {
      return request({ type: "copy", image: { dataURL } });
    },
    close() {
      window.parent.postMessage({ v: 1, type: "close" }, "*");
    },
  };

  window.parent.postMessage({ v: 1, type: "ready" }, "*");
  return bridge;
}
