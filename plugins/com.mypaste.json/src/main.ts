/**
 * The JSON page.
 *
 * Prettier is bundled into this document, so the page formats, minifies and
 * converts without a runtime, Node or the network. Both panes are the same
 * editable, syntax-coloured surface: the left holds the entry and the right
 * holds whatever the actions produced (beautify on open, minify, fold, XML,
 * TypeScript, filter, paste conversion), and the escape toggle re-derives the
 * result. Editing either pane re-colours only that pane. Copying is a host
 * action: the page posts `copy` and never touches the clipboard itself. Every
 * value reaches the DOM through `textContent` or `textarea.value`, never HTML.
 */

import { connectSurface } from "./bridge";
import { convertPaste, type PasteKind } from "./convert";
import { decodeEscapes, escapeNonAscii } from "./escape";
import { evaluateExpression } from "./evaluate";
import { foldJson, type FoldedDocument } from "./fold";
import { describeJsonError, formatJson } from "./format";
import { highlightInto, type Language } from "./highlight";
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
const editorGutter = one<HTMLElement>("#editor-gutter");
const editorHighlight = one<HTMLElement>("#editor-highlight");
const preserveToggle = one<HTMLButtonElement>("#preserve-escapes");
const formatButton = one<HTMLButtonElement>("#format");
const minifyButton = one<HTMLButtonElement>("#minify");
const foldButton = one<HTMLButtonElement>("#fold");
const xmlButton = one<HTMLButtonElement>("#to-xml");
const tsButton = one<HTMLButtonElement>("#to-ts");
const output = one<HTMLElement>("#output");
const outputTitle = one<HTMLElement>("#output-title");
const outputMeta = one<HTMLParagraphElement>("#output-meta");
const outputText = one<HTMLElement>("#output-text");
const outputGutter = one<HTMLElement>("#output-gutter");
const outputInput = one<HTMLTextAreaElement>("#output-input");
const copyOutput = one<HTMLButtonElement>("#copy-output");
const filter = one<HTMLInputElement>("#filter");
const filterRun = one<HTMLButtonElement>("#filter-run");

const bridge = connectSurface();

/** The text the result panel currently owns. */
let derived = "";
/** The folded view of `derived`, or `null` when it has nothing to fold. */
let foldable: FoldedDocument | null = null;
/** Whether the result pane is showing the folded view. */
let folded = false;
/** The newest delivery or paste wins; an older async job may finish later. */
let generation = 0;
/** Whether the document keeps the wire spelling of escapes (see `escape.ts`). */
let preserveEscapes = false;
/** The action behind the result panel, so the toggle can re-derive it. */
let view: (() => Promise<void> | void) | null = null;

/**
 * Every writer passes through here, so the result's spelling never depends on
 * which button produced it: the source is decoded first (Chinese reads as
 * characters, a path as a path), then, when the toggle is on, everything
 * outside ASCII is written back in escaped form. Prettier itself keeps
 * whatever escapes the source spelled, which is why the decode has to happen
 * around it rather than inside it.
 */
async function formatDocument(text: string): Promise<string> {
  const formatted = await formatJson(decodeEscapes(text));
  return preserveEscapes ? escapeNonAscii(formatted) : formatted;
}

function setPreserveEscapes(next: boolean): void {
  preserveEscapes = next;
  preserveToggle.setAttribute("aria-pressed", String(next));
}
setPreserveEscapes(false);

// The toggle is a spelling choice for the right-hand result, never a rewrite of
// the original: flipping it re-derives whatever the result panel is showing.
preserveToggle.addEventListener("click", () => {
  const next = !preserveEscapes;
  setPreserveEscapes(next);
  if (view !== null) {
    void view();
    return;
  }
  setStatus(next
    ? "已保留转义：右侧结果将使用 \\uXXXX 写法。"
    : "已还原转义：右侧结果将还原中文与斜杠。");
});

// The host never sees a key pressed inside this frame, so Esc is the page's
// own: it closes the surface through the bridge (D-1097).
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  event.preventDefault();
  bridge.close();
});

interface CodePane {
  readonly input: HTMLTextAreaElement;
  /** The grammar the copy is coloured with. */
  language: Language;
  /** Repaints the line numbers and the coloured copy from the pane's text. */
  render(): void;
  /** Replaces the pane's text and repaints it. */
  set(text: string, language?: Language): void;
}

