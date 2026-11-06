/**
 * 代码编辑工作台：把宿主交付的这条文本放进一个带行号与语法高亮的编辑面，
 * 另存为新条目或复制到剪贴板。文档不联网、不读取其它条目，也不调用宿主的
 * 高亮或格式化扩展；高亮由本包自带的 tokenizer 完成（D-1040）。
 *
 * D-1065：文档声明 `buffer` 特性，宿主因此在窗口顶部画出编辑器命令栏。
 * 文档只交出当前缓冲区与修订号，并接受宿主发来的整段替换；命令由宿主选择、
 * 由宿主执行，文档仍然没有调用格式化或高亮的入口。
 */

import { connectWorkbench, replaceRefusal, type BridgeResult } from "./bridge";
import {
  LANGUAGE_CHOICES,
  detectLanguage,
  languageLabel,
} from "./languages";
import { tokenizeCode, type CodeLanguage } from "./tokenize";

/** Above this many characters the document shows plain text, not tokens. */
const HIGHLIGHT_LIMIT = 200_000;
const INDENT = "  ";
const SAVE_TITLE_LIMIT = 120;

const bridge = connectWorkbench();

function one<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`工作台文档缺少 ${selector}`);
  return element;
}

const titleInput = one<HTMLInputElement>("#doc-title");
const languageSelect = one<HTMLSelectElement>("#doc-language");
const caret = one<HTMLElement>("#doc-caret");
const dirtyMark = one<HTMLElement>("#doc-dirty");
const gutter = one<HTMLElement>("#editor-gutter");
const highlight = one<HTMLElement>("#editor-highlight");
const input = one<HTMLTextAreaElement>("#editor-input");
const saveButton = one<HTMLButtonElement>("[data-action=save]");
const copyButton = one<HTMLButtonElement>("[data-action=copy]");
const status = one<HTMLElement>("#doc-status");

let originalText = "";
let choice: CodeLanguage | "auto" | "text" = "auto";
let busy = false;
/**
 * The document's own edit counter (D-1065). The host reads a buffer at one
 * revision and sends its replacement tagged with it; this document applies the
 * replacement only if no edit happened in between.
 */
let revision = 0;

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

function setActions(enabled: boolean): void {
  saveButton.disabled = !enabled;
  copyButton.disabled = !enabled;
}

async function run(action: () => Promise<void>): Promise<void> {
  if (busy) return;
  busy = true;
  setActions(false);
  try {
    await action();
  } finally {
    busy = false;
    setActions(true);
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
  revision += 1;
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
    // setRangeText fires no input event, so the edit is counted here.
    revision += 1;
    render();
    return;
  }
  if (event.key === "s" && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    void save();
    return;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    bridge.close();
  }
});

saveButton.addEventListener("click", () => void save());
copyButton.addEventListener("click", () => void copy());

bridge.onItem((item) => {
  originalText = item.text;
  input.value = item.text;
  titleInput.value = item.title.slice(0, SAVE_TITLE_LIMIT);
  choice = "auto";
  revision = 0;
  render();
  input.focus();
  input.setSelectionRange(0, 0);
  renderCaret();
});

// The host's editor toolbar (D-1065) reads this buffer and may replace it.
// Neither handler gives the document a way to run a command: the host names
// the command, runs it and sends back the result.
bridge.onBufferRequest(() => ({ text: input.value, revision }));

/**
 * Applies the host's replacement as one edit. `insertText` participates in the
 * native undo stack, so a format is a single Cmd+Z away; `setRangeText` is the
 * fallback for a browser that refuses the command. The selection is restored
 * to where the reader left it, clamped to the new length, so a format does not
 * also move the caret to the end.
 */
function applyReplace(text: string, expectedRevision: number): BridgeResult {
  const refusal = replaceRefusal(revision, expectedRevision);
  if (refusal !== "") return { ok: false, message: refusal };
  const caret = input.selectionStart;
  input.focus();
  input.setSelectionRange(0, input.value.length);
  const before = revision;
  const inserted = document.execCommand("insertText", false, text);
  if (!inserted) {
    input.setRangeText(text, 0, input.value.length, "end");
  }
  // insertText fires an input event, which already counted the edit;
  // setRangeText does not, so the fallback path counts it here.
  if (revision === before) revision += 1;
  const at = Math.min(caret, text.length);
  input.setSelectionRange(at, at);
  render();
  return { ok: true };
}

bridge.onReplace(applyReplace);
