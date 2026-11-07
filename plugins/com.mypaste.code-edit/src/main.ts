/**
 * 代码编辑表面：把宿主交付的这条文本放进一个带行号与语法高亮的编辑面，
 * 另存为新条目或复制到剪贴板。页面不联网、不读取其它条目；高亮由本包自带的
 * tokenizer 完成（协议 v3：高亮是表面自己的实现，不是宿主服务）。
 *
 * D-1069：宿主不再画编辑器命令栏，也不再交换缓冲区。复制、保存与关闭按钮由
 * 这个页面自己画；格式化能力由页面在运行时向注册表查询 `list("text")` 得到，
 * 选中后经桥调用，返回的文本就地替换、返回的诊断显示在状态行。页面不执行
 * 用户代码，也不调用宿主的任何高亮或格式化服务。
 */

import {
  connectSurface,
  textRefusal,
  type SurfaceCommand,
} from "./bridge";
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

const bridge = connectSurface();

function one<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`表面页面缺少 ${selector}`);
  return element;
}

const titleInput = one<HTMLInputElement>("#doc-title");
const languageSelect = one<HTMLSelectElement>("#doc-language");
const caret = one<HTMLElement>("#doc-caret");
const dirtyMark = one<HTMLElement>("#doc-dirty");
const gutter = one<HTMLElement>("#editor-gutter");
const highlight = one<HTMLElement>("#editor-highlight");
const input = one<HTMLTextAreaElement>("#editor-input");
const status = one<HTMLElement>("#doc-status");
const commandBar = one<HTMLElement>("#doc-commands");
const copyButton = one<HTMLButtonElement>("[data-action=copy]");
const saveButton = one<HTMLButtonElement>("[data-action=save]");

let originalText = "";
let choice: CodeLanguage | "auto" | "text" = "auto";
let busy = false;
let commands: SurfaceCommand[] = [];
const commandButtons: HTMLButtonElement[] = [];

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

function renderHighlight(): void {
  const language = resolvedLanguage();
  const text = input.value;
  if (!language || text.length > HIGHLIGHT_LIMIT) {
    highlight.textContent = text;
    return;
  }
  const tokens = tokenizeCode(text, language);
  highlight.innerHTML = tokens
    .map((token) =>
      token.kind
        ? `<span class="tok-${token.kind}">${escapeHTML(token.text)}</span>`
        : escapeHTML(token.text)
    )
    .join("");
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
  renderHighlight();
  renderGutter();
  renderCaret();
  renderDirty();
  renderLanguage();
  syncScroll();
}

function updateButtons(): void {
  const disabled = busy || bridge.item === null;
  copyButton.disabled = disabled;
  saveButton.disabled = disabled;
  for (const button of commandButtons) button.disabled = disabled;
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
 * Applies a command's text as one edit. `insertText` participates in the
 * native undo stack, so a format is a single Cmd+Z away; `setRangeText` is the
 * fallback for a browser that refuses the command. The caret is clamped to the
 * new length so a format does not also move it to the end.
 */
function applyReplacement(text: string): void {
  const refusal = textRefusal(text);
  if (refusal !== "") {
    setStatus(refusal, true);
    return;
  }
  const caretAt = input.selectionStart;
  input.focus();
  input.setSelectionRange(0, input.value.length);
  const inserted = document.execCommand("insertText", false, text);
  if (!inserted) {
    input.setRangeText(text, 0, input.value.length, "end");
  }
  const at = Math.min(caretAt, text.length);
  input.setSelectionRange(at, at);
  render();
}

function diagnosticSentence(title: string, line: number, column: number, message: string): string {
  return `「${title}」第 ${line} 行第 ${column} 列：${message}`;
}

function invokeCommand(command: SurfaceCommand): Promise<void> {
  return run(async () => {
    setStatus(`正在运行「${command.title}」…`);
    const result = await bridge.invoke(command, input.value);
    const first = result.diagnostics[0];
    if (!result.ok) {
      setStatus(
        first
          ? diagnosticSentence(command.title, first.line, first.column, first.message)
          : (result.message || "命令失败"),
        true,
      );
      return;
    }
    if (result.output !== undefined) applyReplacement(result.output);
    if (first) {
      const more = result.diagnostics.length > 1 ? `（共 ${result.diagnostics.length} 处）` : "";
      setStatus(diagnosticSentence(command.title, first.line, first.column, first.message) + more, true);
      return;
    }
    setStatus(result.output === undefined ? `「${command.title}」已运行` : `已应用「${command.title}」`);
  });
}

/**
 * Fills the page's own command toolbar from the registry. A capability package
 * declares a text command with no placement, so the host never shows it; this
 * surface is the one that composes it (PLUGINS.md section 5.2). A failure just
 * leaves the toolbar hidden — the editor keeps its built-in features.
 */
async function loadCommands(): Promise<void> {
  try {
    commands = await bridge.list(["text"]);
  } catch {
    commands = [];
  }
  commandBar.replaceChildren();
  commandButtons.length = 0;
  for (const command of commands) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = command.title;
    button.title = command.description ?? command.title;
    button.addEventListener("click", () => void invokeCommand(command));
    commandBar.append(button);
    commandButtons.push(button);
  }
  commandBar.hidden = commands.length === 0;
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
  renderHighlight();
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
void loadCommands();