/**
 * One pane is a textarea laid over its own coloured copy: the copy draws the
 * document and the textarea owns the caret, the selection and the scroll, so
 * reading and editing share one set of coordinates. The gutter follows the
 * textarea's vertical scroll, and an IME composition shows the textarea's own
 * ink for as long as the candidate window is open (see the stylesheet).
 */
function codePane(
  input: HTMLTextAreaElement,
  highlight: HTMLElement,
  gutter: HTMLElement,
  initial: Language,
): CodePane {
  const pane: CodePane = {
    input,
    language: initial,
    render(): void {
      highlightInto(highlight, input.value, pane.language);
      const lines = input.value.split("\n").length;
      const numbers: string[] = [];
      for (let line = 1; line <= lines; line += 1) numbers.push(String(line));
      gutter.textContent = numbers.join("\n");
      gutter.scrollTop = input.scrollTop;
    },
    set(text: string, language?: Language): void {
      if (language !== undefined) pane.language = language;
      input.value = text;
      pane.render();
    },
  };
  input.addEventListener("scroll", () => {
    highlight.scrollTop = input.scrollTop;
    highlight.scrollLeft = input.scrollLeft;
    gutter.scrollTop = input.scrollTop;
  });
  input.addEventListener("compositionstart", () => {
    input.classList.add("composing");
  });
  input.addEventListener("compositionend", () => {
    input.classList.remove("composing");
    pane.render();
  });
  return pane;
}

const sourcePane = codePane(editor, editorHighlight, editorGutter, "json");
const resultPane = codePane(outputInput, outputText, outputGutter, "json");

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
  sourcePane.render();
}

function hideOutput(): void {
  derived = "";
  foldable = null;
  folded = false;
  updateFoldControl();
  output.dataset.state = "empty";
  outputTitle.textContent = "结果";
  outputMeta.textContent = "";
  resultPane.set("");
  copyOutput.disabled = true;
}

/** Keeps the fold control honest about the result it would act on. */
function updateFoldControl(): void {
  foldButton.disabled = foldable === null;
  foldButton.setAttribute("aria-pressed", String(folded));
  const label = folded ? "展开全部" : "折叠全部";
  foldButton.title = label;
  foldButton.setAttribute("aria-label", label);
}

function showOutput(title: string, text: string, language: Language = "json"): void {
  derived = text;
  foldable = foldJson(text);
  folded = false;
  updateFoldControl();
  output.dataset.state = "filled";
  outputTitle.textContent = title;
  outputMeta.textContent = describe(text);
  resultPane.set(text, language);
  copyOutput.disabled = text === "";
}

function clearWhenEmpty(): void {
  copyJson.disabled = editor.value === "";
}

// The left pane is editable like the right one, but typing there only
// re-colours that pane: the result keeps what the last action wrote until an
// action is asked for again.
editor.addEventListener("input", () => {
  sourcePane.render();
  updateMeta();
  clearWhenEmpty();
});

// A hand-edited result becomes the document of record: folding reads the
// edited text, and the escape toggle stops re-deriving, because re-deriving
// would discard the edit.
outputInput.addEventListener("input", () => {
  derived = outputInput.value;
  view = null;
  folded = false;
  foldable = foldJson(derived);
  updateFoldControl();
  resultPane.render();
  output.dataset.state = derived === "" ? "empty" : "filled";
  outputTitle.textContent = derived === "" ? "结果" : outputTitle.textContent;
  outputMeta.textContent = derived === "" ? "" : describe(derived);
  copyOutput.disabled = derived === "";
});

async function load(text: string, title: string): Promise<void> {
  const current = ++generation;
  view = applyFormat;
  summary.textContent = title || "当前条目";
  hideOutput();
  setEditor(text);
  clearWhenEmpty();

  if (text.trim() === "") {
    // An entry of only whitespace has nothing to show or copy.
    setEditor("");
    clearWhenEmpty();
    setStatus("条目为空；粘贴内容会转换后写在右侧。");
    return;
  }

  try {
    const formatted = await formatDocument(text);
    if (current !== generation) return;
    // The left pane is the entry as it arrived. The beautified document is a
    // result, so it lands on the right like every other conversion.
    showOutput("美化", formatted);
  } catch (error) {
    if (current !== generation) return;
    setStatus(`无法排版：${describeJsonError(error, text)}`);
  }
  clearWhenEmpty();
}

