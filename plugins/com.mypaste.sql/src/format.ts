/**
 * The page's beautifier.
 *
 * The input is a token stream that already scanned cleanly. Layout is policy,
 * not preservation: whitespace between tokens is re-derived, while strings,
 * comments, numbers and quoted identifiers are copied unchanged and keywords
 * take the toolbar's case. A clause sits on one line while it fits within
 * MAX_LINE_WIDTH columns; past that its commas and its AND/OR/ON break onto
 * one line each. A parenthesis list breaks open the same way once it does not
 * fit the line it is on, and a wide or multi-branch CASE breaks into WHEN and
 * ELSE rows. Layout changes only whitespace and keyword case, so beautifying
 * is idempotent.
 */

import type { Analysis } from "./analyze";
import type { SqlToken } from "./tokenize";

export interface FormatOptions {
  /** "preserve", "upper" or "lower". */
  readonly keywordCase: string;
  /** Spaces per nesting level: 2, 4 or 8. */
  readonly indentWidth: number;
}

export function parseFormatOptions(
  keywordCase: string,
  indent: string,
): FormatOptions {
  const width = indent === "2" ? 2 : indent === "8" ? 8 : 4;
  const name = keywordCase === "upper" || keywordCase === "lower" ? keywordCase : "preserve";
  return { keywordCase: name, indentWidth: width };
}

/** A clause stays on one line up to this many columns; wider ones break. */
const MAX_LINE_WIDTH = 100;

/** Keywords that start a clause of their own at their bracket depth. */
const CLAUSE_HEADS = new Set([
  "SELECT", "FROM", "WHERE", "GROUP", "HAVING", "ORDER", "LIMIT",
  "UNION", "INTERSECT", "EXCEPT", "MINUS", "VALUES", "SET", "INSERT",
  "UPDATE", "DELETE", "WITH",
]);

/** Words that open a join phrase when a JOIN follows them. */
const JOIN_LEADING = new Set(["LEFT", "RIGHT", "FULL", "INNER", "CROSS", "NATURAL"]);
const JOIN_MODIFIERS = new Set(["OUTER", "SEMI", "ANTI"]);

/**
 * Vocabulary words the dialects call keywords that are really function calls:
 * `COUNT(x)` sits tight while `IN (1, 2)` keeps its space.
 */
const CALL_LIKE_KEYWORDS = new Set([
  "COUNT", "SUM", "AVG", "MIN", "MAX", "CAST", "COALESCE", "IFNULL", "NULLIF",
  "IF", "EVERY", "SOME", "ANY", "ARRAY_AGG", "STRING_AGG", "GROUP_CONCAT",
  "SUBSTR", "SUBSTRING", "TRIM", "UPPER", "LOWER", "LENGTH", "CHAR_LENGTH",
  "CHARACTER_LENGTH", "OCTET_LENGTH", "POSITION", "REPLACE", "CONCAT",
  "CONCAT_WS", "EXTRACT", "LEFT", "RIGHT",
]);

/** Operators that sit tight against both neighbours. */
const TIGHT_OPERATORS = new Set(["::", "->", "->>", "#>", "#>>"]);

/** Symbol tokens that keep one space on each side. */
const SPACED_SYMBOLS = new Set([
  "=", "<", ">", "<=", ">=", "<>", "!=", "+", "-", "*", "/", "%",
  "||", "&&", "!", "&", "|", "^", ":=", "=>", "<<", ">>", "..",
  "@>", "<@", "?|", "?&", "!~", "~*", "!~*", "%%",
]);

interface RawPiece {
  readonly text: string;
  readonly kind: SqlToken["kind"];
}

function rawPiecesOf(tokens: readonly SqlToken[]): RawPiece[] {
  const pieces: RawPiece[] = [];
  for (const token of tokens) {
    switch (token.kind) {
      case "keyword":
      case "string":
      case "comment":
      case "number":
      // A quoted name keeps its own spelling: the spaces inside `"my field"`
      // are part of the name, not layout.
      case "property":
        pieces.push({ text: token.text, kind: token.kind });
        break;
      default: {
        const text = token.text.replace(/\s+/gu, " ").trim();
        if (text === "") break;
        pieces.push({ text, kind: token.kind });
      }
    }
  }
  return pieces;
}

function renderText(piece: RawPiece, options: FormatOptions): string {
  if (piece.kind === "keyword") {
    if (options.keywordCase === "upper") return piece.text.toUpperCase();
    if (options.keywordCase === "lower") return piece.text.toLowerCase();
  }
  return piece.text;
}

/**
 * A `+` or `-` is a sign, not a subtraction, when no expression sits before
 * it: after an opening bracket, a comma, an operator or a clause word.
 */
