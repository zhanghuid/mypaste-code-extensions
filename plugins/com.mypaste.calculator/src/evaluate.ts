/**
 * The calculator's expression engine.
 *
 * One row of the scratch sheet is one line: a blank line, a note (`#` or `//`),
 * an assignment (`name = expression`) or an expression. Lines are evaluated in
 * order against one variable scope, so a later row can use a name an earlier
 * row defined, and `ans` always means the previous row's value. Everything here
 * is pure arithmetic in this document: no network, no clock, no clipboard and
 * no other entry.
 *
 * Percent follows the behaviour of a pocket calculator: a trailing `%` is one
 * hundredth, and on the right of `+` or `-` it means that share of the left
 * side (`200 + 10%` is 220). A trailing `°` converts degrees to radians.
 */

export type RowKind = "blank" | "note" | "value" | "error";

export interface RowOutcome {
  kind: RowKind;
  /** The expression after an inline comment is removed, trimmed. */
  source: string;
  /** Display form, with thousands separators; empty unless kind is "value". */
  display: string;
  /** Clipboard/continue form, without separators; empty unless "value". */
  copy: string;
  /** The computed number, or null. */
  value: number | null;
  /** A reader-facing reason; empty unless kind is "error". */
  error: string;
}

class CalcError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CalcError";
  }
}

interface FunctionSpec {
  min: number;
  max: number;
  apply: (args: number[]) => number;
}

/** Constants are matched case-insensitively; `π` is the same name as `pi`. */
const CONSTANTS: Record<string, number> = {
  pi: Math.PI,
  "π": Math.PI,
  e: Math.E,
  tau: Math.PI * 2,
};

const FUNCTIONS: Record<string, FunctionSpec> = {
  abs: { min: 1, max: 1, apply: ([value]) => Math.abs(value ?? 0) },
  sqrt: { min: 1, max: 1, apply: ([value]) => Math.sqrt(value ?? 0) },
  cbrt: { min: 1, max: 1, apply: ([value]) => Math.cbrt(value ?? 0) },
  sign: { min: 1, max: 1, apply: ([value]) => Math.sign(value ?? 0) },
  floor: { min: 1, max: 1, apply: ([value]) => Math.floor(value ?? 0) },
  ceil: { min: 1, max: 1, apply: ([value]) => Math.ceil(value ?? 0) },
  trunc: { min: 1, max: 1, apply: ([value]) => Math.trunc(value ?? 0) },
  round: { min: 1, max: 2, apply: round },
  sin: { min: 1, max: 1, apply: ([value]) => Math.sin(value ?? 0) },
  cos: { min: 1, max: 1, apply: ([value]) => Math.cos(value ?? 0) },
  tan: { min: 1, max: 1, apply: ([value]) => Math.tan(value ?? 0) },
  asin: { min: 1, max: 1, apply: ([value]) => Math.asin(value ?? 0) },
  acos: { min: 1, max: 1, apply: ([value]) => Math.acos(value ?? 0) },
  atan: { min: 1, max: 1, apply: ([value]) => Math.atan(value ?? 0) },
  atan2: { min: 2, max: 2, apply: ([y, x]) => Math.atan2(y ?? 0, x ?? 0) },
  ln: { min: 1, max: 1, apply: ([value]) => Math.log(value ?? 0) },
  log: { min: 1, max: 1, apply: ([value]) => Math.log10(value ?? 0) },
  log2: { min: 1, max: 1, apply: ([value]) => Math.log2(value ?? 0) },
  exp: { min: 1, max: 1, apply: ([value]) => Math.exp(value ?? 0) },
  pow: { min: 2, max: 2, apply: ([base, exponent]) => (base ?? 0) ** (exponent ?? 0) },
  mod: { min: 2, max: 2, apply: mod },
  hypot: { min: 1, max: Number.POSITIVE_INFINITY, apply: (args) => Math.hypot(...args) },
  min: { min: 1, max: Number.POSITIVE_INFINITY, apply: (args) => Math.min(...args) },
  max: { min: 1, max: Number.POSITIVE_INFINITY, apply: (args) => Math.max(...args) },
};

