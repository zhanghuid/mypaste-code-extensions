/**
 * 高亮对比工作台：宿主交付本次调用的条目，以及清单声明的相邻一条文本
 * （D-1040）。两份文本的逐行对齐与词级标记由本包自带的 diff 引擎完成；
 * 文档不联网、不读取其它条目，也不调用宿主的扩展。
 *
 * 单击任一侧的面板即进入该侧编辑，光标落在点击处：该侧换成整列一个
 * textarea，另一侧继续显示高亮行并随输入重算。点标题、行号或最后一行以下
 * 的空白同样算作这一侧的编辑，只把光标放到该侧末尾；编辑中单击另一侧即
 * 切换编辑对象。Esc 先退出编辑，再按一次才关闭文档。关闭本身由宿主卡片
 * 负责，文档不再画第二个关闭按钮。
 */

import { connectWorkbench, type WorkbenchDelivery } from "./bridge";
import { diffSummary, diffText, type DiffRow } from "./diff";
import { detectLanguage, languageLabel } from "./languages";

type Side = "before" | "after";

const bridge = connectWorkbench();

function one<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`工作台文档缺少 ${selector}`);
  return element;
}

const currentTitle = one<HTMLElement>("#current-title");
const companionTitle = one<HTMLElement>("#companion-title");
const languageLabelElement = one<HTMLElement>("#diff-language");
const stats = one<HTMLElement>("#diff-stats");
const rows = one<HTMLElement>("#diff-rows");
const scroller = one<HTMLElement>("#diff-scroller");
const saveButton = one<HTMLButtonElement>("[data-action=save]");
const copyButton = one<HTMLButtonElement>("[data-action=copy]");
const status = one<HTMLElement>("#diff-status");
const emptyState = one<HTMLElement>("#diff-empty");

/**
 * The two texts the document holds. `before` is the comparison baseline; only
 * `after` is saved or copied, so editing the left side changes the comparison
 * without changing what the right side would write into history.
 */
let beforeText = "";
let afterText = "";
let currentName = "";
let editing: Side | null = null;
let busy = false;

type DiffResult = ReturnType<typeof diffText>;

/**
 * The last comparison, kept so entering an editor does not diff the same two
 * texts a second time; every keystroke clears it until the next repaint.
 */
let cachedResult: DiffResult | null = null;

/** Typing repaints the read-only column at most this often, in milliseconds. */
const REPAINT_INTERVAL = 150;
/** A repaint that itself takes long backs off up to this interval. */
const REPAINT_INTERVAL_MAX = 600;
let repaintInterval = REPAINT_INTERVAL;
let repaintTimer = 0;
let lastRepaintAt = 0;

function setStatus(text: string, failed = false): void {
  status.textContent = text;
  status.dataset.tone = failed ? "error" : "info";
  status.hidden = text === "";
}

function cell(className: string): HTMLElement {
  const element = document.createElement("div");
  element.className = className;
  return element;
}

function appendSegments(target: HTMLElement, segments: DiffRow["before"]): void {
  for (const segment of segments) {
    if (segment.changed) {
      const mark = document.createElement("span");
      mark.className = "diff-mark";
      mark.textContent = segment.text;
      target.append(mark);
      continue;
    }
    target.append(segment.text);
  }
}

function sideCell(row: DiffRow, side: Side): HTMLElement {
  const line = cell(`line ${side}`);
  // The side is written by the producer, not guessed from the column: the
  // click handler reads it back to choose which text to edit.
  line.dataset.side = side;
  const number = side === "before" ? row.beforeLine : row.afterLine;
  const gutter = document.createElement("span");
  gutter.className = number === null ? "line-number empty" : "line-number";
  // The roles let the click handler find these two parts again without
  // depending on class names the stylesheet also owns.
  gutter.dataset.role = "number";
  if (number !== null) gutter.textContent = String(number);
  line.append(gutter);
  const text = cell("line-text");
  text.dataset.role = "text";
  appendSegments(text, side === "before" ? row.before : row.after);
  line.append(text);
  return line;
}

function rowElement(row: DiffRow): HTMLElement {
  const element = cell("diff-row");
  element.dataset.kind = row.kind;
  element.append(sideCell(row, "before"), sideCell(row, "after"));
  return element;
}

/** One highlighted column, without its counterpart (edit mode). */
function columnFragment(rowsIn: readonly DiffRow[], side: Side): DocumentFragment {
  const fragment = document.createDocumentFragment();
  for (const row of rowsIn) {
    const element = cell("diff-row");
    element.dataset.kind = row.kind;
    element.append(sideCell(row, side));
    fragment.append(element);
  }
  return fragment;
}

