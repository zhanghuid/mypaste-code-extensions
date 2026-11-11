/**
 * The link inspector page.
 *
 * The host opens this surface for a `link` entity and delivers its text. The
 * page asks the registry which headless capabilities adapt links, invokes the
 * companion detector, and paints the document it returns. Detection is local
 * and offline. Rendering is not: once the type is known, the page loads the
 * link itself — an image, a video, an audio file, or text it fetches and shows
 * as text. The official package declares `surface.network`, so the host's
 * surface document may load remote content (host D-1100); everything the page
 * cannot get falls back to a card that says why. Copying is a host action, and
 * every value reaches the DOM through `textContent`, never HTML — a fetched
 * HTML page is shown as source, never injected.
 */

import { connectSurface } from "./bridge";
import {
  confidenceWord,
  evidenceWord,
  parseDetectorResult,
  sourceWord,
  type DetectorResult,
  type Evidence,
} from "./result";
import { formatText, planFor, planWord, type RenderPlan } from "./renderer";

/**
 * The companion detector's public pair, as declared by com.mypaste.link-mime.
 * The page never composes it: it looks the pair up in the registry's answer
 * and invokes only a pair the host itself returned, so a missing or disabled
 * detector is a visible state, not a failed call.
 */
const DETECTOR_PLUGIN_ID = "com.mypaste.link-mime";
const DETECTOR_COMMAND_ID = "detect";

function one<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (element === null) throw new Error(`缺少元素 ${selector}`);
  return element;
}

const label = one<HTMLHeadingElement>("#type-label");
const mime = one<HTMLElement>("#mime");
const category = one<HTMLElement>("#category");
const confidence = one<HTMLElement>("#confidence");
const linkText = one<HTMLParagraphElement>("#url");
const resultSection = one<HTMLElement>("#result");
const facts = one<HTMLElement>("#facts");
const factScheme = one<HTMLElement>("#fact-scheme");
const factHost = one<HTMLElement>("#fact-host");
const factPath = one<HTMLElement>("#fact-path");
const factSource = one<HTMLElement>("#fact-source");
const schemeValue = one<HTMLElement>("#scheme");
const hostValue = one<HTMLElement>("#host");
const pathValue = one<HTMLElement>("#path");
const sourceValue = one<HTMLElement>("#source");
const evidenceBlock = one<HTMLElement>("#evidence-block");
const evidenceList = one<HTMLUListElement>("#evidence");
const note = one<HTMLParagraphElement>("#note");
const actions = one<HTMLElement>("#actions");
const copyMime = one<HTMLButtonElement>("#copy-mime");
const copyResult = one<HTMLButtonElement>("#copy-result");
const empty = one<HTMLElement>("#empty");
const emptyTitle = one<HTMLElement>("#empty-title");
const emptyDetail = one<HTMLElement>("#empty-detail");
const emptyRaw = one<HTMLPreElement>("#empty-raw");
const status = one<HTMLParagraphElement>("#status");
const closeButton = one<HTMLButtonElement>("#doc-close");
const previewSection = one<HTMLElement>("#preview");
const previewStage = one<HTMLElement>("#preview-stage");
const previewKind = one<HTMLElement>("#preview-kind");
const previewNote = one<HTMLParagraphElement>("#preview-note");
const previewReload = one<HTMLButtonElement>("#preview-reload");
const copyLink = one<HTMLButtonElement>("#copy-link");

const bridge = connectSurface();

/** A page that waits for a slow server must still answer the next item. */
const FETCH_TIMEOUT_MS = 15_000;
const MAX_FETCH_BYTES = 4 * 1024 * 1024;
/**
 * A media element that never loads may never fire `error` either (a stalled
 * connection can leave it spinning). The watchdog turns that into the same
 * fallback card every other failure gets.
 */
const MEDIA_TIMEOUT_MS = 20_000;

let currentMime = "";
let currentUrl = "";
let currentResult: DetectorResult | null = null;
let rawOutput = "";
let previewToken = 0;

