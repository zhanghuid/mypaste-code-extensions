/**
 * The JSON page.
 *
 * Prettier is bundled into this document, so the page formats, minifies and
 * converts without a runtime, Node or the network. Both panes are the same
 * editable, syntax-coloured surface: the left holds the entry and the right
 * holds whatever the document head's actions last produced (beautify on open,
 * minify, fold, XML, TypeScript, filter, paste conversion).
 *
 * The right pane previews the left one: editing the entry re-derives the
 * current action after a short pause, so the result is never stale. Typing in
 * the right pane instead makes it its own document, which the entry then
 * leaves alone until an action is asked for again. Both panes lint what they
 * show: the wrong token is squiggled, its line number is marked, and the
 * message sits on the pane's own bottom edge. Copying is a host action: the
 * page posts `copy` and never touches the clipboard itself. Every value
 * reaches the DOM through `textContent` or `textarea.value`, never HTML.
 */

import { connectSurface } from "./bridge";
import { convertPaste, type PasteKind } from "./convert";
import { decodeEscapes, escapeNonAscii } from "./escape";
import { evaluateExpression } from "./evaluate";
import { foldJson, type FoldedDocument } from "./fold";
import { describeJsonError, formatJson } from "./format";
import { highlightInto, type Language } from "./highlight";
import { lint, positionOf, type Diagnostic } from "./lint";
import { parseJson } from "./json";
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
const editorLint = one<HTMLElement>("#editor-lint");
const preserveToggle = one<HTMLButtonElement>("#preserve-escapes");
const wrapToggle = one<HTMLButtonElement>("#wrap-toggle");
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
const outputLint = one<HTMLElement>("#output-lint");
const copyOutput = one<HTMLButtonElement>("#copy-output");
const filter = one<HTMLInputElement>("#filter");
const filterRun = one<HTMLButtonElement>("#filter-run");

const bridge = connectSurface();

/** How long the entry rests before the result pane catches up. */
const PREVIEW_DELAY_MS = 260;

/** The text the result panel currently owns. */
let derived = "";
/** The folded view of `derived`, or `null` when it has nothing to fold. */
let foldable: FoldedDocument | null = null;
/** Whether the result pane is showing the folded view. */
let folded = false;
/** The newest write wins; an older async job may finish later. */
let writeToken = 0;
/** The pending live-preview timer, if the entry was typed into. */
let previewTimer: ReturnType<typeof setTimeout> | null = null;
/** Whether the document keeps the wire spelling of escapes (see `escape.ts`). */
let preserveEscapes = false;
/** Whether long lines wrap inside the panes; on by default. */
let wrapping = true;
/** The action the result pane follows from the entry; `null` when it is its own. */
let active: ActionName | null = null;
/** The last pasted conversion, kept so the toggle can re-shape its result. */
let pasted: { title: string; text: string; language: Language } | null = null;

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

// The host never sees a key pressed inside this frame, so Esc is the page's
// own: it closes the surface through the bridge (D-1097).
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  event.preventDefault();
  bridge.close();
});

/**
 * How many visual rows each logical line occupies once the pane wraps.
 *
 * The coloured copy is the same text in the same box as the textarea, so its
 * line boxes are the pane's: a Range over one logical line reports a rect per
 * visual row, and rects that share a top belong to spans on the same row. The
 * gutter prints a number on the first row and leaves the rest blank, so the
 * numbers stay beside the lines they name. Without layout (a test stub, a
 * hidden pane) each line counts once.
 */
