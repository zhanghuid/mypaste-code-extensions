/**
 * The JSON page.
 *
 * The host delivers one text item. The page hands it to the Prettier build
 * bundled into this document and paints the canonical JSON layout, one token
 * at a time; an invalid document keeps the original text verbatim beside
 * Prettier's line and column. Copying is a host action: the page posts `copy`
 * and never touches the clipboard itself. Every value reaches the DOM through
 * `textContent`, never HTML.
 */

import { connectSurface } from "./bridge";
import { formatJSON } from "./format";
import { tokenize, type TokenKind } from "./highlight";

function one<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (element === null) throw new Error(`缺少元素 ${selector}`);
  return element;
}

const summary = one<HTMLParagraphElement>("#summary");
const status = one<HTMLParagraphElement>("#status");
const result = one<HTMLElement>("#result");
const meta = one<HTMLParagraphElement>("#meta");
const codeBody = one<HTMLElement>("#code-body");
const copyButton = one<HTMLButtonElement>("#copy");
const original = one<HTMLElement>("#original");
const originalText = one<HTMLElement>("#original-text");

const bridge = connectSurface();

/** The formatted document the copy button hands to the host. */
let formatted = "";
/** The newest delivery wins; an older Prettier call may finish later. */
let generation = 0;

const TOKEN_CLASS: Record<TokenKind, string> = {
  plain: "",
  key: "tok-key",
  string: "tok-string",
  number: "tok-number",
  keyword: "tok-keyword",
  punct: "tok-punct",
};

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

function paint(text: string): void {
  const nodes: Node[] = [];
  for (const token of tokenize(text)) {
    if (token.kind === "plain") {
      nodes.push(document.createTextNode(token.text));
      continue;
    }
    const span = document.createElement("span");
    span.className = TOKEN_CLASS[token.kind];
    span.textContent = token.text;
    nodes.push(span);
  }
  codeBody.replaceChildren(...nodes);
}

function clear(): void {
  formatted = "";
  codeBody.replaceChildren();
  meta.textContent = "";
  result.hidden = true;
  copyButton.hidden = true;
  original.hidden = true;
  originalText.textContent = "";
}

async function render(text: string, title: string): Promise<void> {
  clear();
  const current = ++generation;
  summary.textContent = title || "当前条目";

  if (text.trim() === "") {
    setStatus("条目为空，没有可解析的 JSON。");
    return;
  }

  setStatus("正在用 Prettier 解析…");
  const outcome = await formatJSON(text);
  if (current !== generation) return;

  if (!outcome.ok) {
    setStatus(`解析失败：${outcome.reason}`);
    originalText.textContent = text;
    original.hidden = false;
    return;
  }

  formatted = outcome.text;
  paint(formatted);
  meta.textContent = `${lineCount(formatted)} 行 · ${formatBytes(new TextEncoder().encode(formatted).length)}`;
  setStatus("");
  result.hidden = false;
  copyButton.hidden = false;
}

async function copy(): Promise<void> {
  if (formatted === "") return;
  const answer = await bridge.copy(formatted);
  setStatus(answer.ok ? "已复制格式化后的 JSON。" : `复制失败：${answer.message ?? "宿主没有响应"}`);
}

copyButton.addEventListener("click", () => {
  void copy();
});

bridge.onItem(({ item }) => {
  void render(item.text, item.title);
});