function round(args: number[]): number {
  const value = args[0] ?? 0;
  const digits = args.length > 1 ? args[1] ?? 0 : 0;
  if (!Number.isInteger(digits) || digits < 0 || digits > 15) {
    throw new CalcError("round 的位数需要是 0 到 15 的整数");
  }
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function mod(args: number[]): number {
  const dividend = args[0] ?? 0;
  const divisor = args[1] ?? 0;
  if (divisor === 0) throw new CalcError("不能除以零");
  return dividend % divisor;
}

// ---------------------------------------------------------------- tokenizer

type TokenType = "number" | "name" | "op" | "lparen" | "rparen" | "comma";

interface Token {
  type: TokenType;
  text: string;
  value: number;
  /** Zero-based position in the expression, used only in messages. */
  start: number;
}

const NUMBER_AT = /^(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?\d[\d_]*)?/u;
const NAME_AT = /^[\p{L}_][\p{L}\p{N}_]*/u;

/** Characters a writer may type instead of the ASCII operators. */
const OPERATOR_ALIASES: Record<string, string> = {
  "×": "*",
  "·": "*",
  "÷": "/",
  "−": "-",
  "–": "-",
};

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < text.length) {
    const rest = text.slice(index);
    const character = rest[0] ?? "";
    if (/\s/u.test(character)) {
      index += 1;
      continue;
    }
    const number = NUMBER_AT.exec(rest);
    if (number) {
      const raw = number[0] ?? "";
      const value = Number(raw.replace(/_/gu, ""));
      if (!Number.isFinite(value)) {
        throw new CalcError(`数字“${raw}”无法表示`);
      }
      tokens.push({ type: "number", text: raw, value, start: index });
      index += raw.length;
      continue;
    }
    const name = NAME_AT.exec(rest);
    if (name) {
      const raw = name[0] ?? "";
      tokens.push({ type: "name", text: raw, value: 0, start: index });
      index += raw.length;
      continue;
    }
    if (character === "(") {
      tokens.push({ type: "lparen", text: character, value: 0, start: index });
      index += 1;
      continue;
    }
    if (character === ")") {
      tokens.push({ type: "rparen", text: character, value: 0, start: index });
      index += 1;
      continue;
    }
    if (character === ",") {
      tokens.push({ type: "comma", text: character, value: 0, start: index });
      index += 1;
      continue;
    }
    if (character === "*" && rest[1] === "*") {
      tokens.push({ type: "op", text: "^", value: 0, start: index });
      index += 2;
      continue;
    }
    const operator = OPERATOR_ALIASES[character] ?? character;
    if ("+-*/^%°".includes(operator)) {
      tokens.push({ type: "op", text: operator, value: 0, start: index });
      index += 1;
      continue;
    }
    throw new CalcError(`无法识别的字符“${character}”`);
  }
  return tokens;
}

// ------------------------------------------------------------------- parser

type Node =
  | { kind: "number"; value: number }
  | { kind: "variable"; name: string }
  | { kind: "unary"; operand: Node }
  | { kind: "percent"; operand: Node }
  | { kind: "degrees"; operand: Node }
  | { kind: "call"; name: string; args: Node[] }
  | {
      kind: "binary";
      op: "+" | "-" | "*" | "/" | "^";
      left: Node;
      right: Node;
    };

class Parser {
  private index = 0;

  constructor(private readonly tokens: readonly Token[]) {}

  parse(): Node {
    if (this.tokens.length === 0) throw new CalcError("缺少算式");
    const node = this.parseAdditive();
    const leftover = this.peek();
    if (leftover) {
      if (leftover.type === "rparen") throw new CalcError("多余的右括号");
      if (leftover.type === "comma") throw new CalcError("这里不能出现逗号");
      throw new CalcError(`无法理解“${leftover.text}”`);
    }
    return node;
  }

  private peek(): Token | undefined {
    return this.tokens[this.index];
  }

  private next(): Token | undefined {
    const token = this.tokens[this.index];
    if (token) this.index += 1;
    return token;
  }

  private matchOp(...operators: string[]): Token | undefined {
    const token = this.peek();
    if (!token || token.type !== "op" || !operators.includes(token.text)) {
      return undefined;
    }
    this.index += 1;
    return token;
  }

  private matchKind(type: TokenType): boolean {
    const token = this.peek();
    if (!token || token.type !== type) return false;
    this.index += 1;
    return true;
  }

  private parseAdditive(): Node {
    let left = this.parseMultiplicative();
    for (;;) {
      const operator = this.matchOp("+", "-");
      if (!operator) return left;
      const right = this.parseMultiplicative();
      left = {
        kind: "binary",
        op: operator.text === "+" ? "+" : "-",
        left,
        right,
      };
    }
  }

  private parseMultiplicative(): Node {
    let left = this.parseUnary();
    for (;;) {
      const operator = this.matchOp("*", "/");
      if (operator) {
        const right = this.parseUnary();
        left = {
          kind: "binary",
          op: operator.text === "*" ? "*" : "/",
          left,
          right,
        };
        continue;
      }
      // Juxtaposition is multiplication: 2(3+4), 2pi, (1+2)(3+4).
      const next = this.peek();
      if (
        next &&
        (next.type === "number" || next.type === "name" || next.type === "lparen")
      ) {
        left = { kind: "binary", op: "*", left, right: this.parseUnary() };
        continue;
      }
      return left;
    }
  }