function wrappedRows(target: HTMLElement, text: string): number[] {
  const lines = text.split("\n");
  const rows = lines.map(() => 1);
  if (typeof document.createRange !== "function" || lines.length > 4000) {
    return rows;
  }
  const nodes: Node[] = [];
  const collect = (node: Node): void => {
    node.childNodes.forEach((child) => {
      if (child.nodeType === 3) nodes.push(child);
      else collect(child);
    });
  };
  collect(target);
  if (nodes.length === 0) return rows;

  const locate = (offset: number): { node: Node; offset: number } | null => {
    let remaining = offset;
    for (const node of nodes) {
      const length = node.textContent?.length ?? 0;
      if (remaining <= length) return { node, offset: remaining };
      remaining -= length;
    }
    return null;
  };

  const range = document.createRange();
  let cursor = 0;
  for (let line = 0; line < lines.length; line += 1) {
    const length = lines[line]!.length;
    const start = locate(cursor);
    const end = locate(cursor + length);
    if (start !== null && end !== null) {
      range.setStart(start.node, start.offset);
      range.setEnd(end.node, end.offset);
      const tops = new Set<number>();
      const rects = range.getClientRects();
      for (let index = 0; index < rects.length; index += 1) {
        const rect = rects.item(index);
        if (rect !== null) tops.add(Math.round(rect.top));
      }
      if (tops.size > 1) rows[line] = tops.size;
    }
    cursor += length + 1; // the newline belongs to no line
  }
  return rows;
}

interface CodePane {
  readonly input: HTMLTextAreaElement;
  /** The grammar the copy is coloured, and linted, with. */
  language: Language;
  /** Whether the text is a document to check, or a rendered view of one. */
  check: boolean;
  /** Repaints the coloured copy, the gutter and the lint strip. */
  render(): void;
  /** Re-ties the copy and the gutter to the textarea's scroll position. */
  sync(): void;
  /** Replaces the pane's text and repaints it. */
  set(text: string, language?: Language, check?: boolean): void;
}

/**
 * One pane is a textarea laid over its own coloured copy: the copy draws the
 * document and the textarea owns the caret, the selection and the scroll, so
 * reading and editing share one set of coordinates. The gutter follows the
 * textarea's vertical scroll, an IME composition shows the textarea's own ink
 * for as long as the candidate window is open, and a lint diagnostic marks the
 * token it names in the copy, the line number in the gutter and the strip
 * under the pane.
 */
