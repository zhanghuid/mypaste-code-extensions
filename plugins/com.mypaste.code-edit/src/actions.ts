/**
 * The editor's action menu, described as data.
 *
 * Every entry is an EditorAction: a label, a stable group, an applicability
 * test and one run function. The page renders the menu by walking the
 * registry and never switches on a language or an action id, so adding an
 * action — or a language — is one more object here, not another branch in the
 * toolbar.
 *
 * Three sources feed the registry:
 *
 * - Built-in operations, one per language the page's tokenizer knows. They run
 *   in this package's own runtime through the host registry (protocol v3 lets
 *   a UI package expose internal commands to its own surface), so formatting
 *   works with no other package installed.
 * - Capability commands from the host's `list("text")` answer. A command that
 *   declares text output becomes a document action; the same command also
 *   becomes a selection action, because a surface only ever invokes a command
 *   on the text it sends. The page slices the selection, invokes the command on
 *   that slice and splices the answer back, so the capability never needs to
 *   know about selections. An external command whose title names an operation
 *   the built-ins already own is dropped before it reaches this registry.
 * - Local actions that need no package. Keyword-case toggling uses the page's
 *   own tokenizer, which already knows strings and comments and therefore
 *   never rewrites a keyword-looking word inside either.
 *
 * Groups keep their order (格式化 / 压缩 / 其它 / 本地) whether or not an
 * action currently applies: an inapplicable action is disabled, never hidden,
 * so the menu does not move under the pointer when a selection appears. The
 * 本地 group is last because it is the only one that never needs a runtime.
 */

import type { CommandResult, SurfaceCommand } from "./bridge";
import { tokenizeCode, type CodeLanguage } from "./tokenize";

/** The same ceiling the highlighting path uses for its own tokenizer. */
const TOKENIZE_LIMIT = 200_000;

/** What one action may read and do. Built fresh for every menu paint. */
export interface EditorContext {
  language: CodeLanguage | null;
  text: string;
  selectionStart: number;
  selectionEnd: number;
  /** The capability commands the registry reported for this buffer. */
  commands: readonly SurfaceCommand[];
  invoke(command: SurfaceCommand, text: string): Promise<CommandResult>;
  /** Replaces [start, end) as one edit; keeps the new range selected when asked. */
  replace(text: string, start: number, end: number, keepSelection: boolean): boolean;
  status(text: string, failed?: boolean): void;
}

export interface EditorAction {
  readonly id: string;
  readonly label: string;
  readonly group: string;
  /** Lower comes first inside a group. */
  readonly order: number;
  isEnabled(context: EditorContext): boolean;
  run(context: EditorContext): Promise<void> | void;
}

/** The groups the menu always reports in this order. */
export const GROUP_ORDER: readonly string[] = ["格式化", "压缩", "其它", "本地"];

/** Which stable group a capability command belongs to. */
export function actionGroup(commandId: string): string {
  switch (commandId) {
    case "format":
      return "格式化";
    case "compress":
      return "压缩";
    default:
      return "其它";
  }
}

function hasSelection(context: EditorContext): boolean {
  return context.selectionEnd > context.selectionStart;
}

async function runCapability(
  context: EditorContext,
  command: SurfaceCommand,
  selection: boolean,
): Promise<void> {
  const start = selection ? context.selectionStart : 0;
  const end = selection ? context.selectionEnd : context.text.length;
  const source = context.text.slice(start, end);
  context.status(`正在运行「${command.title}」…`);
  const result = await context.invoke(command, source);
  if (!result.ok) {
    const first = result.diagnostics[0];
    context.status(
      first
        ? `「${command.title}」第 ${first.line} 行第 ${first.column} 列：${first.message}`
        : (result.message || "命令失败"),
      true,
    );
    return;
  }
  if (result.output === undefined) {
    context.status(`「${command.title}」没有返回文本`, true);
    return;
  }
  if (!context.replace(result.output, start, end, selection)) return;
  context.status(
    selection
      ? `已对选区应用「${command.title}」`
      : `已应用「${command.title}」`,
  );
}

