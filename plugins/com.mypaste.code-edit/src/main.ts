/**
 * 代码编辑表面：把宿主交付的这条文本放进一个带行号与语法高亮的编辑面，
 * 另存为新条目或复制到剪贴板。页面不联网、不读取其它条目；高亮是本包自带
 * 的 tokenizer（协议 v3：高亮是表面自己的实现，不是宿主服务，也不依赖任何
 * 能力包）。
 *
 * D-1069：宿主不再画编辑器命令栏，也不再交换缓冲区。复制、保存与关闭按钮由
 * 这个页面自己画；页面自己的图标工具栏上只有「功能区」面板开关、复制与保存，
 * 语言网格与「格式化」菜单收进「功能区」面板，不是所有功能都常驻显示。
 *
 * 「格式化」是一个按动作注册表画出的面板分区。包内的内置操作按当前语言生成
 * 「全文」与「选区」两个动作（SQL 另有压缩），由页面切片、调用本包 runtime 的
 * 命令、再拼回缓冲区，命令本身不需要知道选区。用户另装了格式化能力包时，同名
 * 操作不会重复出现；其余的作为附加项标注来源。纯文本没有内置格式化，分区如实
 * 说明。失败时缓冲区不变，状态行给出理由与诊断位置。
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
  OWN_PLUGIN_ID,
  builtinActions,
  builtinLabels,
  capabilityActions,
  groupActions,
  keywordCaseAction,
  normalizeLabel,
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
const languageBadge = one<HTMLElement>("#doc-language-badge");
const languageGrid = one<HTMLElement>("#doc-language-grid");
const panelRoot = one<HTMLElement>("#doc-panel-root");
const panelToggle = one<HTMLButtonElement>("#doc-panel-toggle");
const panel = one<HTMLElement>("#doc-panel");
const formatList = one<HTMLElement>("#doc-format-list");
const panelClose = one<HTMLButtonElement>("#doc-panel-close");
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
/** The language `actions` was built for; undefined until the first build. */
let actionLanguage: CodeLanguage | null | undefined;
let panelOpen = false;
let renderedActions: { action: EditorAction; button: HTMLButtonElement }[] = [];

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
 * The page's own tokenizer paints the buffer. Highlighting is a surface
 * concern (protocol v3 role "open"): it is not a host service and it does not
 * call any capability package, so the overlay can never show bytes the user
 * did not write.
 */
function renderBuiltinHighlight(): void {
  const text = input.value;
  const language = resolvedLanguage();
  if (!language || text.length > HIGHLIGHT_LIMIT) {
    highlight.textContent = text;
    return;
  }
  highlight.innerHTML = tokenHTML(tokenizeCode(text, language));
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
  // The badge shows what the editor actually renders: automatic detection is
  // labelled, a manual pick is just its name. The grid keeps the chosen value.
  const label = languageLabel(resolvedLanguage());
  languageBadge.textContent = label;
  languageBadge.title = choice === "auto"
    ? `自动识别：${label}`
    : label;
}

