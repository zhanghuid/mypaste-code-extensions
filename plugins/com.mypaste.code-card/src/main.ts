/**
 * 代码卡片工作台：把本次调用的文本条目画成一张卡片，另存为新条目或复制到
 * 剪贴板。卡片完全在本地绘制——没有网络请求，也没有宿主绑定。
 *
 * 页面按 carbon.now.sh 的编辑器界面组织：一条 40px 工具栏（主题、语言、背景、
 * 设置、复制、导出），一块带留白的画布，以及 316px 的设置浮层（预设条 +
 * 「窗口 / 编辑器」两栏）。页面外观跟随宿主的主题消息（D-1042/D-1043），
 * 卡片本身默认也用同一组颜色（「跟随宿主」）。
 */

import { connectSurface } from "./bridge";
import {
  CODE_CARD_THEMES,
  DEFAULT_CODE_CARD_OPTIONS,
  cardSource,
  drawCodeCard,
  resolveBackground,
  resolvePalette,
  type CodeCardOptions,
  type CodeCardSource,
  type CodeCardTheme,
  type CodeWindowStyle,
  type HostTheme,
} from "./card";
import { CODE_LANGUAGES, LANGUAGE_LABELS, isCodeLanguage } from "./tokenize";

const bridge = connectSurface();

function one<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`工作台文档缺少 ${selector}`);
  return element;
}

function all<T extends Element>(selector: string): T[] {
  return Array.from(document.querySelectorAll<T>(selector));
}

/** Carbon's eight background colours, plus the host's own and a transparent one. */
interface BackgroundChoice {
  id: string;
  name: string;
  color: string | null;
}

const BACKGROUNDS: readonly BackgroundChoice[] = [
  { id: "host", name: "跟随宿主", color: null },
  { id: "transparent", name: "透明", color: "transparent" },
  { id: "#abb8c3", name: "灰", color: "#abb8c3" },
  { id: "#4a90e2", name: "蓝", color: "#4a90e2" },
  { id: "#f8e71c", name: "黄", color: "#f8e71c" },
  { id: "#b6a291", name: "棕", color: "#b6a291" },
  { id: "#7948b9", name: "紫", color: "#7948b9" },
  { id: "#ef282c", name: "红", color: "#ef282c" },
  { id: "#1f816d", name: "绿", color: "#1f816d" },
  { id: "#deab63", name: "橙", color: "#deab63" },
];

const MINI_CARD = `<svg width="44" height="30" viewBox="0 0 44 30" fill="none" aria-hidden="true">
  <rect x="1" y="1" width="42" height="28" rx="4" fill="#ffffff" fill-opacity="0.92"/>
  <circle cx="8" cy="8" r="1.6" fill="#ff5f56"/>
  <circle cx="13" cy="8" r="1.6" fill="#ffbd2e"/>
  <circle cx="18" cy="8" r="1.6" fill="#27c93f"/>
  <rect x="7" y="15" width="24" height="2" rx="1" fill="#000000" fill-opacity="0.32"/>
  <rect x="7" y="20" width="16" height="2" rx="1" fill="#000000" fill-opacity="0.2"/>
</svg>`;

const app = one<HTMLElement>("#app");
const preview = one<HTMLCanvasElement>("#card-preview");
const stage = one<HTMLElement>("#stage");
const stageEmpty = one<HTMLElement>("#stage-empty");
const status = one<HTMLElement>("#card-status");
const themeSelect = one<HTMLSelectElement>("#card-theme");
const languageSelect = one<HTMLSelectElement>("#card-language");
const backgroundButton = one<HTMLButtonElement>("#background-button");
const settingsButton = one<HTMLButtonElement>("#settings-button");
const settingsPopout = one<HTMLElement>("#settings-popout");
const resetButton = one<HTMLButtonElement>("#reset-options");
const presetRow = one<HTMLElement>("#background-presets");
const backgroundMenu = one<HTMLElement>("#background-menu");
const backgroundOptions = one<HTMLElement>("#background-options");
const backgroundHex = one<HTMLInputElement>("#background-hex");
const exportMenuButton = one<HTMLButtonElement>("#export-menu-button");
const exportMenu = one<HTMLElement>("#export-menu");
const windowStyles = one<HTMLElement>("#window-styles");
const paddingX = one<HTMLInputElement>("#padding-x");
const paddingY = one<HTMLInputElement>("#padding-y");
const paddingXValue = one<HTMLOutputElement>("#padding-x-value");
const paddingYValue = one<HTMLOutputElement>("#padding-y-value");
const shadowToggle = one<HTMLInputElement>("#card-shadow");
const shadowControls = one<HTMLElement>("#shadow-controls");
const shadowOffset = one<HTMLInputElement>("#shadow-offset");
const shadowBlur = one<HTMLInputElement>("#shadow-blur");
const shadowOffsetValue = one<HTMLOutputElement>("#shadow-offset-value");
const shadowBlurValue = one<HTMLOutputElement>("#shadow-blur-value");
const autoWidth = one<HTMLInputElement>("#auto-width");
const fontSize = one<HTMLInputElement>("#font-size");
const fontSizeValue = one<HTMLOutputElement>("#font-size-value");
const lineHeight = one<HTMLInputElement>("#line-height");
const lineHeightValue = one<HTMLOutputElement>("#line-height-value");
const lineNumbers = one<HTMLInputElement>("#line-numbers");

