/**
 * The timestamp page.
 *
 * The host delivers one text item; the page parses it and lists the answer in
 * every format it knows. Copying is a host action: the page posts the `copy`
 * message and never touches the clipboard itself. All text reaches the DOM
 * through `textContent`, never HTML.
 */

import { connectSurface } from "./bridge";
import { buildRows, parseTimestamp, type TimestampRow } from "./parse";

function one<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (element === null) throw new Error(`缺少元素 ${selector}`);
  return element;
}

const summary = one<HTMLParagraphElement>("#summary");
const status = one<HTMLParagraphElement>("#status");
const result = one<HTMLElement>("#result");
const rows = one<HTMLDivElement>("#rows");
const copyAll = one<HTMLButtonElement>("#copy-all");
const original = one<HTMLElement>("#original");
const originalText = one<HTMLElement>("#original-text");

const bridge = connectSurface();

let currentRows: TimestampRow[] = [];

function setStatus(text: string): void {
  status.textContent = text;
}

function showOriginal(text: string): void {
  originalText.textContent = text;
  original.hidden = text === "";
}

function clear(): void {
  currentRows = [];
  rows.replaceChildren();
  result.hidden = true;
  copyAll.hidden = true;
  showOriginal("");
}

async function copyText(text: string, label: string): Promise<void> {
  const answer = await bridge.copy(text);
  if (answer.ok) {
    setStatus(`已复制${label}`);
  } else {
    setStatus(answer.message?.trim() || `复制${label}失败`);
  }
}

function rowElement(row: TimestampRow): HTMLElement {
  const line = document.createElement("div");
  line.className = "row";

  const label = document.createElement("span");
  label.className = "row-label";
  label.textContent = row.label;

  const value = document.createElement("code");
  value.className = "row-value";
  value.textContent = row.value;
  value.title = row.value;

  const button = document.createElement("button");
  button.type = "button";
  button.className = "row-copy";
  button.textContent = "复制";
  button.setAttribute("aria-label", `复制${row.label}`);
  button.addEventListener("click", () => {
    void copyText(row.value, ` ${row.label}`);
  });

  line.append(label, value, button);
  return line;
}

function render(text: string, title: string): void {
  clear();
  const trimmed = text.trim();

  if (trimmed === "") {
    summary.textContent = title || "当前条目";
    setStatus("条目为空，没有可解析的时间。");
    return;
  }

  const parsed = parseTimestamp(trimmed);
  if (!parsed.ok) {
    summary.textContent = title || "当前条目";
    if (parsed.reason === "out-of-range") {
      setStatus("时间超出 1970–2100 的范围，无法转换。");
    } else {
      setStatus("无法识别为日期或时间。");
    }
    showOriginal(trimmed);
    return;
  }

  currentRows = buildRows(parsed.ms, Date.now());

  if (parsed.source === "embedded") {
    summary.textContent = `从内容中识别：${parsed.matched}`;
    setStatus("整条内容不是完整时间，已识别出其中第一个时间。");
  } else {
    summary.textContent = title || "完整时间";
    setStatus("");
  }

  for (const row of currentRows) rows.append(rowElement(row));
  result.hidden = false;
  copyAll.hidden = false;
}

copyAll.addEventListener("click", () => {
  if (currentRows.length === 0) return;
  const lines = currentRows.map((row) => `${row.label}：${row.value}`);
  void copyText(lines.join("\n"), "全部结果");
});

bridge.onItem(({ item }) => render(item.text, item.title));

// The host never sees a key pressed inside this frame, so Esc is the page's
// own: it closes the surface through the bridge (D-1097).
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  event.preventDefault();
  bridge.close();
});

setStatus("等待条目…");
