/**
 * 图片编辑工作台：裁剪、旋转、翻转与标注都在本文档的 canvas 上完成；
 * 成品只经宿主的桥另存为新条目或复制到剪贴板，原图保持不动。
 */

import { connectSurface } from "./bridge";
import {
  EDITOR_COLORS,
  applyCrop,
  clampZoom,
  emptyHistory,
  exportEditorPNG,
  fitWithin,
  fitZoom,
  initialState,
  newAnnotation,
  normalizeRect,
  orientSize,
  recordHistory,
  redoHistory,
  renderEditor,
  renderSideScale,
  rotateClockwise,
  stepZoom,
  toggleFlip,
  undoHistory,
  workingSize,
  type ImageAnnotation,
  type ImageEditorHistory,
  type ImageEditorState,
  type ImagePoint,
  type ImageRect,
  type ImageTool,
} from "./editor";

const bridge = connectSurface();

function one<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`工作台文档缺少 ${selector}`);
  return element;
}

const canvas = one<HTMLCanvasElement>("#image-canvas");
const scroll = one<HTMLElement>("#image-scroll");
const tools = [...document.querySelectorAll<HTMLButtonElement>("[data-image-tool]")];
const colors = one<HTMLElement>("#image-colors");
const sizeInput = one<HTMLInputElement>("#image-size");
const sizeValue = one<HTMLOutputElement>("#image-size-value");
const output = one<HTMLElement>("#image-output");
const hint = one<HTMLElement>("#image-hint");
const toolTitle = one<HTMLElement>("#image-tool-title");
const status = one<HTMLElement>("#image-status");
const titleInput = one<HTMLInputElement>("#image-title");
const zoomValue = one<HTMLOutputElement>("#image-zoom");
const zoomIn = one<HTMLButtonElement>("#image-zoom-in");
const zoomOut = one<HTMLButtonElement>("#image-zoom-out");
const zoomFit = one<HTMLButtonElement>("#image-zoom-fit");
const cropApply = one<HTMLButtonElement>("#image-crop-apply");
const undoButton = one<HTMLButtonElement>("#image-undo");
const redoButton = one<HTMLButtonElement>("#image-redo");
const saveButton = one<HTMLButtonElement>("[data-action=save]");
const copyButton = one<HTMLButtonElement>("[data-action=copy]");
const textEntry = one<HTMLElement>("#image-text-entry");
const textInput = one<HTMLInputElement>("#image-text-input");

interface Session {
  image: CanvasImageSource;
  width: number;
  height: number;
  state: ImageEditorState;
  history: ImageEditorHistory;
  tool: ImageTool;
  color: string;
  size: number;
  dragStart: ImagePoint | null;
  draft: { tool: ImageAnnotation["tool"]; points: ImagePoint[] } | null;
  cropDraft: ImageRect | null;
  /** "fit" follows the stage; a number is CSS pixels per image pixel. */
  zoom: number | "fit";
}

let session: Session | null = null;
let textPoint: ImagePoint | null = null;
let busy = false;

const TOOL_LABELS: Record<ImageTool, string> = {
  crop: "裁剪",
  pen: "画笔",
  rect: "方框",
  arrow: "箭头",
  mosaic: "马赛克",
  text: "文字",
};

const TOOL_HINTS: Record<ImageTool, string> = {
  crop: "裁剪：拖出一个区域后点“应用裁剪”。",
  pen: "画笔：在图片上拖动即可标注。",
  rect: "方框：拖动出一个矩形范围。",
  arrow: "箭头：从起点拖向终点。",
  mosaic: "马赛克：拖动选中的范围会被像素化。",
  text: "文字：点击图片上的位置后输入。",
};

function setStatus(message: string, failed = false): void {
  status.textContent = message;
  status.dataset.tone = failed ? "error" : "info";
}

function loadImage(dataURL: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("图片无法读取"));
    image.src = dataURL;
  });
}

function draftState(current: Session): ImageEditorState {
  if (!current.draft) return current.state;
  const annotation = newAnnotation(
    current.draft.tool,
    current.color,
    current.size,
    current.draft.points,
    { block: 12 },
  );
  return { ...current.state, annotations: [...current.state.annotations, annotation] };
}

function fitScale(crop: ImageRect): number {
  return fitZoom(crop.width, crop.height, scroll.clientWidth - 28, scroll.clientHeight - 28);
}

function currentScale(crop: ImageRect): number {
  if (!session) return 1;
  return session.zoom === "fit" ? fitScale(crop) : clampZoom(session.zoom);
}

function updateZoomControls(scale: number): void {
  zoomValue.textContent = `${Math.round(scale * 100)}%`;
  zoomFit.setAttribute("aria-pressed", String(session?.zoom === "fit"));
  zoomOut.disabled = scale <= 0.0501;
  zoomIn.disabled = scale >= 7.9999;
}

