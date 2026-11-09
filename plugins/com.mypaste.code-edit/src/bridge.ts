/**
 * The host's surface bridge, as seen from inside the editor page. The page runs
 * in a sandboxed frame with an opaque origin: it holds no host binding and can
 * reach the host only through these messages. Protocol v3 gives a surface two
 * things — a container and a closed service list (PLUGINS.md sections 5–6).
 * Reading the one text entity, saving it as a new entry, copying it and
 * closing are those services; highlighting and formatting are this page's own
 * work.
 *
 * D-1069: the host no longer draws a toolbar, exchanges a buffer or draws a
 * document action row. The page owns its controls and asks for its buffer
 * itself. What it does keep is the registry: `list("text")` names the headless
 * commands other packages expose for text, and `invoke()` runs one against the
 * current buffer. A format command's output replaces the buffer; a highlight
 * command's render tokens paint the overlay (when the host forwards them) and
 * its diagnostics are shown on the status line.
 *
 * D-1042/D-1043: the host also sends the application's resolved colour scheme
 * and the design tokens that scheme resolved to; the page paints by them
 * instead of by the system's appearance or a palette of its own.
 */

export type SurfaceTextItem = { kind: "text"; title: string; text: string };

export interface BridgeResult {
  ok: boolean;
  id?: number;
  message?: string;
}

/** One command the registry reports for an entity type (PLUGINS.md section 7). */
export interface SurfaceCommand {
  pluginId: string;
  commandId: string;
  title: string;
  description?: string;
  output?: string[];
  /**
   * When a host exposes declaredness: `false` means the manifest declared no
   * output (a token command), even though the effective list inherits Forms.
   */
  outputDeclared?: boolean;
  /** Present only when the host reports it; empty/absent means a capability. */
  placement?: string[];
}

/** One syntax finding a capability returned alongside its tokens. */
export interface SurfaceDiagnostic {
  line: number;
  column: number;
  message: string;
}

/** One token a highlight command returned (host render contract, bounded). */
export interface SurfaceToken {
  text: string;
  kind: string;
}

export interface CommandResult extends BridgeResult {
  /** The text a format command produced, when it produced one. */
  output?: string;
  /** Tokens a highlight command produced, when the host forwarded them. */
  tokens?: SurfaceToken[];
  diagnostics: SurfaceDiagnostic[];
}

/** A result carries the request it answers; only the bridge reads that field. */
interface ResultMessage extends BridgeResult {
  requestId: number;
  commands?: SurfaceCommand[];
  output?: string;
  tokens?: unknown;
  diagnostics?: SurfaceDiagnostic[];
  render?: {
    diagnostics?: SurfaceDiagnostic[];
    tokens?: unknown;
  } & Record<string, unknown>;
}

export interface SurfaceBridge {
  /** The item this invocation was opened on, once the host has delivered it. */
  readonly item: SurfaceTextItem | null;
  /** Registers the one receiver for the item; it fires at most once. */
  onItem(listener: (item: SurfaceTextItem) => void): void;
  save(text: string, title: string): Promise<BridgeResult>;
  copy(text: string): Promise<BridgeResult>;
  close(): void;
  /** The capability commands the registry reports for these entity types. */
  list(forms: readonly string[]): Promise<SurfaceCommand[]>;
  /** Runs one registry command against `text` and reports what it returned. */
  invoke(command: SurfaceCommand, text: string): Promise<CommandResult>;
}

/** The same ceiling the host applies to every edited buffer. */
const TEXT_LIMIT = 1 << 20;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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
 * this page already knows is unusable does not need to cross the frame.
 */