function render(): void {
  // Detection can change with the text (the item arrives empty, then fills
  // the buffer). The built-ins follow the language, so rebuild them when it
  // changes; enable states are cheap and stay in refreshActionState.
  if (resolvedLanguage() !== actionLanguage) rebuildActions();
  renderBuiltinHighlight();
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
  // The panel opens even without a capability package: the language grid and
  // the local actions' empty state still belong to the user.
  panelToggle.disabled = disabled;
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
 * Redraws the format list from the action registry. The renderer knows only
 * labels, groups and the enable test; it never asks which language is current
 * or which action it is drawing. Groups appear in their fixed order and every
 * action stays in place, disabled when it does not apply.
 *
 * An empty capability area says so in one muted line. The page never invents
 * an action for a package that is not installed, and it never shows the
 * host's placed commands: those are card actions, not capabilities.
 */
function renderFormatList(): void {
  formatList.replaceChildren();
  renderedActions = [];
  const context = actionContext();
  // The built-ins are the editor's own work: with no language there is
  // nothing to format, and the list says that plainly. It never tells the
  // user to install a capability package, because formatting no longer
  // depends on one.
  if (builtinActions(context.language).length === 0 && actionCommands.length === 0) {
    const empty = document.createElement("div");
    empty.className = "format-empty";
    empty.textContent = context.language === null
      ? "纯文本没有内置格式化操作"
      : "当前语言没有内置格式化操作";
    formatList.append(empty);
  }
  for (const [groupIndex, group] of groupActions(actions).entries()) {
    const section = document.createElement("div");
    section.className = "format-group";
    section.setAttribute("role", "group");
    const heading = document.createElement("div");
    heading.className = "format-group-title";
    heading.id = `doc-format-group-${groupIndex}`;
    heading.textContent = group.title;
    section.setAttribute("aria-labelledby", heading.id);
    section.append(heading);
    for (const action of group.actions) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "format-item";
      button.setAttribute("role", "menuitem");
      button.textContent = action.label;
      button.disabled = actionDisabled(action, context);
      button.addEventListener("click", () => {
        closePanel(false);
        const current = actionContext();
        if (!action.isEnabled(current)) return;
        void run(async () => {
          await action.run(current);
        });
      });
      section.append(button);
      renderedActions.push({ action, button });
    }
    formatList.append(section);
  }
}

/**
 * Draws the language grid. Every choice is a labelled button; the active one
 * is marked, and picking one re-renders the badge and the format list so the
 * built-in actions follow the new language.
 */
function renderLanguageGrid(): void {
  languageGrid.replaceChildren();
  for (const item of LANGUAGE_CHOICES) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "language-item";
    button.setAttribute("role", "menuitem");
    button.dataset.value = item.value;
    button.textContent = item.label;
    button.setAttribute("aria-pressed", String(choice === item.value));
    if (choice === item.value) button.className = "language-item is-active";
    button.addEventListener("click", () => {
      choice = item.value;
      renderLanguage();
      renderLanguageGrid();
      rebuildActions();
      renderBuiltinHighlight();
      renderFormatList();
    });
    languageGrid.append(button);
  }
}

/** Repaints the whole panel and keeps its open/closed state. */
function renderPanel(): void {
  renderLanguageGrid();
  renderFormatList();
  panel.hidden = !panelOpen;
}

/** The enabled items ArrowUp/ArrowDown may land on, in visual order. */
function enabledMenuItems(): HTMLButtonElement[] {
  return renderedActions
    .map((entry) => entry.button)
    .filter((button) => !button.disabled);
}

function focusFirstMenuItem(): void {
  const [first] = enabledMenuItems();
  if (first) first.focus();
  else formatList.focus();
}

/** Re-evaluates only the enable state, so an open panel does not lose focus. */
function refreshActionState(): void {
  if (!panelOpen) return;
  const context = actionContext();
  for (const { action, button } of renderedActions) {
    button.disabled = actionDisabled(action, context);
  }
  const focused = document.activeElement as HTMLButtonElement | null;
  const lostFocus = focused !== null &&
    renderedActions.some((entry) => entry.button === focused) &&
    focused.disabled;
  if (lostFocus) focusFirstMenuItem();
}

/**
 * Places the panel under its trigger in viewport coordinates. `position:
 * fixed` keeps it above the editor no matter which ancestor scrolls, and the
 * width is clamped so a narrow host never pushes the panel off screen.
 */
function positionPanel(): void {
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
  if (!viewportWidth || !viewportHeight) return;
  const margin = 8;
  const rect = panelToggle.getBoundingClientRect();
  const width = Math.min(320, viewportWidth - margin * 2);
  const left = Math.max(margin, Math.min(rect.right - width, viewportWidth - width - margin));
  panel.style.width = `${width}px`;
  panel.style.left = `${left}px`;
  panel.style.top = `${rect.bottom + 6}px`;
  panel.style.maxHeight = `${Math.max(200, viewportHeight - rect.bottom - margin * 2)}px`;
}

function openPanel(): void {
  panelOpen = true;
  renderPanel();
  panel.hidden = false;
  panelToggle.setAttribute("aria-expanded", "true");
  positionPanel();
  focusFirstMenuItem();
}

