/**
 * The editor's action menu, described as data.
 *
 * Every entry is an EditorAction: a label, a stable group, an applicability
 * test and one run function. The page renders the menu by walking the
 * registry and never switches on a language or an action id, so adding an
 * action — or a language — is one more object here, not another branch in the
 * toolbar.
 *
 * Two sources feed the registry:
 *
 * - Capability commands from the host's `list("text")` answer. A command that
 *   declares text output becomes a document action; the same command also
 *   becomes a selection action, because a surface only ever invokes a command
 *   on the text it sends. The page slices the selection, invokes the command on
 *   that slice and splices the answer back, so the capability never needs to
 *   know about selections.
 * - Local actions that need no package. Keyword-case toggling uses the page's
 *   own tokenizer, which already knows strings and comments and therefore
 *   never rewrites a keyword-looking word inside either.
 *
 * Groups keep their order (格式化 / 压缩 / 大小写 / 其它) whether or not an
 * action currently applies: an inapplicable action is disabled, never hidden,
 * so the menu does not move under the pointer when a selection appears.
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
export const GROUP_ORDER: readonly string[] = ["格式化", "压缩", "大小写", "其它"];

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

/**
 * One document action and one selection action per text capability. The
 * command's own title is the only label source: the page does not know which
 * language a package targets, and it must not guess from a plugin id.
 */
export function capabilityActions(commands: readonly SurfaceCommand[]): EditorAction[] {
  return commands.flatMap((command, index) => {
    const group = actionGroup(command.commandId);
    const base = index * 2;
    return [
      {
        id: `${command.pluginId}/${command.commandId}:document`,
        label: command.title,
        group,
        order: base,
        isEnabled: (context) => context.text.length > 0,
        run: (context) => runCapability(context, command, false),
      },
      {
        id: `${command.pluginId}/${command.commandId}:selection`,
        label: `${command.title}（选区）`,
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
  group: "大小写",
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