let options: CodeCardOptions = { ...DEFAULT_CODE_CARD_OPTIONS };
let hostTheme: HostTheme | null = null;
let itemText = "";
let itemTitle = "";
let source: CodeCardSource | null = null;
let pendingFrame = 0;
let statusTimer = 0;

/* ---------------------------------------------------------------- pickers */

function option(value: string, label: string): HTMLOptionElement {
  const element = document.createElement("option");
  element.value = value;
  element.textContent = label;
  return element;
}

function buildPickers(): void {
  const groups = new Map<string, HTMLOptGroupElement>();
  for (const choice of CODE_CARD_THEMES) {
    const element = option(choice.id, choice.name);
    if (choice.tone === "host") {
      themeSelect.append(element);
      continue;
    }
    const label = choice.tone === "light" ? "浅色" : "深色";
    let group = groups.get(label);
    if (!group) {
      group = document.createElement("optgroup");
      group.label = label;
      themeSelect.append(group);
      groups.set(label, group);
    }
    group.append(element);
  }
  languageSelect.append(option("auto", "自动识别"));
  for (const language of CODE_LANGUAGES) {
    languageSelect.append(option(language, LANGUAGE_LABELS[language]));
  }
}

function buildBackgrounds(): void {
  for (const choice of BACKGROUNDS) {
    const preset = document.createElement("button");
    preset.type = "button";
    preset.className = "preset";
    preset.dataset.background = choice.id;
    preset.setAttribute("aria-label", choice.name);
    preset.innerHTML = MINI_CARD;
    if (choice.id === "transparent") preset.classList.add("is-transparent");
    else if (choice.color) preset.style.backgroundColor = choice.color;
    presetRow.append(preset);

    const swatch = document.createElement("button");
    swatch.type = "button";
    swatch.className = "bg-choice";
    swatch.dataset.background = choice.id;
    swatch.setAttribute("aria-label", choice.name);
    if (choice.id === "transparent") swatch.classList.add("is-transparent");
    else if (choice.color) swatch.style.backgroundColor = choice.color;
    backgroundOptions.append(swatch);
  }
}

/* ------------------------------------------------------------------ paint */

function draw(): void {
  pendingFrame = 0;
  const palette = resolvePalette(options.theme, hostTheme);
  const background = resolveBackground(options, palette);
  if (background === null) {
    stage.classList.add("is-transparent");
    stage.style.backgroundColor = "";
    backgroundButton.classList.add("is-transparent");
    backgroundButton.style.backgroundColor = "";
  } else {
    stage.classList.remove("is-transparent");
    stage.style.backgroundColor = background;
    backgroundButton.classList.remove("is-transparent");
    backgroundButton.style.backgroundColor = background;
  }

  source = cardSource(itemText, itemTitle, options.language);
  if (!source) {
    preview.hidden = true;
    stageEmpty.hidden = false;
    return;
  }
  preview.hidden = false;
  stageEmpty.hidden = true;
  const layout = drawCodeCard(preview, source, options, hostTheme);
  preview.style.width = `${layout.width}px`;
  preview.style.height = `${layout.height}px`;
}

function scheduleDraw(): void {
  if (pendingFrame) return;
  pendingFrame = window.requestAnimationFrame(draw);
}

