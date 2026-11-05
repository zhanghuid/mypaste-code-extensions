/**
 * The image editor's engine: state, history, geometry and canvas rendering.
 * Every operation runs on a canvas inside this document; the finished PNG
 * leaves only through the host's save and copy bridge.
 */

export type ImageTool = "crop" | "pen" | "rect" | "arrow" | "mosaic" | "text";

export interface ImageRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ImagePoint {
  x: number;
  y: number;
}

export interface ImageAnnotation {
  id: number;
  tool: Exclude<ImageTool, "crop">;
  color: string;
  size: number;
  points: ImagePoint[];
  text?: string;
  /** Mosaic block size in source pixels. */
  block?: number;
}

export interface ImageEditorState {
  rotation: 0 | 90 | 180 | 270;
  flipH: boolean;
  crop: ImageRect | null;
  annotations: ImageAnnotation[];
}

export const MAX_EDIT_SIDE = 4096;

/**
 * Zoom is CSS pixels per working pixel, so 100% is one-to-one. The editor
 * renders at the zoomed size up to MAX_RENDER_SIDE and lets CSS scale the rest,
 * which keeps a 4096px photo from allocating a 32-megapixel canvas on every
 * pointer move.
 */
export const MIN_ZOOM = 0.05;
export const MAX_ZOOM = 8;
export const MAX_RENDER_SIDE = 2400;

/** Discrete stops keep repeated clicks predictable; fit is not one of them. */
export const ZOOM_STEPS = [
  0.05, 0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8,
] as const;

/** Largest scale that shows the whole working image inside the stage, never
 * above 1:1 — magnifying a small image on open only made it blurry. */
export function fitZoom(
  width: number,
  height: number,
  viewportWidth: number,
  viewportHeight: number,
): number {
  if (width <= 0 || height <= 0 || viewportWidth <= 0 || viewportHeight <= 0) {
    return 1;
  }
  const scale = Math.min(viewportWidth / width, viewportHeight / height, 1);
  return clampZoom(scale);
}

export function clampZoom(scale: number): number {
  if (!Number.isFinite(scale)) return 1;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, scale));
}

/** Next stop above or below the current scale, clamped at the ends. */
export function stepZoom(current: number, direction: 1 | -1): number {
  const scale = clampZoom(current);
  if (direction > 0) {
    return ZOOM_STEPS.find((step) => step > scale + 0.001) ?? MAX_ZOOM;
  }
  for (let index = ZOOM_STEPS.length - 1; index >= 0; index -= 1) {
    const step = ZOOM_STEPS[index]!;
    if (step < scale - 0.001) return step;
  }
  return MIN_ZOOM;
}

/** Render scale that keeps the bitmap bounded while filling the zoomed view. */
export function renderSideScale(
  scale: number,
  width: number,
  height: number,
): number {
  const longest = Math.max(width, height);
  if (longest <= 0) return 1;
  return Math.min(clampZoom(scale), MAX_RENDER_SIDE / longest);
}

export const EDITOR_COLORS = [
  "#c0453a",
  "#d98a2b",
  "#3f7d4f",
  "#2e6f9e",
  "#7a4f9a",
  "#2b2723",
] as const;

export function initialState(): ImageEditorState {
  return { rotation: 0, flipH: false, crop: null, annotations: [] };
}

/** Rotates the canvas clockwise. Crop and annotations reset because their
 * coordinates belong to the previous orientation. */
export function rotateClockwise(state: ImageEditorState): ImageEditorState {
  return {
    rotation: ((state.rotation + 90) % 360) as ImageEditorState["rotation"],
    flipH: state.flipH,
    crop: null,
    annotations: [],
  };
}

export function toggleFlip(state: ImageEditorState): ImageEditorState {
  return { ...state, flipH: !state.flipH, crop: null, annotations: [] };
}

/**
 * Undo and redo steps of committed editor states. Each state only holds the
 * transform and the annotation list — pixels stay in the source image — so a
 * deep stack is cheap even for a 4096px photo.
 */
