/**
 * 代码卡片工作台：把本次调用的文本条目画成一张卡片，另存为新条目或复制到
 * 剪贴板。卡片完全在本地绘制——没有网络请求，也没有宿主绑定。
 */

import { connectSurface } from "./bridge";
import {
  DEFAULT_CODE_CARD_OPTIONS,
  cardSource,
  drawCodeCard,
  type CodeCardOptions,
  type CodeCardSource,
  type CodeCardTheme,
  type CodeWindowStyle,
} from "./card";

const bridge = connectSurface();

function one<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`工作台文档缺少 ${selector}`);
  return element;
}

const preview = one<HTMLCanvasElement>("#card-preview");
const titleInput = one<HTMLInputElement>("#card-title");
const themeSelect = one<HTMLSelectElement>("#card-theme");
const windowSelect = one<HTMLSelectElement>("#card-window");
const lineNumbers = one<HTMLInputElement>("#card-lines");
const fontScale = one<HTMLInputElement>("#card-scale");
const scaleValue = one<HTMLOutputElement>("#card-scale-value");
const saveButton = one<HTMLButtonElement>("[data-action=save]");
const copyButton = one<HTMLButtonElement>("[data-action=copy]");
const closeButton = one<HTMLButtonElement>("[data-action=close]");
const status = one<HTMLElement>("#card-status");

const options: CodeCardOptions = { ...DEFAULT_CODE_CARD_OPTIONS };
let source: CodeCardSource | null = null;
let busy = false;

function setStatus(text: string, failed = false): void {
  status.textContent = text;
  status.dataset.tone = failed ? "error" : "info";
  status.hidden = text === "";
}

function currentTitle(): string {
  return titleInput.value.trim() || "代码卡片";
}

function draw(): void {
  if (!source) return;
  source.title = currentTitle();
  drawCodeCard(preview, source, options);
}

function setActions(enabled: boolean): void {
  saveButton.disabled = !enabled;
  copyButton.disabled = !enabled;
}

async function run(action: () => Promise<void>): Promise<void> {
  if (!source || busy) return;
  busy = true;
  setActions(false);
  try {
    draw();
    await action();
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "操作失败", true);
  } finally {
    busy = false;
    setActions(true);
  }
}

saveButton.addEventListener("click", () => {
  void run(async () => {
    const result = await bridge.save(preview.toDataURL("image/png"), currentTitle());
    setStatus(
      result.ok ? `已保存为新条目 #${result.id ?? ""}` : (result.message || "保存失败"),
      !result.ok,
    );
  });
});

copyButton.addEventListener("click", () => {
  void run(async () => {
    const result = await bridge.copy(preview.toDataURL("image/png"));
    setStatus(result.ok ? "已复制为图片" : (result.message || "复制失败"), !result.ok);
  });
});

closeButton.addEventListener("click", () => bridge.close());

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") bridge.close();
});

titleInput.addEventListener("input", draw);
themeSelect.addEventListener("change", () => {
  options.theme = themeSelect.value as CodeCardTheme;
  draw();
});
windowSelect.addEventListener("change", () => {
  options.windowStyle = windowSelect.value as CodeWindowStyle;
  draw();
});
lineNumbers.addEventListener("change", () => {
  options.lineNumbers = lineNumbers.checked;
  draw();
});
fontScale.addEventListener("input", () => {
  options.fontScale = Number(fontScale.value);
  scaleValue.textContent = `${Math.round(options.fontScale * 100)}%`;
  draw();
});

bridge.onItem((item) => {
  if (item.kind !== "text") {
    setActions(false);
    setStatus("代码卡片只接受文本条目", true);
    return;
  }
  titleInput.value = item.title;
  source = cardSource(item.text, item.title);
  if (!source) {
    setActions(false);
    setStatus("这条内容没有可绘制的文本", true);
    return;
  }
  setActions(true);
  setStatus("");
  draw();
});