function closePanel(focusButton = true): void {
  panelOpen = false;
  panel.hidden = true;
  panelToggle.setAttribute("aria-expanded", "false");
  if (focusButton) panelToggle.focus();
}

/**
 * A command this page composes is a text capability: it declares text output
 * and is offered as a buffer action. The current host fills an omitted output
 * from `forms` before it answers the registry, so a capability can also arrive
 * as `["text"]`; D-1081 records the conflation host-side. Until the wire
 * carries declaredness, the protocol's fixed command ids (`format`,
 * `compress`) are the observable difference. A `highlight` command stays out:
 * it returns render tokens, not text (com.mypaste.sql), and highlighting is a
 * page concern here. Placement is filtered before this test, so the host's own
 * placements never become page actions.
 */
function isTextCapability(command: SurfaceCommand): boolean {
  if (command.outputDeclared !== undefined) {
    return command.outputDeclared && (command.output?.includes("text") ?? false);
  }
  if (command.commandId === "highlight") return false;
  if (command.output?.includes("text")) return true;
  return command.commandId === "format" || command.commandId === "compress";
}

/**
 * Rebuilds the menu from the built-ins for the current language plus whatever
 * other packages offer. Built-in operations come first, and an external
 * capability whose title names the same operation (格式化 SQL, 格式化 Go, …)
 * is dropped: the editor already does that work, so the menu must not show
 * the same language twice. The remaining external commands keep their source
 * in the label.
 */
function rebuildActions(): void {
  const language = resolvedLanguage();
  actionLanguage = language;
  const owned = builtinLabels(language);
  const external = actionCommands.filter(
    (command) => !owned.has(normalizeLabel(command.title)),
  );
  actions = [
    ...builtinActions(language),
    ...capabilityActions(external, 1000),
    keywordCaseAction,
  ];
}

/**
 * Loads the registry's text capabilities into the action list. A command with
 * a placement is the host's to show, not a capability this page composes, and
 * this package's own internal commands are already the built-ins, so the
 * registry never turns them into external entries.
 */
async function loadCommandActions(): Promise<void> {
  let commands: SurfaceCommand[] = [];
  try {
    commands = await bridge.list(["text"]);
  } catch {
    commands = [];
  }
  actionCommands = commands.filter(
    (command) => (command.placement?.length ?? 0) === 0 &&
      command.pluginId !== OWN_PLUGIN_ID,
  ).filter(isTextCapability);
  rebuildActions();
  renderPanel();
  updateButtons();
}

panelToggle.addEventListener("click", () => {
  if (panelOpen) closePanel(false);
  else openPanel();
});

panelClose.addEventListener("click", () => {
  closePanel();
});

document.addEventListener("click", (event) => {
  if (panelOpen && !panelRoot.contains(event.target as Node)) {
    closePanel(false);
  }
});

// Arrow keys move a roving focus over the enabled format items; Enter and
// Space are the browser's own button activation. Tab leaves the panel, never
// walks into the rows that follow the focused one.
formatList.addEventListener("keydown", (event) => {
  if (!panelOpen) return;
  const items = enabledMenuItems();
  const current = items.indexOf(document.activeElement as HTMLButtonElement);
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    if (items.length === 0) return;
    const step = event.key === "ArrowDown" ? 1 : -1;
    const next = current < 0
      ? (step > 0 ? 0 : items.length - 1)
      : (current + step + items.length) % items.length;
    const target = items[next];
    target?.focus();
    return;
  }
  if (event.key === "Home" || event.key === "End") {
    event.preventDefault();
    if (items.length === 0) return;
    items[event.key === "Home" ? 0 : items.length - 1]?.focus();
    return;
  }
  if (event.key === "Tab") {
    event.preventDefault();
    closePanel();
  }
});

// The host never sees a key pressed inside this frame, so Esc is the page's
// own: with the panel open it only closes the panel, otherwise it closes the
// surface through the container's close message.
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  event.preventDefault();
  if (panelOpen) {
    closePanel();
    return;
  }
  bridge.close();
});

window.addEventListener("resize", () => {
  if (panelOpen) closePanel(false);
});

document.addEventListener("selectionchange", () => {
  refreshActionState();
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
void loadCommandActions();