function summaryText(): string {
  return `文本 · ${languageLabel(detectLanguage(afterText))}`;
}

/**
 * The status line states the one thing that matters now: an empty current
 * text disables both actions, editing shows its own way out, and otherwise
 * the result's own limits are reported.
 */
function showStatus(result: DiffResult): void {
  if (afterText.trim() === "") {
    setStatus("当前文本为空，无法保存或复制");
    return;
  }
  if (editing !== null) {
    setStatus(
      editing === "before"
        ? "正在编辑对比基准 · ⌘↩ 保存为新条目 · Esc 退出"
        : "正在编辑当前文本 · ⌘↩ 保存为新条目 · Esc 退出",
    );
    return;
  }
  if (result.truncated) setStatus("文本过长，只比较了前面一部分");
  else if (result.coarse) setStatus("改动过多，按位置配对而不是逐词对齐");
  else setStatus("");
}

function updateActions(): void {
  const enabled = !busy && afterText.trim() !== "";
  saveButton.disabled = !enabled;
  copyButton.disabled = !enabled;
}

/** The read-only comparison. */
function renderView(): void {
  editing = null;
  document.body.classList.remove("editing");
  rows.classList.remove("editing");
  scroller.classList.remove("editing");
  const result = diffText(beforeText, afterText);
  cachedResult = result;
  stats.textContent = diffSummary(result);
  const fragment = document.createDocumentFragment();
  for (const row of result.rows) fragment.append(rowElement(row));
  rows.replaceChildren(fragment);
  showStatus(result);
  updateActions();
}

/**
 * Live re-diff for the column that is not being typed in. Diffing both texts
 * on every keystroke is what made typing feel heavy on long texts, so an
 * input only schedules a repaint and the repaint itself is rate-limited.
 */
function repaintEdit(): void {
  const side = editing;
  if (side === null) return;
  const result = diffText(beforeText, afterText);
  cachedResult = result;
  stats.textContent = diffSummary(result);
  const column = rows.querySelector<HTMLElement>('[data-column="other"]');
  if (column) {
    // Replacing the column's children resets its scroll; a reader who had
    // scrolled down should stay where they were.
    const savedScroll = column.scrollTop;
    column.replaceChildren(
      columnFragment(result.rows, side === "before" ? "after" : "before"),
    );
    column.scrollTop = savedScroll;
  }
  showStatus(result);
  updateActions();
}

function scheduleRepaint(): void {
  if (repaintTimer !== 0) return;
  const wait = Math.max(0, repaintInterval - (performance.now() - lastRepaintAt));
  repaintTimer = window.setTimeout(() => {
    repaintTimer = 0;
    if (editing === null) return;
    const started = performance.now();
    repaintEdit();
    lastRepaintAt = performance.now();
    // A repaint that already cost more than a keystroke's worth backs off, so
    // long texts trade freshness of the comparison for a responsive editor.
    const spent = lastRepaintAt - started;
    repaintInterval = spent > 60
      ? Math.min(REPAINT_INTERVAL_MAX, Math.max(REPAINT_INTERVAL, spent * 2))
      : REPAINT_INTERVAL;
  }, wait);
}

/**
 * One side in edit mode: a plain textarea held across keystrokes. Rebuilding
 * it on every input would move the caret and drop the undo stack, so only the
 * other column is replaced while the user types.
 */
