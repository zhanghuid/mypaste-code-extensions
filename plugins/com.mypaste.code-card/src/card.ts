/**
 * The card renderer: palettes, geometry and canvas drawing. Everything here is
 * local — the card is drawn from the item's text and turned into one PNG data
 * URL; no font, image or script is fetched.
 */

import {
  detectCodeLanguage,
  tokenizeCode,
  type CodeLanguage,
  type CodeToken,
} from "./tokenize";

export type CodeCardTheme = "terracotta" | "midnight" | "paper";
export type CodeWindowStyle = "window" | "flat";

export interface CodeCardOptions {
  theme: CodeCardTheme;
  windowStyle: CodeWindowStyle;
  lineNumbers: boolean;
  fontScale: number;
}

export interface CodeCardPalette {
  surface: string;
  titleBar: string;
  ink: string;
  muted: string;
  gutter: string;
  accent: string;
  tokens: Record<string, string>;
}

export const DEFAULT_CODE_CARD_OPTIONS: CodeCardOptions = {
  theme: "terracotta",
  windowStyle: "window",
  lineNumbers: true,
  fontScale: 1,
};

export const CODE_CARD_PALETTES: Record<CodeCardTheme, CodeCardPalette> = {
  terracotta: {
    surface: "#fbf5ec",
    titleBar: "#f2e7d8",
    ink: "#33281f",
    muted: "#9a8b79",
    gutter: "#c0ae99",
    accent: "#a65d2e",
    tokens: {
      keyword: "#a64f22",
      string: "#55753e",
      comment: "#9c8f7d",
      number: "#9b6a1f",
      function: "#37677f",
      property: "#7a5387",
      literal: "#9c4a45",
      tag: "#a9541f",
      type: "#2f6a67",
    },
  },
  midnight: {
    surface: "#1b1815",
    titleBar: "#231f1b",
    ink: "#efe5d8",
    muted: "#8b8073",
    gutter: "#6d6255",
    accent: "#e29a63",
    tokens: {
      keyword: "#e2955f",
      string: "#a8c184",
      comment: "#7d7367",
      number: "#dfb173",
      function: "#84b4cd",
      property: "#c6a3d3",
      literal: "#dc9a9a",
      tag: "#e0a06a",
      type: "#82c2bb",
    },
  },
  paper: {
    surface: "#fdfcf9",
    titleBar: "#f4f1ea",
    ink: "#26221d",
    muted: "#93897c",
    gutter: "#b9afa1",
    accent: "#3c5f7a",
    tokens: {
      keyword: "#2f5f86",
      string: "#4d6f42",
      comment: "#9b9284",
      number: "#8c6321",
      function: "#356d6b",
      property: "#6b4f7c",
      literal: "#8f4a47",
      tag: "#8a5a25",
      type: "#2f6d61",
    },
  },
};

export interface CodeCardSource {
  title: string;
  tokens: CodeToken[];
  language: CodeLanguage;
  label: string;
}

/**
 * Splits tokens into display lines without losing token boundaries. Very long
 * single lines wrap at maxChars so an export cannot become arbitrarily wide.
 */
export function splitTokenLines(
  tokens: CodeToken[],
  maxChars: number,
): CodeToken[][] {
  const limit = Math.max(16, Math.floor(maxChars));
  const lines: CodeToken[][] = [[]];
  let column = 0;
  for (const token of tokens) {
    let buffer = "";
    for (const character of token.text) {
      if (character === "\n") {
        if (buffer) lines[lines.length - 1]?.push({ text: buffer, kind: token.kind });
        buffer = "";
        lines.push([]);
        column = 0;
        continue;
      }
      if (column >= limit) {
        if (buffer) lines[lines.length - 1]?.push({ text: buffer, kind: token.kind });
        buffer = "";
        lines.push([]);
        column = 0;
      }
      buffer += character;
      column += 1;
    }
    if (buffer) lines[lines.length - 1]?.push({ text: buffer, kind: token.kind });
  }
  return lines;
}

export interface CodeCardLayout {
  width: number;
  height: number;
  lines: CodeToken[][];
  charWidth: number;
  lineHeight: number;
  padding: number;
  titleHeight: number;
  gutterWidth: number;
  fontSize: number;
}

const FONT_STACK = '"SF Mono", "Menlo", "PingFang SC", monospace';
const MAX_CARD_WIDTH = 1_680;

export function codeCardLayout(
  source: CodeCardSource,
  options: CodeCardOptions,
): CodeCardLayout {
  const fontSize = Math.round(13 * clamp(options.fontScale, 0.8, 1.4));
  const charWidth = Math.round(fontSize * 0.602);
  const lineHeight = Math.round(fontSize * 1.62);
  const padding = 30;
  const titleHeight = options.windowStyle === "window" ? 46 : 26;
  const maxChars = Math.max(
    24,
    Math.floor((MAX_CARD_WIDTH - padding * 2 - 60) / charWidth),
  );
  const lines = splitTokenLines(source.tokens, maxChars);
  const longest = lines.reduce(
    (width, line) => Math.max(width, line.reduce((sum, token) => sum + [...token.text].length, 0)),
    0,
  );
  const gutterWidth = options.lineNumbers ? Math.round(charWidth * 3.4) : 0;
  const width = Math.min(
    MAX_CARD_WIDTH,
    Math.max(560, padding * 2 + gutterWidth + longest * charWidth + 24),
  );
  const height = Math.max(
    220,
    titleHeight + padding * 2 + Math.max(1, lines.length) * lineHeight + 26,
  );
  return {
    width,
    height,
    lines,
    charWidth,
    lineHeight,
    padding,
    titleHeight,
    gutterWidth,
    fontSize,
  };
}

