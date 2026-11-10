/**
 * The JSON page.
 *
 * Prettier is bundled into this document, so the page formats, minifies and
 * converts without a runtime, Node or the network. The editor is the user's:
 * text arrives formatted, stays editable, and every action either rewrites it
 * (beautify, minify) or writes a derived document to the result panel (escape,
 * XML, TypeScript, filter). Copying is a host action: the page posts `copy` and
 * never touches the clipboard itself. Every value reaches the DOM through
 * `textContent` or `textarea.value`, never HTML.
 */

import { connectSurface } from "./bridge";
import { convertPaste, type PasteKind } from "./convert";
import { evaluateExpression } from "./evaluate";
import { describeJsonError, formatJson } from "./format";
import { parseJson, type JsonValue } from "./json";
import { jsonToTypeScript } from "./typescript";
import { jsonToXml } from "./xml";

function one<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (element === null) throw new Error(`缺少元素 ${selector}`);
  return element;
}

const summary = one<HTMLParagraphElement>("#summary");
const status = one<HTMLParagraphElement>("#status");
const editor = one<HTMLTextAreaElement>("#editor");
const meta = one<HTMLParagraphElement>("#meta");
const copyJson = one<HTMLButtonElement>("#copy-json");
const closeDoc = one<HTMLButtonElement>("#doc-close");
const formatRoot = one<HTMLElement>("#doc-format-root");
const formatToggle = one<HTMLButtonElement>("#doc-format-toggle");
const formatMenu = one<HTMLElement>("#doc-format-menu");
const editorGutter = one<HTMLElement>("#editor-gutter");
const formatButton = one<HTMLButtonElement>("#format");
const minifyButton = one<HTMLButtonElement>("#minify");
const escapeButton = one<HTMLButtonElement>("#escape");
const xmlButton = one<HTMLButtonElement>("#to-xml");
const tsButton = one<HTMLButtonElement>("#to-ts");
const output = one<HTMLElement>("#output");
const outputTitle = one<HTMLElement>("#output-title");
const outputMeta = one<HTMLParagraphElement>("#output-meta");
const outputText = one<HTMLElement>("#output-text");
const copyOutput = one<HTMLButtonElement>("#copy-output");
const filter = one<HTMLInputElement>("#filter");
const filterRun = one<HTMLButtonElement>("#filter-run");

const bridge = connectSurface();

/** The text the result panel currently owns. */
let derived = "";
/** The newest delivery or paste wins; an older async job may finish later. */
let generation = 0;

/**
 * The format dropdown: the five actions live behind one trigger, the way the
 * code editor groups its actions. The header is never clipped, so the sheet
 * is positioned by the stylesheet and opening it only toggles visibility.
 */
function setMenuOpen(open: boolean): void {
  formatMenu.hidden = !open;
  formatToggle.setAttribute("aria-expanded", String(open));
}
setMenuOpen(false);
formatToggle.addEventListener("click", (event) => {
  event.stopPropagation?.();
  setMenuOpen(formatMenu.hidden);
});
formatMenu.addEventListener("keydown", (event) => {
  if ((event as KeyboardEvent).key === "Escape") {
    setMenuOpen(false);
    formatToggle.focus?.();
  }
});
window.addEventListener("click", (event) => {
  const target = event.target;
  if (target instanceof Node && !formatRoot.contains(target)) setMenuOpen(false);
});
// The host never sees a key pressed inside this frame, so Esc is the page's
// own: with the format menu open it only closes the menu, otherwise it closes
// the surface through the bridge (D-1097).
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  event.preventDefault();
  if (!formatMenu.hidden) {
    setMenuOpen(false);
    formatToggle.focus?.();
    return;
  }
  bridge.close();
});

/** Line numbers beside the textarea, kept in step with its scroll. */
function renderGutter(): void {
  const lines = editor.value.split("\n").length;
  const numbers: string[] = [];
  for (let line = 1; line <= lines; line += 1) numbers.push(String(line));
  editorGutter.textContent = numbers.join("\n");
}

