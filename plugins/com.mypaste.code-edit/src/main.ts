/**
 * 代码编辑表面：把宿主交付的这条文本放进一个带行号与语法高亮的编辑面，
 * 另存为新条目或复制到剪贴板。页面不联网、不读取其它条目；高亮默认为本包
 * 自带的 tokenizer（协议 v3：高亮是表面自己的实现，不是宿主服务）。
 *
 * D-1069：宿主不再画编辑器命令栏，也不再交换缓冲区。复制、保存与关闭按钮由
 * 这个页面自己画。页面在运行时向注册表查询 `list("text")`：
 *
 * - 「操作」是一个按动作注册表画出的下拉面板。声明了文本输出的能力命令各
 *   生成「全文」与「选区」两个动作；选区动作由页面切片、调用同一条命令、再
 *   拼回缓冲区，命令本身不需要知道选区。失败时缓冲区不变，状态行给出宿主
 *   的理由与诊断位置。
 * - 「高亮」是只读的预览开关：选中后用返回的 token 渲染当前文本，失败或没有
 *   token 时回退本包自带的 tokenizer，并在状态行说明。
 *
 * 动作面板只遍历注册表，不按语言或动作 id 分支。本地动作（关键字大小写）与
 * 能力动作共用同一条替换路径，因此一次动作就是一步撤销。页面不硬编码插件 ID，
 * 也不执行用户代码。
 */

import {
  connectSurface,
  textRefusal,
  type SurfaceCommand,
  type SurfaceToken,
} from "./bridge";
import {
  capabilityActions,
  groupActions,
  keywordCaseAction,
  type EditorAction,
  type EditorContext,
} from "./actions";
import {
  LANGUAGE_CHOICES,
  detectLanguage,
  languageLabel,
} from "./languages";
import { tokenizeCode, type CodeLanguage } from "./tokenize";

/** Above this many characters the page shows plain text, not tokens. */
const HIGHLIGHT_LIMIT = 200_000;
/** Wait this long after a keystroke before asking a capability to highlight. */
const HIGHLIGHT_DELAY_MS = 220;
const INDENT = "  ";
const SAVE_TITLE_LIMIT = 120;
/** The token kinds this document has a style for; anything else stays plain. */
const TOKEN_KINDS = new Set([
  "keyword", "string", "number", "comment", "type", "function", "literal",
  "property", "tag",
]);

const bridge = connectSurface();

function one<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`表面页面缺少 ${selector}`);
  return element;
}

const titleInput = one<HTMLInputElement>("#doc-title");
const languageSelect = one<HTMLSelectElement>("#doc-language");
const actionsRoot = one<HTMLElement>("#doc-actions-root");
const actionsButton = one<HTMLButtonElement>("#doc-actions");
const actionMenu = one<HTMLElement>("#doc-action-menu");
const highlightSelect = one<HTMLSelectElement>("#doc-highlight");
const caret = one<HTMLElement>("#doc-caret");
const dirtyMark = one<HTMLElement>("#doc-dirty");
const gutter = one<HTMLElement>("#editor-gutter");
const highlight = one<HTMLElement>("#editor-highlight");
const input = one<HTMLTextAreaElement>("#editor-input");
const status = one<HTMLElement>("#doc-status");
const copyButton = one<HTMLButtonElement>("[data-action=copy]");
const saveButton = one<HTMLButtonElement>("[data-action=save]");

let originalText = "";
let choice: CodeLanguage | "auto" | "text" = "auto";
let busy = false;
let actionCommands: SurfaceCommand[] = [];
let actions: EditorAction[] = [];
let menuOpen = false;
let renderedActions: { action: EditorAction; button: HTMLButtonElement }[] = [];
let highlightCommands: SurfaceCommand[] = [];
let highlightCommand: SurfaceCommand | null = null;
let highlightGeneration = 0;
let highlightTimer: ReturnType<typeof setTimeout> | null = null;
let capabilityTokens: SurfaceToken[] | null = null;
let capabilityTokensFor = "";

