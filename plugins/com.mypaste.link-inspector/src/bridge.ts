/**
 * The host's surface bridge, as seen from inside the link inspector.
 *
 * The document runs in a sandboxed frame with an opaque origin and holds no
 * host binding. It can read the invoked item, receive the application's
 * resolved theme, ask the host for the capabilities registered for an entity
 * type, invoke one of them, ask for a copy, and close the container. Every
 * request carries exactly the fields it needs; a link never leaves the frame
 * as a path, and the clipboard write stays on the host side.
 */

export type SurfaceTextItem = { kind: "text"; title: string; text: string };

export interface BridgeResult {
  ok: boolean;
  id?: number;
  message?: string;
}

interface ResultMessage extends BridgeResult {
  requestId: number;
  commands?: SurfaceCommand[];
  output?: string;
}

/** One capability command the registry reports for an entity type. */
export interface SurfaceCommand {
  pluginId: string;
  commandId: string;
  title: string;
  description?: string;
  output?: string[];
}

export interface RegistryResult extends BridgeResult {
  commands: SurfaceCommand[];
}

export interface InvokeResult extends BridgeResult {
  output?: string;
}

export interface SurfaceDelivery {
  item: SurfaceTextItem;
}

export interface SurfaceBridge {
  readonly delivery: SurfaceDelivery | null;
  /** Registers the one receiver for the delivery; it fires at most once. */
  onItem(listener: (delivery: SurfaceDelivery) => void): void;
  /** The capability commands the registry reports for these entity types. */
  registry(forms: string[]): Promise<RegistryResult>;
  /** Runs one registry command against text this page holds. */
  invoke(pluginId: string, commandId: string, text: string): Promise<InvokeResult>;
  copy(text: string): Promise<BridgeResult>;
  /** Asks the host to close the surface; the page owns the whole card. */
  close(): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseCommand(value: unknown): SurfaceCommand | null {
  if (!isRecord(value) || typeof value.pluginId !== "string" ||
    typeof value.commandId !== "string" || typeof value.title !== "string") {
    return null;
  }
  return {
    pluginId: value.pluginId,
    commandId: value.commandId,
    title: value.title,
    description: typeof value.description === "string" ? value.description : undefined,
    output: Array.isArray(value.output)
      ? value.output.filter((form): form is string => typeof form === "string")
      : undefined,
  };
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
    const commands = Array.isArray(data.commands)
      ? data.commands
        .map(parseCommand)
        .filter((command): command is SurfaceCommand => command !== null)
      : undefined;
    resolve({
      requestId: data.requestId,
      ok: data.ok === true,
      id: typeof data.id === "number" ? data.id : undefined,
      message: typeof data.message === "string" ? data.message : undefined,
      commands,
      output: typeof data.output === "string" ? data.output : undefined,
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
    async registry(forms) {
      const answer = await request({ type: "registry", forms });
      return {
        ok: answer.ok,
        message: answer.message,
        commands: answer.commands ?? [],
      };
    },
    async invoke(pluginId, commandId, text) {
      const answer = await request({ type: "invoke", pluginId, commandId, text });
      return { ok: answer.ok, message: answer.message, output: answer.output };
    },
    copy(text) {
      return request({ type: "copy", text });
    },
    close() {
      post({ v: 1, type: "close" });
    },
  };
}
