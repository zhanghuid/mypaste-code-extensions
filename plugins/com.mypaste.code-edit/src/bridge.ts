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
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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

/**
 * connectWorkbench wires the bridge and tells the host the document is ready.
 * The host sends the item only after that; a document that renders first and
 * asks later would race a host that already delivered.
 */
export function connectWorkbench(): WorkbenchBridge {
  let item: WorkbenchTextItem | null = null;
  const listeners: ((item: WorkbenchTextItem) => void)[] = [];
  const pending = new Map<number, (result: BridgeResult) => void>();
  let nextRequest = 1;

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
    if (!isRecord(data) || data.v !== 1 || data.type !== "result") return;
    const result = data as unknown as ResultMessage;
    const resolve = pending.get(result.requestId);
    if (!resolve) return;
    pending.delete(result.requestId);
    resolve({ ok: Boolean(result.ok), id: result.id, message: result.message });
  });

  post({ v: 1, type: "ready" });

  return {
    get item() {
      return item;
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
  };
}