function renderEdit(caret?: number): void {
  const side = editing;
  if (side === null) return;
  // Entry reuses the comparison just drawn; only a keystroke invalidates it.
  const result = cachedResult ?? diffText(beforeText, afterText);
  cachedResult = result;
  repaintInterval = REPAINT_INTERVAL;
  stats.textContent = diffSummary(result);

  const editorPane = cell("edit-side");
  editorPane.dataset.side = side;
  const textarea = document.createElement("textarea");
  textarea.className = "edit-input";
  textarea.dataset.role = "editor";
  textarea.spellcheck = false;
  textarea.value = side === "before" ? beforeText : afterText;
  textarea.setAttribute(
    "aria-label",
    side === "before" ? "编辑对比基准文本" : "编辑当前文本",
  );
  textarea.addEventListener("input", () => {
    if (side === "before") beforeText = textarea.value;
    else afterText = textarea.value;
    cachedResult = null;
    languageLabelElement.textContent = summaryText();
    if (afterText.trim() === "") setStatus("当前文本为空，无法保存或复制");
    updateActions();
    scheduleRepaint();
  });
  editorPane.append(textarea);

  const otherSide: Side = side === "before" ? "after" : "before";
  const other = cell("diff-column");
  other.dataset.side = otherSide;
  other.dataset.column = "other";
  other.append(columnFragment(result.rows, otherSide));

  // The two-pane view may have been scrolled before the click; carry that
  // position into the read-only column so the click does not jump the reader.
  const savedScroll = scroller.scrollTop;
  document.body.classList.add("editing");
  rows.classList.add("editing");
  scroller.classList.add("editing");
  rows.replaceChildren(
    ...(side === "before" ? [editorPane, other] : [other, editorPane]),
  );
  other.scrollTop = savedScroll;
  showStatus(result);
  updateActions();

  // The caret goes where the reader clicked; without one, to the end of the
  // text, where someone arriving from the comparison most often wants to
  // append.
  const position = caret ?? textarea.value.length;
  textarea.focus();
  textarea.setSelectionRange(position, position);
  // A freshly focused textarea is left scrolled to its end, which drops the
  // reader somewhere else entirely; bring the clicked line back into view.
  const style = getComputedStyle(textarea);
  const lineHeight = Number.parseFloat(style.lineHeight) || 20;
  const paddingTop = Number.parseFloat(style.paddingTop) || 0;
  const clickedLine = textarea.value.slice(0, position).split("\n").length - 1;
  textarea.scrollTop = Math.max(
    0,
    paddingTop + clickedLine * lineHeight - textarea.clientHeight / 3,
  );
}

function beginEdit(side: Side, caret?: number): void {
  if (editing === side) {
    const editor = rows.querySelector<HTMLTextAreaElement>('[data-role="editor"]');
    if (!editor) return;
    editor.focus();
    if (caret !== undefined) editor.setSelectionRange(caret, caret);
    return;
  }
  editing = side;
  renderEdit(caret);
}

/** Character offset at which each line of a text starts. */
function lineStarts(text: string): number[] {
  const starts = [0];
  for (let index = 0; index < text.length; index++) {
    if (text.charCodeAt(index) === 10) starts.push(index + 1);
  }
  return starts;
}

/**
 * Which line of `text` a rendered line stands for, as a zero-based index.
 * The gutter already carries that side's line number; a padding row has none
 * because the other side inserted there, so it stands just after this side's
 * previous line.
 */
function sideLineIndex(line: HTMLElement, side: Side): number {
  const number = line.querySelector('[data-role="number"]')?.textContent;
  if (number) return Math.max(0, Number(number) - 1);
  let node: Element | null = line.closest(".diff-row");
  while (node) {
    const previous = node.previousElementSibling;
    if (!previous) break;
    const label = previous.querySelector(`[data-side="${side}"] [data-role="number"]`)?.textContent;
    if (label) return Number(label);
    node = previous;
  }
  return 0;
}

/** Characters of `parent` before `target`'s `offset`, flattened. */
function offsetWithin(parent: Node, target: Node, offset: number): number {
  let count = 0;
  const visit = (node: Node): boolean => {
    if (node === target) {
      if (node.nodeType === Node.TEXT_NODE) {
        count += offset;
      } else {
        const children = Array.from(node.childNodes).slice(0, offset);
        for (const child of children) count += child.textContent?.length ?? 0;
      }
      return true;
    }
    if (node.nodeType === Node.TEXT_NODE) {
      count += node.textContent?.length ?? 0;
      return false;
    }
    for (const child of Array.from(node.childNodes)) {
      if (visit(child)) return true;
    }
    return false;
  };
  visit(parent);
  return count;
}

/**
 * The caret a click asks for: the clicked line's start plus the characters up
 * to the click itself, as the highlighted text lays them out.
 */
function caretOffsetFor(side: Side, line: HTMLElement, event: MouseEvent): number {
  const text = side === "before" ? beforeText : afterText;
  const starts = lineStarts(text);
  const lineIndex = Math.min(sideLineIndex(line, side), starts.length - 1);
  let column = 0;
  const range = document.caretRangeFromPoint?.(event.clientX, event.clientY);
  const rendered = line.querySelector('[data-role="text"]');
  if (range && rendered?.contains(range.startContainer)) {
    column = offsetWithin(rendered, range.startContainer, range.startOffset);
  }
  return Math.min((starts[lineIndex] ?? 0) + column, text.length);
}

function exitEdit(): void {
  if (editing === null) return;
  renderView();
}

function render(delivery: WorkbenchDelivery): void {
  const companion = delivery.companion;
  if (!companion) {
    // The host refuses before opening a document whose manifest asked for a
    // comparison; this guard covers a delivery that lost its pair.
    setStatus("历史里还需要另一条文本才能对比", true);
    updateActions();
    return;
  }
  beforeText = companion.text;
  afterText = delivery.item.text;
  currentName = delivery.item.title;
  emptyState.hidden = true;
  currentTitle.textContent = currentName || "当前条目";
  companionTitle.textContent = companion.title || "相邻条目";
  languageLabelElement.textContent = summaryText();
  renderView();
}

