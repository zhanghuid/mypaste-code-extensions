/**
 * 代码卡片工作台：把本次调用的文本条目画成一张卡片，另存为新条目或复制到
 * 剪贴板。卡片完全在本地绘制——没有网络请求，也没有宿主绑定。
 *
 * 页面自己的外观跟随宿主的主题消息（D-1042/D-1043）；卡片本身默认也用同一
 * 组颜色（「跟随宿主」），所以导出的图片和读者正在看的代码表面一致。
 */

import { connectSurface, type SurfaceTheme } from "./bridge";
import {
  CODE_CARD_THEMES,
  DEFAULT_CODE_CARD_OPTIONS,
  cardSource,
  drawCodeCard,
  type CodeCardOptions,
  type CodeCardSource,
  type CodeCardTheme,
  type CodeWindowStyle,
  type CodeCardLayout,
} from "./card";
import {
  CODE_LANGUAGES,
  LANGUAGE_LABELS,
  isCodeLanguage,
} from "./tokenize";

const bridge = connectSurface();

function one<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`工作台文档缺少 ${selector}`);
  return element;
}

const preview = one<HTMLCanvasElement>("#card-preview");
const titleInput = one<HTMLInputElement>("#card-title");
const themeSelect = one<HTMLSelectElement>("#card-theme");
const languageSelect = one<HTMLSelectElement>("#card-language");
const windowSelect = one<HTMLSelectElement>("#card-window");
const lineNumbers = one<HTMLInputElement>("#card-lines");
const shadowToggle = one<HTMLInputElement>("#card-shadow");
const transparentToggle = one<HTMLInputElement>("#card-transparent");
const fontSize = one<HTMLInputElement>("#card-font");
const fontSizeValue = one<HTMLOutputElement>("#card-font-value");
const padding = one<HTMLInputElement>("#card-padding");
const paddingValue = one<HTMLOutputElement>("#card-padding-value");
const scaleSelect = one<HTMLSelectElement>("#card-scale");
const sizeOutput = one<HTMLOutputElement>("#card-size");
const saveButton = one<HTMLButtonElement>("[data-action=save]");
const copyButton = one<HTMLButtonElement>("[data-action=copy]");
const closeButton = one<HTMLButtonElement>("[data-action=close]");
const status = one<HTMLElement>("#card-status");

const options: CodeCardOptions = { ...DEFAULT_CODE_CARD_OPTIONS };
let source: CodeCardSource | null = null;
let text = "";
let baseTitle = "";
let hostTheme: SurfaceTheme | null = bridge.theme;
let busy = false;

function fillChoices(): void {
  const host = document.createElement("option");
  host.value = "host";
  host.textContent = "跟随宿主";
  themeSelect.append(host);
  const groups = new Map<"light" | "dark", HTMLOptGroupElement>();
  for (const choice of CODE_CARD_THEMES) {
    if (choice.tone === "host") continue;
    let group = groups.get(choice.tone);
    if (!group) {
      group = document.createElement("optgroup");
      group.label = choice.tone === "light" ? "浅色" : "深色";
      groups.set(choice.tone, group);
      themeSelect.append(group);
    }
    const option = document.createElement("option");
    option.value = choice.id;
    option.textContent = choice.name;
    group.append(option);
  }

  const auto = document.createElement("option");
  auto.value = "auto";
  auto.textContent = "自动识别";
  languageSelect.append(auto);
  for (const language of CODE_LANGUAGES) {
    const option = document.createElement("option");
    option.value = language;
    option.textContent = LANGUAGE_LABELS[language];
    languageSelect.append(option);
  }
}

function setStatus(message: string, failed = false): void {
  status.textContent = message;
  status.dataset.tone = failed ? "error" : "info";
  status.hidden = message === "";
}

function currentTitle(): string {
  return titleInput.value.trim() || "代码卡片";
}

function rebuildSource(): void {
  source = cardSource(text, baseTitle, options.language);
  if (!source) return;
  source.title = titleInput.value;
}

function draw(): CodeCardLayout | null {
  if (!source) return null;
  const layout = drawCodeCard(preview, source, options, hostTheme);
  preview.dataset.transparent = String(options.transparent);
  sizeOutput.textContent =
    `${layout.width} × ${layout.height} px · ${options.scale}×`;
  return layout;
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

titleInput.addEventListener("input", () => {
  if (source) source.title = titleInput.value;
  draw();
});

themeSelect.addEventListener("change", () => {
  options.theme = themeSelect.value as CodeCardTheme;
  draw();
});

languageSelect.addEventListener("change", () => {
  const value = languageSelect.value;
  options.language = isCodeLanguage(value) ? value : "auto";
  rebuildSource();
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

shadowToggle.addEventListener("change", () => {
  options.shadow = shadowToggle.checked;
  draw();
});

transparentToggle.addEventListener("change", () => {
  options.transparent = transparentToggle.checked;
  draw();
});

fontSize.addEventListener("input", () => {
  options.fontSize = Number(fontSize.value);
  fontSizeValue.textContent = `${options.fontSize} px`;
  draw();
});

padding.addEventListener("input", () => {
  options.padding = Number(padding.value);
  paddingValue.textContent = `${options.padding} px`;
  draw();
});

scaleSelect.addEventListener("change", () => {
  options.scale = Number(scaleSelect.value) === 1 ? 1 : 2;
  draw();
});

bridge.onTheme((theme) => {
  hostTheme = theme;
  if (options.theme === "host") draw();
});

bridge.onItem((item) => {
  if (item.kind !== "text") {
    setActions(false);
    setStatus("代码卡片只接受文本条目", true);
    return;
  }
  text = item.text;
  baseTitle = item.title;
  titleInput.value = item.title;
  options.language = "auto";
  languageSelect.value = "auto";
  rebuildSource();
  if (!source) {
    setActions(false);
    setStatus("这条内容没有可绘制的文本", true);
    return;
  }
  setActions(true);
  setStatus("");
  draw();
});

fillChoices();
themeSelect.value = options.theme;
languageSelect.value = options.language;
windowSelect.value = options.windowStyle;
lineNumbers.checked = options.lineNumbers;
shadowToggle.checked = options.shadow;
transparentToggle.checked = options.transparent;
fontSize.value = String(options.fontSize);
fontSizeValue.textContent = `${options.fontSize} px`;
padding.value = String(options.padding);
paddingValue.textContent = `${options.padding} px`;
scaleSelect.value = String(options.scale);
