/**
 * The detector document (com.mypaste.link-mime) and the two closed word sets
 * this page renders it with.
 *
 * The page treats the JSON as data, not as trusted markup: a malformed or
 * newer document is refused whole rather than half-painted. Every value that
 * survives validation is a plain string the caller writes with textContent.
 */

export type Confidence = "high" | "medium" | "low";

export interface Evidence {
  kind: string;
  value?: string;
  detail: string;
}

export interface DetectorResult {
  schema: number;
  url: string;
  scheme?: string;
  host?: string;
  path?: string;
  mime?: string;
  label: string;
  category: string;
  categoryLabel?: string;
  confidence: Confidence;
  source: string;
  evidence: Evidence[];
  note?: string;
}

const CONFIDENCE_WORDS: Record<Confidence, string> = {
  high: "高",
  medium: "中",
  low: "低",
};

/** Why the result was chosen, in the page's own words. */
const SOURCE_WORDS: Record<string, string> = {
  "data-url": "data: 内联内容",
  extension: "URL 扩展名",
  host: "已知站点",
  scheme: "链接协议",
  query: "查询参数",
  page: "网页默认",
  fallback: "无法确定",
};

/** The short label a piece of evidence carries. */
const EVIDENCE_WORDS: Record<string, string> = {
  "data-url": "内联内容",
  extension: "扩展名",
  host: "站点",
  scheme: "协议",
  query: "查询参数",
  path: "路径",
  fallback: "兜底",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function parseEvidence(value: unknown): Evidence | null {
  if (!isRecord(value) || typeof value.kind !== "string" ||
    typeof value.detail !== "string" || value.kind === "" || value.detail === "") {
    return null;
  }
  return {
    kind: value.kind,
    value: optionalString(value.value),
    detail: value.detail,
  };
}

/**
 * parseDetectorResult reads one detector output. Anything that is not a
 * complete schema-1 document returns null: a page that painted half of a
 * changed document would be worse than one that says it cannot read it.
 */
export function parseDetectorResult(output: string): DetectorResult | null {
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    return null;
  }
  if (!isRecord(value) || value.schema !== 1) return null;
  if (typeof value.url !== "string" || typeof value.label !== "string" ||
    typeof value.category !== "string" || typeof value.source !== "string") {
    return null;
  }
  const confidence = value.confidence;
  if (confidence !== "high" && confidence !== "medium" && confidence !== "low") {
    return null;
  }
  if (!Array.isArray(value.evidence)) return null;
  const evidence = value.evidence
    .map(parseEvidence)
    .filter((entry): entry is Evidence => entry !== null);
  if (evidence.length !== value.evidence.length || evidence.length === 0) {
    return null;
  }
  return {
    schema: 1,
    url: value.url,
    scheme: optionalString(value.scheme),
    host: optionalString(value.host),
    path: optionalString(value.path),
    mime: optionalString(value.mime),
    label: value.label,
    category: value.category,
    categoryLabel: optionalString(value.categoryLabel),
    confidence,
    source: value.source,
    evidence,
    note: optionalString(value.note),
  };
}

export function confidenceWord(confidence: Confidence): string {
  return CONFIDENCE_WORDS[confidence];
}

export function sourceWord(source: string): string {
  return SOURCE_WORDS[source] ?? source;
}

export function evidenceWord(kind: string): string {
  return EVIDENCE_WORDS[kind] ?? kind;
}
