/**
 * The SQL workspace page.
 *
 * The host opens this surface for a text entity and delivers its text. From
 * then on the page owns everything: it scans the buffer once, paints the
 * syntax colours, derives bracket and clause findings from the same token
 * stream, and lays the tokens out again when the toolbar asks it to. Nothing
 * is executed, no process runs and no request leaves the frame. Copying is a
 * host action; the page posts `copy` and never touches the clipboard itself.
 *
 * Every value reaches the DOM through `textContent` or `textarea.value`, never
 * HTML, so SQL that contains markup stays text.
 */

import { analyzeSql, firstError, type Analysis } from "./analyze";
import { connectSurface } from "./bridge";
import { compressSql } from "./compress";
import { DIALECTS, dialectById } from "./dialect";
import { formatSql, parseFormatOptions } from "./format";
import { positionOf, type SqlToken } from "./tokenize";

function one<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (element === null) throw new Error(`缺少元素 ${selector}`);
  return element;
}

const docTitle = one<HTMLHeadingElement>("#doc-title");
const dialectSelect = one<HTMLSelectElement>("#dialect");
const keywordCase = one<HTMLSelectElement>("#keyword-case");
const indent = one<HTMLSelectElement>("#indent");
const counts = one<HTMLSpanElement>("#counts");
const gutter = one<HTMLDivElement>("#gutter");
const gutterInner = one<HTMLDivElement>("#gutter-inner");
const highlight = one<HTMLPreElement>("#highlight");
const editor = one<HTMLTextAreaElement>("#editor");
const status = one<HTMLSpanElement>("#status");
const finding = one<HTMLSpanElement>("#finding");
const position = one<HTMLSpanElement>("#position");
const formatButton = one<HTMLButtonElement>("#format");
const compressButton = one<HTMLButtonElement>("#compress");
const copyButton = one<HTMLButtonElement>("#copy");
const closeButton = one<HTMLButtonElement>("#close");

const bridge = connectSurface();

for (const dialect of DIALECTS) {
  const option = document.createElement("option");
  option.value = dialect.id;
  option.textContent = dialect.label;
  dialectSelect.append(option);
}

/** The one text the page is showing, and what the last transformation replaced. */
let current: Analysis = { tokens: [], diagnostics: [] };
let previousText: string | null = null;
let scheduled = 0;
let renderedLines = 0;

const raf: (callback: FrameRequestCallback) => number =
  typeof requestAnimationFrame === "function"
    ? (callback) => requestAnimationFrame(callback)
    : (callback) => window.setTimeout(() => callback(0), 16);

function currentDialect() {
  return dialectById(dialectSelect.value);
}

function setStatus(message: string, tone: "ok" | "bad" | "" = ""): void {
  status.textContent = message;
  status.className = tone === "" ? "status" : `status ${tone}`;
}

function caretPosition(): void {
  const at = positionOf(editor.value, editor.selectionStart);
  position.textContent = `${at.line}:${at.column}`;
}

function errorLines(analysis: Analysis): Set<number> {
  return new Set(
    analysis.diagnostics
      .filter((entry) => entry.severity === "error")
      .map((entry) => entry.line),
  );
}

function tokenClass(token: SqlToken): string {
  if (token.error) return "tok-error";
  if (token.kind === "") return "";
  return `tok-${token.kind}`;
}

/** Paints the token stream under the textarea, merging adjacent same-colour runs. */
function renderHighlight(text: string): void {
  if (text.length > 400_000) {
    highlight.textContent = `${text}\n`;
    return;
  }
  const fragment = document.createDocumentFragment();
  let pending = "";
  let pendingClass = "";
  const flush = (): void => {
    if (pending === "") return;
    if (pendingClass === "") {
      fragment.append(document.createTextNode(pending));
    } else {
      const span = document.createElement("span");
      span.className = pendingClass;
      span.textContent = pending;
      fragment.append(span);
    }
    pending = "";
  };
  for (const token of current.tokens) {
    const className = tokenClass(token);
    if (className !== pendingClass) {
      flush();
      pendingClass = className;
    }
    pending += token.text;
  }
  flush();
  fragment.append(document.createTextNode("\n"));
  highlight.replaceChildren(fragment);
}

function renderGutter(text: string): void {
  const lineCount = text.split("\n").length;
  const marks = errorLines(current);
  if (lineCount !== renderedLines) {
    const fragment = document.createDocumentFragment();
    for (let line = 1; line <= lineCount; line += 1) {
      const row = document.createElement("div");
      row.className = marks.has(line) ? "gutter-line error" : "gutter-line";
      row.textContent = String(line);
      fragment.append(row);
    }
    gutterInner.replaceChildren(fragment);
    renderedLines = lineCount;
  } else {
    const rows = gutterInner.children;
    for (let line = 1; line <= lineCount; line += 1) {
      const row = rows.item(line - 1);
      if (row === null) continue;
      row.className = marks.has(line) ? "gutter-line error" : "gutter-line";
    }
  }
  counts.textContent = `${lineCount} 行 · ${[...text].length} 字符`;
}

function renderFinding(): void {
  const first = current.diagnostics[0];
  if (first === undefined) {
    finding.textContent = editor.value.trim() === "" ? "等待 SQL" : "没有语法问题";
    finding.className = "finding clean";
    return;
  }
  const extra = current.diagnostics.length > 1 ? ` · 另有 ${current.diagnostics.length - 1} 个` : "";
  finding.textContent = `第 ${first.line} 行第 ${first.column} 列 · ${first.message}${extra}`;
  finding.className = "finding";
}