function reflect(): void {
  themeSelect.value = options.theme;
  languageSelect.value = options.language;
  paddingX.value = String(options.paddingX);
  paddingY.value = String(options.paddingY);
  paddingXValue.textContent = String(options.paddingX);
  paddingYValue.textContent = String(options.paddingY);
  shadowToggle.checked = options.shadow;
  shadowOffset.value = String(options.shadowOffset);
  shadowBlur.value = String(options.shadowBlur);
  shadowOffsetValue.textContent = String(options.shadowOffset);
  shadowBlurValue.textContent = String(options.shadowBlur);
  shadowControls.dataset.disabled = String(!options.shadow);
  autoWidth.checked = options.autoWidth;
  fontSize.value = String(options.fontSize);
  fontSizeValue.textContent = String(options.fontSize);
  lineHeight.value = String(options.lineHeight);
  lineHeightValue.textContent = `${options.lineHeight}%`;
  lineNumbers.checked = options.lineNumbers;
  for (const button of all<HTMLButtonElement>("[data-window-style]")) {
    button.setAttribute(
      "aria-pressed",
      String(button.dataset.windowStyle === options.windowStyle),
    );
  }
  for (const preset of all<HTMLElement>("[data-background]")) {
    preset.setAttribute("aria-pressed", String(preset.dataset.background === options.background));
  }
  for (const entry of all<HTMLButtonElement>("[data-scale]")) {
    entry.setAttribute("aria-checked", String(Number(entry.dataset.scale) === options.scale));
  }
  backgroundHex.value =
    options.background.startsWith("#") ? options.background.slice(1).toUpperCase() : "";
}

/* ---------------------------------------------------------------- actions */

let busy = false;

function showStatus(message: string): void {
  window.clearTimeout(statusTimer);
  status.textContent = message;
  status.classList.add("is-visible");
  statusTimer = window.setTimeout(() => status.classList.remove("is-visible"), 2600);
}

function pngDataURL(): string {
  return preview.toDataURL("image/png");
}

async function saveImage(): Promise<void> {
  if (!source || busy) return;
  busy = true;
  try {
    const result = await bridge.save(pngDataURL(), source.title);
    showStatus(result.ok ? "已保存为新的图片条目" : result.message || "保存失败");
  } finally {
    busy = false;
  }
}

async function copyImage(): Promise<void> {
  if (!source || busy) return;
  busy = true;
  try {
    const result = await bridge.copy(pngDataURL());
    showStatus(result.ok ? "已复制到剪贴板" : result.message || "复制失败");
  } finally {
    busy = false;
  }
}

/* ---------------------------------------------------------------- popovers */

function closePopovers(except?: HTMLElement): void {
  for (const [panel, toggle] of [
    [settingsPopout, settingsButton],
    [exportMenu, exportMenuButton],
    [backgroundMenu, backgroundButton],
  ] as const) {
    if (panel === except) continue;
    panel.hidden = true;
    toggle.setAttribute("aria-expanded", "false");
  }
}

function togglePanel(panel: HTMLElement, toggle: HTMLElement): void {
  const open = panel.hidden;
  closePopovers(open ? panel : undefined);
  panel.hidden = !open;
  toggle.setAttribute("aria-expanded", String(open));
}

function placeBackgroundMenu(): void {
  const appRect = app.getBoundingClientRect();
  const buttonRect = backgroundButton.getBoundingClientRect();
  const width = backgroundMenu.offsetWidth || 236;
  const left = Math.max(
    8,
    Math.min(buttonRect.left - appRect.left, appRect.width - width - 8),
  );
  backgroundMenu.style.left = `${left}px`;
}

/** Carbon anchors the settings popout under the gear, with a caret pointing at it. */
function placeSettings(): void {
  const appRect = app.getBoundingClientRect();
  const buttonRect = settingsButton.getBoundingClientRect();
  const width = settingsPopout.offsetWidth || 316;
  const left = Math.max(
    8,
    Math.min(buttonRect.left - appRect.left, appRect.width - width - 8),
  );
  settingsPopout.style.left = `${left}px`;
  const caret = Math.round(buttonRect.left + buttonRect.width / 2 - appRect.left - left - 5);
  settingsPopout.style.setProperty("--caret-x", `${caret}px`);
}

function setPane(name: string): void {
  for (const tab of all<HTMLButtonElement>("[data-pane]")) {
    tab.setAttribute("aria-selected", String(tab.dataset.pane === name));
  }
  for (const pane of all<HTMLElement>("[data-pane-body]")) {
    pane.hidden = pane.dataset.paneBody !== name;
  }
}

function chooseBackground(id: string): void {
  options.background = id;
  reflect();
  scheduleDraw();
}

/* ------------------------------------------------------------------ wiring */