/** The package whose runtime serves the built-in operations. */
export const OWN_PLUGIN_ID = "com.mypaste.code-edit";

/**
 * One formatting operation the editor ships in its own runtime. The page
 * invokes these by id through the host's registry, which protocol v3 lets a
 * surface use for its own package only; no other surface and no command
 * palette sees them.
 */
export interface BuiltinOperation {
  readonly commandId: string;
  readonly label: string;
  readonly language: CodeLanguage;
  readonly group: "格式化" | "压缩";
}

/**
 * Everything the editor can format without another package installed. The
 * table is keyed by the page's own language codes, so a menu can never offer
 * an operation the tokenizer does not know. Plain text has no formatter; its
 * menu says so instead of pretending a capability package is missing.
 */
const BUILTIN_OPERATIONS: readonly BuiltinOperation[] = [
  { commandId: "format.go", label: "格式化 Go", language: "go", group: "格式化" },
  { commandId: "format.javascript", label: "格式化 JavaScript", language: "javascript", group: "格式化" },
  { commandId: "format.typescript", label: "格式化 TypeScript", language: "typescript", group: "格式化" },
  { commandId: "format.python", label: "格式化 Python", language: "python", group: "格式化" },
  { commandId: "format.rust", label: "格式化 Rust", language: "rust", group: "格式化" },
  { commandId: "format.php", label: "格式化 PHP", language: "php", group: "格式化" },
  { commandId: "format.html", label: "格式化 HTML", language: "html", group: "格式化" },
  { commandId: "format.css", label: "格式化 CSS", language: "css", group: "格式化" },
  { commandId: "format.json", label: "格式化 JSON", language: "json", group: "格式化" },
  { commandId: "format.yaml", label: "格式化 YAML", language: "yaml", group: "格式化" },
  { commandId: "format.sql", label: "格式化 SQL", language: "sql", group: "格式化" },
  { commandId: "format.shell", label: "格式化 Shell", language: "shell", group: "格式化" },
  { commandId: "compress.sql", label: "压缩 SQL", language: "sql", group: "压缩" },
];

/** A label compared without spacing and case, for cross-source deduplication. */
export function normalizeLabel(label: string): string {
  return label.replace(/\s+/g, "").toLowerCase();
}

/** The labels the built-ins already own for this language. */
export function builtinLabels(language: CodeLanguage | null): Set<string> {
  if (!language) return new Set();
  return new Set(
    BUILTIN_OPERATIONS
      .filter((operation) => operation.language === language)
      .map((operation) => normalizeLabel(operation.label)),
  );
}

/** Document and selection actions for the current language's built-ins. */
export function builtinActions(language: CodeLanguage | null): EditorAction[] {
  if (!language) return [];
  const operations = BUILTIN_OPERATIONS.filter(
    (operation) => operation.language === language,
  );
  return operations.flatMap((operation, index) => {
    // The command title carries the concrete language (格式化 SQL) so the
    // registry status line and the dedup key stay precise; the menu item is
    // language-agnostic because the trigger already shows the language.
    const command: SurfaceCommand = {
      pluginId: OWN_PLUGIN_ID,
      commandId: operation.commandId,
      title: operation.label,
    };
    const base = index * 2;
    return [
      {
        id: `${OWN_PLUGIN_ID}/${operation.commandId}:document`,
        label: `${operation.group}文档`,
        group: operation.group,
        order: base,
        isEnabled: (context) => context.text.length > 0,
        run: (context) => runCapability(context, command, false),
      },
      {
        id: `${OWN_PLUGIN_ID}/${operation.commandId}:selection`,
        label: `${operation.group}选区`,
        group: operation.group,
        order: base + 1,
        isEnabled: (context) => hasSelection(context),
        run: (context) => runCapability(context, command, true),
      },
    ];
  });
}

