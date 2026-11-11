/**
 * Structural analysis: the findings the scanner can state with confidence.
 *
 * Nothing here parses SQL deeply. Bracket balance and clause order are what a
 * bounded token stream can prove, and every uncertain construct is skipped
 * rather than reported — a false error costs more trust than a missed one.
 * Positions and messages mirror the toolkit's former runtime, because the
 * wording is part of what users already learned to read.
 */

import type { DialectInfo } from "./dialect";
import {
  positionOf,
  runeLength,
  tokenizeSql,
  type Diagnostic,
  type SqlToken,
} from "./tokenize";

export interface Analysis {
  readonly tokens: SqlToken[];
  readonly diagnostics: Diagnostic[];
}

const MAX_DIAGNOSTICS = 50;

/** Position in the fixed SELECT pipeline; a later clause may not come first. */
const CLAUSE_ORDER = new Map<string, number>([
  ["SELECT", 1],
  ["FROM", 2],
  ["WHERE", 3],
  ["GROUP", 4],
  ["HAVING", 5],
  ["ORDER", 6],
  ["LIMIT", 7],
  ["OFFSET", 8],
]);

const SET_OPERATORS = new Set(["UNION", "INTERSECT", "EXCEPT", "MINUS"]);

const STATEMENT_STARTERS = new Set([
  "SELECT", "INSERT", "UPDATE", "DELETE", "CREATE", "DROP", "ALTER",
  "TRUNCATE", "WITH", "REPLACE", "CALL", "GRANT", "REVOKE", "BEGIN",
  "COMMIT", "ROLLBACK", "EXPLAIN", "USE", "SHOW", "DESC", "DESCRIBE", "SET",
]);

const CLOSER_FOR = new Map<string, string>([
  ["(", ")"],
  ["[", "]"],
  ["{", "}"],
]);

function diagnostic(
  text: string,
  start: number,
  end: number,
  message: string,
): Diagnostic {
  const { line, column } = positionOf(text, start);
  return {
    line,
    column,
    length: runeLength(text, start, end),
    severity: "error",
    message,
  };
}

/** Findings the scanner itself marked: an unclosed quote or comment. */
function lexicalDiagnostics(text: string, tokens: readonly SqlToken[]): Diagnostic[] {
  const found: Diagnostic[] = [];
  for (const token of tokens) {
    if (!token.error) continue;
    found.push(
      diagnostic(
        text,
        token.start,
        token.end,
        "无法识别的记号（常见原因：未闭合的引号或注释）",
      ),
    );
    if (found.length >= MAX_DIAGNOSTICS) break;
  }
  return found;
}

interface Scope {
  lastIndex: number;
  lastWord: string;
  seen: Set<string>;
}

/** Bracket balance and clause order over one token stream. */
function structuralDiagnostics(text: string, tokens: readonly SqlToken[]): Diagnostic[] {
  const found: Diagnostic[] = [];
  const add = (start: number, end: number, message: string): void => {
    if (found.length >= MAX_DIAGNOSTICS) return;
    found.push(diagnostic(text, start, end, message));
  };

  const brackets: { closer: string; start: number }[] = [];
  const scopes: Scope[] = [{ lastIndex: 0, lastWord: "", seen: new Set() }];

  const pushScope = (): void => {
    scopes.push({ lastIndex: 0, lastWord: "", seen: new Set() });
  };
  const popScope = (): void => {
    if (scopes.length > 1) scopes.pop();
  };

  for (const token of tokens) {
    if (token.error || token.kind === "string" || token.kind === "comment") continue;
    const word = token.text.trim().toUpperCase();
    if (word === "") continue;

    if (word === ";") {
      scopes[scopes.length - 1] = { lastIndex: 0, lastWord: "", seen: new Set() };
      continue;
    }

    const closer = CLOSER_FOR.get(word);
    if (closer !== undefined) {
      brackets.push({ closer, start: token.start });
      pushScope();
      continue;
    }

    if (word === ")" || word === "]" || word === "}") {
      const top = brackets[brackets.length - 1];
      if (top === undefined) {
        add(token.start, token.end, "多余的右括号");
        continue;
      }
      if (top.closer !== word) {
        add(token.start, token.end, `括号不匹配：此处应为 ${top.closer}`);
        continue;
      }
      brackets.pop();
      popScope();
      continue;
    }

    if (STATEMENT_STARTERS.has(word) && word !== "SELECT") {
      scopes[scopes.length - 1] = { lastIndex: 0, lastWord: "", seen: new Set() };
      continue;
    }

    if (SET_OPERATORS.has(word)) {
      scopes[scopes.length - 1] = { lastIndex: 0, lastWord: "", seen: new Set() };
      continue;
    }

    const order = CLAUSE_ORDER.get(word);
    if (order === undefined) continue;

    const active = scopes[scopes.length - 1]!;
    if (active.seen.has(word) && word !== "SELECT") {
      add(token.start, token.end, `重复的 ${word} 子句`);
      continue;
    }
    if (active.lastIndex > order && word !== "SELECT") {
      add(
        token.start,
        token.end,
        `子句顺序不正确：${word} 出现在 ${active.lastWord} 之后`,
      );
      continue;
    }
    active.seen.add(word);
    if (order >= active.lastIndex) {
      active.lastIndex = order;
      active.lastWord = word;
    }
  }

  const unclosed = brackets[brackets.length - 1];
  if (unclosed !== undefined) {
    add(unclosed.start, unclosed.start + 1, "有未闭合的左括号");
  }
  return found;
}

export function analyzeSql(text: string, dialect: DialectInfo): Analysis {
  if (text.trim() === "") {
    return { tokens: [], diagnostics: [] };
  }
  const tokens = tokenizeSql(text, dialect);
  const diagnostics = [
    ...lexicalDiagnostics(text, tokens),
    ...structuralDiagnostics(text, tokens),
  ]
    // The page reports the first finding and marks its line, so position order
    // matters more than the pass that found it.
    .sort((left, right) => left.line - right.line || left.column - right.column)
    .slice(0, MAX_DIAGNOSTICS);
  return { tokens, diagnostics };
}

/** The first error a format or compress action must refuse on. */
export function firstError(
  diagnostics: readonly Diagnostic[],
): Diagnostic | null {
  return diagnostics.find((entry) => entry.severity === "error") ?? null;
}