function codePane(
  input: HTMLTextAreaElement,
  highlight: HTMLElement,
  gutter: HTMLElement,
  strip: HTMLElement,
  initial: Language,
): CodePane {
  function paintGutter(diagnostic: Diagnostic | null): void {
    const lines = input.value.split("\n").length;
    const occupied = wrapping ? wrappedRows(highlight, input.value) : null;
    const errorLine = diagnostic === null
      ? 0
      : positionOf(input.value, diagnostic.start).line;
    const fragment = document.createDocumentFragment();
    let printed = false;
    for (let line = 1; line <= lines; line += 1) {
      const height = occupied?.[line - 1] ?? 1;
      for (let row = 0; row < height; row += 1) {
        if (printed) fragment.append(document.createTextNode("\n"));
        printed = true;
        // A wrapped line is numbered once; the rows below it stay blank.
        if (row > 0) continue;
        if (line !== errorLine) {
          fragment.append(document.createTextNode(String(line)));
          continue;
        }
        const marked = document.createElement("span");
        marked.className = "gutter-line is-error";
        marked.textContent = String(line);
        fragment.append(marked);
      }
    }
    gutter.replaceChildren(fragment);
    gutter.scrollTop = input.scrollTop;
  }

  function report(diagnostic: Diagnostic | null): void {
    if (diagnostic === null) {
      strip.hidden = true;
      strip.textContent = "";
      strip.removeAttribute("title");
      input.setAttribute("aria-invalid", "false");
      return;
    }
    const { line, column } = positionOf(input.value, diagnostic.start);
    const message = `第 ${line} 行第 ${column} 列 · ${diagnostic.message}`;
    strip.hidden = false;
    strip.textContent = message;
    strip.setAttribute("title", message);
    input.setAttribute("aria-invalid", "true");
  }

  const pane: CodePane = {
    input,
    language: initial,
    check: true,
    render(): void {
      const diagnostic = pane.check ? lint(input.value, pane.language) : null;
      highlightInto(
        highlight,
        input.value,
        pane.language,
        diagnostic === null ? undefined : { start: diagnostic.start, end: diagnostic.end },
      );
      paintGutter(diagnostic);
      report(diagnostic);
    },
    sync(): void {
      highlight.scrollTop = input.scrollTop;
      highlight.scrollLeft = input.scrollLeft;
      gutter.scrollTop = input.scrollTop;
    },
    set(text: string, language?: Language, check = true): void {
      if (language !== undefined) pane.language = language;
      pane.check = check;
      input.value = text;
      // A new document starts at its own beginning; a live write puts the
      // reader's scroll position back afterwards.
      input.scrollTop = 0;
      input.scrollLeft = 0;
      pane.render();
    },
  };
  input.addEventListener("scroll", () => {
    pane.sync();
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

const sourcePane = codePane(editor, editorHighlight, editorGutter, editorLint, "json");
const resultPane = codePane(outputInput, outputText, outputGutter, outputLint, "json");

/**
 * Applies the wrap state to both panes: the textarea's `wrap` attribute, the
 * document root's `data-wrap` (which the stylesheet keys the coloured copy
 * off), and a repaint so the gutter numbers follow the new line heights.
 */
function setWrapping(next: boolean): void {
  wrapping = next;
  wrapToggle.setAttribute("aria-pressed", String(next));
  document.documentElement.dataset.wrap = next ? "on" : "off";
  for (const pane of [sourcePane, resultPane]) {
    pane.input.setAttribute("wrap", next ? "soft" : "off");
    if (next) pane.input.scrollLeft = 0;
    pane.render();
    pane.sync();
  }
}
wrapToggle.addEventListener("click", () => {
  setWrapping(!wrapping);
});
setWrapping(true);

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
  editor.scrollTop = 0;
  editor.scrollLeft = 0;
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

/** The action behind the result pane, so the toggle and the live preview agree. */
type ActionName = "format" | "minify" | "xml" | "typescript" | "filter";

interface Rendered {
  title: string;
  text: string;
  language: Language;
}

const ACTION_TITLE: Record<ActionName, string> = {
  format: "美化",
  minify: "压缩",
  xml: "XML",
  typescript: "TypeScript",
  filter: "过滤结果",
};

const ACTION_STATUS: Record<ActionName, string> = {
  format: "已在右侧重新排版。",
  minify: "已压缩为单行，写在右侧。",
  xml: "已转换为 XML，写在右侧。",
  typescript: "已生成 TypeScript interface，写在右侧。",
  filter: "已对当前 JSON 求值，写在右侧。",
};

/** A failure that is an expected outcome, carried as its own status line. */
class Stop extends Error {
  constructor(readonly status: string) {
    super(status);
  }
}

/** The result the current action produces from the entry, as it stands now. */
async function derive(action: ActionName): Promise<Rendered> {
  switch (action) {
    case "format":
      return {
        title: ACTION_TITLE.format,
        text: await formatDocument(editor.value),
        language: "json",
      };
    case "minify": {
      const text = JSON.stringify(parseJson(editor.value));
      return {
        title: ACTION_TITLE.minify,
        text: preserveEscapes ? escapeNonAscii(text) : text,
        language: "json",
      };
    }
    case "xml":
      return { title: ACTION_TITLE.xml, text: jsonToXml(parseJson(editor.value)), language: "xml" };
    case "typescript":
      return {
        title: ACTION_TITLE.typescript,
        text: jsonToTypeScript(parseJson(editor.value)),
        language: "typescript",
      };
    case "filter": {
      const evaluation = evaluateExpression(filter.value, parseJson(editor.value));
      if (evaluation.value === undefined) throw new Stop("表达式没有返回值。");
      return {
        title: ACTION_TITLE.filter,
        text: resultText(evaluation.value),
        language: typeof evaluation.value === "string" ? "plain" : "json",
      };
    }
  }
}

/**
 * Writes a rendered result into the result pane. A live write keeps the
 * reader's folded view and scroll position: the entry is being edited, not the
 * result, so the pane must not jump under the eye.
 */
function writeResult(rendered: Rendered, live: boolean): void {
  const top = outputInput.scrollTop;
  const left = outputInput.scrollLeft;
  derived = rendered.text;
  foldable = foldJson(rendered.text);
  if (!live || foldable === null) folded = false;
  updateFoldControl();
  output.dataset.state = "filled";
  outputTitle.textContent = rendered.title;
  outputMeta.textContent = describe(rendered.text);
  // A folded pane shows a rendering of the document, not the document, so it
  // is not linted: its `…` placeholders are not JSON the reader typed.
  resultPane.set(folded && foldable !== null ? foldable.text : rendered.text, rendered.language, !folded);
  if (live) {
    outputInput.scrollTop = top;
    outputInput.scrollLeft = left;
    resultPane.sync();
  }
  copyOutput.disabled = rendered.text === "";
}

/** The status line for an action that could not produce a result. */
function failureStatus(action: ActionName, error: unknown): string {
  if (error instanceof Stop) return error.status;
  if (action === "format" || action === "minify") {
    const verb = action === "format" ? "排版" : "压缩";
    const diagnostic = lint(editor.value, "json");
    if (diagnostic !== null) {
      const { line, column } = positionOf(editor.value, diagnostic.start);
      return `无法${verb}：第 ${line} 行第 ${column} 列 · ${diagnostic.message}`;
    }
    return `无法${verb}：${describeJsonError(error, editor.value)}`;
  }
  const detail = error instanceof Error ? error.message : "未知错误";
  if (action === "filter") return `过滤失败：${detail}`;
  return action === "xml" ? `无法转换为 XML：${detail}` : `无法生成 TypeScript interface：${detail}`;
}

/** Whether the current action last failed, so a good preview can say it works. */
let failing = false;

/**
 * Runs one action: derives its result from the entry and makes it the thing
 * the result pane follows. `note` replaces the action's own status line when
 * the caller has something more specific to say (the escape toggle).
 */
async function applyAction(action: ActionName, note?: string): Promise<void> {
  const token = ++writeToken;
  active = action;
  pasted = null;
  cancelPreview();
  if (action === "format") setStatus("正在排版…");
  let rendered: Rendered;
  try {
    rendered = await derive(action);
  } catch (error) {
    if (token !== writeToken) return;
    failing = true;
    setStatus(failureStatus(action, error));
    return;
  }
  if (token !== writeToken) return;
  failing = false;
  writeResult(rendered, false);
  setStatus(note ?? ACTION_STATUS[action]);
}

function cancelPreview(): void {
  if (previewTimer === null) return;
  clearTimeout(previewTimer);
  previewTimer = null;
}

/** Schedules the result pane to catch up with the entry once typing pauses. */
function schedulePreview(): void {
  if (active === null) return;
  cancelPreview();
  previewTimer = setTimeout(() => {
    previewTimer = null;
    void refreshPreview();
  }, PREVIEW_DELAY_MS);
}

/**
 * Re-derives the current action from the entry and writes it quietly: no
 * status line, no scroll jump, no clearing. An entry that does not parse keeps
 * the last good result, and its own pane says why.
 */
async function refreshPreview(): Promise<void> {
  if (active === null) return;
  const action = active;
  const token = ++writeToken;
  let rendered: Rendered;
  try {
    rendered = await derive(action);
  } catch {
    return;
  }
  if (token !== writeToken || active !== action) return;
  writeResult(rendered, true);
  if (failing) {
    failing = false;
    setStatus(ACTION_STATUS[action]);
  }
}

function clearWhenEmpty(): void {
  copyJson.disabled = editor.value === "";
}

// Typing in the entry re-derives the current action after a pause, so the
// result pane is a preview of what is on the left, never a leftover.
editor.addEventListener("input", () => {
  sourcePane.render();
  updateMeta();
  clearWhenEmpty();
  schedulePreview();
});

// A hand-edited result becomes its own document: folding and copying read it,
// the entry stops previewing into it, and the escape toggle stops re-deriving,
// because re-deriving would discard the edit.
outputInput.addEventListener("input", () => {
  active = null;
  pasted = null;
  cancelPreview();
  derived = outputInput.value;
  folded = false;
  foldable = foldJson(derived);
  updateFoldControl();
  resultPane.render();
  output.dataset.state = derived === "" ? "empty" : "filled";
  if (derived === "") {
    outputTitle.textContent = "结果";
    outputMeta.textContent = "";
  } else {
    outputMeta.textContent = describe(derived);
  }
  copyOutput.disabled = derived === "";
});

async function load(text: string, title: string): Promise<void> {
  summary.textContent = title || "当前条目";
  hideOutput();
  setEditor(text);
  clearWhenEmpty();
  active = "format";

  if (text.trim() === "") {
    // An entry of only whitespace has nothing to show or copy.
    setEditor("");
    clearWhenEmpty();
    setStatus("条目为空；粘贴内容会转换后写在右侧。");
    return;
  }

  await applyAction("format");
}

function applyFold(): void {
  if (foldable === null) return;
  folded = !folded;
  resultPane.set(folded ? foldable.text : derived, undefined, !folded);
  updateFoldControl();
  setStatus(folded
    ? `已折叠 ${foldable.count} 处嵌套结构；复制仍是完整 JSON。`
    : "已展开全部结构。");
}

function resultText(value: unknown): string {
  if (typeof value === "string") return value;
  const text = JSON.stringify(value, null, 2);
  return text === undefined ? String(value) : text;
}

const KIND_LABEL: Record<PasteKind, string> = {
  json: "JSON",
  "url-params": "URL 参数",
  xml: "XML",
  yaml: "YAML",
};

function shapeResult(text: string): string {
  return preserveEscapes ? escapeNonAscii(text) : decodeEscapes(text);
}

function applyPaste(): void {
  if (pasted === null) return;
  // A paste converts clipboard text, not the entry: the result does not follow
  // the left pane, so it is not a preview of it.
  active = null;
  writeResult({ title: pasted.title, text: shapeResult(pasted.text), language: pasted.language }, false);
}

// A paste into the entry pane is a conversion of clipboard text, not an edit:
// the converted document lands on the right and the entry keeps what it had.
// Pasting into the result pane is an ordinary edit.
async function handlePaste(text: string): Promise<void> {
  const mine = ++writeToken;
  setStatus("正在识别粘贴内容…");
  const attempt = await convertPaste(text);
  if (mine !== writeToken) return;

  if (attempt.status === "converted") {
    pasted = { title: `粘贴 · ${KIND_LABEL[attempt.kind]}`, text: attempt.text, language: "json" };
    applyPaste();
    setStatus(`已把粘贴的 ${KIND_LABEL[attempt.kind]} 转为 JSON，写在右侧。`);
    return;
  }

  const reason = attempt.status === "failed"
    ? `识别为 ${KIND_LABEL[attempt.kind]}，但转换失败：${attempt.message}`
    : "不是可识别的 JSON、URL 参数、XML 或 YAML";
  pasted = { title: "粘贴内容", text, language: "plain" };
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
  void applyAction("format");
});
minifyButton.addEventListener("click", () => {
  void applyAction("minify");
});
foldButton.addEventListener("click", () => {
  applyFold();
});
xmlButton.addEventListener("click", () => {
  void applyAction("xml");
});
tsButton.addEventListener("click", () => {
  void applyAction("typescript");
});
filterRun.addEventListener("click", () => {
  void applyAction("filter");
});
filter.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    void applyAction("filter");
  }
});
// The expression reads the entry, so it previews like every other action.
filter.addEventListener("input", () => {
  schedulePreview();
});

// The toggle is a spelling choice for the result, never a rewrite of the
// original: flipping it re-derives whatever the result pane is showing.
preserveToggle.addEventListener("click", () => {
  const next = !preserveEscapes;
  setPreserveEscapes(next);
  const note = next
    ? "已保留转义：右侧结果将使用 \\uXXXX 写法。"
    : "已还原转义：右侧结果将还原中文与斜杠。";
  if (active !== null) {
    void applyAction(active, note);
    return;
  }
  if (pasted !== null) {
    applyPaste();
    setStatus(note);
    return;
  }
  setStatus(note);
});

hideOutput();
updateMeta();
sourcePane.render();
clearWhenEmpty();

bridge.onItem(({ item }) => {
  void load(item.text, item.title);
});
