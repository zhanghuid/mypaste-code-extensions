/**
 * The card renderer: palettes, geometry and canvas drawing. Everything here is
 * local — the card is drawn from the item's text and turned into one PNG data
 * URL; no font, image or script is fetched.
 *
 * A card has three layers, from the outside in: the background (the theme's
 * own tone, or transparent), the window (surface, title bar, border, optional
 * shadow) and the code. Only the code is measured by the tokenizer; the rest
 * is geometry, so the rail can change any appearance option without
 * re-reading the item.
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
  /** Monospace size in CSS pixels, 11–18. */
  fontSize: number;
  /** Space between the window edge and the code, 16–56. */
  padding: number;
  shadow: boolean;
  /** Leave the area outside the window transparent instead of themed. */
  transparent: boolean;
  /** Export pixel density. */
  scale: CodeCardScale;
}

export interface CodeCardPalette {
  /** The window surface the code sits on. */
  surface: string;
  /** The title bar, drawn over the surface. */
  titleBar: string;
  /** The area around the window. */
  background: string;
  border: string;
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
  lineNumbers: true,
  fontSize: 13,
  padding: 30,
  shadow: true,
  transparent: false,
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
    titleBar: "#f2e7d8",
    background: "#ece3d5",
    border: "rgba(60, 42, 26, 0.12)",
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
    titleBar: "#f4f1ea",
    background: "#efede6",
    border: "rgba(40, 34, 26, 0.12)",
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
    titleBar: "#e8f0f3",
    background: "#dde8ec",
    border: "rgba(31, 44, 51, 0.12)",
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
    titleBar: "#231f1b",
    background: "#12100e",
    border: "rgba(255, 255, 255, 0.09)",
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
    titleBar: "#27272b",
    background: "#161618",
    border: "rgba(255, 255, 255, 0.09)",
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
    titleBar: "#343b48",
    background: "#242933",
    border: "rgba(236, 239, 244, 0.10)",
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
    titleBar: "#2a2537",
    background: "#181420",
    border: "rgba(236, 230, 242, 0.10)",
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
  titleBar: "#efe7d9",
  background: "#f3ece1",
  border: "rgba(73, 61, 47, 0.14)",
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
  titleBar: "#2c2620",
  background: "#1b1916",
  border: "rgba(230, 216, 197, 0.12)",
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
    titleBar: token("surface-raised") || fallback.titleBar,
    background: token("surface-solid") || token("surface-raised") || fallback.background,
    border: token("line") || fallback.border,
    shadow: fallback.shadow,
    ink: token("code-ink") || token("ink") || fallback.ink,
    muted: token("code-comment") || token("ink-soft") || fallback.muted,
    gutter: token("code-comment") || token("ink-soft") || fallback.gutter,
    accent: token("accent") || token("code-function") || fallback.accent,
    tokens: {
      keyword: token("code-keyword") || fallback.tokens.keyword || fallback.ink,
      string: token("code-string") || fallback.tokens.string || fallback.ink,
      comment: token("code-comment") || fallback.tokens.comment || fallback.ink,
      number: token("code-number") || fallback.tokens.number || fallback.ink,
      function: token("code-function") || fallback.tokens.function || fallback.ink,
      property: token("code-property") || fallback.tokens.property || fallback.ink,
      literal: token("code-number") || fallback.tokens.literal || fallback.ink,
      tag: token("code-tag") || fallback.tokens.tag || fallback.ink,
      type: token("code-type") || fallback.tokens.type || fallback.ink,
    },
  };
}

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
      // Canvas draws a tab as an arbitrary-width space, while the layout
      // advances by one character. Four spaces make the indent visible and
      // keep the two measurements the same.
      if (character === "\t") {
        buffer += "    ";
        column += 4;
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
  /** Export size in CSS pixels, background margin included. */
  width: number;
  height: number;
  /** The window inside the export. */
  cardWidth: number;
  cardHeight: number;
  margin: number;
  lines: CodeToken[][];
  charWidth: number;
  lineHeight: number;
  padding: number;
  titleHeight: number;
  /** Extra space a headless window gives its language label. */
  headerExtra: number;
  gutterWidth: number;
  fontSize: number;
}