function escapeHTML(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function setStatus(text: string, failed = false): void {
  status.textContent = text;
  status.dataset.tone = failed ? "error" : "info";
  status.hidden = text === "";
}

function resolvedLanguage(): CodeLanguage | null {
  if (choice === "text") return null;
  if (choice === "auto") return detectLanguage(input.value);
  return choice;
}

function tokenHTML(tokens: readonly SurfaceToken[]): string {
  return tokens
    .map((token) => {
      const text = escapeHTML(token.text);
      return TOKEN_KINDS.has(token.kind)
        ? `<span class="tok-${token.kind}">${text}</span>`
        : text;
    })
    .join("");
}

/**
 * The page's own tokenizer is both the default highlight and the fallback: a
 * capability that fails, returns no tokens, or returns tokens that do not add
 * up to the buffer never paints something the user did not write.
 */
function renderBuiltinHighlight(): void {
  capabilityTokens = null;
  capabilityTokensFor = "";
  const text = input.value;
  const language = resolvedLanguage();
  if (!language || text.length > HIGHLIGHT_LIMIT) {
    highlight.textContent = text;
    return;
  }
  highlight.innerHTML = tokenHTML(tokenizeCode(text, language));
}

function scheduleHighlight(): void {
  highlightGeneration += 1;
  if (highlightTimer !== null) {
    clearTimeout(highlightTimer);
    highlightTimer = null;
  }
  // The built-in paint keeps the overlay aligned with the buffer while a
  // capability runs; its tokens replace it when they arrive.
  renderBuiltinHighlight();
  const command = highlightCommand;
  if (!command) return;
  const text = input.value;
  if (text === "" || text.length > HIGHLIGHT_LIMIT) return;
  const generation = highlightGeneration;
  highlightTimer = setTimeout(() => {
    highlightTimer = null;
    void runHighlight(generation);
  }, HIGHLIGHT_DELAY_MS);
}

function diagnosticSentence(title: string, line: number, column: number, message: string): string {
  return `「${title}」第 ${line} 行第 ${column} 列：${message}`;
}

async function runHighlight(generation: number): Promise<void> {
  const command = highlightCommand;
  if (!command || generation !== highlightGeneration) return;
  const text = input.value;
  if (text === "" || text.length > HIGHLIGHT_LIMIT) return;
  let result;
  try {
    result = await bridge.invoke(command, text);
  } catch (error) {
    if (generation !== highlightGeneration) return;
    const message = error instanceof Error ? error.message : "命令失败";
    renderBuiltinHighlight();
    setStatus(`「${command.title}」失败，已回退内置高亮：${message}`, true);
    return;
  }
  if (generation !== highlightGeneration || input.value !== text) return;
  if (!result.ok) {
    const first = result.diagnostics[0];
    const reason = first
      ? diagnosticSentence(command.title, first.line, first.column, first.message)
      : (result.message || "命令失败");
    renderBuiltinHighlight();
    setStatus(`已回退内置高亮：${reason}`, true);
    return;
  }
  if (!result.tokens || result.tokens.length === 0) {
    renderBuiltinHighlight();
    setStatus(`「${command.title}」没有返回高亮，已回退内置高亮`);
    return;
  }
  if (result.tokens.map((token) => token.text).join("") !== text) {
    renderBuiltinHighlight();
    setStatus(`「${command.title}」返回的高亮与当前文本不一致，已回退内置高亮`, true);
    return;
  }
  capabilityTokens = result.tokens;
  capabilityTokensFor = text;
  highlight.innerHTML = tokenHTML(result.tokens);
}

function renderGutter(): void {
  const lines = input.value.split("\n").length;
  const numbers: string[] = [];
  for (let line = 1; line <= lines; line++) numbers.push(String(line));
  gutter.textContent = numbers.join("\n");
}

function renderCaret(): void {
  const before = input.value.slice(0, input.selectionStart);
  const line = before.split("\n").length;
  const column = before.length - before.lastIndexOf("\n");
  caret.textContent = `行 ${line}，列 ${column}`;
}

function renderDirty(): void {
  dirtyMark.hidden = input.value === originalText;
}

function syncScroll(): void {
  highlight.scrollTop = input.scrollTop;
  highlight.scrollLeft = input.scrollLeft;
  gutter.scrollTop = input.scrollTop;
}

function renderLanguage(): void {
  // The select keeps its own value; the note shows what automatic detection
  // decided, so the user can tell a guess from a choice.
  languageSelect.value = choice;
  languageSelect.title = choice === "auto"
    ? `自动识别：${languageLabel(resolvedLanguage())}`
    : languageLabel(resolvedLanguage());
}

function render(): void {
  scheduleHighlight();
  renderGutter();
  renderCaret();
  renderDirty();
  renderLanguage();
  syncScroll();
  refreshActionState();
}

function updateButtons(): void {
  const disabled = busy || bridge.item === null;
  copyButton.disabled = disabled;
  saveButton.disabled = disabled;
  actionsButton.disabled = disabled || actions.length === 0;
  highlightSelect.disabled = disabled || highlightCommands.length === 0;
}

async function run(action: () => Promise<void>): Promise<void> {
  // A press that lands mid-write is ignored; the status line already says what
  // is happening. The page owns its buttons, so it also disables them.
  if (busy) return;
  busy = true;
  updateButtons();
  try {
    await action();
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "操作失败", true);
  } finally {
    busy = false;
    updateButtons();
    refreshActionState();
  }
}

