/**
 * The text comparison engine behind the 高亮对比 workbench document.
 *
 * Both sides arrive through the workbench bridge: the item the command was
 * invoked on and the one comparison item its manifest declared (D-1040).
 * Nothing here touches the host. The approach follows
 * OmniDiff (https://github.com/ivankovic/omnidiff): align whole lines first,
 * then compare the words inside a changed pair so only the parts that really
 * changed are painted. MyPaste's implementation is its own; no OmniDiff code
 * is used or shipped.
 *
 * The inputs are bounded. A clipboard entry can be arbitrarily large, and an
 * exact alignment table grows with both sides, so past the budgets below the
 * middle is paired by position instead of failing or freezing the document.
 * The result says so through `coarse`, and this document keeps that visible.
 */

/** One run of text inside a diff row. Adjacent runs never share `changed`. */
export interface DiffSegment {
  text: string;
  changed: boolean;
}

export type DiffRowKind = "equal" | "change" | "delete" | "insert";

/**
 * One aligned row. A delete row has no after side, an insert row no before
 * side; a change row has both, with the changed words marked on each side.
 */
export interface DiffRow {
  kind: DiffRowKind;
  beforeLine: number | null;
  afterLine: number | null;
  before: DiffSegment[];
  after: DiffSegment[];
}

export interface DiffStats {
  /** Lines present only on the after side, change rows included. */
  added: number;
  /** Lines present only on the before side, change rows included. */
  removed: number;
  /** Paired lines that differ. */
  changed: number;
}

export interface DiffResult {
  rows: DiffRow[];
  stats: DiffStats;
  /** A side was cut to the comparison limits. */
  truncated: boolean;
  /** The alignment budget was exceeded and the middle was paired by position. */
  coarse: boolean;
}

/** Per-side caps: 4,000 lines and 200,000 characters of the original text. */
export const DIFF_MAX_LINES = 4_000;
export const DIFF_MAX_CHARS = 200_000;

// Alignment tables are (n+1)*(m+1) int32 cells. The line budget keeps one
// comparison under ~6 MB; a single line may still be long, so words get their
// own, much smaller budget before a pair degrades to whole-line emphasis.
const LINE_CELL_BUDGET = 1_500_000;
const TOKEN_CELL_BUDGET = 12_000;

const CJK =
  /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff]/u;
const WORD = /[\p{L}\p{N}_]/u;

/**
 * splitLines normalizes line endings and applies the per-side caps. A file
 * without a trailing newline keeps its last line; a trailing newline does not
 * invent an empty one.
 */
export function splitLines(value: string): { lines: string[]; truncated: boolean } {
  const normalized = value.replace(/\r\n?/g, "\n");
  let truncated = false;
  let lines = normalized.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  if (lines.length > DIFF_MAX_LINES) {
    lines = lines.slice(0, DIFF_MAX_LINES);
    truncated = true;
  }
  if (normalized.length > DIFF_MAX_CHARS) {
    // Cutting at the character cap keeps the visible text under the same
    // promise as the line cap: a bounded amount is shown, and the page says
    // the rest was left out.
    let consumed = 0;
    const capped: string[] = [];
    for (const line of lines) {
      if (consumed + line.length > DIFF_MAX_CHARS) {
        capped.push(line.slice(0, Math.max(0, DIFF_MAX_CHARS - consumed)));
        truncated = true;
        break;
      }
      capped.push(line);
      consumed += line.length + 1;
    }
    lines = capped;
  }
  return { lines, truncated };
}

type LinePair = { before: number | null; after: number | null };

/**
 * alignLines pairs line indexes through a longest-common-subsequence table.
 * Common prefix and suffix are peeled first so an edit in a long unchanged
 * file stays inside the budget. When the middle is still too large the two
 * sides are paired by position: every paired row is a change, leftovers are
 * pure deletes or inserts.
 */