const FONT_STACK = '"SF Mono", "Menlo", "PingFang SC", monospace';
const MAX_CARD_WIDTH = 1_600;
const MIN_CARD_WIDTH = 420;
const CARD_RADIUS = 14;
const SHADOW_MARGIN = 54;
const FLAT_MARGIN = 32;
const MIN_FONT_SIZE = 11;
const MAX_FONT_SIZE = 18;
const MIN_PADDING = 16;
const MAX_PADDING = 56;

export function codeCardLayout(
  source: CodeCardSource,
  options: CodeCardOptions,
): CodeCardLayout {
  const fontSize = clamp(Math.round(options.fontSize), MIN_FONT_SIZE, MAX_FONT_SIZE);
  const padding = clamp(Math.round(options.padding), MIN_PADDING, MAX_PADDING);
  const charWidth = fontSize * 0.602;
  const lineHeight = Math.round(fontSize * 1.62);
  const titleHeight =
    options.windowStyle === "mac" ? 46 : options.windowStyle === "windows" ? 40 : 0;
  const headerExtra = options.windowStyle === "none" ? 22 : 0;
  const maxChars = Math.max(
    24,
    Math.floor((MAX_CARD_WIDTH - padding * 2 - 20) / charWidth),
  );
  const lines = splitTokenLines(source.tokens, maxChars);
  const longest = lines.reduce(
    (width, line) =>
      Math.max(width, line.reduce((sum, token) => sum + [...token.text].length, 0)),
    0,
  );
  // The gutter reserves two spaces plus the digits a line count needs, so a
  // 4,000-line card does not push its numbers over the code.
  const gutterWidth = options.lineNumbers
    ? Math.ceil(charWidth * (String(lines.length).length + 2))
    : 0;
  const cardWidth = Math.min(
    MAX_CARD_WIDTH,
    Math.max(
      MIN_CARD_WIDTH,
      Math.ceil(padding * 2 + gutterWidth + longest * charWidth + 20),
    ),
  );
  const cardHeight = Math.max(
    168,
    titleHeight + headerExtra + padding * 2 + Math.max(1, lines.length) * lineHeight,
  );
  const margin = options.shadow ? SHADOW_MARGIN : FLAT_MARGIN;
  return {
    width: cardWidth + margin * 2,
    height: cardHeight + margin * 2,
    cardWidth,
    cardHeight,
    margin,
    lines,
    charWidth,
    lineHeight,
    padding,
    titleHeight,
    headerExtra,
    gutterWidth,
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
  const ratio = options.scale;
  canvas.width = Math.round(layout.width * ratio);
  canvas.height = Math.round(layout.height * ratio);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("当前环境不支持 Canvas");
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, layout.width, layout.height);

  if (!options.transparent) {
    context.fillStyle = palette.background;
    context.fillRect(0, 0, layout.width, layout.height);
  }

  const x = layout.margin;
  const y = layout.margin;
  const width = layout.cardWidth;
  const height = layout.cardHeight;

  if (options.shadow) {
    context.save();
    context.shadowColor = palette.shadow;
    context.shadowBlur = 36;
    context.shadowOffsetY = 18;
    roundedRect(context, x, y, width, height, CARD_RADIUS);
    context.fillStyle = palette.surface;
    context.fill();
    context.restore();
  } else {
    roundedRect(context, x, y, width, height, CARD_RADIUS);
    context.fillStyle = palette.surface;
    context.fill();
  }

  context.save();
  roundedRect(context, x, y, width, height, CARD_RADIUS);
  context.clip();

  if (layout.titleHeight > 0) {
    context.fillStyle = palette.titleBar;
    context.fillRect(x, y, width, layout.titleHeight);
    context.fillStyle = palette.muted;
    context.font = `500 ${Math.max(10, layout.fontSize - 2)}px ${FONT_STACK}`;
    context.textAlign = "center";
    context.textBaseline = "middle";
    if (options.windowStyle === "mac") {
      drawMacControls(context, x + 26, y + layout.titleHeight / 2);
    } else {
      drawWindowsControls(
        context,
        x + width - 26,
        y + layout.titleHeight / 2,
        palette.muted,
      );
    }
    context.fillText(
      truncateText(
        context,
        source.title.trim() || source.label,
        width - (options.windowStyle === "mac" ? 190 : 150),
      ),
      x + width / 2,
      y + layout.titleHeight / 2,
    );
    context.textAlign = "left";
  } else {
    context.fillStyle = palette.accent;
    context.font = `700 ${Math.max(9, layout.fontSize - 3)}px ${FONT_STACK}`;
    context.textBaseline = "middle";
    context.fillText(source.label.toUpperCase(), x + layout.padding, y + 20);
  }

  context.font = `${layout.fontSize}px ${FONT_STACK}`;
  context.textBaseline = "middle";
  let lineY =
    y + layout.titleHeight + layout.headerExtra + layout.padding + layout.lineHeight / 2;
  layout.lines.forEach((line, index) => {
    let lineX = x + layout.padding;
    if (options.lineNumbers) {
      context.fillStyle = palette.gutter;
      context.textAlign = "right";
      context.fillText(
        String(index + 1),
        x + layout.padding + layout.gutterWidth - 10,
        lineY,
      );
      context.textAlign = "left";
      lineX += layout.gutterWidth;
    }
    for (const token of line) {
      context.fillStyle = token.kind
        ? palette.tokens[token.kind] ?? palette.ink
        : palette.ink;
      context.fillText(token.text, lineX, lineY);
      lineX += [...token.text].length * layout.charWidth;
    }
    lineY += layout.lineHeight;
  });

  context.restore();

  roundedRect(context, x + 0.5, y + 0.5, width - 1, height - 1, CARD_RADIUS);
  context.strokeStyle = palette.border;
  context.lineWidth = 1;
  context.stroke();
  return layout;
}