/** Draws the card at device pixel ratio 2 for a crisp PNG export. */
export function drawCodeCard(
  canvas: HTMLCanvasElement,
  source: CodeCardSource,
  options: CodeCardOptions,
): CodeCardLayout {
  const layout = codeCardLayout(source, options);
  const palette = CODE_CARD_PALETTES[options.theme];
  const ratio = 2;
  canvas.width = Math.round(layout.width * ratio);
  canvas.height = Math.round(layout.height * ratio);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("当前环境不支持 Canvas");
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, layout.width, layout.height);

  roundedRect(context, 0, 0, layout.width, layout.height, 18);
  context.fillStyle = palette.surface;
  context.fill();
  context.strokeStyle = options.theme === "midnight"
    ? "rgba(255,255,255,0.09)"
    : "rgba(60,42,26,0.12)";
  context.lineWidth = 1;
  context.stroke();

  if (options.windowStyle === "window") {
    context.save();
    roundedRect(context, 0, 0, layout.width, layout.titleHeight, 18);
    context.clip();
    context.fillStyle = palette.titleBar;
    context.fillRect(0, 0, layout.width, layout.titleHeight);
    context.restore();
    const dots = ["#de6a5c", "#dfae55", "#7aa365"];
    dots.forEach((color, index) => {
      context.beginPath();
      context.fillStyle = color;
      context.arc(26 + index * 17, layout.titleHeight / 2, 4.6, 0, Math.PI * 2);
      context.fill();
    });
    context.fillStyle = palette.muted;
    context.font = `500 ${Math.max(10, layout.fontSize - 2)}px ${FONT_STACK}`;
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(
      truncateText(context, source.title, layout.width - 170),
      layout.width / 2,
      layout.titleHeight / 2,
    );
    context.textAlign = "left";
  } else {
    context.fillStyle = palette.accent;
    context.font = `700 ${Math.max(9, layout.fontSize - 3)}px ${FONT_STACK}`;
    context.textBaseline = "middle";
    context.fillText(source.label.toUpperCase(), layout.padding, 20);
  }

  context.font = `${layout.fontSize}px ${FONT_STACK}`;
  context.textBaseline = "middle";
  let y = layout.titleHeight + layout.padding + layout.lineHeight / 2;
  layout.lines.forEach((line, index) => {
    let x = layout.padding;
    if (options.lineNumbers) {
      context.fillStyle = palette.gutter;
      context.textAlign = "right";
      context.fillText(String(index + 1), layout.padding + layout.gutterWidth - 12, y);
      context.textAlign = "left";
      x += layout.gutterWidth;
    }
    for (const token of line) {
      context.fillStyle = token.kind
        ? palette.tokens[token.kind] ?? palette.ink
        : palette.ink;
      context.fillText(token.text, x, y);
      x += [...token.text].length * layout.charWidth;
    }
    y += layout.lineHeight;
  });

  context.fillStyle = palette.muted;
  context.font = `500 10px ${FONT_STACK}`;
  context.textAlign = "right";
  context.fillText(
    `MyPaste · ${source.label}`,
    layout.width - layout.padding,
    layout.height - 20,
  );
  context.textAlign = "left";
  return layout;
}

function roundedRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  const r = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + r, y);
  context.arcTo(x + width, y, x + width, y + height, r);
  context.arcTo(x + width, y + height, x, y + height, r);
  context.arcTo(x, y + height, x, y, r);
  context.arcTo(x, y, x + width, y, r);
  context.closePath();
}

function truncateText(
  context: CanvasRenderingContext2D,
  value: string,
  maxWidth: number,
): string {
  if (context.measureText(value).width <= maxWidth) return value;
  let text = value;
  while (text.length > 1 && context.measureText(`${text}…`).width > maxWidth) {
    text = text.slice(0, -1);
  }
  return `${text}…`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** The words this card prints for its own languages; nothing else supplies them. */
const LANGUAGE_LABELS: Record<CodeLanguage, string> = {
  css: "CSS",
  go: "Go",
  html: "HTML",
  javascript: "JavaScript",
  json: "JSON",
  php: "PHP",
  python: "Python",
  rust: "Rust",
  shell: "Shell",
  sql: "SQL",
  typescript: "TypeScript",
  yaml: "YAML",
};

/** The most source characters one card ever reads; the rest is elided. */
export const CARD_SOURCE_LIMIT = 6_000;

/**
 * cardSource turns the item's text into a drawn card. Detection reads the text
 * itself, so a JSON object pasted as plain text still gets JSON tokens; text
 * with no recognizable shape is drawn plain rather than refused.
 */
export function cardSource(text: string, fallbackTitle: string): CodeCardSource | null {
  const candidate = text.trim();
  if (!candidate) return null;
  const bounded = candidate.length > CARD_SOURCE_LIMIT
    ? `${candidate.slice(0, CARD_SOURCE_LIMIT)}\n...`
    : candidate;
  const detected = detectCodeLanguage(candidate);
  // Text the detector cannot place is tokenized as JavaScript and labelled as
  // plain text: the card still renders, and the footer does not claim a
  // language the card did not recognize.
  const language = detected ?? "javascript";
  return {
    title: fallbackTitle.trim() || "未命名",
    tokens: tokenizeCode(bounded, language),
    language,
    label: detected ? LANGUAGE_LABELS[detected] : "文本",
  };
}
