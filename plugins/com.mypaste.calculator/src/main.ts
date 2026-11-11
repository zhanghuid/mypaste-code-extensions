/**
 * The calculator page: a scratch sheet where every line is evaluated as it is
 * typed. The page owns the whole interaction (rows, keys, notes and results);
 * copying and saving are host actions reached through the bridge, and the page
 * never touches the clipboard or the database itself.
 */

import { connectSurface } from "./bridge";
import { evaluateSheet, type RowOutcome } from "./evaluate";

/** A surface document is at most 1 MiB; these keep a huge entry responsive. */
const MAX_ROWS = 300;
const MAX_LINE = 4096;
const MAX_CHARS = 120_000;

function one<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (element === null) throw new Error(`缺少元素 ${selector}`);
  return element;
}

const rowsElement = one<HTMLDivElement>("#rows");
const countElement = one<HTMLDivElement>("#count");
const statusElement = one<HTMLParagraphElement>("#status");
const addButton = one<HTMLButtonElement>("#add-row");
const clearButton = one<HTMLButtonElement>("#clear");
const copyAllButton = one<HTMLButtonElement>("#copy-all");
const saveButton = one<HTMLButtonElement>("#save");

const bridge = connectSurface();

interface Row {
  text: string;
}

interface RowView {
  element: HTMLDivElement;
  input: HTMLInputElement;
  result: HTMLDivElement;
  outcome: RowOutcome | null;
}

let rows: Row[] = [{ text: "" }];
let outcomes: RowOutcome[] = [];
let views: RowView[] = [];

function setStatus(text: string, tone: "info" | "error" = "info"): void {
  statusElement.textContent = text;
  statusElement.dataset.tone = tone;
}

async function copyText(text: string, label: string): Promise<void> {
  const answer = await bridge.copy(text);
  if (answer.ok) {
    setStatus(`已复制${label}`);
  } else {
    setStatus(answer.message?.trim() || `复制${label}失败`, "error");
  }
}

function updateSummary(): void {
  const values = outcomes.filter((outcome) => outcome.kind === "value");
  countElement.textContent = `${rows.length} 行`;
  if (values.length === 0) {
    const empty = rows.every((row) => row.text.trim() === "");
    setStatus(
      empty
        ? "输入算式，结果会实时显示在右边。"
        : "还没有可计算的结果，检查一下写法。",
    );
    return;
  }
  const last = values[values.length - 1];
  setStatus(`${values.length} 个结果 · 最后结果 ${last?.display ?? ""}`);
}

/** Recomputes the whole sheet and only repaints the result cells, so typing
 * never recreates an input or loses the caret. */
function evaluate(): void {
  outcomes = evaluateSheet(rows.map((row) => row.text));
  outcomes.forEach((outcome, index) => {
    const view = views[index];
    if (!view) return;
    view.outcome = outcome;
    view.element.dataset.kind = outcome.kind;
    view.result.replaceChildren();
    if (outcome.kind === "value") {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "value";
      button.textContent = outcome.display;
      button.title = `复制 ${outcome.copy}`;
      button.setAttribute("aria-label", `复制结果 ${outcome.copy}`);
      view.result.append(button);
    } else if (outcome.kind === "error") {
      const error = document.createElement("span");
      error.className = "error";
      error.textContent = outcome.error;
      error.title = outcome.error;
      view.result.append(error);
    }
  });
  updateSummary();
}

function renderRows(focusIndex?: number, caret?: number): void {
  const fragment = document.createDocumentFragment();
  views = [];
  rows.forEach((row, index) => {
    const element = document.createElement("div");
    element.className = "row";
    element.dataset.index = String(index);

    const lineNumber = document.createElement("span");
    lineNumber.className = "line-no";
    lineNumber.setAttribute("aria-hidden", "true");
    lineNumber.textContent = String(index + 1);

    const input = document.createElement("input");
    input.className = "expr";
    input.type = "text";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.value = row.text;
    input.setAttribute("aria-label", `第 ${index + 1} 行`);
    if (index === 0) input.placeholder = "输入算式，例如 (12+3)*4";

    const result = document.createElement("div");
    result.className = "result";

    element.append(lineNumber, input, result);
    fragment.append(element);
    views.push({ element, input, result, outcome: null });
  });
  rowsElement.replaceChildren(fragment);
  evaluate();
  if (focusIndex !== undefined) focusRow(focusIndex, caret);
}

function focusRow(index: number, caret?: number): void {
  const view = views[index];
  if (!view) return;
  view.input.focus();
  const position = caret ?? view.input.value.length;
  view.input.setSelectionRange(position, position);
}

function insertRow(at: number, text: string): void {
  const index = Math.max(0, Math.min(at, rows.length));
  rows.splice(index, 0, { text });
  renderRows(index, text.length);
}

function removeRow(index: number): void {
  if (rows.length <= 1) return;
  rows.splice(index, 1);
  renderRows(Math.max(0, index - 1));
}

function clearSheet(): void {
  rows = [{ text: "" }];
  renderRows(0);
  setStatus("稿纸已清空");
}

/** Carries the current result into a new row, the way a paper calculation
 * continues from its last answer. */