async function run(action: () => Promise<void>): Promise<void> {
  if (busy) return;
  busy = true;
  updateActions();
  try {
    await action();
  } finally {
    busy = false;
    updateActions();
  }
}

function save(): Promise<void> {
  return run(async () => {
    if (afterText.trim() === "") {
      showStatus(diffText(beforeText, afterText));
      return;
    }
    setStatus("正在保存…");
    const result = await bridge.save(
      afterText,
      (currentName || "对比结果").slice(0, 120),
    );
    if (!result.ok) {
      setStatus(result.message || "保存失败", true);
      return;
    }
    setStatus(result.id === undefined ? "已保存为新条目" : `已保存为新条目 #${result.id}`);
  });
}

function copy(): Promise<void> {
  return run(async () => {
    if (afterText.trim() === "") {
      showStatus(diffText(beforeText, afterText));
      return;
    }
    setStatus("正在复制…");
    const result = await bridge.copy(afterText);
    setStatus(result.ok ? "已复制当前文本" : (result.message || "复制失败"), !result.ok);
  });
}

/** The side a point falls in. Both the view and the editors split evenly. */
function sideAt(x: number): Side {
  const bounds = rows.getBoundingClientRect();
  return x < bounds.left + bounds.width / 2 ? "before" : "after";
}

/**
 * What a click asks for: the side it lands on and, when it lands on a rendered
 * line, the caret under the pointer. A click on the pane head, the gutter or
 * the empty area below the last line carries no caret, so that side opens at
 * its end. Returns null for clicks that belong to something else: the editor
 * itself, the footer, or a scrollbar drag.
 */
function editRequest(
  event: MouseEvent,
): { side: Side; caret?: number } | null {
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return null;
  if (target.closest('[data-role="editor"]') || target.closest("footer")) {
    return null;
  }
  const head = target.closest<HTMLElement>(".pane-head");
  if (head) {
    const side = head.dataset.side;
    return side === "before" || side === "after" ? { side } : null;
  }
  const line = target.closest<HTMLElement>(".line");
  if (line) {
    const side = line.dataset.side;
    if (side === "before" || side === "after") {
      return { side, caret: caretOffsetFor(side, line, event) };
    }
  }
  if (editing !== null) {
    // In edit mode the read-only column scrolls on its own; its scrollbar is
    // not an edit request either.
    const column = target.closest<HTMLElement>(".diff-column");
    if (column) {
      const bounds = column.getBoundingClientRect();
      if (event.clientX > bounds.right - 14) return null;
    }
    return { side: sideAt(event.clientX) };
  }
  // The vertical scrollbar belongs to the scroller; pressing it scrolls.
  const bounds = scroller.getBoundingClientRect();
  if (event.clientX > bounds.right - 14) return null;
  return { side: sideAt(event.clientX) };
}

// A click anywhere in a pane opens that side's editor: on a line it keeps the
// caret where the pointer landed, elsewhere it opens at the end. With an
// editor open, a click on the read-only column moves the editor to the side
// clicked. A drag that selected text stays a selection, so the pointer's
// travel from mouse-down decides.
let downX = 0;
let downY = 0;
document.addEventListener("mousedown", (event) => {
  downX = event.clientX;
  downY = event.clientY;
});
document.addEventListener("click", (event) => {
  if (Math.abs(event.clientX - downX) + Math.abs(event.clientY - downY) > 4) {
    return;
  }
  const request = editRequest(event);
  if (!request) return;
  event.preventDefault();
  beginEdit(request.side, request.caret);
});
// A fast second click is still an edit request, never a word selection — but
// inside the editor a double-click keeps selecting a word.
rows.addEventListener("dblclick", (event) => {
  const target = event.target instanceof Element ? event.target : null;
  if (target?.closest('[data-role="editor"]')) return;
  event.preventDefault();
});

saveButton.addEventListener("click", () => void save());
copyButton.addEventListener("click", () => void copy());

document.addEventListener("keydown", (event) => {
  const modifier = event.metaKey || event.ctrlKey;
  if (modifier && (event.key === "Enter" || event.key === "s")) {
    event.preventDefault();
    if (!saveButton.disabled) void save();
    return;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    // Escape leaves the editor first; only the next one closes the card.
    if (editing !== null) {
      exitEdit();
      return;
    }
    bridge.close();
  }
});

bridge.onItem(render);
