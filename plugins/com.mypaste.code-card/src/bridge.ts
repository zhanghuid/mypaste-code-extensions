/**
 * The host's surface bridge, as seen from inside the document. The document
 * runs in a sandboxed frame with an opaque origin: it holds no host binding and
 * can reach the host only through these messages. Each one carries exactly the
 * fields it needs, and the host answers every save and copy with a result the
 * document shows on its own status line.
 *
 * D-1042/D-1043: the host also sends the application's resolved colour scheme
 * and the design tokens that scheme resolved to; the page paints by them
 * instead of by the system's appearance or a palette of its own. The card's
 * "follow the host" theme reads the same values, so an exported image matches
 * the code surface the reader is looking at.
 */

export type SurfaceItem =
  | { kind: "text"; title: string; text: string }
  | { kind: "image"; title: string; mime: string; dataURL: string };

/** The application's resolved colour scheme (D-1042). */
export type SurfaceScheme = "light" | "dark";

/** Resolved host tokens; keys are the host's CSS names without `--` (D-1043). */
export type SurfaceTokens = Record<string, string>;

/** The application's resolved theme, as the host sends it. */
export interface SurfaceTheme {
  scheme: SurfaceScheme;
  tokens: SurfaceTokens;
}

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
  /** The host theme, once delivered; the page's fallback until then. */
  readonly theme: SurfaceTheme | null;
  /** Registers the one receiver for the item; it fires at most once. */
  onItem(listener: (item: SurfaceItem) => void): void;
  /** Registers the one receiver for theme changes; fires again on each change. */
  onTheme(listener: (theme: SurfaceTheme) => void): void;
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
      kind: "image",
      title: item.title,
      mime: item.mime,
      dataURL: item.dataURL,
    };
  }
  return null;
}

/** The only shape a token name may take once it is prefixed with `--mp-`. */
const TOKEN_NAME = /^[a-z][a-z0-9-]*$/;

/**
 * parseTheme reads the scheme the host resolved from the application's
 * appearance. The frame's own prefers-color-scheme follows the system, so it
 * cannot answer this question on its own.
 */
function parseTheme(data: unknown): SurfaceTheme | null {
  if (!isRecord(data) || data.v !== 1 || data.type !== "theme") return null;
  if (data.scheme !== "light" && data.scheme !== "dark") return null;
  const tokens: SurfaceTokens = {};
  // Unknown keys are ignored: the page has no registry of the host's theme,
  // and a value it has no rule for sets a variable nothing reads. Only
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
function applyTheme(theme: SurfaceTheme): void {
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
  let theme: SurfaceTheme | null = null;
  let themeListener: ((theme: SurfaceTheme) => void) | null = null;
  let nextRequest = 1;
  const pending = new Map<number, (result: BridgeResult) => void>();

  function settle(result: ResultMessage): void {
    const resolve = pending.get(result.requestId);
    if (!resolve) return;
    pending.delete(result.requestId);
    resolve(result);
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window.parent) return;
    const parsed = parseItem(event.data);
    if (parsed) {
      if (item) return;
      item = parsed;
      itemListener?.(parsed);
      return;
    }
    const parsedTheme = parseTheme(event.data);
    if (parsedTheme) {
      theme = parsedTheme;
      applyTheme(parsedTheme);
      themeListener?.(parsedTheme);
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
    get theme() {
      return theme;
    },
    onItem(listener) {
      itemListener = listener;
      if (item) listener(item);
    },
    onTheme(listener) {
      themeListener = listener;
      if (theme) listener(theme);
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