function syncScroll(): void {
  highlight.scrollTop = editor.scrollTop;
  highlight.scrollLeft = editor.scrollLeft;
  gutter.scrollTop = editor.scrollTop;
}

function render(): void {
  scheduled = 0;
  current = analyzeSql(editor.value, currentDialect());
  renderHighlight(editor.value);
  renderGutter(editor.value);
  renderFinding();
  caretPosition();
  syncScroll();
  const empty = editor.value.trim() === "";
  formatButton.disabled = empty;
  compressButton.disabled = empty;
  copyButton.disabled = empty;
}

function scheduleRender(): void {
  if (scheduled !== 0) return;
  scheduled = raf(() => render());
}

function replaceText(next: string, message: string): void {
  const caret = Math.min(editor.selectionStart, next.length);
  previousText = editor.value;
  editor.value = next;
  editor.setSelectionRange(caret, caret);
  render();
  setStatus(message, "ok");
}

function refuse(entry: NonNullable<ReturnType<typeof firstError>>): void {
  setStatus(`第 ${entry.line} 行第 ${entry.column} 列：${entry.message}`, "bad");
  const offset = offsetOf(entry.line, entry.column);
  const end = advance(offset, entry.length);
  editor.focus();
  editor.setSelectionRange(offset, end);
  caretPosition();
}

/** The UTF-16 offset reached by advancing `count` runes from `offset`. */
function advance(offset: number, count: number): number {
  let index = offset;
  let remaining = count;
  while (index < editor.value.length && remaining > 0) {
    const code = editor.value.codePointAt(index);
    if (code === undefined) break;
    index += code > 0xffff ? 2 : 1;
    remaining -= 1;
  }
  return Math.min(editor.value.length, index);
}

/** The UTF-16 offset of a 1-based rune line and column. */
function offsetOf(line: number, column: number): number {
  let currentLine = 1;
  let index = 0;
  while (index < editor.value.length && currentLine < line) {
    if (editor.value.charAt(index) === "\n") currentLine += 1;
    index += 1;
  }
  let remaining = Math.max(0, column - 1);
  while (index < editor.value.length && remaining > 0) {
    const code = editor.value.codePointAt(index);
    if (code === undefined) break;
    index += code > 0xffff ? 2 : 1;
    remaining -= 1;
  }
  return index;
}

function runFormat(): void {
  if (editor.value.trim() === "") return;
  const analysis = analyzeSql(editor.value, currentDialect());
  const error = firstError(analysis.diagnostics);
  if (error !== null) {
    refuse(error);
    return;
  }
  const next = formatSql(
    analysis,
    parseFormatOptions(keywordCase.value, indent.value),
  );
  if (next === editor.value) {
    setStatus("已经是格式化后的样子");
    return;
  }
  replaceText(next, "已格式化");
}

function runCompress(): void {
  if (editor.value.trim() === "") return;
  const analysis = analyzeSql(editor.value, currentDialect());
  const error = firstError(analysis.diagnostics);
  if (error !== null) {
    refuse(error);
    return;
  }
  const result = compressSql(analysis);
  if (!result.ok) {
    setStatus(result.message, "bad");
    return;
  }
  if (result.text === editor.value) {
    setStatus("已经是压缩后的样子");
    return;
  }
  replaceText(result.text, "已压缩为一行");
}

async function runCopy(): Promise<void> {
  const text = editor.value;
  if (text.trim() === "") {
    setStatus("没有可复制的内容", "bad");
    return;
  }
  const result = await bridge.copy(text);
  if (result.ok) setStatus("已复制到剪贴板", "ok");
  else setStatus(result.message ?? "复制失败", "bad");
}

formatButton.addEventListener("click", runFormat);
compressButton.addEventListener("click", runCompress);
copyButton.addEventListener("click", () => {
  void runCopy();
});
closeButton.addEventListener("click", () => bridge.close());

dialectSelect.addEventListener("change", () => {
  setStatus("");
  render();
});
keywordCase.addEventListener("change", () => setStatus(""));
indent.addEventListener("change", () => setStatus(""));

editor.addEventListener("input", () => {
  previousText = null;
  setStatus("");
  scheduleRender();
});
editor.addEventListener("scroll", syncScroll);
editor.addEventListener("keyup", caretPosition);
editor.addEventListener("click", caretPosition);
editor.addEventListener("select", caretPosition);

editor.addEventListener("keydown", (event) => {
  const command = event.metaKey || event.ctrlKey;
  if (command && !event.shiftKey && event.key.toLowerCase() === "z" && previousText !== null) {
    event.preventDefault();
    const restored = previousText;
    previousText = null;
    editor.value = restored;
    editor.setSelectionRange(restored.length, restored.length);
    render();
    setStatus("已还原上一次排版", "ok");
    return;
  }
  if (command && event.shiftKey && event.key.toLowerCase() === "f") {
    event.preventDefault();
    runFormat();
  }
});

bridge.onItem(({ item }) => {
  docTitle.textContent = item.title.trim() === "" ? "未命名 SQL" : item.title;
  document.title = `${item.title.trim() === "" ? "SQL" : item.title} · SQL`;
  editor.value = item.text;
  previousText = null;
  renderedLines = 0;
  render();
  if (item.text.trim() === "") setStatus("这条条目是空的", "");
  else editor.focus();
});

setStatus("就绪");
render();