export interface ImageEditorHistory {
  past: ImageEditorState[];
  future: ImageEditorState[];
}

/** Bounds the stack; older steps fall off the bottom. */
export const MAX_HISTORY_STEPS = 50;

export function emptyHistory(): ImageEditorHistory {
  return { past: [], future: [] };
}

/** Records the state a change is about to replace. A new change drops the
 * redo branch, which is what "the next step" means after editing again. */
export function recordHistory(
  history: ImageEditorHistory,
  current: ImageEditorState,
): ImageEditorHistory {
  const past = history.past.length >= MAX_HISTORY_STEPS
    ? history.past.slice(history.past.length - MAX_HISTORY_STEPS + 1)
    : history.past;
  return { past: [...past, current], future: [] };
}

export interface ImageEditorStep {
  state: ImageEditorState;
  history: ImageEditorHistory;
}

/** Moves one step back, or null when the stack is empty. */
export function undoHistory(
  history: ImageEditorHistory,
  current: ImageEditorState,
): ImageEditorStep | null {
  const previous = history.past[history.past.length - 1];
  if (!previous) return null;
  return {
    state: previous,
    history: {
      past: history.past.slice(0, -1),
      future: [current, ...history.future],
    },
  };
}

/** Moves one step forward, or null when nothing was undone. */
export function redoHistory(
  history: ImageEditorHistory,
  current: ImageEditorState,
): ImageEditorStep | null {
  const next = history.future[0];
  if (!next) return null;
  return {
    state: next,
    history: {
      past: [...history.past, current],
      future: history.future.slice(1),
    },
  };
}

export function normalizeRect(start: ImagePoint, end: ImagePoint): ImageRect {
  return {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
  };
}

/** Clamps a user-drawn crop to the visible image and drops unusable slivers. */
export function clampCrop(rect: ImageRect, width: number, height: number): ImageRect | null {
  const x = Math.max(0, Math.min(rect.x, width));
  const y = Math.max(0, Math.min(rect.y, height));
  const right = Math.max(0, Math.min(rect.x + rect.width, width));
  const bottom = Math.max(0, Math.min(rect.y + rect.height, height));
  const clamped = {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(right - x),
    height: Math.round(bottom - y),
  };
  if (clamped.width < 16 || clamped.height < 16) return null;
  return clamped;
}

/**
 * Applies a crop expressed in current working coordinates. Existing
 * annotations move with the crop so a mark stays on the same pixels.
 */
export function applyCrop(
  state: ImageEditorState,
  rect: ImageRect,
  orientedWidth: number,
  orientedHeight: number,
): ImageEditorState | null {
  const base = state.crop ?? {
    x: 0,
    y: 0,
    width: orientedWidth,
    height: orientedHeight,
  };
  const absolute = clampCrop(
    {
      x: base.x + rect.x,
      y: base.y + rect.y,
      width: rect.width,
      height: rect.height,
    },
    orientedWidth,
    orientedHeight,
  );
  if (!absolute) return null;
  const dx = absolute.x - base.x;
  const dy = absolute.y - base.y;
  const annotations = state.annotations
    .map((annotation) => ({
      ...annotation,
      points: annotation.points.map((point) => ({ x: point.x - dx, y: point.y - dy })),
    }))
    .filter((annotation) =>
      annotation.points.some((point) =>
        point.x >= 0 && point.y >= 0 &&
        point.x <= absolute.width && point.y <= absolute.height
      )
    );
  return { ...state, crop: absolute, annotations };
}

export function orientSize(
  width: number,
  height: number,
  rotation: number,
): { width: number; height: number } {
  return rotation % 180 === 0
    ? { width, height }
    : { width: height, height: width };
}

export function workingSize(state: ImageEditorState, width: number, height: number) {
  const oriented = orientSize(width, height, state.rotation);
  const crop = state.crop ?? {
    x: 0,
    y: 0,
    width: oriented.width,
    height: oriented.height,
  };
  return { width: crop.width, height: crop.height, crop };
}