  private parseUnary(): Node {
    const operator = this.matchOp("+", "-");
    if (!operator) return this.parsePower();
    const operand = this.parseUnary();
    return operator.text === "-" ? { kind: "unary", operand } : operand;
  }

  private parsePower(): Node {
    const left = this.parsePostfix();
    if (!this.matchOp("^")) return left;
    // Right-associative, and the exponent may be signed: 2^3^2, 2^-3.
    return { kind: "binary", op: "^", left, right: this.parseUnary() };
  }

  private parsePostfix(): Node {
    let node = this.parsePrimary();
    for (;;) {
      if (this.matchOp("%")) {
        node = { kind: "percent", operand: node };
        continue;
      }
      if (this.matchOp("°")) {
        node = { kind: "degrees", operand: node };
        continue;
      }
      return node;
    }
  }

  private parsePrimary(): Node {
    const token = this.next();
    if (!token) throw new CalcError("缺少运算数");
    if (token.type === "number") {
      return { kind: "number", value: token.value };
    }
    if (token.type === "name") {
      if (!this.matchKind("lparen")) {
        return { kind: "variable", name: token.text };
      }
      const args: Node[] = [];
      if (this.matchKind("rparen")) {
        return { kind: "call", name: token.text, args };
      }
      for (;;) {
        args.push(this.parseAdditive());
        if (this.matchKind("rparen")) break;
        if (!this.matchKind("comma")) {
          throw new CalcError("函数参数之间需要逗号");
        }
      }
      return { kind: "call", name: token.text, args };
    }
    if (token.type === "lparen") {
      const inner = this.parseAdditive();
      if (!this.matchKind("rparen")) throw new CalcError("缺少右括号");
      return inner;
    }
    if (token.type === "rparen") throw new CalcError("多余的右括号");
    throw new CalcError("这里不能出现逗号");
  }
}

// ---------------------------------------------------------------- evaluator

interface Scope {
  variables: Map<string, number>;
  previous: number | null;
}

function evaluateNode(node: Node, scope: Scope): number {
  switch (node.kind) {
    case "number":
      return node.value;
    case "variable":
      return resolveName(node.name, scope);
    case "unary":
      return -evaluateNode(node.operand, scope);
    case "percent":
      return evaluateNode(node.operand, scope) / 100;
    case "degrees":
      return (evaluateNode(node.operand, scope) * Math.PI) / 180;
    case "call":
      return evaluateCall(node.name, node.args, scope);
    case "binary":
      return evaluateBinary(node, scope);
  }
}

function evaluateBinary(
  node: Extract<Node, { kind: "binary" }>,
  scope: Scope,
): number {
  const left = evaluateNode(node.left, scope);
  // A trailing percent on the right of + / - is a share of the left side:
  // 200 + 10% is 220, not 200.1.
  if ((node.op === "+" || node.op === "-") && node.right.kind === "percent") {
    const share = (left * evaluateNode(node.right.operand, scope)) / 100;
    return node.op === "+" ? left + share : left - share;
  }
  const right = evaluateNode(node.right, scope);
  switch (node.op) {
    case "+":
      return left + right;
    case "-":
      return left - right;
    case "*":
      return left * right;
    case "/":
      if (right === 0) throw new CalcError("不能除以零");
      return left / right;
    case "^":
      return left ** right;
  }
}

function evaluateCall(name: string, args: Node[], scope: Scope): number {
  const key = name.toLowerCase();
  const spec = FUNCTIONS[key];
  if (!spec) throw new CalcError(`未知函数“${name}”`);
  if (args.length < spec.min || args.length > spec.max) {
    throw new CalcError(arityMessage(key, spec));
  }
  return spec.apply(args.map((argument) => evaluateNode(argument, scope)));
}

function arityMessage(name: string, spec: FunctionSpec): string {
  if (spec.min === spec.max) {
    return `函数 ${name} 需要 ${spec.min} 个参数`;
  }
  if (spec.max === Number.POSITIVE_INFINITY) {
    return `函数 ${name} 至少需要 ${spec.min} 个参数`;
  }
  return `函数 ${name} 需要 ${spec.min} 到 ${spec.max} 个参数`;
}

function resolveName(name: string, scope: Scope): number {
  const key = name.toLowerCase();
  if (key === "ans") {
    if (scope.previous === null) {
      throw new CalcError("还没有可以引用的上一个结果");
    }
    return scope.previous;
  }
  const constant = CONSTANTS[key];
  if (constant !== undefined) return constant;
  const variable = scope.variables.get(name);
  if (variable !== undefined) return variable;
  if (FUNCTIONS[key]) {
    throw new CalcError(`函数 ${key} 需要括号和参数`);
  }
  throw new CalcError(`未知标识符“${name}”`);
}

function evaluateCode(code: string, scope: Scope): number {
  return evaluateNode(new Parser(tokenize(code)).parse(), scope);
}

// --------------------------------------------------------------------- sheet