/**
 * One document action and one selection action per text capability. The
 * command's own title is the only label source: the page does not know which
 * language a package targets, and it must not guess from a plugin id. Commands
 * that come from another package are marked with their source, because a
 * built-in operation of the same name already covers that language.
 */
export function capabilityActions(
  commands: readonly SurfaceCommand[],
  orderBase = 0,
): EditorAction[] {
  return commands.flatMap((command, index) => {
    const group = actionGroup(command.commandId);
    const base = orderBase + index * 2;
    const source = `（外部：${command.pluginId}）`;
    return [
      {
        id: `${command.pluginId}/${command.commandId}:document`,
        label: `${command.title}${source}`,
        group,
        order: base,
        isEnabled: (context) => context.text.length > 0,
        run: (context) => runCapability(context, command, false),
      },
      {
        id: `${command.pluginId}/${command.commandId}:selection`,
        label: `${command.title}（选区）${source}`,
        group,
        order: base + 1,
        isEnabled: (context) => hasSelection(context),
        run: (context) => runCapability(context, command, true),
      },
    ];
  });
}

// The menu re-evaluates enable states while it is open; a selection change
// must not tokenize a long buffer again when its text has not changed.
let keywordCache: { text: string; language: CodeLanguage; found: boolean } | null = null;

/** True when the tokenizer can find at least one keyword in this buffer. */
export function hasKeywords(text: string, language: CodeLanguage): boolean {
  if (text.length > TOKENIZE_LIMIT) return false;
  if (keywordCache?.text === text && keywordCache.language === language) {
    return keywordCache.found;
  }
  const found = tokenizeCode(text, language).some((token) => token.kind === "keyword");
  keywordCache = { text, language, found };
  return found;
}

/**
 * Flips every keyword token between upper and lower case. The tokenizer
 * already separates strings and comments, so those keep their exact bytes.
 * If any keyword is not upper case the buffer goes upper; otherwise it goes
 * lower. A buffer without keywords is returned unchanged.
 */
export function toggleKeywordCase(text: string, language: CodeLanguage): string {
  const tokens = tokenizeCode(text, language);
  const keywords = tokens.filter((token) => token.kind === "keyword");
  if (keywords.length === 0) return text;
  const upper = keywords.some((token) => token.text !== token.text.toUpperCase());
  return tokens
    .map((token) => {
      if (token.kind !== "keyword") return token.text;
      return upper ? token.text.toUpperCase() : token.text.toLowerCase();
    })
    .join("");
}

/** Keyword casing needs no package; the page's tokenizer is enough. */
export const keywordCaseAction: EditorAction = {
  id: "local:keyword-case",
  label: "切换关键字大小写",
  group: "本地",
  order: 0,
  isEnabled: (context) =>
    context.language !== null && hasKeywords(context.text, context.language),
  run: (context) => {
    if (context.language === null) return;
    if (!context.replace(toggleKeywordCase(context.text, context.language), 0, context.text.length, false)) {
      return;
    }
    context.status("已切换关键字大小写");
  },
};

export interface ActionGroup {
  title: string;
  actions: EditorAction[];
}

/**
 * Groups the registry for rendering. Known groups keep GROUP_ORDER; a group an
 * action invents is appended alphabetically rather than dropped. Groups with
 * no action are omitted (an uninstalled package has nothing to disable).
 */
export function groupActions(actions: readonly EditorAction[]): ActionGroup[] {
  const groups = new Map<string, EditorAction[]>();
  for (const action of actions) {
    const list = groups.get(action.group) ?? [];
    list.push(action);
    groups.set(action.group, list);
  }
  const known = GROUP_ORDER.filter((title) => groups.has(title));
  const extra = [...groups.keys()]
    .filter((title) => !GROUP_ORDER.includes(title))
    .sort((left, right) => left.localeCompare(right));
  return [...known, ...extra].map((title) => ({
    title,
    actions: (groups.get(title) ?? []).slice().sort(
      (left, right) => left.order - right.order || left.label.localeCompare(right.label),
    ),
  }));
}
