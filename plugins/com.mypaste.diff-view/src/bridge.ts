/**
 * The host's surface bridge, as seen from inside the comparison document.
 * The document runs in a sandboxed frame with an opaque origin: it holds no
 * host binding and can reach the host only through these messages. Each one
 * carries exactly the fields it needs, and the host answers every save and
 * copy with a result the document shows on its own status line.
 *
 * D-1040: this page writes text. The comparison item is read through the
 * `companion.read` service: after the host delivers the invoked item, the page
 * asks for the one neighbour it compares against, and the host chooses it. A
 * host that already pushed a companion with the item still works (older v3
 * drafts did); the page never learns where the neighbour came from.
 *
 * D-1042/D-1043: the host also sends the application's resolved colour scheme
 * and the design tokens that scheme resolved to; the document paints by them
 * instead of by the system's appearance or a palette of its own.
 */

export type SurfaceTextItem = { kind: "text"; title: string; text: string };

export interface BridgeResult {
  ok: boolean;
  id?: number;
  message?: string;
}

/** A result carries the request it answers; only the bridge reads that field. */
interface ResultMessage extends BridgeResult {
  requestId: number;
  /** The companion item, when the host answers a `companion` request. */
  item?: unknown;
}

/** One delivery: the invoked item and, when declared, its comparison item. */
export interface SurfaceDelivery {
  item: SurfaceTextItem;
  companion: SurfaceTextItem | null;
}

export interface SurfaceBridge {
  readonly delivery: SurfaceDelivery | null;
  /** Registers the one receiver for the delivery; it fires at most once. */
  onItem(listener: (delivery: SurfaceDelivery) => void): void;
  save(text: string, title: string): Promise<BridgeResult>;
  copy(text: string): Promise<BridgeResult>;
  close(): void;
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

/**
 * parseTheme reads the scheme the host resolved from the application's
 * appearance. The frame's own prefers-color-scheme follows the system, so it
 * cannot answer this question on its own.
 */
function parseTheme(data: unknown): ParsedTheme | null {
  if (!isRecord(data) || data.v !== 1 || data.type !== "theme") return null;
  if (data.scheme !== "light" && data.scheme !== "dark") return null;
  const tokens: SurfaceTokens = {};
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
 * The host sends the delivery only after that; a document that renders first
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

  /**
   * Reads the comparison item. A host that already pushed one with the item
   * keeps working; otherwise the page asks for it through `companion.read`.
   * A malformed pushed companion makes the pair unusable rather than half a
   * comparison, exactly as v2 refused it.
   */
  async function deliver(item: SurfaceTextItem, message: unknown): Promise<void> {
    if (delivering) return;
    delivering = true;
    const pushed = isRecord(message) ? message.companion : undefined;
    let companion: SurfaceTextItem | null;
    if (pushed !== undefined) {
      companion = parseTextItem(pushed);
      if (!companion) return;
    } else {
      const result = await request({ type: "companion" });
      companion = result.ok ? parseTextItem(result.item) : null;
    }
    delivery = { item, companion };
    for (const listener of listeners.splice(0)) listener(delivery);
  }

  // The system appearance only covers the moment before the host speaks: the
  // host sends the scheme the application actually resolved (D-1042).
  document.documentElement.dataset.scheme =
    matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";

  window.addEventListener("message", (event) => {
    if (event.source !== parent) return;
    const data = event.data;
    const item = parseItem(data);
    if (item) {
      void deliver(item, data);
      return;
    }
    const theme = parseTheme(data);
    if (theme) {
      applyTheme(theme);
      return;
    }
    if (!isRecord(data) || data.v !== 1 || data.type !== "result") return;
    const result = data as unknown as ResultMessage;
    const resolve = pending.get(result.requestId);
    if (!resolve) return;
    pending.delete(result.requestId);
    resolve({ ...result, ok: Boolean(result.ok) });
  });

  post({ v: 1, type: "ready" });

  return {
    get delivery() {
      return delivery;
    },
    onItem(listener) {
      if (delivery) {
        listener(delivery);
        return;
      }
      listeners.push(listener);
    },
    async save(text, title) {
      const result = await request({ type: "save", text, title });
      return { ok: result.ok, id: result.id, message: result.message };
    },
    async copy(text) {
      const result = await request({ type: "copy", text });
      return { ok: result.ok, id: result.id, message: result.message };
    },
    close() {
      post({ v: 1, type: "close" });
    },
  };
}