function setStatus(text: string): void {
  status.textContent = text;
}

function setFact(row: HTMLElement, value: HTMLElement, text: string | undefined): void {
  const shown = (text ?? "").trim();
  row.hidden = shown === "";
  value.textContent = shown;
}

/*
 * The preview stage. Three of the renderers are the browser's own — <img>,
 * <video> and <audio> load their source directly — and text is fetched and
 * painted as text. Nothing the server sends becomes markup. Every failure
 * replaces the stage with a card that names what was attempted and why it
 * stopped, so a link that cannot be fetched is a visible state rather than a
 * blank page.
 */
function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} 字节`;
}

function stageNote(title: string, detail: string, tone: "error" | "quiet"): HTMLElement {
  const box = document.createElement("div");
  box.className = "stage-empty";
  box.dataset.tone = tone;
  const heading = document.createElement("h3");
  heading.textContent = title;
  const body = document.createElement("p");
  body.textContent = detail;
  box.append(heading, body);
  return box;
}

function showPreviewFailure(title: string, detail: string): void {
  previewStage.replaceChildren(stageNote(title, detail, "error"));
  previewNote.hidden = true;
  previewNote.textContent = "";
}

function renderTextBlock(text: string, note: string): void {
  if (text === "") {
    showPreviewFailure("内容为空", "服务器返回了 0 字节的文本。");
    return;
  }
  const pre = document.createElement("pre");
  pre.className = "stage-text";
  pre.textContent = text;
  previewStage.replaceChildren(pre);
  previewNote.textContent = note;
  previewNote.hidden = note === "";
}

function renderMedia(plan: Extract<RenderPlan, { kind: "image" | "video" | "audio" }>): void {
  const detail = `浏览器没有取到 ${plan.mime} 内容：地址可能失效、服务器拒绝了请求，或网络不可达。`;
  let settled = false;
  const timer = window.setTimeout(() => {
    if (settled) return;
    settled = true;
    showPreviewFailure(
      "加载超时",
      `浏览器在 ${MEDIA_TIMEOUT_MS / 1000} 秒内没有取到 ${plan.mime} 内容；可以点「重新加载」再试，或复制链接后在浏览器中打开。`,
    );
  }, MEDIA_TIMEOUT_MS);
  const settle = (): void => {
    settled = true;
    window.clearTimeout(timer);
  };
  if (plan.kind === "image") {
    const image = document.createElement("img");
    image.className = "stage-image";
    image.alt = currentResult?.label ?? "链接内容";
    image.decoding = "async";
    image.referrerPolicy = "no-referrer";
    image.addEventListener("load", settle);
    image.addEventListener("error", () => {
      settle();
      showPreviewFailure("无法加载这张图片", detail);
    });
    image.src = plan.url;
    previewStage.replaceChildren(image);
    return;
  }
  const media =
    plan.kind === "video" ? document.createElement("video") : document.createElement("audio");
  media.className = plan.kind === "video" ? "stage-video" : "stage-audio";
  media.controls = true;
  media.preload = "metadata";
  if (media instanceof HTMLVideoElement) media.playsInline = true;
  media.addEventListener("loadeddata", settle);
  media.addEventListener("error", () => {
    settle();
    showPreviewFailure(plan.kind === "video" ? "无法加载这段视频" : "无法加载这段音频", detail);
  });
  media.src = plan.url;
  previewStage.replaceChildren(media);
}

/** Reads a response body up to `maxBytes`, refusing to hold more in memory. */
async function readBounded(response: Response, maxBytes: number): Promise<string | "too-large"> {
  const body = response.body;
  if (body === null) {
    const text = await response.text();
    return text.length > maxBytes ? "too-large" : text;
  }
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let received = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel();
      return "too-large";
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return text;
}

type FetchOutcome = { ok: true; text: string } | { ok: false; message: string };

async function fetchLinkText(url: string): Promise<FetchOutcome> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      credentials: "omit",
      referrerPolicy: "no-referrer",
    });
    if (!response.ok) {
      const reason = response.statusText === "" ? "" : ` ${response.statusText}`;
      return { ok: false, message: `服务器返回 HTTP ${response.status}${reason}。` };
    }
    const length = Number(response.headers.get("content-length") ?? "");
    if (Number.isFinite(length) && length > MAX_FETCH_BYTES) {
      return {
        ok: false,
        message: `响应太大（${formatBytes(length)}），页面只读取 ${formatBytes(MAX_FETCH_BYTES)} 以内的文本。`,
      };
    }
    const text = await readBounded(response, MAX_FETCH_BYTES);
    if (text === "too-large") {
      return {
        ok: false,
        message: `响应超过 ${formatBytes(MAX_FETCH_BYTES)}，页面没有继续读取。`,
      };
    }
    return { ok: true, text };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      return {
        ok: false,
        message: `服务器没有在 ${FETCH_TIMEOUT_MS / 1000} 秒内返回，页面已放弃这次读取。`,
      };
    }
    return {
      ok: false,
      message: "浏览器没有取到内容：地址可能失效、服务器不允许跨域读取（CORS），或网络不可达。",
    };
  } finally {
    window.clearTimeout(timer);
  }
}

async function renderPreview(result: DetectorResult): Promise<void> {
  const token = ++previewToken;
  const plan = planFor(result);
  previewSection.hidden = false;
  previewKind.textContent = planWord(plan);
  previewNote.hidden = true;
  previewNote.textContent = "";
  previewStage.replaceChildren(stageNote("正在加载预览…", "正在向链接地址取内容。", "quiet"));
  previewReload.hidden = plan.kind === "unsupported" || (plan.kind === "text" && plan.inline);

  if (plan.kind === "unsupported") {
    showPreviewFailure("没有可用的预览", plan.reason);
    return;
  }
  if (plan.kind === "text") {
    if (plan.inline) {
      const formatted = formatText(plan.flavor, plan.text ?? "");
      renderTextBlock(formatted.text, formatted.note);
      return;
    }
    const outcome = await fetchLinkText(plan.url);
    if (token !== previewToken) return;
    if (!outcome.ok) {
      showPreviewFailure("无法读取文本内容", outcome.message);
      return;
    }
    const formatted = formatText(plan.flavor, outcome.text);
    renderTextBlock(formatted.text, formatted.note);
    return;
  }
  renderMedia(plan);
}

function clearPreview(): void {
  previewToken += 1;
  previewSection.hidden = true;
  previewStage.replaceChildren();
  previewKind.textContent = "";
  previewNote.textContent = "";
  previewNote.hidden = true;
  previewReload.hidden = true;
}

function renderEvidence(entries: readonly Evidence[]): void {
  evidenceList.replaceChildren(
    ...entries.map((entry) => {
      const item = document.createElement("li");
      item.className = "evidence";

      const kind = document.createElement("span");
      kind.className = "evidence-kind";
      kind.textContent = evidenceWord(entry.kind);

      const detail = document.createElement("span");
      detail.className = "evidence-detail";
      detail.textContent = entry.detail;

      const value = (entry.value ?? "").trim();
      if (value !== "") {
        const code = document.createElement("code");
        code.className = "evidence-value";
        code.textContent = value;
        detail.append(code);
      }

      item.append(kind, detail);
      return item;
    }),
  );
}

function showResult(result: DetectorResult): void {
  currentMime = result.mime ?? "";
  currentUrl = result.url.trim();
  currentResult = result;
  label.textContent = result.label;
  mime.textContent = result.mime ?? "—";
  category.textContent = result.categoryLabel ?? result.category;
  confidence.textContent = `置信度 ${confidenceWord(result.confidence)}`;
  confidence.dataset.level = result.confidence;

  setFact(factScheme, schemeValue, result.scheme);
  setFact(factHost, hostValue, result.host);
  setFact(factPath, pathValue, result.path);
  setFact(factSource, sourceValue, sourceWord(result.source));
  facts.hidden = [factScheme, factHost, factPath, factSource].every((row) => row.hidden);

  renderEvidence(result.evidence);
  note.textContent = result.note ?? "";
  note.hidden = note.textContent === "";

  evidenceBlock.hidden = false;
  actions.hidden = false;
  copyMime.hidden = currentMime === "";
  copyResult.hidden = false;
  copyLink.hidden = currentUrl === "";
  resultSection.hidden = false;
  empty.hidden = true;
  void renderPreview(result);
}

function showEmpty(title: string, detail: string, raw = ""): void {
  currentMime = "";
  currentUrl = "";
  currentResult = null;
  rawOutput = "";
  clearPreview();
  resultSection.hidden = true;
  empty.hidden = false;
  emptyTitle.textContent = title;
  emptyDetail.textContent = detail;
  emptyRaw.textContent = raw;
  emptyRaw.hidden = raw === "";
}

function showLoading(text: string): void {
  currentUrl = "";
  currentResult = null;
  clearPreview();
  linkText.textContent = text;
  linkText.hidden = text === "";
  label.textContent = "正在识别…";
  mime.textContent = "—";
  category.textContent = "";
  confidence.textContent = "";
  confidence.removeAttribute("data-level");
  facts.hidden = true;
  evidenceBlock.hidden = true;
  note.hidden = true;
  actions.hidden = true;
  copyMime.hidden = true;
  copyResult.hidden = true;
  evidenceList.replaceChildren();
  resultSection.hidden = text === "";
  empty.hidden = text !== "";
  setStatus("");
}

async function copyText(text: string, what: string): Promise<void> {
  if (text === "") return;
  const answer = await bridge.copy(text);
  setStatus(answer.ok ? `已复制${what}` : answer.message?.trim() || `复制${what}失败`);
}

async function inspect(text: string): Promise<void> {
  rawOutput = "";
  showLoading(text);
  if (text.trim() === "") {
    showEmpty("这条链接没有文本内容", "剪贴板条目是空的，没有可推断的链接。");
    return;
  }

  const registry = await bridge.registry(["link"]);
  if (!registry.ok) {
    showEmpty("无法读取扩展注册表", registry.message?.trim() || "宿主没有返回可用的能力列表。");
    return;
  }
  const detector = registry.commands.find(
    (command) =>
      command.pluginId === DETECTOR_PLUGIN_ID && command.commandId === DETECTOR_COMMAND_ID,
  );
  if (detector === undefined) {
    showEmpty(
      "没有找到「链接类型识别」扩展",
      "在市场安装并启用「链接类型识别」后，打开链接就会自动显示推断结果。",
    );
    return;
  }

  const answer = await bridge.invoke(detector.pluginId, detector.commandId, text);
  if (!answer.ok) {
    showEmpty("识别失败", answer.message?.trim() || "扩展没有说明原因。");
    return;
  }
  const output = (answer.output ?? "").trim();
  if (output === "") {
    showEmpty("识别没有返回结果", "链接类型识别扩展没有给出输出。");
    return;
  }
  const parsed = parseDetectorResult(output);
  if (parsed === null) {
    showEmpty(
      "扩展返回了无法识别的结果",
      "可能是扩展版本与页面不匹配；原始输出保留在下面。",
      output,
    );
    return;
  }
  rawOutput = output;
  showResult(parsed);
}

closeButton.addEventListener("click", () => {
  bridge.close();
});

copyMime.addEventListener("click", () => {
  void copyText(currentMime, " MIME 类型");
});

copyResult.addEventListener("click", () => {
  void copyText(rawOutput, "完整识别结果");
});

copyLink.addEventListener("click", () => {
  void copyText(currentUrl, "链接");
});

previewReload.addEventListener("click", () => {
  if (currentResult !== null) void renderPreview(currentResult);
});

bridge.onItem((delivery) => {
  void inspect(delivery.item.text);
});