const ASSIGNMENT = /^([\p{L}_][\p{L}\p{N}_]*)\s*=(?!=)\s*(.*)$/u;

/** Removes an inline comment. The expression language has no strings, so the
 * first `#` or `//` always starts a comment. */
function stripComment(text: string): string {
  let cut = text.length;
  const hash = text.indexOf("#");
  if (hash >= 0) cut = Math.min(cut, hash);
  const slashes = text.indexOf("//");
  if (slashes >= 0) cut = Math.min(cut, slashes);
  return text.slice(0, cut);
}

function isNote(text: string): boolean {
  return text.startsWith("#") || text.startsWith("//");
}

function blankOutcome(source: string): RowOutcome {
  return {
    kind: "blank",
    source,
    display: "",
    copy: "",
    value: null,
    error: "",
  };
}

function noteOutcome(source: string): RowOutcome {
  return {
    kind: "note",
    source,
    display: "",
    copy: "",
    value: null,
    error: "",
  };
}

function errorOutcome(source: string, message: string): RowOutcome {
  return {
    kind: "error",
    source,
    display: "",
    copy: "",
    value: null,
    error: message,
  };
}

function valueOutcome(source: string, value: number): RowOutcome {
  const formatted = formatValue(value);
  return {
    kind: "value",
    source,
    display: formatted.display,
    copy: formatted.copy,
    value,
    error: "",
  };
}

function evaluateLine(line: string, scope: Scope): RowOutcome {
  const trimmed = line.trim();
  if (trimmed === "") return blankOutcome("");
  if (isNote(trimmed)) return noteOutcome(trimmed);
  const code = stripComment(trimmed).trim();
  if (code === "") return noteOutcome(trimmed);

  const assignment = ASSIGNMENT.exec(code);
  if (assignment) {
    const name = assignment[1] ?? "";
    const expression = (assignment[2] ?? "").trim();
    const key = name.toLowerCase();
    if (key === "ans" || CONSTANTS[key] !== undefined || FUNCTIONS[key]) {
      throw new CalcError(`“${name}”是内置名字，不能赋值`);
    }
    if (expression === "") throw new CalcError("等号右边缺少算式");
    const value = evaluateCode(expression, scope);
    checkFinite(value);
    scope.variables.set(name, value);
    return valueOutcome(code, value);
  }

  const value = evaluateCode(code, scope);
  checkFinite(value);
  return valueOutcome(code, value);
}

function checkFinite(value: number): void {
  if (Number.isNaN(value)) throw new CalcError("结果不是一个数");
  if (!Number.isFinite(value)) throw new CalcError("结果超出可表示范围");
}

/**
 * Evaluates the whole sheet in order. An error only affects its own row: the
 * variables it would have defined are absent, while later rows still see the
 * names and `ans` established before it.
 */
export function evaluateSheet(lines: readonly string[]): RowOutcome[] {
  const scope: Scope = { variables: new Map(), previous: null };
  const outcomes: RowOutcome[] = [];
  for (const line of lines) {
    let outcome: RowOutcome;
    try {
      outcome = evaluateLine(line, scope);
    } catch (error) {
      outcome = errorOutcome(line.trim(), messageOf(error));
    }
    if (outcome.kind === "value" && outcome.value !== null) {
      scope.previous = outcome.value;
    }
    outcomes.push(outcome);
  }
  return outcomes;
}

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "无法计算这一行";
}

// ---------------------------------------------------------------- formatting

/**
 * Formats a result twice: `display` groups the integer part for reading, and
 * `copy` stays a plain number so a copied result can be pasted into another
 * calculator or used as the next row verbatim.
 */
export function formatValue(value: number): { display: string; copy: string } {
  checkFinite(value);
  if (value === 0) return { display: "0", copy: "0" };
  const absolute = Math.abs(value);
  if (absolute >= 1e15 || absolute < 1e-6) {
    const text = shortExponential(value);
    return { display: text, copy: text };
  }
  const rounded = Number(value.toPrecision(12));
  const plain = String(rounded);
  const negative = plain.startsWith("-");
  const unsigned = negative ? plain.slice(1) : plain;
  const [integer = "0", fraction] = unsigned.split(".");
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/gu, ",");
  const body = fraction ? `${grouped}.${fraction}` : grouped;
  return { display: `${negative ? "-" : ""}${body}`, copy: plain };
}

function shortExponential(value: number): string {
  const [mantissa = "", exponent = ""] = value.toExponential(8).split("e");
  const trimmed = mantissa
    .replace(/0+$/u, "")
    .replace(/\.$/u, "");
  const sign = exponent.startsWith("-") ? "-" : "";
  const digits = exponent.replace(/^[+-]/u, "").replace(/^0+(?=\d)/u, "");
  return `${trimmed}e${sign}${digits}`;
}