editor.addEventListener("scroll", () => {
  editorGutter.scrollTop = editor.scrollTop;
});

function setStatus(text: string): void {
  status.textContent = text;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} 字节`;
  const kilobytes = bytes / 1024;
  return `${kilobytes < 10 ? kilobytes.toFixed(1) : Math.round(kilobytes)} KB`;
}

function lineCount(text: string): number {
  const body = text.endsWith("\n") ? text.slice(0, -1) : text;
  return body === "" ? 0 : body.split("\n").length;
}

function describe(text: string): string {
  return `${lineCount(text)} 行 · ${formatBytes(new TextEncoder().encode(text).length)}`;
}

function updateMeta(): void {
  meta.textContent = describe(editor.value);
}

function setEditor(text: string): void {
  editor.value = text;
  updateMeta();
  renderGutter();
}

function hideOutput(): void {
  derived = "";
  output.hidden = true;
  outputTitle.textContent = "";
  outputMeta.textContent = "";
  outputText.textContent = "";
}

function showOutput(title: string, text: string): void {
  derived = text;
  outputTitle.textContent = title;
  outputMeta.textContent = describe(text);
  outputText.textContent = text;
  output.hidden = false;
}

function clearWhenEmpty(): void {
  copyJson.disabled = editor.value === "";
}

async function load(text: string, title: string): Promise<void> {
  const current = ++generation;
  summary.textContent = title || "当前条目";
  hideOutput();
  setEditor(text);
  clearWhenEmpty();

  if (text.trim() === "") {
    // An entry of only whitespace has nothing to edit or copy.
    setEditor("");
    clearWhenEmpty();
    setStatus("条目为空，可以粘贴或输入 JSON。");
    return;
  }

  setStatus("正在用页面内的 Prettier 排版…");
  try {
    const formatted = await formatJson(text);
    if (current !== generation) return;
    setEditor(formatted);
    setStatus("");
  } catch (error) {
    if (current !== generation) return;
    setStatus(`无法排版：${describeJsonError(error, text)}（原文保留，可直接编辑）`);
  }
  clearWhenEmpty();
}

async function applyFormat(): Promise<void> {
  hideOutput();
  const source = editor.value;
  if (source.trim() === "") {
    setStatus("没有可排版的内容。");
    return;
  }
  setStatus("正在排版…");
  try {
    const formatted = await formatJson(source);
    setEditor(formatted);
    setStatus("已按 Prettier 排版。");
  } catch (error) {
    setStatus(`无法排版：${describeJsonError(error, source)}`);
  }
  clearWhenEmpty();
}

function currentJson(): { value: JsonValue } | null {
  try {
    return { value: parseJson(editor.value) };
  } catch (error) {
    setStatus(`当前 JSON 无法解析：${describeJsonError(error, editor.value)}`);
    return null;
  }
}

function applyMinify(): void {
  hideOutput();
  const current = currentJson();
  if (current === null) return;
  setEditor(JSON.stringify(current.value));
  setStatus("已压缩为单行 JSON。");
  clearWhenEmpty();
}

function applyEscape(): void {
  const escaped = JSON.stringify(editor.value);
  showOutput("转义结果", escaped);
  setStatus("已把整段 JSON 转义为字符串字面量；原 JSON 未改动。");
}

function applyXml(): void {
  const current = currentJson();
  if (current === null) return;
  try {
    showOutput("XML", jsonToXml(current.value));
    setStatus("已转换为 XML；原 JSON 未改动。");
  } catch (error) {
    setStatus(`无法转换为 XML：${error instanceof Error ? error.message : "未知错误"}`);
  }
}

function applyTypeScript(): void {
  const current = currentJson();
  if (current === null) return;
  showOutput("TypeScript", jsonToTypeScript(current.value));
  setStatus("已生成 TypeScript interface；原 JSON 未改动。");
}

function resultText(value: unknown): string {
  if (typeof value === "string") return value;
  const text = JSON.stringify(value, null, 2);
  return text === undefined ? String(value) : text;
}

function applyFilter(): void {
  const current = currentJson();
  if (current === null) return;
  try {
    const evaluation = evaluateExpression(filter.value, current.value);
    if (evaluation.value === undefined) {
      setStatus("表达式没有返回值。");
      return;
    }
    showOutput("过滤结果", resultText(evaluation.value));
    setStatus("已对当前 JSON 求值；原数据未改动。");
  } catch (error) {
    setStatus(`过滤失败：${error instanceof Error ? error.message : "未知错误"}`);
  }
}

const KIND_LABEL: Record<PasteKind, string> = {
  json: "JSON",
  "url-params": "URL 参数",
  xml: "XML",
  yaml: "YAML",
};

function replaceDocument(text: string): void {
  setEditor(text);
  editor.selectionStart = text.length;
  editor.selectionEnd = text.length;
}

function insertAtCursor(text: string): void {
  const start = editor.selectionStart;
  const end = editor.selectionEnd;
  const next = editor.value.slice(0, start) + text + editor.value.slice(end);
  setEditor(next);
  const caret = start + text.length;
  editor.selectionStart = caret;
  editor.selectionEnd = caret;
}

async function handlePaste(text: string): Promise<void> {
  const current = ++generation;
  setStatus("正在识别粘贴内容…");
  const attempt = await convertPaste(text);
  if (current !== generation) return;

  if (attempt.status === "unrecognized") {
    insertAtCursor(text);
    setStatus("粘贴的内容不是可识别的 JSON、URL 参数、XML 或 YAML，已原样插入。");
    clearWhenEmpty();
    return;
  }
  if (attempt.status === "failed") {
    insertAtCursor(text);
    setStatus(
      `识别为 ${KIND_LABEL[attempt.kind]}，但转换失败：${attempt.message}；已原样插入。`,
    );
    clearWhenEmpty();
    return;
  }
  hideOutput();
  replaceDocument(attempt.text);
  setStatus(`已把粘贴的 ${KIND_LABEL[attempt.kind]} 转为 JSON 并排版。`);
  clearWhenEmpty();
}

editor.addEventListener("paste", (event) => {
  const text = event.clipboardData?.getData("text/plain") ?? "";
  if (text === "") return;
  event.preventDefault();
  void handlePaste(text);
});

editor.addEventListener("input", () => {
  updateMeta();
  renderGutter();
  hideOutput();
  clearWhenEmpty();
});

async function copy(text: string, what: string): Promise<void> {
  if (text === "") return;
  const answer = await bridge.copy(text);
  setStatus(answer.ok ? `已复制${what}。` : `复制失败：${answer.message ?? "宿主没有响应"}`);
}

copyJson.addEventListener("click", () => {
  void copy(editor.value, " JSON");
});
copyOutput.addEventListener("click", () => {
  void copy(derived, outputTitle.textContent === "" ? "结果" : ` ${outputTitle.textContent}`);
});
closeDoc.addEventListener("click", () => {
  bridge.close();
});
formatButton.addEventListener("click", () => {
  setMenuOpen(false);
  void applyFormat();
});
minifyButton.addEventListener("click", () => {
  setMenuOpen(false);
  applyMinify();
});
escapeButton.addEventListener("click", () => {
  setMenuOpen(false);
  applyEscape();
});
xmlButton.addEventListener("click", () => {
  setMenuOpen(false);
  applyXml();
});
tsButton.addEventListener("click", () => {
  setMenuOpen(false);
  applyTypeScript();
});
filterRun.addEventListener("click", applyFilter);
filter.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    applyFilter();
  }
});

hideOutput();
updateMeta();
renderGutter();
clearWhenEmpty();

bridge.onItem(({ item }) => {
  void load(item.text, item.title);
});
