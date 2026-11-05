/**
 * 高亮对比工作台：宿主交付本次调用的条目，以及清单声明的相邻一条文本
 * （D-1040）。两份文本的逐行对齐与词级标记由本包自带的 diff 引擎完成；
 * 文档不联网、不读取其它条目，也不调用宿主的扩展。
 */

import { connectWorkbench, type WorkbenchDelivery } from "./bridge";
import { diffSummary, diffText, type DiffRow } from "./diff";
import { detectLanguage, languageLabel } from "./languages";

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
const saveButton = one<HTMLButtonElement>("[data-action=save]");
const copyButton = one<HTMLButtonElement>("[data-action=copy]");
const closeButton = one<HTMLButtonElement>("[data-action=close]");
const status = one<HTMLElement>("#diff-status");
const emptyState = one<HTMLElement>("#diff-empty");

let currentText = "";
let currentName = "";
let busy = false;

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
    target.append(document.createTextNode(segment.text));
  }
}

function sideCell(row: DiffRow, side: "before" | "after"): HTMLElement {
  const line = cell(`line ${side}`);
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

function render(delivery: WorkbenchDelivery): void {
  const companion = delivery.companion;
  if (!companion) {
    // The host refuses before opening a document whose manifest asked for a
    // comparison; this guard covers a delivery that lost its pair.
    setStatus("历史里还需要另一条文本才能对比", true);
    saveButton.disabled = true;
    copyButton.disabled = true;
    return;
  }
  currentText = delivery.item.text;
  currentName = delivery.item.title;
  const result = diffText(companion.text, currentText);
  emptyState.hidden = true;
  currentTitle.textContent = currentName || "当前条目";
  companionTitle.textContent = companion.title || "相邻条目";
  languageLabelElement.textContent = `文本 · ${languageLabel(detectLanguage(currentText))}`;
  stats.textContent = diffSummary(result);

  const fragment = document.createDocumentFragment();
  for (const row of result.rows) {
    const element = cell("diff-row");
    element.dataset.kind = row.kind;
    element.append(sideCell(row, "before"), sideCell(row, "after"));
    fragment.append(element);
  }
  rows.replaceChildren(fragment);

  if (result.truncated || result.coarse) {
    setStatus(
      result.truncated
        ? "文本过长，只比较了前面一部分"
        : "改动过多，按位置配对而不是逐词对齐",
    );
  } else {
    setStatus("");
  }
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
    setStatus("正在保存…");
    const result = await bridge.save(currentText, (currentName || "对比结果").slice(0, 120));
    if (!result.ok) {
      setStatus(result.message || "保存失败", true);
      return;
    }
    setStatus(result.id === undefined ? "已保存为新条目" : `已保存为新条目 #${result.id}`);
  });
}

function copy(): Promise<void> {
  return run(async () => {
    setStatus("正在复制…");
    const result = await bridge.copy(currentText);
    setStatus(result.ok ? "已复制当前文本" : (result.message || "复制失败"), !result.ok);
  });
}

saveButton.addEventListener("click", () => void save());
copyButton.addEventListener("click", () => void copy());
closeButton.addEventListener("click", () => bridge.close());
document.addEventListener("keydown", (event) => {
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

bridge.onItem(render);
