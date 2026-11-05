/**
 * The host's workbench bridge, as seen from inside the document. The document
 * runs in a sandboxed frame with an opaque origin: it holds no host binding and
 * can reach the host only through these four messages. Each one carries exactly
 * the fields it needs, and the host answers every save and copy with a result
 * the document shows on its own status line.
 */

export type WorkbenchItem =
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

export interface WorkbenchBridge {
  /** The item this invocation was opened on, once the host has delivered it. */
  readonly item: WorkbenchItem | null;
  /** Registers the one receiver for the item; it fires at most once. */
  onItem(listener: (item: WorkbenchItem) => void): void;
  save(dataURL: string, title: string): Promise<BridgeResult>;
  copy(dataURL: string): Promise<BridgeResult>;
  close(): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseItem(data: unknown): WorkbenchItem | null {
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

/**
 * connectWorkbench wires the bridge and tells the host the document is ready.
 * The host delivers the item only after that message, so nothing may be drawn
 * before it arrives.
 */
export function connectWorkbench(): WorkbenchBridge {
  let item: WorkbenchItem | null = null;
  let itemListener: ((item: WorkbenchItem) => void) | null = null;
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

  const bridge: WorkbenchBridge = {
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