function redraw(): void {
  const current = session;
  if (!current) return;
  const { crop } = workingSize(current.state, current.width, current.height);
  const scale = currentScale(crop);
  const renderScale = renderSideScale(scale, crop.width, crop.height);
  renderEditor(canvas, current.image, current.width, current.height, draftState(current), renderScale);
  canvas.style.width = `${Math.max(1, Math.round(scale * crop.width))}px`;
  canvas.style.height = `${Math.max(1, Math.round(scale * crop.height))}px`;
  if (current.cropDraft) drawCropDraft(current.cropDraft, crop);
  output.textContent = `${Math.round(crop.width)} × ${Math.round(crop.height)}`;
  updateZoomControls(scale);
}

/**
 * The crop draft is drawn over the rendered canvas rather than through the
 * engine: it is a temporary selection, not part of the edited image.
 */
function drawCropDraft(draft: ImageRect, crop: ImageRect): void {
  const context = canvas.getContext("2d");
  if (!context) return;
  const ratio = canvas.width / crop.width;
  const x = draft.x * ratio;
  const y = draft.y * ratio;
  const width = draft.width * ratio;
  const height = draft.height * ratio;
  context.save();
  context.fillStyle = "rgba(28,20,14,0.45)";
  context.fillRect(0, 0, canvas.width, y);
  context.fillRect(0, y + height, canvas.width, canvas.height - y - height);
  context.fillRect(0, y, x, height);
  context.fillRect(x + width, y, canvas.width - x - width, height);
  context.strokeStyle = "#f6e7d5";
  context.lineWidth = 1;
  context.strokeRect(x + 0.5, y + 0.5, Math.max(0, width - 1), Math.max(0, height - 1));
  context.strokeStyle = "rgba(246,231,213,0.42)";
  for (let step = 1; step <= 2; step += 1) {
    const gx = x + (width * step) / 3;
    const gy = y + (height * step) / 3;
    context.beginPath();
    context.moveTo(gx + 0.5, y);
    context.lineTo(gx + 0.5, y + height);
    context.moveTo(x, gy + 0.5);
    context.lineTo(x + width, gy + 0.5);
    context.stroke();
  }
  context.fillStyle = "#f6e7d5";
  const handles: Array<[number, number]> = [
    [x, y], [x + width, y], [x, y + height], [x + width, y + height],
  ];
  for (const [hx, hy] of handles) {
    context.fillRect(hx - 3, hy - 3, 6, 6);
  }
  context.restore();
}

/** Pointer position in the working image's own pixels. */
function canvasPoint(event: PointerEvent): ImagePoint {
  const current = session!;
  const oriented = orientSize(current.width, current.height, current.state.rotation);
  const crop = current.state.crop ?? {
    x: 0, y: 0, width: oriented.width, height: oriented.height,
  };
  const rect = canvas.getBoundingClientRect();
  const scale = rect.width / crop.width;
  return {
    x: Math.max(0, Math.min(crop.width, (event.clientX - rect.left) / scale)),
    y: Math.max(0, Math.min(crop.height, (event.clientY - rect.top) / scale)),
  };
}

function syncHistory(): void {
  const history = session?.history;
  undoButton.disabled = !history || history.past.length === 0;
  redoButton.disabled = !history || history.future.length === 0;
}

function commit(next: ImageEditorState, message?: string): void {
  const current = session;
  if (!current) return;
  current.history = recordHistory(current.history, current.state);
  current.state = next;
  current.cropDraft = null;
  cropApply.hidden = true;
  syncHistory();
  redraw();
  if (message) setStatus(message);
}

function stepHistory(direction: -1 | 1): void {
  const current = session;
  if (!current) return;
  const step = direction < 0
    ? undoHistory(current.history, current.state)
    : redoHistory(current.history, current.state);
  if (!step) {
    setStatus(direction < 0 ? "没有可撤销的操作" : "没有可重做的操作", true);
    return;
  }
  current.history = step.history;
  current.state = step.state;
  current.cropDraft = null;
  cropApply.hidden = true;
  syncHistory();
  redraw();
  setStatus(direction < 0 ? "已撤销" : "已重做");
}