/** Downscales oversized images before editing so memory stays bounded. */
export function fitWithin(
  width: number,
  height: number,
  maxSide = MAX_EDIT_SIDE,
): { width: number; height: number; scale: number } {
  const scale = Math.min(1, maxSide / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    scale,
  };
}

let nextAnnotationID = 1;

export function newAnnotation(
  tool: ImageAnnotation["tool"],
  color: string,
  size: number,
  points: ImagePoint[],
  extras: { text?: string; block?: number } = {},
): ImageAnnotation {
  return {
    id: nextAnnotationID++,
    tool,
    color,
    size,
    points: points.map((point) => ({ ...point })),
    ...extras,
  };
}

export function resetAnnotationIDsForTest(): void {
  nextAnnotationID = 1;
}

function drawOrientedBase(
  context: CanvasRenderingContext2D,
  image: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  state: ImageEditorState,
  scale: number,
): { width: number; height: number } {
  const oriented = orientSize(sourceWidth, sourceHeight, state.rotation);
  context.save();
  context.translate(oriented.width / 2, oriented.height / 2);
  if (state.flipH) context.scale(-1, 1);
  context.rotate((state.rotation * Math.PI) / 180);
  context.drawImage(
    image,
    -sourceWidth / 2,
    -sourceHeight / 2,
    sourceWidth,
    sourceHeight,
  );
  context.restore();
  return {
    width: Math.round(oriented.width * scale),
    height: Math.round(oriented.height * scale),
  };
}

/**
 * Draws the composed image into a canvas and returns its pixel size. The
 * canvas is scaled to devicePixelRatio-free CSS pixels; export re-renders at
 * natural size through the same function.
 */
export function renderEditor(
  canvas: HTMLCanvasElement,
  image: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  state: ImageEditorState,
  displayScale = 1,
): { width: number; height: number } {
  const oriented = orientSize(sourceWidth, sourceHeight, state.rotation);
  const crop = state.crop ?? {
    x: 0,
    y: 0,
    width: oriented.width,
    height: oriented.height,
  };
  const width = Math.max(1, Math.round(crop.width * displayScale));
  const height = Math.max(1, Math.round(crop.height * displayScale));
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("当前环境不支持 Canvas");
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, width, height);

  // Orient into an isolated buffer so cropping never mixes transform state.
  const buffer = document.createElement("canvas");
  buffer.width = oriented.width;
  buffer.height = oriented.height;
  const bufferContext = buffer.getContext("2d");
  if (!bufferContext) throw new Error("当前环境不支持 Canvas");
  drawOrientedBase(bufferContext, image, sourceWidth, sourceHeight, state, 1);

  context.drawImage(
    buffer,
    crop.x,
    crop.y,
    crop.width,
    crop.height,
    0,
    0,
    width,
    height,
  );
  const ratio = width / crop.width;
  drawAnnotations(context, state.annotations, ratio);
  return { width, height };
}

function drawAnnotations(
  context: CanvasRenderingContext2D,
  annotations: ImageAnnotation[],
  ratio: number,
): void {
  for (const annotation of annotations) {
    context.save();
    context.strokeStyle = annotation.color;
    context.fillStyle = annotation.color;
    context.lineWidth = Math.max(1, annotation.size * ratio);
    context.lineCap = "round";
    context.lineJoin = "round";
    const points = annotation.points.map((point) => ({
      x: point.x * ratio,
      y: point.y * ratio,
    }));
    if (annotation.tool === "pen" && points.length > 0) {
      context.beginPath();
      context.moveTo(points[0]!.x, points[0]!.y);
      for (const point of points.slice(1)) context.lineTo(point.x, point.y);
      context.stroke();
    }
    if ((annotation.tool === "rect" || annotation.tool === "arrow") && points.length >= 2) {
      const start = points[0]!;
      const end = points[points.length - 1]!;
      if (annotation.tool === "rect") {
        context.strokeRect(start.x, start.y, end.x - start.x, end.y - start.y);
      } else {
        drawArrow(context, start, end, annotation.size * ratio);
      }
    }
    if (annotation.tool === "text" && points.length > 0 && annotation.text) {
      const fontSize = Math.max(10, annotation.size * 3 * ratio);
      context.font = `600 ${fontSize}px "PingFang SC", "Helvetica Neue", sans-serif`;
      context.textBaseline = "top";
      const lines = annotation.text.split("\n");
      lines.forEach((line, index) => {
        context.fillText(line, points[0]!.x, points[0]!.y + index * fontSize * 1.3);
      });
    }
    if (annotation.tool === "mosaic" && points.length >= 2) {
      const start = points[0]!;
      const end = points[points.length - 1]!;
      pixelate(
        context,
        Math.min(start.x, end.x),
        Math.min(start.y, end.y),
        Math.abs(end.x - start.x),
        Math.abs(end.y - start.y),
        Math.max(4, Math.round((annotation.block ?? 12) * ratio)),
      );
    }
    context.restore();
  }
}