function carryResult(index: number): void {
  const outcome = outcomes[index];
  if (!outcome || outcome.kind !== "value") {
    insertRow(index + 1, "");
    return;
  }
  insertRow(index + 1, outcome.copy);
}

function addNote(index: number): void {
  insertRow(index + 1, "# ");
}

async function saveSheet(): Promise<void> {
  const text = rows
    .map((row) => row.text)
    .join("\n")
    .replace(/\s+$/u, "");
  if (text.trim() === "") {
    setStatus("稿纸是空的，没有可保存的内容", "error");
    return;
  }
  const answer = await bridge.save(text, "计算稿纸");
  if (answer.ok) {
    setStatus(`已保存为新条目${answer.id ? `（#${answer.id}）` : ""}`);
  } else {
    setStatus(answer.message?.trim() || "保存失败", "error");
  }
}

function copyAllResults(): void {
  const copies = outcomes
    .filter((outcome) => outcome.kind === "value")
    .map((outcome) => outcome.copy);
  if (copies.length === 0) {
    setStatus("还没有可复制的结果", "error");
    return;
  }
  void copyText(copies.join("\n"), "全部结果");
}

function seed(text: string): void {
  const lines = text
    .replace(/\r\n?/gu, "\n")
    .split("\n");
  while (lines.length > 0 && (lines[lines.length - 1] ?? "").trim() === "") {
    lines.pop();
  }
  if (lines.length === 0) {
    renderRows(0);
    return;
  }

  let truncated = false;
  const kept: string[] = [];
  let characters = 0;
  for (const line of lines.slice(0, MAX_ROWS)) {
    if (characters + line.length > MAX_CHARS) {
      truncated = true;
      break;
    }
    let next = line;
    if (next.length > MAX_LINE) {
      next = next.slice(0, MAX_LINE);
      truncated = true;
    }
    kept.push(next);
    characters += next.length;
  }
  if (lines.length > MAX_ROWS) truncated = true;
  if (kept.length === 0) kept.push("");

  rows = kept.map((line) => ({ text: line }));
  renderRows(0);
  if (truncated) {
    setStatus(`内容较长，只载入了前 ${rows.length} 行`);
  }
}

rowsElement.addEventListener("input", (event) => {
  const input = (event.target as HTMLElement | null)?.closest<HTMLInputElement>(
    "input.expr",
  );
  if (!input) return;
  const rowElement = input.closest<HTMLElement>(".row");
  const index = Number(rowElement?.dataset.index);
  const row = rows[index];
  if (!row) return;
  row.text = input.value;
  evaluate();
});

rowsElement.addEventListener("click", (event) => {
  const button = (event.target as HTMLElement | null)?.closest<HTMLElement>(
    "button.value",
  );
  if (!button) return;
  const rowElement = button.closest<HTMLElement>(".row");
  const index = Number(rowElement?.dataset.index);
  const outcome = outcomes[index];
  if (!outcome || outcome.kind !== "value") return;
  const input = views[index]?.input;
  void copyText(outcome.copy, "结果").then(() => input?.focus());
});

rowsElement.addEventListener("keydown", (event) => {
  const input = (event.target as HTMLElement | null)?.closest<HTMLInputElement>(
    "input.expr",
  );
  if (!input) return;
  const rowElement = input.closest<HTMLElement>(".row");
  const index = Number(rowElement?.dataset.index);
  if (!Number.isInteger(index) || index < 0) return;
  const command = event.metaKey || event.ctrlKey;
  const key = event.key.toLowerCase();

  if (command && key === "b") {
    event.preventDefault();
    addNote(index);
    return;
  }
  if (command && event.key === "Enter") {
    event.preventDefault();
    carryResult(index);
    return;
  }
  if (
    command &&
    key === "c" &&
    input.selectionStart === input.selectionEnd
  ) {
    const outcome = outcomes[index];
    if (outcome && outcome.kind === "value") {
      event.preventDefault();
      void copyText(outcome.copy, "结果");
    }
    return;
  }
  if (command && key === "s") {
    event.preventDefault();
    void saveSheet();
    return;
  }
  if (command && key === "r") {
    event.preventDefault();
    clearSheet();
    return;
  }
  if (event.key === "Enter" && !event.altKey && !event.shiftKey) {
    event.preventDefault();
    insertRow(index + 1, "");
    return;
  }
  if (event.key === "Backspace" && input.value === "" && rows.length > 1) {
    event.preventDefault();
    removeRow(index);
    return;
  }
  if (event.key === "ArrowUp") {
    event.preventDefault();
    focusRow(index - 1);
    return;
  }
  if (event.key === "ArrowDown") {
    event.preventDefault();
    focusRow(index + 1);
  }
});

addButton.addEventListener("click", () => {
  insertRow(rows.length, "");
});

clearButton.addEventListener("click", () => {
  clearSheet();
});

copyAllButton.addEventListener("click", () => {
  copyAllResults();
});

saveButton.addEventListener("click", () => {
  void saveSheet();
});

bridge.onItem(({ item }) => {
  seed(item.text);
});

renderRows();
