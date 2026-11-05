/**
 * 高亮对比工作台：宿主交付本次调用的条目，以及清单声明的相邻一条文本
 * （D-1040）。两份文本的逐行对齐与词级标记由本包自带的 diff 引擎完成；
 * 文档不联网、不读取其它条目，也不调用宿主的扩展。
 *
 * 双击任一侧进入该侧编辑：该侧换成整列一个 textarea，另一侧继续显示高亮
 * 行并随输入重算；Esc 先退出编辑，再按一次才关闭文档。关闭本身由宿主卡片
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
  // double-click handler reads it back to choose which text to edit.
  line.dataset.side = side;
  const number = side === "before" ? row.beforeLine : row.afterLine;
  if (number !== null) {
    const gutter = document.createElement("span");
    gutter.className = "line-number";
    gutter.textContent = String(number);
    line.append(gutter);
  } else {
    const gutter = document.createElement("span");
    gutter.className = "line-number empty";
    line.append(gutter);
  }
  const text = cell("line-text");
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
  stats.textContent = diffSummary(result);
  const fragment = document.createDocumentFragment();
  for (const row of result.rows) fragment.append(rowElement(row));
  rows.replaceChildren(fragment);
  showStatus(result);
  updateActions();
}

/**
 * One side in edit mode: a plain textarea held across keystrokes. Rebuilding
 * it on every input would move the caret and drop the undo stack, so only the
 * other column is replaced while the user types.
 */
function renderEdit(): void {
  const side = editing;
  if (side === null) return;
  const result = diffText(beforeText, afterText);
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
    const live = diffText(beforeText, afterText);
    stats.textContent = diffSummary(live);
    languageLabelElement.textContent = summaryText();
    const column = rows.querySelector<HTMLElement>('[data-column="other"]');
    column?.replaceChildren(
      columnFragment(live.rows, side === "before" ? "after" : "before"),
    );
    showStatus(live);
    updateActions();
  });
  editorPane.append(textarea);

  const otherSide: Side = side === "before" ? "after" : "before";
  const other = cell("diff-column");
  other.dataset.side = otherSide;
  other.dataset.column = "other";
  other.append(columnFragment(result.rows, otherSide));

  document.body.classList.add("editing");
  rows.classList.add("editing");
  scroller.classList.add("editing");
  rows.replaceChildren(
    ...(side === "before" ? [editorPane, other] : [other, editorPane]),
  );
  showStatus(result);
  updateActions();

  // The caret starts at the end of the text, where a reader arriving from the
  // comparison most often wants to append.
  textarea.focus();
  textarea.setSelectionRange(textarea.value.length, textarea.value.length);
}

function beginEdit(side: Side): void {
  if (editing === side) {
    rows.querySelector<HTMLTextAreaElement>('[data-role="editor"]')?.focus();
    return;
  }
  editing = side;
  renderEdit();
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

// A double-click anywhere on a line — its number, its text or a blank row —
// opens that side's editor. The handler sits on the rows container because
// every render replaces the children; the side comes from the cell itself.
rows.addEventListener("dblclick", (event) => {
  const target = event.target instanceof Element ? event.target : null;
  const side = target?.closest<HTMLElement>(".line")?.dataset.side;
  if (side !== "before" && side !== "after") return;
  // Without this the browser selects the word under the pointer, and the
  // editor replaces that selection a moment later.
  event.preventDefault();
  beginEdit(side);
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
