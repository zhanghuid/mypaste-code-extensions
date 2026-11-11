/**
 * 代码卡片工作台：把本次调用的文本条目画成一张卡片，另存为新条目或复制到
 * 剪贴板。卡片完全在本地绘制——没有网络请求，也没有宿主绑定。
 *
 * 页面按 carbon.now.sh 的编辑器界面组织：一条 40px 工具栏（主题、语言、编辑、
 * 设置、复制、导出、关闭），一块带留白的画布，编辑时工具栏下方展开一块内容
 * 编辑区，以及 316px 的设置浮层（背景色板 + 十六进制输入 +「窗口 / 编辑器」
 * 两栏）。背景只在浮层里选，工具栏不再放第二个入口。页面外观跟随宿主的主题
 * 消息（D-1042/D-1043），卡片本身默认也用同一组颜色（「跟随宿主」）。
 *
 * 画布按舞台真正给出的宽度排版，长行默认在那里折行，所以页面不会出现横向
 * 滚动条；这一条与「自动换行」开关共用同一个布局入口。
 *
 * 这份文档声明 chrome: "page"（D-1097）：宿主不画自己的标题栏和底部动作条，
 * 关闭由页面的方块 X 与 Esc 经桥的 close 请求交回宿主。
 */

import { connectSurface } from "./bridge";
import {
  CARD_FONT_STACK,
  CODE_CARD_THEMES,
  DEFAULT_CODE_CARD_OPTIONS,
  cardSource,
  drawCodeCard,
  resolveBackground,
  resolvePalette,
  type CodeCardLayout,
  type CodeCardOptions,
  type CodeCardSource,
  type CodeCardTheme,
  type CodeWindowStyle,
  type HostTheme,
} from "./card";
import {
  CODE_LANGUAGES,
  LANGUAGE_LABELS,
  isCodeLanguage,
  tokenizeCode,
  type CodeToken,
} from "./tokenize";

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
const settingsButton = one<HTMLButtonElement>("#settings-button");
const settingsPopout = one<HTMLElement>("#settings-popout");
const resetButton = one<HTMLButtonElement>("#reset-options");
const presetRow = one<HTMLElement>("#background-presets");
const backgroundHex = one<HTMLInputElement>("#background-hex");
const exportMenuButton = one<HTMLButtonElement>("#export-menu-button");
const exportMenu = one<HTMLElement>("#export-menu");
const closeButton = one<HTMLButtonElement>("#close-button");
const editButton = one<HTMLButtonElement>("#edit-button");
const editorCard = one<HTMLElement>("#card-editor");
const editorHighlight = one<HTMLElement>("#editor-highlight");
const editorInput = one<HTMLTextAreaElement>("#card-editor-input");
const wrapLines = one<HTMLInputElement>("#wrap-lines");
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
/** The card as last drawn; a click on it reads its lines to find the caret. */
let layout: CodeCardLayout | null = null;
/** Whether the card is being edited in place. */
let editing = false;
/** The room the stage gives the canvas, in CSS pixels; 0 before the first paint. */
let available = 0;
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
  }
}

/* ------------------------------------------------------------------ paint */

function draw(): void {
  pendingFrame = 0;
  // The stage's own content box is what the card has to live in — it already
  // excludes the scrollbar when one is showing. With wrapping on the layout
  // breaks lines at this width, so the card never pushes the stage sideways.
  available = Math.max(0, stage.clientWidth);
  const palette = resolvePalette(options.theme, hostTheme);
  const background = resolveBackground(options, palette);
  if (background === null) {
    stage.classList.add("is-transparent");
    stage.style.backgroundColor = "";
  } else {
    stage.classList.remove("is-transparent");
    stage.style.backgroundColor = background;
  }

  source = cardSource(itemText, itemTitle, options.language);
  if (!source) {
    layout = null;
    preview.hidden = true;
    stageEmpty.hidden = editing;
    return;
  }
  preview.hidden = editing;
  stageEmpty.hidden = true;
  layout = drawCodeCard(preview, source, options, hostTheme, available);
  preview.style.width = `${layout.width}px`;
  preview.style.height = `${layout.height}px`;
}

function scheduleDraw(): void {
  if (pendingFrame) return;
  pendingFrame = window.requestAnimationFrame(draw);
}

/** The card's settings changed: repaint, and repaint the editor if it is up. */
function update(): void {
  reflect();
  if (editing) {
    draw();
    renderEditor();
    return;
  }
  scheduleDraw();
}

/* ---------------------------------------------------------------- editing */

