/**
 * The card renderer: palettes, geometry and canvas drawing. Everything here is
 * local — the card is drawn from the item's text and turned into one PNG data
 * URL; no font, image or script is fetched.
 *
 * Geometry follows Carbon (carbon.now.sh): a 48 px window band above the code,
 * 16 px left / 18 px right / 18 px bottom padding, a 133 % line box, a 20 px /
 * 68 px shadow and a 56 px canvas padding. The rail exposes the same knobs
 * Carbon does — window style, vertical and horizontal padding, shadow offset
 * and blur, auto width, font size, line height and line numbers.
 *
 * The corners come from the host's ladder (D-1099), not from Carbon's 3–5 px
 * literals: the card is a card (--radius-md) and every control lives in the
 * page's stylesheet.
 *
 * The "host" palette is not stored here: it is resolved from the tokens the
 * host sends with its theme (D-1042/D-1043), so an exported card matches the
 * code surface the reader is looking at.
 */

import {
  detectCodeLanguage,
  LANGUAGE_LABELS,
  tokenizeCode,
  type CodeLanguage,
  type CodeToken,
} from "./tokenize";

export type CodeCardTheme =
  | "host"
  | "terracotta"
  | "paper"
  | "ocean"
  | "midnight"
  | "graphite"
  | "nord"
  | "violet";
export type CodeWindowStyle = "mac" | "windows" | "none";
export type CodeCardScale = 1 | 2;

export interface CodeCardOptions {
  theme: CodeCardTheme;
  /** Explicit language; "auto" asks the detector. */
  language: CodeLanguage | "auto";
  windowStyle: CodeWindowStyle;
  lineNumbers: boolean;
  /** Monospace size in CSS pixels, 11–20. */
  fontSize: number;
  /** Line box as a percentage of the font size, 100–200. */
  lineHeight: number;
  /** Canvas padding left and right, 16–128. */
  paddingX: number;
  /** Canvas padding above and below, 16–128. */
  paddingY: number;
  shadow: boolean;
  /** Shadow offset below the window, 0–100. */
  shadowOffset: number;
  /** Shadow blur radius, 0–100. */
  shadowBlur: number;
  /** Window surface: "host" follows the host, a hex value is fixed. */
  background: string;
  /** Keep the window on the code's own width instead of a fixed 680 px. */
  autoWidth: boolean;
  /** Export pixel density. */
  scale: CodeCardScale;
}

export interface CodeCardPalette {
  /** The window surface the code sits on. */
  surface: string;
  /** The area around the window. */
  background: string;
  shadow: string;
  ink: string;
  muted: string;
  gutter: string;
  accent: string;
  tokens: Record<string, string>;
}

/** The host's resolved scheme and design tokens, as the bridge delivers them. */
export interface HostTheme {
  scheme: "light" | "dark";
  tokens: Record<string, string>;
}

export const DEFAULT_CODE_CARD_OPTIONS: CodeCardOptions = {
  theme: "host",
  language: "auto",
  windowStyle: "mac",
  lineNumbers: false,
  fontSize: 14,
  lineHeight: 133,
  paddingX: 56,
  paddingY: 56,
  shadow: true,
  shadowOffset: 20,
  shadowBlur: 68,
  background: "host",
  autoWidth: true,
  scale: 2,
};

/** A theme's name and the tone it belongs to in the rail's grouped picker. */
export interface CodeCardThemeChoice {
  id: CodeCardTheme;
  name: string;
  tone: "host" | "light" | "dark";
}

export const CODE_CARD_THEMES: readonly CodeCardThemeChoice[] = [
  { id: "host", name: "跟随宿主", tone: "host" },
  { id: "terracotta", name: "陶土", tone: "light" },
  { id: "paper", name: "纸白", tone: "light" },
  { id: "ocean", name: "海蓝", tone: "light" },
  { id: "midnight", name: "午夜", tone: "dark" },
  { id: "graphite", name: "石墨", tone: "dark" },
  { id: "nord", name: "北境", tone: "dark" },
  { id: "violet", name: "紫夜", tone: "dark" },
];

type StoredTheme = Exclude<CodeCardTheme, "host">;

