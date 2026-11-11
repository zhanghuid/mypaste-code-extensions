/**
 * The page's formatter.
 *
 * The input is a token stream that already scanned cleanly. Layout is policy,
 * not preservation: whitespace between tokens is re-derived, while strings,
 * comments, numbers and quoted identifiers are copied unchanged. Keywords are
 * cased by the toolbar's choice.
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

/** Words that start a line of their own at bracket depth 0. */
const NEWLINE_BEFORE = new Set([
  "SELECT", "FROM", "WHERE", "GROUP", "HAVING", "ORDER", "LIMIT", "OFFSET",
  "UNION", "INTERSECT", "EXCEPT", "MINUS", "VALUES", "SET", "INSERT", "UPDATE",
  "DELETE", "CREATE", "DROP", "ALTER",
]);

/** Words that open a join clause when the next word is JOIN. */
const JOIN_LEADING = new Set([
  "JOIN", "LEFT", "RIGHT", "FULL", "INNER", "CROSS", "NATURAL",
]);

/** Words that break a long condition onto their own, deeper line. */
const CONDITION_BREAKS = new Set(["AND", "OR", "ON"]);

/** Operators that sit tight against both neighbours. */
const TIGHT_OPERATORS = new Set(["::", "->", "->>", "#>", "#>>"]);

const TIGHT_BEFORE = new Set([",", ")", ";", ".", "(", "]", "}"]);

interface Piece {
  readonly text: string;
  readonly kind: SqlToken["kind"];
  readonly isKeyword: boolean;
}

function piecesOf(tokens: readonly SqlToken[]): Piece[] {
  const pieces: Piece[] = [];
  for (const token of tokens) {
    switch (token.kind) {
      case "string":
      case "comment":
      case "number":
        pieces.push({ text: token.text, kind: token.kind, isKeyword: false });
        break;
      case "keyword":
        pieces.push({ text: token.text, kind: token.kind, isKeyword: true });
        break;
      default: {
        const text = token.text.replace(/\s+/gu, " ").trim();
        if (text === "") break;
        pieces.push({ text, kind: token.kind, isKeyword: false });
      }
    }
  }
  return pieces;
}

function renderKeyword(text: string, options: FormatOptions): string {
  if (options.keywordCase === "upper") return text.toUpperCase();
  if (options.keywordCase === "lower") return text.toLowerCase();
  return text;
}

function subqueryHead(word: string): boolean {
  return word === "SELECT" || word === "WITH";
}

export function formatSql(analysis: Analysis, options: FormatOptions): string {
  const pieces = piecesOf(analysis.tokens);

  const nextWord = (from: number): string => {
    for (let index = from + 1; index < pieces.length; index += 1) {
      const piece = pieces[index]!;
      if (piece.kind === "comment") continue;
      return piece.text.toUpperCase();
    }
    return "";
  };

  const lines: string[] = [];
  let current = "";
  let lastChar = "";
  let lastText = "";
  let lastUnary = false;
  let depth = 0;
  const parenBlocks: boolean[] = [];

  const emit = (text: string): void => {
    current += text;
    const trimmed = text.replace(/[ \t]+$/gu, "");
    if (trimmed !== "") lastChar = trimmed.charAt(trimmed.length - 1);
  };

  const startLine = (levels: number): void => {
    if (current.trim() !== "") {
      lines.push(current);
    }
    current = levels > 0 ? " ".repeat(levels * options.indentWidth) : "";
    lastChar = "";
    lastText = "";
    lastUnary = false;
  };

  const inline = (text: string, unary = false): void => {
    if (current.trim() === "") {
      emit(text);
      lastText = text;
      lastUnary = unary;
      return;
    }
    const tightBefore =
      TIGHT_BEFORE.has(text) || TIGHT_OPERATORS.has(text) || text.startsWith("(");
    const tightAfter =
      lastText === "(" || lastText === "." || lastText === "[" || lastUnary ||
      TIGHT_OPERATORS.has(lastText);
    if (!tightBefore && !tightAfter) emit(" ");
    emit(text);
    lastText = text;
    lastUnary = unary;
  };

  for (let index = 0; index < pieces.length; index += 1) {
    const piece = pieces[index]!;

    if (piece.kind === "comment") {
      const trimmed = piece.text.trim();
      if (trimmed.startsWith("--") || trimmed.startsWith("#")) {
        if (current.trim() !== "") {
          lines.push(current);
          current = "";
        }
        current += piece.text.replace(/[ \t]+$/gu, "");
        lines.push(current);
        current = "";
        lastChar = "";
        lastText = "";
        lastUnary = false;
      } else {
        inline(piece.text);
      }
      continue;
    }

    if (piece.kind === "string" || piece.kind === "number") {
      inline(piece.text);
      continue;
    }

    const word = piece.text.toUpperCase();
    switch (piece.text) {
      case "(": {
        const block = subqueryHead(nextWord(index));
        if (block) {
          if (current.trim() !== "") emit(" ");
          emit("(");
          depth += 1;
          parenBlocks.push(true);
          startLine(depth);
        } else {
          parenBlocks.push(false);
          depth += 1;
          inline("(");
        }
        break;
      }
      case ")": {
        const block = parenBlocks.pop() ?? false;
        depth = Math.max(0, depth - 1);
        if (block) startLine(depth);
        inline(")");
        break;
      }
      case ",":
        emit(",");
        lastText = ",";
        lastUnary = false;
        if (depth === 0) startLine(1);
        break;
      case ";":
        emit(";");
        lastText = ";";
        lastUnary = false;
        startLine(0);
        break;
      default:
        if (TIGHT_OPERATORS.has(piece.text)) {
          inline(piece.text);
          break;
        }
        if ((piece.text === "-" || piece.text === "+") && isUnaryContext(lastText, lastUnary)) {
          inline(piece.text, true);
          break;
        }
        if (piece.isKeyword && JOIN_LEADING.has(word) && word !== "JOIN" && nextWord(index) !== "JOIN") {
          inline(renderKeyword(piece.text, options));
          break;
        }
        if (piece.isKeyword && (NEWLINE_BEFORE.has(word) || word === "JOIN" || CONDITION_BREAKS.has(word))) {
          const levels = CONDITION_BREAKS.has(word) && word !== "ON" ? depth + 1 : depth;
          startLine(levels);
          emit(renderKeyword(piece.text, options));
          lastText = piece.text;
          lastUnary = false;
          break;
        }
        inline(piece.isKeyword ? renderKeyword(piece.text, options) : piece.text);
        break;
    }
  }

  if (current.trim() !== "") lines.push(current);
  return lines.join("\n");
}

/** Whether a `-` or `+` is a sign rather than a binary operator. */
function isUnaryContext(lastText: string, lastUnary: boolean): boolean {
  if (lastText === "") return true;
  if (lastUnary) return false;
  return (
    lastText === "(" || lastText === "[" || lastText === "," ||
    lastText === "=" || lastText === "<" || lastText === ">" ||
    lastText === "<=" || lastText === ">=" || lastText === "<>" ||
    lastText === "!=" || lastText === "+" || lastText === "-" ||
    lastText === "*" || lastText === "/" || lastText === "%"
  );
}