function save(): Promise<void> {
  return run(async () => {
    const title = titleInput.value.trim().slice(0, SAVE_TITLE_LIMIT) || "代码";
    setStatus("正在保存…");
    const result = await bridge.save(input.value, title);
    if (!result.ok) {
      setStatus(result.message || "保存失败", true);
      return;
    }
    originalText = input.value;
    renderDirty();
    setStatus(result.id === undefined ? "已保存为新条目" : `已保存为新条目 #${result.id}`);
  });
}

function copy(): Promise<void> {
  return run(async () => {
    setStatus("正在复制…");
    const result = await bridge.copy(input.value);
    setStatus(result.ok ? "已复制编辑后的文本" : (result.message || "复制失败"), !result.ok);
  });
}

/**
 * Applies an action's text to [start, end) as one edit. `insertText`
 * participates in the native undo stack, so an action is a single Cmd+Z away;
 * `setRangeText` is the fallback for a browser that refuses the command. A
 * document action clamps the old caret to the new length; a selection action
 * leaves the replaced text selected so the next action can chain. Refused
 * text leaves the buffer untouched and returns false.
 */
function applyRange(
  text: string,
  start: number,
  end: number,
  keepSelection: boolean,
): boolean {
  const next = input.value.slice(0, start) + text + input.value.slice(end);
  const refusal = textRefusal(next);
  if (refusal !== "") {
    setStatus(refusal, true);
    return false;
  }
  const caretAt = input.selectionStart;
  input.focus();
  input.setSelectionRange(start, end);
  const inserted = document.execCommand("insertText", false, text);
  if (!inserted) {
    input.setRangeText(text, start, end, "end");
  }
  if (keepSelection) {
    input.setSelectionRange(start, start + text.length);
  } else {
    const at = Math.min(caretAt, input.value.length);
    input.setSelectionRange(at, at);
  }
  render();
  return true;
}

/** Everything the registry's actions read and do for the current buffer. */
function actionContext(): EditorContext {
  return {
    language: resolvedLanguage(),
    text: input.value,
    selectionStart: input.selectionStart,
    selectionEnd: input.selectionEnd,
    commands: actionCommands,
    invoke: (command, text) => bridge.invoke(command, text),
    replace: (text, start, end, keepSelection) =>
      applyRange(text, start, end, keepSelection),
    status: setStatus,
  };
}

function actionDisabled(action: EditorAction, context: EditorContext): boolean {
  return busy || bridge.item === null || !action.isEnabled(context);
}

/**
 * Redraws the menu from the action registry. The renderer knows only labels,
 * groups and the enable test; it never asks which language is current or
 * which action it is drawing. Groups appear in their fixed order and every
 * action stays in place, disabled when it does not apply.
 */
function renderActionMenu(): void {
  actionMenu.replaceChildren();
  renderedActions = [];
  const context = actionContext();
  for (const [groupIndex, group] of groupActions(actions).entries()) {
    const section = document.createElement("div");
    section.className = "action-group";
    section.setAttribute("role", "group");
    const heading = document.createElement("div");
    heading.className = "action-heading";
    heading.id = `doc-action-group-${groupIndex}`;
    heading.textContent = group.title;
    section.setAttribute("aria-labelledby", heading.id);
    section.append(heading);
    for (const action of group.actions) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "action-item";
      button.setAttribute("role", "menuitem");
      button.textContent = action.label;
      button.disabled = actionDisabled(action, context);
      button.addEventListener("click", () => {
        closeActionMenu(false);
        const current = actionContext();
        if (!action.isEnabled(current)) return;
        void run(async () => {
          await action.run(current);
        });
      });
      section.append(button);
      renderedActions.push({ action, button });
    }
    actionMenu.append(section);
  }
  actionMenu.hidden = !menuOpen;
}

/** Re-evaluates only the enable state, so an open menu does not lose focus. */
function refreshActionState(): void {
  if (!menuOpen) return;
  const context = actionContext();
  for (const { action, button } of renderedActions) {
    button.disabled = actionDisabled(action, context);
  }
}

function openActionMenu(): void {
  menuOpen = true;
  renderActionMenu();
  actionMenu.hidden = false;
  actionsButton.setAttribute("aria-expanded", "true");
}

function closeActionMenu(focusButton = true): void {
  menuOpen = false;
  actionMenu.hidden = true;
  actionsButton.setAttribute("aria-expanded", "false");
  if (focusButton) actionsButton.focus();
}

/**
 * Fills the highlight picker from the registry answer. The first option is
 * the page's own tokenizer, so choosing "none" is always possible and the
 * picker disappears entirely when no highlighter is installed (D-1047).
 */