export function alignLines(a: readonly string[], b: readonly string[]): {
  pairs: LinePair[];
  coarse: boolean;
} {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const pairs: LinePair[] = [];
  for (let index = 0; index < start; index++) {
    pairs.push({ before: index, after: index });
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  let coarse = false;
  if (midA.length === 0 || midB.length === 0) {
    for (let offset = 0; offset < midA.length; offset++) {
      pairs.push({ before: start + offset, after: null });
    }
    for (let offset = 0; offset < midB.length; offset++) {
      pairs.push({ before: null, after: start + offset });
    }
  } else if (midA.length * midB.length > LINE_CELL_BUDGET) {
    coarse = true;
    const common = Math.min(midA.length, midB.length);
    for (let offset = 0; offset < common; offset++) {
      pairs.push({ before: start + offset, after: start + offset });
    }
    for (let offset = common; offset < midA.length; offset++) {
      pairs.push({ before: start + offset, after: null });
    }
    for (let offset = common; offset < midB.length; offset++) {
      pairs.push({ before: null, after: start + offset });
    }
  } else {
    const ops = lcsOps(midA, midB);
    let beforeAt = start;
    let afterAt = start;
    for (const op of ops) {
      if (op === "equal") {
        pairs.push({ before: beforeAt++, after: afterAt++ });
      } else if (op === "delete") {
        pairs.push({ before: beforeAt++, after: null });
      } else {
        pairs.push({ before: null, after: afterAt++ });
      }
    }
  }
  for (let index = endA; index < a.length; index++) {
    pairs.push({ before: index, after: endB + (index - endA) });
  }
  return { pairs, coarse };
}

type EditOp = "equal" | "delete" | "insert";

/** lcsOps returns one edit operation per aligned sequence position. */
function lcsOps(a: readonly string[], b: readonly string[]): EditOp[] {
  const width = b.length + 1;
  const table = new Int32Array((a.length + 1) * width);
  const cell = (row: number, column: number): number =>
    table[row * width + column] ?? 0;
  for (let i = a.length - 1; i >= 0; i--) {
    const tokenA = a[i];
    if (tokenA === undefined) continue;
    for (let j = b.length - 1; j >= 0; j--) {
      const tokenB = b[j];
      if (tokenB === undefined) continue;
      table[i * width + j] = tokenA === tokenB
        ? cell(i + 1, j + 1) + 1
        : Math.max(cell(i + 1, j), cell(i, j + 1));
    }
  }
  const ops: EditOp[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const tokenA = a[i];
    const tokenB = b[j];
    if (tokenA === undefined || tokenB === undefined) break;
    if (tokenA === tokenB) {
      ops.push("equal");
      i++;
      j++;
    } else if (cell(i + 1, j) >= cell(i, j + 1)) {
      ops.push("delete");
      i++;
    } else {
      ops.push("insert");
      j++;
    }
  }
  while (i < a.length) {
    ops.push("delete");
    i++;
  }
  while (j < b.length) {
    ops.push("insert");
    j++;
  }
  return ops;
}

/**
 * tokenizeForDiff splits a line into comparison tokens. Latin words stay
 * whole; every CJK character is its own token so a single changed character
 * inside a run of Han text is highlighted instead of the whole phrase;
 * whitespace and punctuation are single tokens so spacing changes stay
 * visible.
 */
export function tokenizeForDiff(value: string): string[] {
  const tokens: string[] = [];
  let word = "";
  const flush = () => {
    if (word !== "") {
      tokens.push(word);
      word = "";
    }
  };
  for (const char of value) {
    if (CJK.test(char) || !WORD.test(char)) {
      flush();
      tokens.push(char);
    } else {
      word += char;
    }
  }
  flush();
  return tokens;
}

function pushSegment(segments: DiffSegment[], text: string, changed: boolean): void {
  if (text === "") return;
  const last = segments[segments.length - 1];
  if (last && last.changed === changed) {
    last.text += text;
    return;
  }
  segments.push({ text, changed });
}

function whole(text: string, changed: boolean): DiffSegment[] {
  return text === "" ? [] : [{ text, changed }];
}

/**
 * diffLinePair compares two lines token by token. It returns both sides with
 * only the changed tokens marked; a pair too large to align is marked whole.
 */
export function diffLinePair(before: string, after: string): {
  before: DiffSegment[];
  after: DiffSegment[];
} {
  const beforeTokens = tokenizeForDiff(before);
  const afterTokens = tokenizeForDiff(after);
  if (beforeTokens.length * afterTokens.length > TOKEN_CELL_BUDGET) {
    return { before: whole(before, true), after: whole(after, true) };
  }
  const ops = lcsOps(beforeTokens, afterTokens);
  const beforeSegments: DiffSegment[] = [];
  const afterSegments: DiffSegment[] = [];
  let beforeAt = 0;
  let afterAt = 0;
  for (const op of ops) {
    if (op === "equal") {
      const beforeToken = beforeTokens[beforeAt++];
      const afterToken = afterTokens[afterAt++];
      if (beforeToken === undefined || afterToken === undefined) break;
      pushSegment(beforeSegments, beforeToken, false);
      pushSegment(afterSegments, afterToken, false);
    } else if (op === "delete") {
      const beforeToken = beforeTokens[beforeAt++];
      if (beforeToken === undefined) break;
      pushSegment(beforeSegments, beforeToken, true);
    } else {
      const afterToken = afterTokens[afterAt++];
      if (afterToken === undefined) break;
      pushSegment(afterSegments, afterToken, true);
    }
  }
  return { before: beforeSegments, after: afterSegments };
}

/**
 * diffText turns two texts into aligned, highlighted rows plus the counts the
 * workbench reports. Lines that exist only on one side are marked whole; a
 * deletion and an insertion that sit next to each other become one change row
 * with word-level detail.
 */
export function diffText(beforeText: string, afterText: string): DiffResult {
  const beforeSide = splitLines(beforeText);
  const afterSide = splitLines(afterText);
  const { pairs, coarse } = alignLines(beforeSide.lines, afterSide.lines);
  const rows: DiffRow[] = [];
  const stats: DiffStats = { added: 0, removed: 0, changed: 0 };

  let at = 0;
  while (at < pairs.length) {
    const pair = pairs[at];
    if (!pair) break;
    if (pair.before !== null && pair.after !== null) {
      const before = beforeSide.lines[pair.before];
      const after = afterSide.lines[pair.after];
      if (before === undefined || after === undefined) break;
      if (before === after) {
        rows.push({
          kind: "equal",
          beforeLine: pair.before + 1,
          afterLine: pair.after + 1,
          before: whole(before, false),
          after: whole(after, false),
        });
      } else {
        const segments = diffLinePair(before, after);
        rows.push({
          kind: "change",
          beforeLine: pair.before + 1,
          afterLine: pair.after + 1,
          before: segments.before,
          after: segments.after,
        });
        stats.changed++;
        stats.removed++;
        stats.added++;
      }
      at++;
      continue;
    }
    // Collect a run of one-sided lines, then pair deletes with inserts in
    // order so the row order stays readable instead of stacking all deletes
    // before all inserts.
    let end = at;
    while (
      end < pairs.length &&
      (pairs[end]?.before === null || pairs[end]?.after === null)
    ) end++;
    const deletes: number[] = [];
    const inserts: number[] = [];
    for (let index = at; index < end; index++) {
      const runPair = pairs[index];
      if (runPair?.before !== null && runPair?.before !== undefined) {
        deletes.push(runPair.before);
      } else if (runPair?.after !== null && runPair?.after !== undefined) {
        inserts.push(runPair.after);
      }
    }
    const common = Math.min(deletes.length, inserts.length);
    for (let index = 0; index < common; index++) {
      const beforeLine = deletes[index];
      const afterLine = inserts[index];
      if (beforeLine === undefined || afterLine === undefined) break;
      const before = beforeSide.lines[beforeLine];
      const after = afterSide.lines[afterLine];
      if (before === undefined || after === undefined) break;
      const segments = diffLinePair(before, after);
      rows.push({
        kind: "change",
        beforeLine: beforeLine + 1,
        afterLine: afterLine + 1,
        before: segments.before,
        after: segments.after,
      });
      stats.changed++;
      stats.removed++;
      stats.added++;
    }
    for (let index = common; index < deletes.length; index++) {
      const beforeLine = deletes[index];
      if (beforeLine === undefined) continue;
      const before = beforeSide.lines[beforeLine];
      if (before === undefined) continue;
      rows.push({
        kind: "delete",
        beforeLine: beforeLine + 1,
        afterLine: null,
        before: whole(before, true),
        after: [],
      });
      stats.removed++;
    }
    for (let index = common; index < inserts.length; index++) {
      const afterLine = inserts[index];
      if (afterLine === undefined) continue;
      const after = afterSide.lines[afterLine];
      if (after === undefined) continue;
      rows.push({
        kind: "insert",
        beforeLine: null,
        afterLine: afterLine + 1,
        before: [],
        after: whole(after, true),
      });
      stats.added++;
    }
    at = end;
  }

  return {
    rows,
    stats,
    truncated: beforeSide.truncated || afterSide.truncated,
    coarse,
  };
}

/** diffSummary is the sentence the workbench header carries. */
export function diffSummary(result: DiffResult): string {
  if (result.stats.added === 0 && result.stats.removed === 0) {
    return "两段文本相同";
  }
  return `+${result.stats.added} 行 −${result.stats.removed} 行 · ${result.stats.changed} 行改动`;
}