async function applyFormat(): Promise<void> {
  view = applyFormat;
  const source = editor.value;
  if (source.trim() === "") {
    hideOutput();
    setStatus("没有可排版的内容。");
    return;
  }
  hideOutput();
  setStatus("正在排版…");
  try {
    const formatted = await formatDocument(source);
    showOutput("美化", formatted);
    setStatus("已在右侧重新排版。");
  } catch (error) {
    setStatus(`无法排版：${describeJsonError(error, source)}`);
  }
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
  view = applyMinify;
  hideOutput();
  const current = currentJson();
  if (current === null) return;
  const text = JSON.stringify(current.value);
  showOutput("压缩", preserveEscapes ? escapeNonAscii(text) : text);
  setStatus("已压缩为单行，写在右侧。");
}

function applyFold(): void {
  if (foldable === null) return;
  folded = !folded;
  resultPane.set(folded ? foldable.text : derived);
  updateFoldControl();
  setStatus(folded
    ? `已折叠 ${foldable.count} 处嵌套结构；复制仍是完整 JSON。`
    : "已展开全部结构。");
}

function applyXml(): void {
  view = applyXml;
  const current = currentJson();
  if (current === null) return;
  try {
    showOutput("XML", jsonToXml(current.value), "xml");
    setStatus("已转换为 XML，写在右侧。");
  } catch (error) {
    setStatus(`无法转换为 XML：${error instanceof Error ? error.message : "未知错误"}`);
  }
}

function applyTypeScript(): void {
  view = applyTypeScript;
  const current = currentJson();
  if (current === null) return;
  showOutput("TypeScript", jsonToTypeScript(current.value), "typescript");
  setStatus("已生成 TypeScript interface，写在右侧。");
}

function resultText(value: unknown): string {
  if (typeof value === "string") return value;
  const text = JSON.stringify(value, null, 2);
  return text === undefined ? String(value) : text;
}

function applyFilter(): void {
  view = applyFilter;
  const current = currentJson();
  if (current === null) return;
  try {
    const evaluation = evaluateExpression(filter.value, current.value);
    if (evaluation.value === undefined) {
      setStatus("表达式没有返回值。");
      return;
    }
    const text = resultText(evaluation.value);
    showOutput("过滤结果", text, typeof evaluation.value === "string" ? "plain" : "json");
    setStatus("已对当前 JSON 求值，写在右侧。");
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

/** The last pasted text, kept so the toggle can re-shape its result. */
let pasted: { title: string; text: string; language: Language } | null = null;

function shapeResult(text: string): string {
  return preserveEscapes ? escapeNonAscii(text) : decodeEscapes(text);
}

function applyPaste(): void {
  if (pasted === null) return;
  showOutput(pasted.title, shapeResult(pasted.text), pasted.language);
}

// A paste into the entry pane is a conversion of clipboard text, not an edit:
// the converted document lands on the right and the entry keeps what it had.
// Pasting into the result pane is an ordinary edit.
async function handlePaste(text: string): Promise<void> {
  const current = ++generation;
  setStatus("正在识别粘贴内容…");
  const attempt = await convertPaste(text);
  if (current !== generation) return;

  if (attempt.status === "converted") {
    pasted = { title: `粘贴 · ${KIND_LABEL[attempt.kind]}`, text: attempt.text, language: "json" };
    view = applyPaste;
    applyPaste();
    setStatus(`已把粘贴的 ${KIND_LABEL[attempt.kind]} 转为 JSON，写在右侧。`);
    return;
  }

  const reason = attempt.status === "failed"
    ? `识别为 ${KIND_LABEL[attempt.kind]}，但转换失败：${attempt.message}`
    : "不是可识别的 JSON、URL 参数、XML 或 YAML";
  pasted = { title: "粘贴内容", text, language: "plain" };
  view = applyPaste;
  applyPaste();
  setStatus(`${reason}；粘贴内容原样放在右侧。`);
}

editor.addEventListener("paste", (event) => {
  const text = event.clipboardData?.getData("text/plain") ?? "";
  if (text === "") return;
  event.preventDefault();
  void handlePaste(text);
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
  void applyFormat();
});
minifyButton.addEventListener("click", () => {
  applyMinify();
});
foldButton.addEventListener("click", () => {
  applyFold();
});
xmlButton.addEventListener("click", () => {
  applyXml();
});
tsButton.addEventListener("click", () => {
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
sourcePane.render();
clearWhenEmpty();

bridge.onItem(({ item }) => {
  void load(item.text, item.title);
});