function wire(): void {
  buildPickers();
  buildBackgrounds();

  themeSelect.addEventListener("change", () => {
    options.theme = themeSelect.value as CodeCardTheme;
    reflect();
    scheduleDraw();
  });
  languageSelect.addEventListener("change", () => {
    const value = languageSelect.value;
    options.language = value === "auto" || !isCodeLanguage(value) ? "auto" : value;
    reflect();
    scheduleDraw();
  });

  backgroundButton.addEventListener("click", () => {
    if (backgroundMenu.hidden) placeBackgroundMenu();
    togglePanel(backgroundMenu, backgroundButton);
  });
  backgroundMenu.addEventListener("click", (event) => {
    const choice = (event.target as HTMLElement).closest<HTMLElement>("[data-background]");
    if (!choice) return;
    chooseBackground(choice.dataset.background ?? "host");
  });
  backgroundHex.addEventListener("change", () => {
    const value = backgroundHex.value.trim().replace(/^#/, "");
    if (/^[0-9a-f]{6}$/i.test(value)) chooseBackground(`#${value.toLowerCase()}`);
    else reflect();
  });

  settingsButton.addEventListener("click", () => {
    const opening = settingsPopout.hidden;
    togglePanel(settingsPopout, settingsButton);
    if (opening) placeSettings();
  });
  for (const tab of all<HTMLButtonElement>("[data-pane]")) {
    tab.addEventListener("click", () => setPane(tab.dataset.pane ?? "window"));
  }
  resetButton.addEventListener("click", () => {
    options = { ...DEFAULT_CODE_CARD_OPTIONS };
    reflect();
    scheduleDraw();
  });
  presetRow.addEventListener("click", (event) => {
    const preset = (event.target as HTMLElement).closest<HTMLElement>("[data-background]");
    if (preset) chooseBackground(preset.dataset.background ?? "host");
  });

  for (const button of all<HTMLButtonElement>("[data-window-style]")) {
    button.addEventListener("click", () => {
      options.windowStyle = (button.dataset.windowStyle ?? "mac") as CodeWindowStyle;
      reflect();
      scheduleDraw();
    });
  }

  paddingX.addEventListener("input", () => {
    options.paddingX = Number(paddingX.value);
    reflect();
    scheduleDraw();
  });
  paddingY.addEventListener("input", () => {
    options.paddingY = Number(paddingY.value);
    reflect();
    scheduleDraw();
  });
  shadowToggle.addEventListener("change", () => {
    options.shadow = shadowToggle.checked;
    reflect();
    scheduleDraw();
  });
  shadowOffset.addEventListener("input", () => {
    options.shadowOffset = Number(shadowOffset.value);
    reflect();
    scheduleDraw();
  });
  shadowBlur.addEventListener("input", () => {
    options.shadowBlur = Number(shadowBlur.value);
    reflect();
    scheduleDraw();
  });
  autoWidth.addEventListener("change", () => {
    options.autoWidth = autoWidth.checked;
    reflect();
    scheduleDraw();
  });
  fontSize.addEventListener("input", () => {
    options.fontSize = Number(fontSize.value);
    reflect();
    scheduleDraw();
  });
  lineHeight.addEventListener("input", () => {
    options.lineHeight = Number(lineHeight.value);
    reflect();
    scheduleDraw();
  });
  lineNumbers.addEventListener("change", () => {
    options.lineNumbers = lineNumbers.checked;
    reflect();
    scheduleDraw();
  });

  for (const button of all<HTMLButtonElement>("[data-action]")) {
    button.addEventListener("click", () => {
      closePopovers();
      if (button.dataset.action === "save") void saveImage();
      else void copyImage();
    });
  }
  exportMenuButton.addEventListener("click", () => togglePanel(exportMenu, exportMenuButton));
  for (const entry of all<HTMLButtonElement>("[data-scale]")) {
    entry.addEventListener("click", () => {
      options.scale = Number(entry.dataset.scale) === 1 ? 1 : 2;
      reflect();
      scheduleDraw();
      closePopovers();
    });
  }

  document.addEventListener("pointerdown", (event) => {
    const target = event.target as Node;
    if (
      settingsPopout.contains(target) ||
      exportMenu.contains(target) ||
      backgroundMenu.contains(target) ||
      settingsButton.contains(target) ||
      exportMenuButton.contains(target) ||
      backgroundButton.contains(target)
    ) {
      return;
    }
    closePopovers();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closePopovers();
  });

  bridge.onItem((item) => {
    itemText = item.kind === "text" ? item.text : "";
    itemTitle = item.title;
    draw();
  });
  bridge.onTheme((next) => {
    hostTheme = next;
    scheduleDraw();
  });
}

wire();
reflect();
draw();