function escapeHTML(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * The editor is the card itself — same surface, band, padding and type — so the
 * text does not move when the pen comes out. Its colours are the export's own:
 * the backdrop carries the token colours and the textarea types over it with the
 * caret as its only glyph.
 */
function renderEditor(): void {
  const palette = resolvePalette(options.theme, hostTheme);
  const size = layout?.fontSize ?? Math.round(options.fontSize);
  const line = layout?.lineHeight ?? Math.max(size + 2, Math.round(size * (options.lineHeight / 100)));
  editorCard.style.setProperty("--card-surface", palette.surface);
  editorCard.style.setProperty("--card-ink", palette.ink);
  editorCard.style.setProperty("--card-muted", palette.muted);
  editorCard.style.setProperty("--card-shadow-color", palette.shadow);
  editorCard.style.setProperty("--card-shadow-y", `${options.shadowOffset}px`);
  editorCard.style.setProperty("--card-shadow-blur", `${options.shadowBlur}px`);
  editorCard.style.setProperty("--card-font", `${size}px/${line}px ${CARD_FONT_STACK}`);
  editorCard.dataset.window = options.windowStyle;
  editorCard.dataset.shadow = String(options.shadow);
  // The editor carries the card's own width, so nothing shifts sideways when
  // the pen comes out and the wrap is the same one the export uses.
  if (layout) editorCard.style.width = `${layout.cardWidth}px`;
  else editorCard.style.width = "";

  // The editor edits what the entry holds, so the highlighting comes from this
  // text rather than from the copy the card re-indents for a one-line snippet.
  const tokens: CodeToken[] = itemText
    ? tokenizeCode(itemText, source?.language ?? "javascript")
    : [];
  editorHighlight.innerHTML = tokens
    .map(
      (token) =>
        `<span style="color:${palette.tokens[token.kind] ?? palette.ink}">${escapeHTML(token.text)}</span>`,
    )
    .join("");
  // The textarea grows with its text; the backdrop in the same grid cell then
  // sizes the card, so the editor is as tall as what is being written.
  editorInput.style.height = "auto";
  editorInput.style.height = `${editorInput.scrollHeight}px`;
}

/** The column a pointer landed on, measured with the card's own font. */
function columnAt(text: string, x: number): number {
  const context = preview.getContext("2d");
  if (!context || x <= 0) return 0;
  context.font = `${layout?.fontSize ?? Math.round(options.fontSize)}px ${CARD_FONT_STACK}`;
  let column = 0;
  while (column < text.length) {
    if (context.measureText(text.slice(0, column + 1)).width > x) break;
    column += 1;
  }
  return column;
}

/** Where a click on the card lands, as an offset in the item's own text. */
function caretFromPoint(event: PointerEvent): number {
  if (!layout) return itemText.length;
  const rect = preview.getBoundingClientRect();
  const x = event.clientX - rect.left - layout.paddingX - layout.contentLeft;
  const y = event.clientY - rect.top - layout.paddingY - layout.barHeight;
  const index = Math.max(
    0,
    Math.min(layout.lines.length - 1, Math.floor(y / layout.lineHeight)),
  );
  const line = layout.lines[index] ?? [];
  const text = line.map((token) => token.text).join("");
  const offset = (layout.lineStarts[index] ?? 0) + columnAt(text, x);
  return Math.max(0, Math.min(itemText.length, offset));
}

/**
 * Editing happens in place, and only for this invocation: nothing is written
 * back, so closing the surface leaves the history as it was. A click on the
 * code opens the editor with the caret where the click landed; Escape and a
 * click on the stage around it put the card back.
 */
function setEditing(open: boolean, caret?: number): void {
  if (open === editing) {
    if (open && caret !== undefined) editorInput.setSelectionRange(caret, caret);
    return;
  }
  editing = open;
  editButton.setAttribute("aria-pressed", String(open));
  editorCard.hidden = !open;
  if (!open) {
    editorInput.blur();
    draw();
    return;
  }
  closePopovers();
  editorInput.value = itemText;
  renderEditor();
  draw();
  editorInput.focus();
  const at = Math.max(0, Math.min(itemText.length, caret ?? itemText.length));
  editorInput.setSelectionRange(at, at);
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
  wrapLines.checked = options.wrap;
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
  update();
}

/* ------------------------------------------------------------------ wiring */

function wire(): void {
  buildPickers();
  buildBackgrounds();

  themeSelect.addEventListener("change", () => {
    options.theme = themeSelect.value as CodeCardTheme;
    update();
  });
  languageSelect.addEventListener("change", () => {
    const value = languageSelect.value;
    options.language = value === "auto" || !isCodeLanguage(value) ? "auto" : value;
    update();
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
    update();
  });
  presetRow.addEventListener("click", (event) => {
    const preset = (event.target as HTMLElement).closest<HTMLElement>("[data-background]");
    if (preset) chooseBackground(preset.dataset.background ?? "host");
  });

  for (const button of all<HTMLButtonElement>("[data-window-style]")) {
    button.addEventListener("click", () => {
      options.windowStyle = (button.dataset.windowStyle ?? "mac") as CodeWindowStyle;
      update();
    });
  }

  paddingX.addEventListener("input", () => {
    options.paddingX = Number(paddingX.value);
    update();
  });
  paddingY.addEventListener("input", () => {
    options.paddingY = Number(paddingY.value);
    update();
  });
  shadowToggle.addEventListener("change", () => {
    options.shadow = shadowToggle.checked;
    update();
  });
  shadowOffset.addEventListener("input", () => {
    options.shadowOffset = Number(shadowOffset.value);
    update();
  });
  shadowBlur.addEventListener("input", () => {
    options.shadowBlur = Number(shadowBlur.value);
    update();
  });
  autoWidth.addEventListener("change", () => {
    options.autoWidth = autoWidth.checked;
    update();
  });
  fontSize.addEventListener("input", () => {
    options.fontSize = Number(fontSize.value);
    update();
  });
  lineHeight.addEventListener("input", () => {
    options.lineHeight = Number(lineHeight.value);
    update();
  });
  lineNumbers.addEventListener("change", () => {
    options.lineNumbers = lineNumbers.checked;
    update();
  });
  wrapLines.addEventListener("change", () => {
    options.wrap = wrapLines.checked;
    update();
  });

  // The code is the editor: a click on the card puts the caret where it landed.
  preview.addEventListener("pointerdown", (event) => {
    setEditing(true, caretFromPoint(event));
  });
  stage.addEventListener("pointerdown", (event) => {
    if (!editing || event.target === preview) return;
    if (editorCard.contains(event.target as Node)) return;
    setEditing(false);
  });
  editorInput.addEventListener("input", () => {
    itemText = editorInput.value;
    draw();
    renderEditor();
  });
  editorInput.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setEditing(false);
      editButton.focus();
      return;
    }
    if (event.key !== "Tab") return;
    // Tab indents in the editor instead of leaving it for the next control.
    event.preventDefault();
    editorInput.setRangeText(
      "  ",
      editorInput.selectionStart,
      editorInput.selectionEnd,
      "end",
    );
    itemText = editorInput.value;
    draw();
    renderEditor();
  });
  editButton.addEventListener("click", () => setEditing(!editing));

  // The card is painted to the room the stage actually has, so a resized window
  // re-wraps instead of waiting for the next setting change. Wrapping only
  // shortens as the room shrinks, so this settles instead of ping-ponging.
  if (typeof ResizeObserver === "function") {
    new ResizeObserver(() => {
      if (Math.abs(stage.clientWidth - available) < 1) return;
      scheduleDraw();
    }).observe(stage);
  }

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
      update();
      closePopovers();
    });
  }

  document.addEventListener("pointerdown", (event) => {
    const target = event.target as Node;
    if (
      settingsPopout.contains(target) ||
      exportMenu.contains(target) ||
      settingsButton.contains(target) ||
      exportMenuButton.contains(target)
    ) {
      return;
    }
    closePopovers();
  });
  // The host never sees a key pressed inside this page, and this page draws the
  // card's chrome, so Escape is its own: an open popover closes first, then the
  // editor, and only then does it ask the container to close the surface
  // (D-1097). A key pressed in the editor never reaches this listener.
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (!settingsPopout.hidden || !exportMenu.hidden) closePopovers();
    else if (editing) setEditing(false);
    else bridge.close();
  });
  closeButton.addEventListener("click", () => bridge.close());

  bridge.onItem((item) => {
    if (editing) setEditing(false);
    itemText = item.kind === "text" ? item.text : "";
    itemTitle = item.title;
    // Each entry is read on its own terms: a language kept from the last one
    // scans this text with the wrong token set, which is how an HTML line got
    // drawn as plain text. The rail returns to detection for the new item.
    options.language = "auto";
    reflect();
    draw();
  });
  bridge.onTheme((next) => {
    hostTheme = next;
    update();
  });
}

wire();
reflect();
draw();
