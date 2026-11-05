/**
 * The host's workbench bridge, as seen from inside the comparison document.
 * The document runs in a sandboxed frame with an opaque origin: it holds no
 * host binding and can reach the host only through these messages. Each one
 * carries exactly the fields it needs, and the host answers every save and
 * copy with a result the document shows on its own status line.
 *
 * D-1040: this document writes text. The item message also carries the one
 * comparison item the manifest declared; the host chooses the neighbour and
 * the document never learns where it came from.
 *
 * D-1042: the host also sends the application's resolved colour scheme;
 * the document paints by it instead of by the system's appearance.
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

/** One delivery: the invoked item and, when declared, its comparison item. */
export interface WorkbenchDelivery {
  item: WorkbenchTextItem;
  companion: WorkbenchTextItem | null;
}

export interface WorkbenchBridge {
  readonly delivery: WorkbenchDelivery | null;
  /** Registers the one receiver for the delivery; it fires at most once. */
  onItem(listener: (delivery: WorkbenchDelivery) => void): void;
  save(text: string, title: string): Promise<BridgeResult>;
  copy(text: string): Promise<BridgeResult>;
  close(): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** The application's resolved colour scheme (D-1042). */
type WorkbenchScheme = "light" | "dark";

/**
 * parseTheme reads the scheme the host resolved from the application's
 * appearance. The frame's own prefers-color-scheme follows the system, so it
 * cannot answer this question on its own.
 */
function parseTheme(data: unknown): WorkbenchScheme | null {
  if (!isRecord(data) || data.v !== 1 || data.type !== "theme") return null;
  return data.scheme === "light" || data.scheme === "dark" ? data.scheme : null;
}

function parseTextItem(value: unknown): WorkbenchTextItem | null {
  if (!isRecord(value) || value.kind !== "text" ||
    typeof value.title !== "string" || typeof value.text !== "string") {
    return null;
  }
  return { kind: "text", title: value.title, text: value.text };
}

function parseDelivery(data: unknown): WorkbenchDelivery | null {
  if (!isRecord(data) || data.v !== 1 || data.type !== "item") return null;
  const item = parseTextItem(data.item);
  if (!item) return null;
  const companion = data.companion === undefined ? null : parseTextItem(data.companion);
  // A malformed companion is not silently dropped: the document declared that
  // it needs one, so it treats the delivery as unusable instead of comparing
  // against half a pair.
  if (data.companion !== undefined && !companion) return null;
  return { item, companion };
}

/**
 * connectWorkbench wires the bridge and tells the host the document is ready.
 * The host sends the delivery only after that; a document that renders first
 * and asks later would race a host that already delivered.
 */
export function connectWorkbench(): WorkbenchBridge {
  let delivery: WorkbenchDelivery | null = null;
  const listeners: ((delivery: WorkbenchDelivery) => void)[] = [];
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
    const delivered = parseDelivery(data);
    if (delivered) {
      delivery = delivered;
      for (const listener of listeners.splice(0)) listener(delivered);
      return;
    }
    const scheme = parseTheme(data);
    if (scheme) {
      document.documentElement.dataset.scheme = scheme;
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