/** The three traffic lights, one circle each. */
function drawMacControls(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
): void {
  const dots = ["#de6a5c", "#dfae55", "#7aa365"];
  dots.forEach((color, index) => {
    context.beginPath();
    context.fillStyle = color;
    context.arc(x + index * 17, y, 4.6, 0, Math.PI * 2);
    context.fill();
  });
}

/** Minimise, maximise, close: three strokes at the title bar's right edge. */
function drawWindowsControls(
  context: CanvasRenderingContext2D,
  right: number,
  y: number,
  color: string,
): void {
  context.save();
  context.strokeStyle = color;
  context.lineWidth = 1.3;
  context.lineCap = "butt";
  const closeX = right;
  const maxX = right - 22;
  const minX = right - 44;
  context.beginPath();
  context.moveTo(closeX - 4, y - 4);
  context.lineTo(closeX + 4, y + 4);
  context.moveTo(closeX + 4, y - 4);
  context.lineTo(closeX - 4, y + 4);
  context.stroke();
  context.strokeRect(maxX - 4, y - 4, 8, 8);
  context.beginPath();
  context.moveTo(minX - 4, y);
  context.lineTo(minX + 4, y);
  context.stroke();
  context.restore();
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
  text: string,
  maxWidth: number,
): string {
  if (context.measureText(text).width <= maxWidth) return text;
  const characters = [...text];
  while (characters.length > 1) {
    characters.pop();
    const candidate = `${characters.join("")}…`;
    if (context.measureText(candidate).width <= maxWidth) return candidate;
  }
  return "…";
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** The most source characters one card ever reads; the rest is elided. */
export const CARD_SOURCE_LIMIT = 6_000;

/**
 * cardSource turns the item's text into a drawn card. Detection reads the text
 * itself, so a JSON object pasted as plain text still gets JSON tokens; text
 * with no recognizable shape is drawn plain rather than refused. An explicit
 * language skips detection, because the reader can see the language when the
 * detector cannot.
 */
export function cardSource(
  text: string,
  fallbackTitle: string,
  language: CodeLanguage | "auto" = "auto",
): CodeCardSource | null {
  const candidate = text.trim();
  if (!candidate) return null;
  const bounded =
    candidate.length > CARD_SOURCE_LIMIT
      ? `${candidate.slice(0, CARD_SOURCE_LIMIT)}\n...`
      : candidate;
  const detected =
    language === "auto" ? detectCodeLanguage(candidate) : language;
  // Text the detector cannot place is tokenized as JavaScript and labelled as
  // plain text: the card still renders, and the label does not claim a
  // language the card did not recognize.
  const effective = detected ?? "javascript";
  return {
    title: fallbackTitle.trim() || "未命名",
    tokens: tokenizeCode(bounded, effective),
    language: effective,
    label: detected ? LANGUAGE_LABELS[detected] : "文本",
  };
}