function applyZoom(zoom: number | "fit"): void {
  const current = session;
  if (!current) return;
  const before = canvas.getBoundingClientRect();
  const viewport = scroll.getBoundingClientRect();
  const anchorX = before.width > 0
    ? (viewport.left + viewport.width / 2 - before.left) / before.width
    : 0.5;
  const anchorY = before.height > 0
    ? (viewport.top + viewport.height / 2 - before.top) / before.height
    : 0.5;
  const anchored = anchorX >= 0 && anchorX <= 1 && anchorY >= 0 && anchorY <= 1;
  current.zoom = zoom;
  redraw();
  if (!anchored) return;
  const after = canvas.getBoundingClientRect();
  const next = scroll.getBoundingClientRect();
  scroll.scrollLeft += after.left + anchorX * after.width - (next.left + next.width / 2);
  scroll.scrollTop += after.top + anchorY * after.height - (next.top + next.height / 2);
}

function renderTools(): void {
  const current = session;
  if (!current) return;
  for (const button of tools) {
    const active = button.dataset.imageTool === current.tool;
    button.setAttribute("aria-pressed", String(active));
  }
  toolTitle.textContent = TOOL_LABELS[current.tool];
  hint.textContent = TOOL_HINTS[current.tool];
}

function renderColors(): void {
  const current = session;
  if (!current) return;
  colors.innerHTML = EDITOR_COLORS.map((color) => `
    <button type="button" class="swatch" data-color="${color}" style="--swatch:${color}"
      aria-pressed="${color === current.color}" aria-label="颜色 ${color}"></button>
  `).join("");
}

function openTextEntry(point: ImagePoint): void {
  textPoint = point;
  textEntry.hidden = false;
  textInput.value = "";
  textInput.focus();
}

function closeTextEntry(): void {
  textPoint = null;
  textEntry.hidden = true;
  textInput.value = "";
}

function commitTextEntry(): void {
  const current = session;
  const text = textInput.value.trim();
  if (!current || !textPoint) return;
  if (!text) {
    setStatus("请先输入文字", true);
    textInput.focus();
    return;
  }
  const point = textPoint;
  closeTextEntry();
  commit(
    {
      ...current.state,
      annotations: [
        ...current.state.annotations,
        newAnnotation("text", current.color, current.size, [point], { text }),
      ],
    },
    `已添加文字：${text}`,
  );
  canvas.focus();
}

canvas.addEventListener("pointerdown", (event) => {
  if (!session) return;
  event.preventDefault();
  canvas.setPointerCapture(event.pointerId);
  const point = canvasPoint(event);
  if (session.tool === "text") {
    openTextEntry(point);
    return;
  }
  session.dragStart = point;
  if (session.tool === "crop") {
    session.cropDraft = { x: point.x, y: point.y, width: 0, height: 0 };
  } else {
    session.draft = { tool: session.tool, points: [point] };
  }
  redraw();
});

canvas.addEventListener("pointermove", (event) => {
  const current = session;
  if (!current || !current.dragStart) return;
  const point = canvasPoint(event);
  if (current.cropDraft) {
    current.cropDraft = normalizeRect(current.dragStart, point);
  } else if (current.draft) {
    const points = current.draft.points;
    if (current.tool === "pen") {
      const last = points[points.length - 1];
      if (!last || Math.hypot(point.x - last.x, point.y - last.y) >= 1.5) points.push(point);
    } else {
      current.draft.points = [points[0]!, point];
    }
  }
  redraw();
});

canvas.addEventListener("pointerup", (event) => {
  const current = session;
  if (!current || !current.dragStart) return;
  if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
  current.dragStart = null;
  if (current.cropDraft) {
    const draft = current.cropDraft;
    cropApply.hidden = draft.width < 16 || draft.height < 16;
    if (!cropApply.hidden) setStatus("点“应用裁剪”完成，或重新拖出范围");
    redraw();
    return;
  }
  const draft = current.draft;
  current.draft = null;
  if (!draft) return;
  const points = draft.points;
  const usable = draft.tool === "pen"
    ? points.length > 0
    : points.length >= 2 && Math.hypot(
      points[1]!.x - points[0]!.x,
      points[1]!.y - points[0]!.y,
    ) >= 4;
  if (!usable) {
    redraw();
    setStatus("拖动距离太短，没有添加标注", true);
    return;
  }
  commit(
    {
      ...current.state,
      annotations: [
        ...current.state.annotations,
        newAnnotation(draft.tool, current.color, current.size, points, { block: 12 }),
      ],
    },
    `已添加${TOOL_LABELS[draft.tool]}`,
  );
});

cropApply.addEventListener("click", () => {
  const current = session;
  if (!current || !current.cropDraft) return;
  const oriented = orientSize(current.width, current.height, current.state.rotation);
  const next = applyCrop(current.state, current.cropDraft, oriented.width, oriented.height);
  if (!next) {
    setStatus("裁剪区域太小", true);
    return;
  }
  commit(next, "已裁剪");
});

