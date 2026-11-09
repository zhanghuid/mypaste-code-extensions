/**
 * Timestamp parsing and formatting.
 *
 * Pure functions only: no DOM, no network, no clock of its own. Every value is
 * derived from the input and, for the relative row, from the `now` the caller
 * passes in, so the page and its tests agree on the same answer.
 *
 * Local-time inputs (`YYYY-MM-DD`, `YYYY/MM/DD`, Chinese dates and a datetime
 * without a zone) are read in the host's local zone; an explicit `Z` or offset
 * is honoured exactly. Nothing accepts a value that silently rolls over: a
 * component outside its range makes the input unrecognised instead of turning
 * 2030-02-30 into March 2nd.
 */

export const MIN_YEAR = 1970;
export const MAX_YEAR = 2100;

/** End of 2100, the last instant the range accepts. */
const MAX_MS = Date.UTC(MAX_YEAR, 11, 31, 23, 59, 59, 999);

export type ParseFailure =
  | "empty"
  | "unrecognized"
  | "invalid-date"
  | "out-of-range";

export interface ParsedTimestamp {
  ok: true;
  ms: number;
  /** `whole` when the entire trimmed input was one time; `embedded` otherwise. */
  source: "whole" | "embedded";
  /** The exact substring that produced the value. */
  matched: string;
}

export interface ParseError {
  ok: false;
  reason: ParseFailure;
}

export type ParseResult = ParsedTimestamp | ParseError;

export interface TimestampRow {
  id: string;
  label: string;
  value: string;
}

interface Parts {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  s: number;
  ms: number;
}

type WholeResult =
  | { ms: number }
  | { reason: "invalid-date" | "out-of-range" }
  | null;