function isUnarySign(pieces: readonly RawPiece[], index: number): boolean {
  const piece = pieces[index]!;
  if (piece.text !== "+" && piece.text !== "-") return false;
  for (let before = index - 1; before >= 0; before -= 1) {
    const previous = pieces[before]!;
    if (previous.kind === "comment") continue;
    if (previous.kind === "keyword") return true;
    const text = previous.text;
    return (
      text === "(" || text === "[" || text === "{" || text === "," ||
      text === ";" || text === "." || SPACED_SYMBOLS.has(text) ||
      TIGHT_OPERATORS.has(text)
    );
  }
  return true;
}

/** The one space — or none — this piece keeps before it. */
function glueBetween(
  previous: RawPiece,
  previousUnary: boolean,
  piece: RawPiece,
): string {
  const p = previous.text;
  const c = piece.text;
  if (c === ")" || c === "]" || c === "}" || c === "," || c === ";" || c === ".") return "";
  if (TIGHT_OPERATORS.has(c)) return "";
  if (TIGHT_OPERATORS.has(p) || p === "." || p === "[") return "";
  if (previousUnary) return "";
  if (c === "(") {
    if (p === "," || p === ")" || p === "]") return " ";
    if (previous.kind === "keyword" && CALL_LIKE_KEYWORDS.has(p.toUpperCase())) return "";
    return previous.kind === "function" ? "" : " ";
  }
  if (c === "[" || c === "{") return "";
  if (c === "*") return p === "(" || p === "." ? "" : " ";
  if (SPACED_SYMBOLS.has(c)) return " ";
  if (p === "(" || p === "[" || p === "{") return "";
  return " ";
}

/** Whether a JOIN (possibly past OUTER/SEMI/ANTI) follows this word. */
function leadsToJoin(pieces: readonly RawPiece[], from: number): boolean {
  let seen = 0;
  for (let index = from + 1; index < pieces.length && seen < 3; index += 1) {
    const piece = pieces[index]!;
    if (piece.kind === "comment") continue;
    const word = piece.text.toUpperCase();
    if (word === "JOIN") return true;
    if (!JOIN_MODIFIERS.has(word)) return false;
    seen += 1;
  }
  return false;
}

/**
 * A run of tokens that is laid out together until it does not fit. Clause and
 * statement groups decide up front from their one-line width; a paren group
 * decides as it is emitted, against the width of the line it lands on.
 */
interface Group {
  readonly kind: "statement" | "clause" | "paren" | "case";
  /** Bracket depth the group lives at. */
  readonly depth: number;
  /** Level the group's broken items indent to. */
  readonly innerLevel: number;
  /** Level a paren group's closing bracket sits at. */
  readonly closeLevel: number;
  /** Index of the piece that opens the group; clause groups measure from it. */
  readonly start: number;
  /** One-line width of the group's tokens, comments excluded. */
  readonly flatWidth: number;
  broken: boolean;
}

interface Piece {
  readonly text: string;
  readonly kind: SqlToken["kind"];
  readonly glue: string;
  /** Start a new line at this level before the piece. */
  readonly hardLevel: number | null;
  /** The hard break applies only once the enclosing paren group broke. */
  readonly softParen: boolean;
  /** Break before this piece when its own group broke. */
  readonly soft: boolean;
  readonly group: Group;
  readonly parenGroup: Group | null;
  /** A `--`/`#` comment: the line ends after it. */
  readonly lineComment: boolean;
  /** A block comment that holds a newline: it takes a line of its own. */
  readonly blockComment: boolean;
  readonly endsStatement: boolean;
  readonly opensParen: boolean;
  readonly closesParen: boolean;
}