function drawArrow(
  context: CanvasRenderingContext2D,
  start: ImagePoint,
  end: ImagePoint,
  size: number,
): void {
  const angle = Math.atan2(end.y - start.y, end.x - start.x);
  const head = Math.max(size * 3.4, 8);
  context.beginPath();
  context.moveTo(start.x, start.y);
  context.lineTo(end.x, end.y);
  context.stroke();
  context.beginPath();
  context.moveTo(end.x, end.y);
  context.lineTo(
    end.x - head * Math.cos(angle - Math.PI / 7),
    end.y - head * Math.sin(angle - Math.PI / 7),
  );
  context.lineTo(
    end.x - head * Math.cos(angle + Math.PI / 7),
    end.y - head * Math.sin(angle + Math.PI / 7),
  );
  context.closePath();
  context.fill();
}

/**
 * Replaces a rectangle with block averages. Data is read from the current
 * canvas, so mosaic also covers strokes drawn before it.
 */
export function pixelate(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  block: number,
): void {
  const left = Math.max(0, Math.floor(x));
  const top = Math.max(0, Math.floor(y));
  const right = Math.min(context.canvas.width, Math.ceil(x + width));
  const bottom = Math.min(context.canvas.height, Math.ceil(y + height));
  const w = right - left;
  const h = bottom - top;
  if (w <= 0 || h <= 0) return;
  const data = context.getImageData(left, top, w, h);
  const pixels = data.data;
  for (let blockY = 0; blockY < h; blockY += block) {
    for (let blockX = 0; blockX < w; blockX += block) {
      const blockW = Math.min(block, w - blockX);
      const blockH = Math.min(block, h - blockY);
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let count = 0;
      for (let dy = 0; dy < blockH; dy += 1) {
        for (let dx = 0; dx < blockW; dx += 1) {
          const index = ((blockY + dy) * w + blockX + dx) * 4;
          r += pixels[index] ?? 0;
          g += pixels[index + 1] ?? 0;
          b += pixels[index + 2] ?? 0;
          a += pixels[index + 3] ?? 0;
          count += 1;
        }
      }
      if (count === 0) continue;
      const average = [r / count, g / count, b / count, a / count].map(Math.round);
      for (let dy = 0; dy < blockH; dy += 1) {
        for (let dx = 0; dx < blockW; dx += 1) {
          const index = ((blockY + dy) * w + blockX + dx) * 4;
          pixels[index] = average[0]!;
          pixels[index + 1] = average[1]!;
          pixels[index + 2] = average[2]!;
          pixels[index + 3] = average[3]!;
        }
      }
    }
  }
  context.putImageData(data, left, top);
}

/** Composes the final PNG at natural working size. */
export function exportEditorPNG(
  image: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  state: ImageEditorState,
): { dataURL: string; width: number; height: number } {
  const canvas = document.createElement("canvas");
  const size = renderEditor(canvas, image, sourceWidth, sourceHeight, state, 1);
  return {
    dataURL: canvas.toDataURL("image/png"),
    width: size.width,
    height: size.height,
  };
}