function fillPicker(
  select: HTMLSelectElement,
  placeholder: string,
  commands: SurfaceCommand[],
): void {
  select.replaceChildren();
  const base = document.createElement("option");
  base.value = "";
  base.textContent = placeholder;
  select.append(base);
  commands.forEach((command, index) => {
    const option = document.createElement("option");
    option.value = String(index + 1);
    option.textContent = command.title;
    option.title = command.description ?? command.title;
    select.append(option);
  });
  select.value = "";
  select.hidden = commands.length === 0;
}

/**
 * The two capability shapes this page composes. A command that declares text
 * output is a buffer action; a highlighter declares no output and returns
 * render tokens. The current host fills an omitted output from `forms` before
 * it answers the registry, so both can arrive as `["text"]`; D-1081 records
 * the same conflation host-side. Until the wire carries declaredness, the
 * protocol's fixed command ids (`format`, `compress`, `highlight`,
 * PLUGINS.md §5.2) are the observable difference. Placement is filtered before
 * either test, so the host's own placements never become page actions.
 */
function isHighlightCapability(command: SurfaceCommand): boolean {
  if (command.outputDeclared !== undefined) return command.outputDeclared === false;
  return command.commandId === "highlight";
}

function isTextCapability(command: SurfaceCommand): boolean {
  if (command.outputDeclared !== undefined) {
    return command.outputDeclared && (command.output?.includes("text") ?? false);
  }
  if (command.commandId === "highlight") return false;
  if (command.output?.includes("text")) return true;
  return command.commandId === "format" || command.commandId === "compress";
}

/**
 * Splits the registry's text commands into the action menu and the highlight
 * picker. A command with a placement is the host's to show, not a capability
 * this page composes.
 */
async function loadCommandPickers(): Promise<void> {
  let commands: SurfaceCommand[] = [];
  try {
    commands = await bridge.list(["text"]);
  } catch {
    commands = [];
  }
  const capabilities = commands.filter(
    (command) => (command.placement?.length ?? 0) === 0,
  );
  actionCommands = capabilities.filter(isTextCapability);
  highlightCommands = capabilities.filter(isHighlightCapability);
  actions = [...capabilityActions(actionCommands), keywordCaseAction];
  fillPicker(highlightSelect, "内置", highlightCommands);
  renderActionMenu();
  updateButtons();
}

for (const item of LANGUAGE_CHOICES) {
  const option = document.createElement("option");
  option.value = item.value;
  option.textContent = item.label;
  languageSelect.append(option);
}

languageSelect.addEventListener("change", () => {
  choice = languageSelect.value as CodeLanguage | "auto" | "text";
  renderLanguage();
  scheduleHighlight();
  refreshActionState();
});

actionsButton.addEventListener("click", () => {
  if (menuOpen) closeActionMenu(false);
  else openActionMenu();
});

document.addEventListener("click", (event) => {
  if (menuOpen && !actionsRoot.contains(event.target as Node)) {
    closeActionMenu(false);
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && menuOpen) {
    event.preventDefault();
    closeActionMenu();
  }
});

document.addEventListener("selectionchange", () => {
  refreshActionState();
});

highlightSelect.addEventListener("change", () => {
  const index = Number(highlightSelect.value) - 1;
  highlightCommand = index >= 0 ? (highlightCommands[index] ?? null) : null;
  if (highlightTimer !== null) {
    clearTimeout(highlightTimer);
    highlightTimer = null;
  }
  highlightGeneration += 1;
  if (!highlightCommand) {
    renderBuiltinHighlight();
    return;
  }
  void runHighlight(highlightGeneration);
});

input.addEventListener("input", () => {
  render();
});

input.addEventListener("scroll", syncScroll);
input.addEventListener("click", renderCaret);
input.addEventListener("keyup", renderCaret);
input.addEventListener("keydown", (event) => {
  if (event.key === "Tab" && !event.metaKey && !event.ctrlKey) {
    event.preventDefault();
    const start = input.selectionStart;
    const end = input.selectionEnd;
    input.setRangeText(INDENT, start, end, "end");
    render();
    return;
  }
  if (event.key === "s" && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    void save();
  }
});

copyButton.addEventListener("click", () => void copy());
saveButton.addEventListener("click", () => void save());

bridge.onItem((item) => {
  originalText = item.text;
  input.value = item.text;
  titleInput.value = item.title.slice(0, SAVE_TITLE_LIMIT);
  choice = "auto";
  render();
  updateButtons();
  input.focus();
  input.setSelectionRange(0, 0);
  renderCaret();
});

updateButtons();
void loadCommandPickers();