function classify(raw: readonly RawPiece[], options: FormatOptions): Piece[] {
  const count = raw.length;

  // Rendered text, per-piece width (comments carry none) and prefix widths.
  const rendered: string[] = new Array(count);
  const glue: string[] = new Array(count);
  const unary: boolean[] = new Array(count);
  const prefix = new Array<number>(count + 1).fill(0);
  for (let index = 0; index < count; index += 1) {
    const piece = raw[index]!;
    rendered[index] = renderText(piece, options);
    unary[index] = isUnarySign(raw, index);
    glue[index] =
      index === 0 ? "" : glueBetween(raw[index - 1]!, unary[index - 1]!, piece);
  }
  // `INSERT INTO t (c1, c2)`: the tokenizer calls `t` a function because a `(`
  // follows it, but the word before is INTO — a table's column list, not a
  // call, so the list keeps its space.
  for (let index = 1; index < count; index += 1) {
    if (raw[index]!.text !== "(" || raw[index - 1]!.kind !== "function") continue;
    for (let before = index - 2; before >= 0; before -= 1) {
      const word = raw[before]!;
      if (word.kind === "comment") continue;
      if (word.kind === "keyword" && word.text.toUpperCase() === "INTO") {
        glue[index] = " ";
      }
      break;
    }
  }
  for (let index = 0; index < count; index += 1) {
    const spaces = glue[index] === "" ? 0 : 1;
    prefix[index + 1] = prefix[index]! +
      (raw[index]!.kind === "comment" ? 0 : rendered[index]!.length + spaces);
  }

  // Bracket matching and the depth each piece sits at.
  const matchOf = new Array<number>(count).fill(-1);
  const depthAt = new Array<number>(count);
  const bracketStack: number[] = [];
  let depth = 0;
  for (let index = 0; index < count; index += 1) {
    const piece = raw[index]!;
    depthAt[index] = depth;
    if (piece.text === "(") {
      bracketStack.push(index);
      depth += 1;
    } else if (piece.text === ")" && bracketStack.length > 0) {
      const open = bracketStack.pop()!;
      matchOf[open] = index;
      matchOf[index] = open;
      depth = Math.max(0, depth - 1);
      depthAt[index] = depth;
    }
  }

  // CASE … END matching, nesting tracked across parens.
  const caseMatch = new Array<number>(count).fill(-1);
  const caseStack: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const piece = raw[index]!;
    if (piece.kind !== "keyword") continue;
    const word = piece.text.toUpperCase();
    if (word === "CASE") caseStack.push(index);
    else if (word === "END" && caseStack.length > 0) {
      const open = caseStack.pop()!;
      caseMatch[open] = index;
      caseMatch[index] = open;
    }
  }

  /** A CASE breaks open when it is wide or has more than one WHEN row. */
  const caseBreaks = (open: number): boolean => {
    const end = caseMatch[open]!;
    let branches = 0;
    let nested = 0;
    for (let index = open + 1; index < end; index += 1) {
      const piece = raw[index]!;
      if (piece.kind !== "keyword") continue;
      const word = piece.text.toUpperCase();
      if (word === "CASE") nested += 1;
      else if (word === "END") nested -= 1;
      else if (word === "WHEN" && nested === 0) branches += 1;
    }
    return branches > 1 || prefix[end + 1]! - prefix[open]! > MAX_LINE_WIDTH;
  };

  const root: Group = {
    kind: "statement", depth: 0, innerLevel: 1, closeLevel: 0, start: 0,
    flatWidth: 0, broken: false,
  };
  const open: Group[] = [];
  const parenGroups: Group[] = [];
  let pendingSoft = false;
  let previousWord = "";

  const innermost = (): Group => (open.length > 0 ? open[open.length - 1]! : root);

  /** Closes the open clause groups at `minDepth` or deeper; they end at `end`. */
  const closeClauses = (minDepth: number, end: number): void => {
    for (let index = open.length - 1; index >= 0; index -= 1) {
      const group = open[index]!;
      if (group.kind !== "clause" && group.kind !== "statement") break;
      if (group.depth < minDepth) break;
      group.broken = prefix[end]! - prefix[group.start]! > MAX_LINE_WIDTH;
      open.pop();
    }
  };

  const pieces: Piece[] = [];
  for (let index = 0; index < count; index += 1) {
    const source = raw[index]!;
    const at = depthAt[index]!;
    const word = source.kind === "keyword" ? source.text.toUpperCase() : "";
    const isComment = source.kind === "comment";
    const lineComment =
      isComment && (source.text.startsWith("--") || source.text.startsWith("#"));
    const blockComment = isComment && !lineComment && source.text.includes("\n");

    let hardLevel: number | null = null;
    let softParen = false;
    let soft = false;
    let opensParen = false;
    let closesParen = false;
    let endsStatement = false;
    let parenGroup: Group | null = null;
    let group: Group;

    if (isComment) {
      // A comment rides on the current line; a pending break stays armed.
      group = innermost();
    } else if (source.text === "(") {
      group = innermost();
      opensParen = true;
      const match = matchOf[index]!;
      if (match > index) {
        parenGroup = {
          kind: "paren", depth: at, innerLevel: at + 1, closeLevel: at,
          start: index, flatWidth: prefix[match]! - prefix[index + 1]!,
          broken: false,
        };
        open.push(parenGroup);
        parenGroups.push(parenGroup);
      }
    } else if (source.text === ")") {
      closeClauses(at, index);
      group = innermost();
      const match = matchOf[index]!;
      if (match >= 0) {
        closesParen = true;
        parenGroup = parenGroups.pop() ?? null;
        open.pop();
      }
      pendingSoft = false;
    } else if (source.text === ";") {
      group = innermost();
      endsStatement = true;
      closeClauses(0, index);
      open.push({
        kind: "statement", depth: 0, innerLevel: 1, closeLevel: 0,
        start: index + 1, flatWidth: 0, broken: false,
      });
      pendingSoft = false;
    } else if (word === "CASE" && caseMatch[index]! >= 0) {
      group = innermost();
      open.push({
        kind: "case", depth: at, innerLevel: at + 1, closeLevel: at,
        start: index, flatWidth: prefix[caseMatch[index]! + 1]! - prefix[index]!,
        broken: caseBreaks(index),
      });
    } else if (word === "END" && caseMatch[index]! >= 0) {
      const caseGroup = innermost();
      group = caseGroup;
      if (caseGroup.kind === "case") {
        if (caseGroup.broken) {
          hardLevel = caseGroup.depth;
          softParen = at > 0;
        }
        open.pop();
      }
    } else {
      const joins = word !== "" &&
        (word === "JOIN"
          ? !(JOIN_LEADING.has(previousWord) || JOIN_MODIFIERS.has(previousWord))
          : JOIN_LEADING.has(word) && leadsToJoin(raw, index));
      const clauseHead = word !== "" && CLAUSE_HEADS.has(word) &&
        !(word === "FROM" && previousWord === "DELETE");
      if (joins || clauseHead) {
        closeClauses(at, index);
        const clause: Group = {
          kind: "clause", depth: at, innerLevel: at + 1, closeLevel: at,
          start: index, flatWidth: 0, broken: false,
        };
        open.push(clause);
        group = clause;
        hardLevel = at;
        softParen = at > 0;
      } else if (word === "WHEN" || word === "ELSE") {
        group = innermost();
        const caseGroup = innermost();
        if (caseGroup.kind === "case" && caseGroup.broken) {
          hardLevel = caseGroup.depth + 1;
          softParen = at > 0;
        }
      } else {
        group = innermost();
        if (pendingSoft) soft = true;
        if (
          (word === "AND" || word === "OR" || word === "ON") &&
          !(word === "AND" && previousWord === "BETWEEN")
        ) {
          soft = true;
        }
      }
    }

    pieces.push({
      text: rendered[index]!,
      kind: source.kind,
      glue: glue[index]!,
      hardLevel,
      softParen,
      soft,
      group,
      parenGroup,
      lineComment,
      blockComment,
      endsStatement,
      opensParen,
      closesParen,
    });

    if (isComment) continue;
    if (source.text === ",") pendingSoft = true;
    else pendingSoft = false;
    if (word !== "") previousWord = word;
  }
  // The statement's last clause group never sees a closing event of its own.
  closeClauses(0, count);
  return pieces;
}