for (const button of tools) {
  button.addEventListener("click", () => {
    if (!session) return;
    session.tool = button.dataset.imageTool as ImageTool;
    session.draft = null;
    session.cropDraft = null;
    cropApply.hidden = true;
    renderTools();
    redraw();
    canvas.focus();
  });
}

colors.addEventListener("click", (event) => {
  const button = (event.target as Element).closest<HTMLButtonElement>("[data-color]");
  if (!button || !session) return;
  session.color = button.dataset.color ?? EDITOR_COLORS[0];
  renderColors();
});

sizeInput.addEventListener("input", () => {
  if (!session) return;
  session.size = Number(sizeInput.value);
  sizeValue.textContent = sizeInput.value;
});

one<HTMLButtonElement>("#image-rotate").addEventListener("click", () => {
  if (!session) return;
  commit(rotateClockwise(session.state), "已旋转");
});

one<HTMLButtonElement>("#image-flip").addEventListener("click", () => {
  if (!session) return;
  commit(toggleFlip(session.state), "已翻转");
});

one<HTMLButtonElement>("#image-reset").addEventListener("click", () => {
  if (!session) return;
  commit(initialState(), "已重置");
});

undoButton.addEventListener("click", () => stepHistory(-1));
redoButton.addEventListener("click", () => stepHistory(1));

zoomIn.addEventListener("click", () => {
  if (!session) return;
  applyZoom(stepZoom(currentScale(workingSize(session.state, session.width, session.height).crop), 1));
});
zoomOut.addEventListener("click", () => {
  if (!session) return;
  applyZoom(stepZoom(currentScale(workingSize(session.state, session.width, session.height).crop), -1));
});
zoomFit.addEventListener("click", () => applyZoom("fit"));

one<HTMLButtonElement>("#image-text-confirm").addEventListener("click", commitTextEntry);
one<HTMLButtonElement>("#image-text-cancel").addEventListener("click", closeTextEntry);
textInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") commitTextEntry();
  if (event.key === "Escape") closeTextEntry();
});

one<HTMLButtonElement>("[data-action=close]").addEventListener("click", () => bridge.close());

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && textEntry.hidden) {
    bridge.close();
    return;
  }
  const command = event.metaKey || event.ctrlKey;
  if (command && event.key.toLowerCase() === "z") {
    event.preventDefault();
    stepHistory(event.shiftKey ? 1 : -1);
  }
});

function currentTitle(): string {
  return titleInput.value.trim() || "图片编辑";
}

function setActions(enabled: boolean): void {
  saveButton.disabled = !enabled;
  copyButton.disabled = !enabled;
}

async function run(action: () => Promise<void>): Promise<void> {
  if (!session || busy) return;
  busy = true;
  setActions(false);
  try {
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
    const current = session!;
    const png = exportEditorPNG(current.image, current.width, current.height, current.state);
    const result = await bridge.save(png.dataURL, currentTitle());
    setStatus(
      result.ok ? `已保存为新条目 #${result.id ?? ""}` : (result.message || "保存失败"),
      !result.ok,
    );
  });
});

copyButton.addEventListener("click", () => {
  void run(async () => {
    const current = session!;
    const png = exportEditorPNG(current.image, current.width, current.height, current.state);
    const result = await bridge.copy(png.dataURL);
    setStatus(result.ok ? "已复制为图片" : (result.message || "复制失败"), !result.ok);
  });
});

bridge.onItem((item) => {
  if (item.kind !== "image") {
    setActions(false);
    setStatus("图片编辑只接受图片条目", true);
    return;
  }
  void (async () => {
    try {
      const loaded = await loadImage(item.dataURL);
      const fitted = fitWithin(loaded.naturalWidth, loaded.naturalHeight);
      let source: CanvasImageSource = loaded;
      if (fitted.scale < 1) {
        const buffer = document.createElement("canvas");
        buffer.width = fitted.width;
        buffer.height = fitted.height;
        buffer.getContext("2d")?.drawImage(loaded, 0, 0, fitted.width, fitted.height);
        source = buffer;
      }
      session = {
        image: source,
        width: fitted.width,
        height: fitted.height,
        state: initialState(),
        history: emptyHistory(),
        tool: "pen",
        color: EDITOR_COLORS[0],
        size: Number(sizeInput.value),
        dragStart: null,
        draft: null,
        cropDraft: null,
        zoom: "fit",
      };
      titleInput.value = item.title;
      sizeValue.textContent = sizeInput.value;
      cropApply.hidden = true;
      closeTextEntry();
      setStatus("");
      renderTools();
      renderColors();
      syncHistory();
      setActions(true);
      redraw();
    } catch (error) {
      setActions(false);
      setStatus(error instanceof Error ? error.message : "图片无法读取", true);
    }
  })();
});