export function textRefusal(text: string): string {
  if (new TextEncoder().encode(text).length > TEXT_LIMIT) {
    return "内容超过 1 MiB 上限";
  }
  if (!isWellFormedText(text)) return "内容不是有效的 UTF-8";
  if (text.includes("\u0000")) return "内容包含无法处理的字符";
  return "";
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
function applyTheme(theme: ParsedTheme): void {
  const root = document.documentElement;
  root.dataset.scheme = theme.scheme;
  for (const [name, value] of Object.entries(theme.tokens)) {
    root.style.setProperty(`--mp-${name}`, value);
  }
}

function parseItem(data: unknown): SurfaceTextItem | null {
  if (!isRecord(data) || data.v !== 1 || data.type !== "item") return null;
  const item = data.item;
  if (!isRecord(item) || item.kind !== "text" ||
    typeof item.title !== "string" || typeof item.text !== "string") {
    return null;
  }
  return { kind: "text", title: item.title, text: item.text };
}

function parseCommand(value: unknown): SurfaceCommand | null {
  if (!isRecord(value)) return null;
  if (typeof value.pluginId !== "string" || value.pluginId === "") return null;
  if (typeof value.commandId !== "string" || value.commandId === "") return null;
  if (typeof value.title !== "string" || value.title === "") return null;
  const command: SurfaceCommand = {
    pluginId: value.pluginId,
    commandId: value.commandId,
    title: value.title,
  };
  if (typeof value.description === "string") command.description = value.description;
  if (Array.isArray(value.output) && value.output.every((item) => typeof item === "string")) {
    command.output = value.output;
  }
  if (Array.isArray(value.placement) &&
    value.placement.every((item) => typeof item === "string")) {
    command.placement = value.placement;
  }
  if (typeof value.outputDeclared === "boolean") {
    command.outputDeclared = value.outputDeclared;
  }
  return command;
}

function parseDiagnostic(value: unknown): SurfaceDiagnostic | null {
  if (!isRecord(value)) return null;
  if (typeof value.line !== "number" || !Number.isInteger(value.line)) return null;
  if (typeof value.column !== "number" || !Number.isInteger(value.column)) return null;
  if (typeof value.message !== "string") return null;
  return { line: value.line, column: value.column, message: value.message };
}

function parseDiagnostics(value: unknown): SurfaceDiagnostic[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(parseDiagnostic)
    .filter((item): item is SurfaceDiagnostic => item !== null);
}

/** The same bounds the host applies to a capability's render output. */
const MAX_TOKENS = 4000;
const MAX_TOKEN_BYTES = 64 * 1024;

/**
 * parseTokens accepts the render tokens a highlight capability returned. A
 * malformed or oversized answer is rejected whole: a partial token list would
 * paint text that no longer matches the buffer, so the page falls back to its
 * own tokenizer instead.
 */
function parseTokens(value: unknown): SurfaceToken[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_TOKENS) {
    return undefined;
  }
  const tokens: SurfaceToken[] = [];
  let bytes = 0;
  for (const entry of value) {
    if (!isRecord(entry)) return undefined;
    if (typeof entry.text !== "string" || typeof entry.kind !== "string") return undefined;
    if (!isWellFormedText(entry.text)) return undefined;
    bytes += new TextEncoder().encode(entry.text).length;
    tokens.push({ text: entry.text, kind: entry.kind });
  }
  return bytes > MAX_TOKEN_BYTES ? undefined : tokens;
}

/**
 * connectSurface wires the bridge and tells the host the page is ready. The
 * host sends the item only after that; a page that renders first and asks
 * later would race a host that already delivered.
 */
export function connectSurface(): SurfaceBridge {
  let item: SurfaceTextItem | null = null;
  const listeners: ((item: SurfaceTextItem) => void)[] = [];
  const pending = new Map<number, (result: ResultMessage) => void>();
  let nextRequest = 1;

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
    resolve(result);
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
    async list(forms) {
      const result = await request({ type: "registry", forms: [...forms] });
      if (!result.ok) throw new Error(result.message || "读取扩展命令失败");
      if (!Array.isArray(result.commands)) return [];
      return result.commands
        .map(parseCommand)
        .filter((command): command is SurfaceCommand => command !== null);
    },
    async invoke(command, text) {
      const result = await request({
        type: "invoke",
        pluginId: command.pluginId,
        commandId: command.commandId,
        text,
      });
      const diagnostics = parseDiagnostics(
        result.diagnostics ?? result.render?.diagnostics,
      );
      return {
        ok: result.ok,
        id: result.id,
        message: result.message,
        output: typeof result.output === "string" ? result.output : undefined,
        tokens: parseTokens(result.tokens ?? result.render?.tokens),
        diagnostics,
      };
    },
  };
}