export const CODE_CARD_PALETTES: Record<StoredTheme, CodeCardPalette> = {
  terracotta: {
    surface: "#fbf5ec",
    background: "#ece3d5",
    shadow: "rgba(58, 38, 18, 0.28)",
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
  paper: {
    surface: "#fdfcf9",
    background: "#efede6",
    shadow: "rgba(40, 34, 26, 0.22)",
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
  ocean: {
    surface: "#f7fafb",
    background: "#dde8ec",
    shadow: "rgba(24, 50, 62, 0.24)",
    ink: "#1f2c33",
    muted: "#7d8f98",
    gutter: "#a9bcc5",
    accent: "#2f6d86",
    tokens: {
      keyword: "#2f5f86",
      string: "#3f6b52",
      comment: "#8b9aa1",
      number: "#8a5a1f",
      function: "#2f6d7e",
      property: "#6b4f7c",
      literal: "#8f4a47",
      tag: "#2f6d86",
      type: "#2f6d61",
    },
  },
  midnight: {
    surface: "#1b1815",
    background: "#12100e",
    shadow: "rgba(0, 0, 0, 0.55)",
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
  graphite: {
    surface: "#1f1f22",
    background: "#161618",
    shadow: "rgba(0, 0, 0, 0.55)",
    ink: "#ecebe8",
    muted: "#9a9a9e",
    gutter: "#75757a",
    accent: "#d0a45f",
    tokens: {
      keyword: "#d0a45f",
      string: "#a3c184",
      comment: "#828287",
      number: "#d8b878",
      function: "#8bb8d4",
      property: "#c3a6d0",
      literal: "#e09b9b",
      tag: "#e0a06a",
      type: "#86c2ba",
    },
  },
  nord: {
    surface: "#2e3440",
    background: "#242933",
    shadow: "rgba(0, 0, 0, 0.50)",
    ink: "#eceff4",
    muted: "#9099a8",
    gutter: "#6f7889",
    accent: "#88c0d0",
    tokens: {
      keyword: "#81a1c1",
      string: "#a3be8c",
      comment: "#7b8494",
      number: "#b48ead",
      function: "#88c0d0",
      property: "#d8a0b8",
      literal: "#d08770",
      tag: "#8fbcbb",
      type: "#8fbcbb",
    },
  },
  violet: {
    surface: "#211d2b",
    background: "#181420",
    shadow: "rgba(0, 0, 0, 0.55)",
    ink: "#ece6f2",
    muted: "#9a90aa",
    gutter: "#756b85",
    accent: "#c9a4e8",
    tokens: {
      keyword: "#c9a4e8",
      string: "#a8c98a",
      comment: "#8a8099",
      number: "#e0b979",
      function: "#8bb8d4",
      property: "#d3a6d0",
      literal: "#e09b9b",
      tag: "#e0a06a",
      type: "#86c2ba",
    },
  },
};

/** The host palette before a theme message arrives: the page's light fallback. */
const HOST_LIGHT: CodeCardPalette = {
  surface: "#f7f1e6",
  background: "#f3ece1",
  shadow: "rgba(58, 38, 18, 0.28)",
  ink: "#241e19",
  muted: "#7d7264",
  gutter: "#a99d8c",
  accent: "#a65d2e",
  tokens: {
    keyword: "#9c4a15",
    string: "#476a2f",
    comment: "#7d7264",
    number: "#855715",
    function: "#70448f",
    property: "#1f6b6a",
    literal: "#855715",
    tag: "#a6471d",
    type: "#2d5580",
  },
};

/** The host palette in dark appearance, matching the host's code surface. */
const HOST_DARK: CodeCardPalette = {
  surface: "#241e19",
  background: "#1b1916",
  shadow: "rgba(0, 0, 0, 0.55)",
  ink: "#f5ecdf",
  muted: "#9b8d7e",
  gutter: "#6d6255",
  accent: "#e29a63",
  tokens: {
    keyword: "#f0aa72",
    string: "#b9cf99",
    comment: "#9b8d7e",
    number: "#e1c27e",
    function: "#d2b5e5",
    property: "#8fc9c1",
    literal: "#e1c27e",
    tag: "#eaa97c",
    type: "#b6c9e8",
  },
};

/**
 * resolvePalette answers the card's colours. A stored theme is a constant; the
 * host theme reads the tokens the bridge received, so it follows appearance
 * changes while the page is open. Missing tokens fall back by scheme rather
 * than by theme, so a host that sends only a few values still gets a coherent
 * card.
 */
export function resolvePalette(
  theme: CodeCardTheme,
  host: HostTheme | null = null,
): CodeCardPalette {
  if (theme !== "host") return CODE_CARD_PALETTES[theme];
  const fallback = host?.scheme === "dark" ? HOST_DARK : HOST_LIGHT;
  const token = (name: string): string => {
    const value = host?.tokens[name];
    return typeof value === "string" ? value.trim() : "";
  };
  return {
    surface: token("code-surface") || fallback.surface,
    background: token("surface-solid") || token("surface-raised") || fallback.background,
    shadow: fallback.shadow,
    ink: token("code-ink") || token("ink") || fallback.ink,
    muted: token("code-comment") || token("ink-soft") || fallback.muted,
    gutter: token("code-comment") || token("ink-soft") || fallback.gutter,
    accent: token("accent") || token("code-function") || fallback.accent,
    tokens: {
      keyword: token("code-keyword") || fallback.tokens.keyword || fallback.ink,
      string: token("code-string") || fallback.tokens.string || fallback.ink,
      comment: token("code-comment") || fallback.tokens.comment || fallback.muted,
      number: token("code-number") || fallback.tokens.number || fallback.ink,
      function: token("code-function") || fallback.tokens.function || fallback.ink,
      property: token("code-property") || fallback.tokens.property || fallback.ink,
      literal: token("code-number") || fallback.tokens.literal || fallback.ink,
      tag: token("code-tag") || fallback.tokens.tag || fallback.ink,
      type: token("code-type") || fallback.tokens.type || fallback.ink,
    },
  };
}

/**
 * resolveBackground answers the colour behind the window: the palette's own
 * ground, the chosen hex, or null for a transparent export.
 */
export function resolveBackground(
  options: CodeCardOptions,
  palette: CodeCardPalette,
): string | null {
  const chosen = options.background.trim();
  if (chosen === "transparent") return null;
  if (chosen === "" || chosen === "host") return palette.background;
  return chosen;
}

export interface CodeCardSource {
  /** The entry title, kept for the exported file name only. */
  title: string;
  language: CodeLanguage;
  label: string;
  tokens: CodeToken[];
}

/** Longest source drawn on a card; the rest is cut once with a marker. */
export const CARD_SOURCE_LIMIT = 6_000;

/**
 * cardSource turns an entry into what the card draws. Detection only decides
 * when the rail says "auto"; an explicit language is also the label, so the
 * picker and the drawing cannot disagree.
 */
export function cardSource(
  text: string,
  fallbackTitle: string,
  language: CodeLanguage | "auto" = "auto",
): CodeCardSource | null {
  const body = text.trim();
  if (!body) return null;
  const chosen: CodeLanguage =
    language === "auto" ? detectCodeLanguage(body) ?? "javascript" : language;
  const tokens = tokenizeCode(body, chosen);
  const title = fallbackTitle.trim() || body.split("\n", 1)[0]?.trim().slice(0, 60) || "代码";
  return {
    title,
    language: chosen,
    label: chosen === "javascript" && !hasKnownSyntax(tokens) ? "文本" : LANGUAGE_LABELS[chosen],
    tokens: truncateTokens(tokens, CARD_SOURCE_LIMIT),
  };
}

/** The detector falls back to JavaScript; an untouched scan is plain text. */
function hasKnownSyntax(tokens: CodeToken[]): boolean {
  return tokens.some((token) => token.kind !== "");
}

function truncateTokens(tokens: CodeToken[], limit: number): CodeToken[] {
  const out: CodeToken[] = [];
  let used = 0;
  for (const token of tokens) {
    if (used + token.text.length <= limit) {
      out.push(token);
      used += token.text.length;
      continue;
    }
    const room = limit - used;
    if (room > 0) out.push({ ...token, text: token.text.slice(0, room) });
    out.push({ kind: "", text: "\n..." });
    return out;
  }
  return out;
}

/** Splits tokens into drawn lines; a tab is drawn as four spaces, like Carbon. */
export function splitTokenLines(tokens: CodeToken[], maxChars: number): CodeToken[][] {
  const lines: CodeToken[][] = [[]];
  let column = 0;
  let buffer = "";
  const flush = () => {
    if (buffer) lines[lines.length - 1]?.push({ text: buffer, kind: "" });
    buffer = "";
  };
  for (const token of tokens) {
    const text = token.text.replace(/\t/g, "    ");
    for (const character of text) {
      if (character === "\n") {
        flush();
        lines.push([]);
        column = 0;
        continue;
      }
      if (column >= maxChars) {
        flush();
        lines.push([]);
        column = 0;
      }
      buffer += character;
      column += 1;
    }
    flush();
  }
  return lines;
}

export interface CodeCardLayout {
  /** Export size in CSS pixels, canvas padding included. */
  width: number;
  height: number;
  /** The window inside the export. */
  cardWidth: number;
  cardHeight: number;
  paddingX: number;
  paddingY: number;
  lines: CodeToken[][];
  charWidth: number;
  lineHeight: number;
  /** Height of the window band above the code (Carbon's 48 px). */
  barHeight: number;
  gutterWidth: number;
  /** Where the first code column starts, measured from the window's left edge. */
  contentLeft: number;
  fontSize: number;
}

export const CARD_BAR_HEIGHT = 48;
export const CARD_PAD_LEFT = 16;
export const CARD_PAD_RIGHT = 18;
export const CARD_PAD_BOTTOM = 18;
export const CARD_RADIUS = 10;
export const FIXED_CARD_WIDTH = 680;
export const MAX_CARD_WIDTH = 1_600;
export const MIN_CARD_WIDTH = 220;
export const MIN_FONT_SIZE = 11;
export const MAX_FONT_SIZE = 20;
export const MIN_LINE_HEIGHT = 100;
export const MAX_LINE_HEIGHT = 200;
export const MIN_PADDING = 16;
export const MAX_PADDING = 128;

const FONT_STACK = '"Hack", "SF Mono", "Menlo", "PingFang SC", monospace';

export function codeCardLayout(
  source: CodeCardSource,
  options: CodeCardOptions,
): CodeCardLayout {
  const fontSize = clamp(Math.round(options.fontSize), MIN_FONT_SIZE, MAX_FONT_SIZE);
  const lineHeightPercent = clamp(
    Math.round(options.lineHeight),
    MIN_LINE_HEIGHT,
    MAX_LINE_HEIGHT,
  );
  const paddingX = clamp(Math.round(options.paddingX), MIN_PADDING, MAX_PADDING);
  const paddingY = clamp(Math.round(options.paddingY), MIN_PADDING, MAX_PADDING);
  const charWidth = fontSize * 0.602;
  const lineHeight = Math.max(fontSize + 2, Math.round(fontSize * (lineHeightPercent / 100)));
  const digits = Math.max(2, String(Math.max(1, source.tokens.length)).length);
  const gutterWidth = options.lineNumbers ? Math.ceil(digits * charWidth) + 16 : 0;
  const maxChars = Math.max(
    24,
    Math.floor((MAX_CARD_WIDTH - CARD_PAD_LEFT - CARD_PAD_RIGHT - gutterWidth) / charWidth),
  );
  const lines = splitTokenLines(source.tokens, maxChars);
  const longest = lines.reduce(
    (width, line) => Math.max(width, line.reduce((sum, token) => sum + token.text.length, 0)),
    0,
  );
  const measured =
    CARD_PAD_LEFT + gutterWidth + longest * charWidth + CARD_PAD_RIGHT;
  const cardWidth = options.autoWidth
    ? clamp(Math.ceil(measured), MIN_CARD_WIDTH, MAX_CARD_WIDTH)
    : FIXED_CARD_WIDTH;
  const cardHeight = CARD_BAR_HEIGHT + lines.length * lineHeight + CARD_PAD_BOTTOM;
  return {
    width: cardWidth + paddingX * 2,
    height: cardHeight + paddingY * 2,
    cardWidth,
    cardHeight,
    paddingX,
    paddingY,
    lines,
    charWidth,
    lineHeight,
    barHeight: CARD_BAR_HEIGHT,
    gutterWidth,
    contentLeft: CARD_PAD_LEFT + gutterWidth,
    fontSize,
  };
}

/** Draws the card at the selected export scale and returns its geometry. */
export function drawCodeCard(
  canvas: HTMLCanvasElement,
  source: CodeCardSource,
  options: CodeCardOptions,
  host: HostTheme | null = null,
): CodeCardLayout {
  const layout = codeCardLayout(source, options);
  const palette = resolvePalette(options.theme, host);
  const background = resolveBackground(options, palette);
  const ratio = options.scale;
  canvas.width = Math.round(layout.width * ratio);
  canvas.height = Math.round(layout.height * ratio);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("当前环境不支持 Canvas");
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, layout.width, layout.height);

  if (background) {
    context.fillStyle = background;
    context.fillRect(0, 0, layout.width, layout.height);
  }

  const x = layout.paddingX;
  const y = layout.paddingY;
  const width = layout.cardWidth;
  const height = layout.cardHeight;

  context.save();
  if (options.shadow) {
    context.shadowColor = palette.shadow;
    context.shadowBlur = clamp(options.shadowBlur, 0, 100);
    context.shadowOffsetY = clamp(options.shadowOffset, 0, 100);
  }
  roundedRect(context, x, y, width, height, CARD_RADIUS);
  context.fillStyle = palette.surface;
  context.fill();
  context.restore();

  context.save();
  roundedRect(context, x, y, width, height, CARD_RADIUS);
  context.clip();

  if (options.windowStyle === "mac") {
    drawMacControls(context, x + CARD_PAD_LEFT, y + layout.barHeight / 2);
  } else if (options.windowStyle === "windows") {
    drawWindowsControls(
      context,
      x + width - CARD_PAD_RIGHT,
      y + layout.barHeight / 2,
      palette.muted,
    );
  }

  context.font = `${layout.fontSize}px ${FONT_STACK}`;
  context.textBaseline = "middle";
  const top = y + layout.barHeight;
  layout.lines.forEach((line, index) => {
    const lineY = top + layout.lineHeight / 2 + index * layout.lineHeight;
    if (options.lineNumbers) {
      context.fillStyle = palette.gutter;
      context.textAlign = "right";
      context.fillText(
        String(index + 1),
        x + CARD_PAD_LEFT + layout.gutterWidth - 14,
        lineY,
      );
      context.textAlign = "left";
    }
    let lineX = x + layout.contentLeft;
    for (const token of line) {
      context.fillStyle = palette.tokens[token.kind] ?? palette.ink;
      context.fillText(token.text, lineX, lineY);
      lineX += token.text.length * layout.charWidth;
    }
  });

  context.restore();
  return layout;
}

/** Carbon's traffic lights: 12 px circles, 8 px apart, 16 px in. */
function drawMacControls(
  context: CanvasRenderingContext2D,
  left: number,
  centerY: number,
): void {
  const colors = ["#ff5f56", "#ffbd2e", "#27c93f"];
  colors.forEach((color, index) => {
    context.beginPath();
    context.arc(left + 6 + index * 20, centerY, 6, 0, Math.PI * 2);
    context.fillStyle = color;
    context.fill();
  });
}

/** Windows draws its three controls at the right edge, as Carbon does. */
function drawWindowsControls(
  context: CanvasRenderingContext2D,
  right: number,
  centerY: number,
  color: string,
): void {
  context.strokeStyle = color;
  context.lineWidth = 1.2;
  context.lineCap = "round";
  const closeX = right - 6;
  context.beginPath();
  context.moveTo(closeX - 4, centerY - 4);
  context.lineTo(closeX + 4, centerY + 4);
  context.moveTo(closeX + 4, centerY - 4);
  context.lineTo(closeX - 4, centerY + 4);
  context.stroke();
  const maximizeX = closeX - 20;
  context.strokeRect(maximizeX - 4, centerY - 4, 8, 8);
  const minimizeX = maximizeX - 20;
  context.beginPath();
  context.moveTo(minimizeX - 4, centerY);
  context.lineTo(minimizeX + 4, centerY);
  context.stroke();
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

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