const ISO_DATE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|z|[+-]\d{2}:?\d{2}|[+-]\d{2})?)?$/;
const SLASHED_DATE =
  /^(\d{4})\/(\d{1,2})\/(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;
const COMPACT_DATE = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/;
const CHINESE_DATE =
  /^(\d{4})年(\d{1,2})月(\d{1,2})日(?:[ T]?(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;
const RFC_2822 =
  /^(?:[A-Za-z]{3},\s*)?(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?\s+([+-]\d{4}|[A-Za-z]{1,5})$/;

/** The scan is bounded: a long entry cannot make the page walk it repeatedly. */
const SCAN_LIMIT = 4096;
const EMBEDDED_ISO =
  /(\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}(?::\d{2})?(?:\.\d{1,3})?(?:[Zz]|[+-]\d{2}:?\d{2})?)/;
const EMBEDDED_UNIX = /(?:^|[^\d])(\d{13}|\d{10})(?!\d)/;

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];
const WEEKDAYS_EN = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WEEKDAYS_ZH = [
  "星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六",
];

/** Zone abbreviations RFC 2822 allows; minutes east of UTC. */
const ZONE_NAMES: Record<string, number> = {
  UT: 0,
  UTC: 0,
  GMT: 0,
  EST: -300,
  EDT: -240,
  CST: -360,
  CDT: -300,
  MST: -420,
  MDT: -360,
  PST: -480,
  PDT: -420,
};

function group(match: RegExpMatchArray, index: number): string {
  return match[index] ?? "";
}

function integer(match: RegExpMatchArray, index: number): number {
  return Number(group(match, index));
}

function optionalInteger(match: RegExpMatchArray, index: number): number {
  const value = group(match, index);
  return value === "" ? 0 : Number(value);
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Rejects a component outside its range, including 2030-02-30. */
function validParts(parts: Parts): boolean {
  return (
    parts.mo >= 1 && parts.mo <= 12 &&
    parts.d >= 1 && parts.d <= daysInMonth(parts.y, parts.mo) &&
    parts.h >= 0 && parts.h <= 23 &&
    parts.mi >= 0 && parts.mi <= 59 &&
    parts.s >= 0 && parts.s <= 59 &&
    parts.ms >= 0 && parts.ms <= 999
  );
}

function inYearRange(year: number): boolean {
  return year >= MIN_YEAR && year <= MAX_YEAR;
}

function inRange(ms: number): boolean {
  return Number.isFinite(ms) && ms >= 0 && ms <= MAX_MS;
}

function fromLocal(parts: Parts): WholeResult {
  if (!validParts(parts)) return { reason: "invalid-date" };
  if (!inYearRange(parts.y)) return { reason: "out-of-range" };
  return {
    ms: new Date(
      parts.y, parts.mo - 1, parts.d,
      parts.h, parts.mi, parts.s, parts.ms,
    ).getTime(),
  };
}

/** Constructs the instant at `parts` in a fixed offset (minutes east of UTC). */
function fromOffset(parts: Parts, offsetMinutes: number): WholeResult {
  if (!validParts(parts)) return { reason: "invalid-date" };
  if (!inYearRange(parts.y)) return { reason: "out-of-range" };
  const ms = Date.UTC(
    parts.y, parts.mo - 1, parts.d,
    parts.h, parts.mi, parts.s, parts.ms,
  ) - offsetMinutes * 60_000;
  return inRange(ms) ? { ms } : { reason: "out-of-range" };
}

/** Reads `Z`, `+08:00`, `+0800` or `+08`; null when the text is not an offset. */
function parseOffset(zone: string): number | null {
  if (zone === "" || zone === "Z" || zone === "z") return 0;
  const match = /^([+-])(\d{2}):?(\d{2})?$/.exec(zone);
  if (!match) return null;
  const hours = Number(match[2]);
  const minutes = match[3] === undefined ? 0 : Number(match[3]);
  if (hours > 23 || minutes > 59) return null;
  const sign = match[1] === "-" ? -1 : 1;
  return sign * (hours * 60 + minutes);
}

function parseUnix(text: string): WholeResult {
  if (!/^\d{10}$|^\d{13}$|^\d{16}$/.test(text)) return null;
  const value = Number(text);
  let ms: number;
  if (text.length === 10) ms = value * 1000;
  else if (text.length === 13) ms = value;
  else ms = Math.floor(value / 1000);
  return inRange(ms) ? { ms } : { reason: "out-of-range" };
}

function parseIso(match: RegExpMatchArray): WholeResult {
  const parts: Parts = {
    y: integer(match, 1),
    mo: integer(match, 2),
    d: integer(match, 3),
    h: optionalInteger(match, 4),
    mi: optionalInteger(match, 5),
    s: optionalInteger(match, 6),
    ms: group(match, 7) === "" ? 0 : Number(group(match, 7).padEnd(3, "0")),
  };
  const zone = group(match, 8);
  if (zone === "") return fromLocal(parts);
  const offset = parseOffset(zone);
  if (offset === null) return { reason: "invalid-date" };
  return fromOffset(parts, offset);
}

function parseSlashed(match: RegExpMatchArray): WholeResult {
  return fromLocal({
    y: integer(match, 1),
    mo: integer(match, 2),
    d: integer(match, 3),
    h: optionalInteger(match, 4),
    mi: optionalInteger(match, 5),
    s: optionalInteger(match, 6),
    ms: 0,
  });
}

function parseCompact(match: RegExpMatchArray): WholeResult {
  return fromLocal({
    y: integer(match, 1),
    mo: integer(match, 2),
    d: integer(match, 3),
    h: integer(match, 4),
    mi: integer(match, 5),
    s: integer(match, 6),
    ms: 0,
  });
}

function parseChinese(match: RegExpMatchArray): WholeResult {
  return fromLocal({
    y: integer(match, 1),
    mo: integer(match, 2),
    d: integer(match, 3),
    h: optionalInteger(match, 4),
    mi: optionalInteger(match, 5),
    s: optionalInteger(match, 6),
    ms: 0,
  });
}

function parseRfc2822(match: RegExpMatchArray): WholeResult {
  const monthLabel = group(match, 2);
  const normalized =
    monthLabel.charAt(0).toUpperCase() + monthLabel.slice(1).toLowerCase();
  const monthIndex = MONTHS.indexOf(normalized);
  if (monthIndex < 0) return { reason: "invalid-date" };
  const zone = group(match, 7);
  const offset = /^[+-]\d{4}$/.test(zone)
    ? parseOffset(`${zone.slice(0, 3)}:${zone.slice(3)}`)
    : ZONE_NAMES[zone.toUpperCase()];
  if (offset === undefined || offset === null) return { reason: "invalid-date" };
  return fromOffset({
    y: integer(match, 3),
    mo: monthIndex + 1,
    d: integer(match, 1),
    h: integer(match, 4),
    mi: integer(match, 5),
    s: optionalInteger(match, 6),
    ms: 0,
  }, offset);
}

function parseWhole(text: string): WholeResult {
  const unix = parseUnix(text);
  if (unix !== null) return unix;

  const iso = ISO_DATE.exec(text);
  if (iso) return parseIso(iso);

  const slashed = SLASHED_DATE.exec(text);
  if (slashed) return parseSlashed(slashed);

  const compact = COMPACT_DATE.exec(text);
  if (compact) return parseCompact(compact);

  const chinese = CHINESE_DATE.exec(text);
  if (chinese) return parseChinese(chinese);

  const rfc = RFC_2822.exec(text);
  if (rfc) return parseRfc2822(rfc);

  return null;
}

/** One bounded pass over the text, looking for an embedded time. */
function scanEmbedded(text: string): { ms: number; matched: string } | null {
  const bounded = text.slice(0, SCAN_LIMIT);
  for (const pattern of [EMBEDDED_ISO, EMBEDDED_UNIX]) {
    const match = pattern.exec(bounded);
    if (!match) continue;
    const matched = group(match, 1);
    const whole = parseWhole(matched);
    if (whole !== null && "ms" in whole) return { ms: whole.ms, matched };
  }
  return null;
}

export function parseTimestamp(input: string): ParseResult {
  const text = input.trim();
  if (text === "") return { ok: false, reason: "empty" };

  const whole = parseWhole(text);
  if (whole !== null && "ms" in whole) {
    return { ok: true, ms: whole.ms, source: "whole", matched: text };
  }

  const embedded = scanEmbedded(text);
  if (embedded !== null) {
    return {
      ok: true,
      ms: embedded.ms,
      source: "embedded",
      matched: embedded.matched,
    };
  }

  if (whole !== null) return { ok: false, reason: whole.reason };
  return { ok: false, reason: "unrecognized" };
}

function localDateParts(ms: number): Parts {
  const date = new Date(ms);
  return {
    y: date.getFullYear(),
    mo: date.getMonth() + 1,
    d: date.getDate(),
    h: date.getHours(),
    mi: date.getMinutes(),
    s: date.getSeconds(),
    ms: date.getMilliseconds(),
  };
}

function localStamp(parts: Parts): string {
  return (
    `${parts.y}-${pad(parts.mo, 2)}-${pad(parts.d, 2)} ` +
    `${pad(parts.h, 2)}:${pad(parts.mi, 2)}:${pad(parts.s, 2)}`
  );
}

function utcStamp(ms: number): string {
  const date = new Date(ms);
  return (
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1, 2)}-` +
    `${pad(date.getUTCDate(), 2)} ${pad(date.getUTCHours(), 2)}:` +
    `${pad(date.getUTCMinutes(), 2)}:${pad(date.getUTCSeconds(), 2)}`
  );
}

function localOffset(ms: number): string {
  const minutes = -new Date(ms).getTimezoneOffset();
  const sign = minutes < 0 ? "-" : "+";
  const absolute = Math.abs(minutes);
  return `${sign}${pad(Math.floor(absolute / 60), 2)}:${pad(absolute % 60, 2)}`;
}

function compactOffset(ms: number): string {
  return localOffset(ms).replace(":", "");
}

function rfc2822Local(ms: number): string {
  const date = new Date(ms);
  return (
    `${WEEKDAYS_EN[date.getDay()] ?? "Sun"}, ` +
    `${pad(date.getDate(), 2)} ${MONTHS[date.getMonth()] ?? "Jan"} ` +
    `${date.getFullYear()} ${pad(date.getHours(), 2)}:` +
    `${pad(date.getMinutes(), 2)}:${pad(date.getSeconds(), 2)} ` +
    compactOffset(ms)
  );
}

/** The ISO week of the local calendar date, e.g. `2030-W01-2`. */
export function isoWeek(ms: number): string {
  const parts = localDateParts(ms);
  const target = new Date(Date.UTC(parts.y, parts.mo - 1, parts.d));
  const weekday = target.getUTCDay() || 7;
  target.setUTCDate(target.getUTCDate() + 4 - weekday);
  const isoYear = target.getUTCFullYear();
  const yearStart = Date.UTC(isoYear, 0, 1);
  const week = Math.ceil(
    ((target.getTime() - yearStart) / 86_400_000 + 1) / 7,
  );
  return `${isoYear}-W${pad(week, 2)}-${weekday}`;
}

/** A short Chinese distance from `now`, e.g. `3 小时前` or `2 天后`. */
export function relativeTime(ms: number, now: number): string {
  const difference = now - ms;
  const absolute = Math.abs(difference);
  if (absolute < 10_000) return "刚刚";
  const units: Array<[number, string]> = [
    [365 * 86_400_000, "年"],
    [30 * 86_400_000, "个月"],
    [86_400_000, "天"],
    [3_600_000, "小时"],
    [60_000, "分钟"],
    [1_000, "秒"],
  ];
  for (const [size, label] of units) {
    if (absolute >= size) {
      const amount = Math.floor(absolute / size);
      return `${amount} ${label}${difference < 0 ? "后" : "前"}`;
    }
  }
  return "刚刚";
}

const ZONE_FORMAT = new Map<string, Intl.DateTimeFormat>();

function zoneFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = ZONE_FORMAT.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
      timeZoneName: "shortOffset",
    });
    ZONE_FORMAT.set(timeZone, formatter);
  }
  return formatter;
}

/** `2030-01-01 08:00:00 (UTC+8)` in a named zone. */
export function formatInZone(ms: number, timeZone: string): string {
  const parts = zoneFormatter(timeZone).formatToParts(new Date(ms));
  const value = (type: string): string =>
    parts.find((part) => part.type === type)?.value ?? "";
  const zone = value("timeZoneName").replace(/^GMT/, "UTC").replace(/^UTC\+0$/, "UTC");
  return (
    `${value("year")}-${value("month")}-${value("day")} ` +
    `${value("hour")}:${value("minute")}:${value("second")} ` +
    `(${zone === "" ? "UTC" : zone})`
  );
}

export const DISPLAY_ZONES = [
  "UTC",
  "Asia/Shanghai",
  "America/New_York",
  "Europe/London",
  "Asia/Tokyo",
] as const;

/** Every row the page shows, in display order. */
export function buildRows(ms: number, now: number): TimestampRow[] {
  const parts = localDateParts(ms);
  const date = `${parts.y}-${pad(parts.mo, 2)}-${pad(parts.d, 2)}`;
  const time =
    `${pad(parts.h, 2)}:${pad(parts.mi, 2)}:${pad(parts.s, 2)}`;
  const utc = utcStamp(ms);

  const rows: TimestampRow[] = [
    { id: "local", label: "本地时间", value: localStamp(parts) },
    { id: "utc", label: "UTC", value: `${utc} UTC` },
    { id: "iso", label: "ISO 8601", value: `${date}T${time}${localOffset(ms)}` },
    { id: "rfc", label: "RFC 2822", value: rfc2822Local(ms) },
    { id: "unix", label: "Unix 秒", value: String(Math.floor(ms / 1000)) },
    { id: "unix-ms", label: "Unix 毫秒", value: String(ms) },
    { id: "date", label: "日期", value: date },
    { id: "time", label: "时间", value: time },
    {
      id: "weekday",
      label: "星期",
      value: WEEKDAYS_ZH[new Date(ms).getDay()] ?? "",
    },
    { id: "iso-week", label: "ISO 周", value: isoWeek(ms) },
    { id: "relative", label: "相对现在", value: relativeTime(ms, now) },
  ];

  for (const zone of DISPLAY_ZONES) {
    rows.push({
      id: `zone-${zone}`,
      label: zone,
      value: formatInZone(ms, zone),
    });
  }

  return rows;
}