function layOut(pieces: readonly Piece[], indentWidth: number): string {
  const indentOf = (level: number): string => " ".repeat(level * indentWidth);
  const lines: string[] = [];
  let line = "";
  let level = 0;

  const flush = (): void => {
    if (line.trim() !== "") lines.push(line);
    line = indentOf(level);
  };

  for (const piece of pieces) {
    if (piece.lineComment) {
      line += (line.trim() === "" ? "" : " ") + piece.text;
      flush();
      continue;
    }
    if (piece.blockComment) {
      flush();
      line = indentOf(level) + piece.text;
      flush();
      continue;
    }
    if (
      piece.hardLevel !== null &&
      (!piece.softParen || piece.parenGroup?.broken === true)
    ) {
      level = piece.hardLevel;
      flush();
    } else if (piece.soft && piece.group.broken) {
      level = piece.group.innerLevel;
      flush();
    } else if (
      piece.closesParen &&
      piece.parenGroup !== null &&
      piece.parenGroup.broken
    ) {
      level = piece.parenGroup.closeLevel;
      flush();
    }
    line += (line.trim() === "" ? "" : piece.glue) + piece.text;
    if (piece.opensParen && piece.parenGroup !== null) {
      piece.parenGroup.broken =
        line.length + piece.parenGroup.flatWidth + 1 > MAX_LINE_WIDTH;
      if (piece.parenGroup.broken) {
        level = piece.parenGroup.innerLevel;
        flush();
      }
    }
    if (piece.endsStatement) {
      level = 0;
      flush();
    }
  }
  flush();
  return lines.join("\n");
}

export function formatSql(analysis: Analysis, options: FormatOptions): string {
  const raw = rawPiecesOf(analysis.tokens);
  if (raw.length === 0) return "";
  return layOut(classify(raw, options), options.indentWidth);
}
