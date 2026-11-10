/**
 * The filter box's expression evaluator.
 *
 * The page runs under a CSP without `eval` or `new Function`, so this module
 * parses a small JavaScript expression and evaluates it against a scope that
 * contains only the current JSON (`data` and `json`). Supported: member access,
 * indexing, array and string methods with arrow-function callbacks, comparisons,
 * logical operators, arithmetic, array literals and a few pure globals
 * (`Object.keys`, `Array.isArray`, `JSON.parse` / `JSON.stringify`, `String`,
 * `Number`, `Boolean`). Anything else is refused with a readable message.
 *
 * The evaluator never mutates the parsed JSON: sorting and splicing methods are
 * not on the allowlist, and only values flow out of it.
 */

import type { JsonValue } from "./json";

type Node =
  | { kind: "literal"; value: JsonValue | undefined }
  | { kind: "identifier"; name: string; line: number; column: number }
  | { kind: "array"; items: Node[] }
  | { kind: "member"; object: Node; property: Node | string; line: number; column: number }
  | { kind: "call"; callee: Node; args: Node[]; line: number; column: number }
  | { kind: "arrow"; params: string[]; body: Node }
  | { kind: "unary"; operator: string; argument: Node }
  | { kind: "binary"; operator: string; left: Node; right: Node };

interface Token {
  kind: "number" | "string" | "identifier" | "punct" | "eof";
  value: string;
  line: number;
  column: number;
}

const PUNCTUATION = [
  "===", "!==", "=>", "==", "!=", "<=", ">=", "&&", "||", "??",
  ".", ",", "[", "]", "(", ")", "{", "}", "?", ":", "+", "-", "*", "/", "%",
  "!", "<", ">",
];

const PRECEDENCE: { [operator: string]: number } = {
  "??": 1,
  "||": 2,
  "&&": 3,
  "==": 4, "!=": 4, "===": 4, "!==": 4,
  "<": 5, "<=": 5, ">": 5, ">=": 5,
  "+": 6, "-": 6,
  "*": 7, "/": 7, "%": 7,
};

const DANGEROUS = new Set([
  "__proto__", "prototype", "constructor",
  "__defineGetter__", "__defineSetter__", "__lookupGetter__", "__lookupSetter__",
]);

const ARRAY_METHODS = new Set([
  "filter", "map", "find", "findIndex", "some", "every", "reduce",
  "slice", "concat", "join", "includes", "indexOf", "lastIndexOf", "at",
  "flat", "keys", "values", "entries",
]);

const STRING_METHODS = new Set([
  "toUpperCase", "toLowerCase", "trim", "trimStart", "trimEnd",
  "startsWith", "endsWith", "includes", "indexOf", "lastIndexOf",
  "slice", "split", "replace", "replaceAll", "concat", "at",
  "padStart", "padEnd", "repeat",
]);

const STEP_LIMIT = 200_000;

class ExpressionError extends Error {}

function fail(token: Token, message: string): never {
  throw new ExpressionError(`第 ${token.line} 行第 ${token.column} 列：${message}`);
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  let line = 1;
  let column = 1;

  function advance(text: string): void {
    for (const char of text) {
      if (char === "\n") {
        line += 1;
        column = 1;
      } else {
        column += 1;
      }
    }
    index += text.length;
  }

  while (index < source.length) {
    const char = source[index]!;
    if (/\s/.test(char)) {
      advance(char);
      continue;
    }
    const startLine = line;
    const startColumn = column;
    if (/[0-9]/.test(char) || (char === "." && /[0-9]/.test(source[index + 1] ?? ""))) {
      const match = /^\d*\.?\d+(?:[eE][-+]?\d+)?/.exec(source.slice(index));
      if (match === null) throw new ExpressionError("无法识别的数字");
      advance(match[0]);
      tokens.push({ kind: "number", value: match[0], line: startLine, column: startColumn });
      continue;
    }
    if (char === "\"" || char === "'") {
      const quote = char;
      let cursor = index + 1;
      let value = "";
      while (cursor < source.length && source[cursor] !== quote) {
        if (source[cursor] === "\\") {
          const next = source[cursor + 1] ?? "";
          value += next === "n" ? "\n" : next === "t" ? "\t" : next;
          cursor += 2;
          continue;
        }
        value += source[cursor];
        cursor += 1;
      }
      if (cursor >= source.length) {
        throw new ExpressionError(`第 ${startLine} 行第 ${startColumn} 列：字符串没有结束`);
      }
      advance(source.slice(index, cursor + 1));
      tokens.push({ kind: "string", value, line: startLine, column: startColumn });
      continue;
    }
    if (/[A-Za-z_$]/.test(char)) {
      const match = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(source.slice(index))!;
      advance(match[0]);
      tokens.push({ kind: "identifier", value: match[0], line: startLine, column: startColumn });
      continue;
    }
    const punctuation = PUNCTUATION.find((item) => source.startsWith(item, index));
    if (punctuation === undefined) {
      throw new ExpressionError(
        `第 ${startLine} 行第 ${startColumn} 列：无法识别的字符 ${JSON.stringify(char)}`,
      );
    }
    advance(punctuation);
    tokens.push({ kind: "punct", value: punctuation, line: startLine, column: startColumn });
  }
  tokens.push({ kind: "eof", value: "", line, column });
  return tokens;
}

class Parser {
  private index = 0;

  constructor(private readonly tokens: Token[]) {}

  parse(): Node {
    const node = this.expression(0);
    const token = this.peek();
    if (token.kind !== "eof") fail(token, `多余的记号 ${token.value}`);
    return node;
  }

  private peek(offset = 0): Token {
    return this.tokens[Math.min(this.index + offset, this.tokens.length - 1)]!;
  }

  private next(): Token {
    const token = this.peek();
    this.index += 1;
    return token;
  }

  private expect(value: string): Token {
    const token = this.next();
    if (token.kind !== "punct" || token.value !== value) {
      fail(token, `缺少 ${value}`);
    }
    return token;
  }

  private isPunct(value: string, offset = 0): boolean {
    const token = this.peek(offset);
    return token.kind === "punct" && token.value === value;
  }

  private expression(minimum: number): Node {
    let left = this.unary();
    for (;;) {
      const token = this.peek();
      if (token.kind !== "punct") break;
      const precedence = PRECEDENCE[token.value];
      if (precedence === undefined || precedence < minimum) break;
      this.next();
      const right = this.expression(precedence + 1);
      left = { kind: "binary", operator: token.value, left, right };
    }
    return left;
  }

  private unary(): Node {
    const token = this.peek();
    if (token.kind === "punct" && (token.value === "!" || token.value === "-" ||
      token.value === "+")) {
      this.next();
      return { kind: "unary", operator: token.value, argument: this.unary() };
    }
    return this.postfix(this.primary());
  }

  private postfix(base: Node): Node {
    let node = base;
    for (;;) {
      if (this.isPunct(".")) {
        this.next();
        const token = this.next();
        if (token.kind !== "identifier") fail(token, "成员名缺失");
        node = {
          kind: "member", object: node, property: token.value,
          line: token.line, column: token.column,
        };
        continue;
      }
      if (this.isPunct("[")) {
        const open = this.next();
        const property = this.expression(0);
        this.expect("]");
        node = {
          kind: "member", object: node, property,
          line: open.line, column: open.column,
        };
        continue;
      }
      if (this.isPunct("(")) {
        const open = this.next();
        const args: Node[] = [];
        if (!this.isPunct(")")) {
          for (;;) {
            args.push(this.expression(0));
            if (!this.isPunct(",")) break;
            this.next();
          }
        }
        this.expect(")");
        node = {
          kind: "call", callee: node, args,
          line: open.line, column: open.column,
        };
        continue;
      }
      return node;
    }
  }

  private primary(): Node {
    const token = this.peek();
    if (token.kind === "number") {
      this.next();
      return { kind: "literal", value: Number(token.value) };
    }
    if (token.kind === "string") {
      this.next();
      return { kind: "literal", value: token.value };
    }
    if (token.kind === "identifier") {
      if (token.value === "true" || token.value === "false") {
        this.next();
        return { kind: "literal", value: token.value === "true" };
      }
      if (token.value === "null") {
        this.next();
        return { kind: "literal", value: null };
      }
      if (token.value === "undefined") {
        this.next();
        return { kind: "literal", value: undefined };
      }
      if (this.isPunct("=>", 1)) {
        this.next();
        this.next();
        const body = this.expression(0);
        return { kind: "arrow", params: [token.value], body };
      }
      this.next();
      return {
        kind: "identifier", name: token.value,
        line: token.line, column: token.column,
      };
    }
    if (token.kind === "punct" && token.value === "(") {
      const arrow = this.tryArrow();
      if (arrow !== null) return arrow;
      this.next();
      const inner = this.expression(0);
      this.expect(")");
      return inner;
    }
    if (token.kind === "punct" && token.value === "[") {
      this.next();
      const items: Node[] = [];
      if (!this.isPunct("]")) {
        for (;;) {
          items.push(this.expression(0));
          if (!this.isPunct(",")) break;
          this.next();
        }
      }
      this.expect("]");
      return { kind: "array", items };
    }
    if (token.kind === "punct" && token.value === "{") {
      fail(token, "不支持对象字面量");
    }
    if (token.kind === "eof") fail(token, "表达式不完整");
    fail(token, `不能以 ${token.value} 开始表达式`);
  }

  /** Recognizes `(a, b) => …`; rewinds when the parentheses are a group. */
  private tryArrow(): Node | null {
    const saved = this.index;
    this.next();
    const params: string[] = [];
    if (this.isPunct(")")) {
      // `()` alone is not an arrow; rewind.
      this.index = saved;
      return null;
    }
    for (;;) {
      const token = this.peek();
      if (token.kind !== "identifier") {
        this.index = saved;
        return null;
      }
      params.push(token.value);
      this.next();
      if (!this.isPunct(",")) break;
      this.next();
    }
    if (!this.isPunct(")") || !this.isPunct("=>", 1)) {
      this.index = saved;
      return null;
    }
    this.next();
    this.next();
    return { kind: "arrow", params, body: this.expression(0) };
  }
}

class Scope {
  constructor(
    private readonly values: Map<string, unknown>,
    private readonly parent: Scope | null = null,
  ) {}

  get(name: string): unknown {
    if (this.values.has(name)) return this.values.get(name);
    return this.parent?.get(name);
  }
}

const GLOBAL_NAMESPACES: { [name: string]: unknown } = {
  Object: {
    keys: (value: unknown) => Object.keys(value as object),
    values: (value: unknown) => Object.values(value as object),
    entries: (value: unknown) => Object.entries(value as object),
  },
  Array: {
    isArray: (value: unknown) => Array.isArray(value),
  },
  JSON: {
    parse: (value: unknown) => JSON.parse(String(value)) as unknown,
    stringify: (value: unknown) => JSON.stringify(value),
  },
  Math: {
    min: (...values: number[]) => Math.min(...values),
    max: (...values: number[]) => Math.max(...values),
    round: (value: number) => Math.round(value),
    floor: (value: number) => Math.floor(value),
    ceil: (value: number) => Math.ceil(value),
    abs: (value: number) => Math.abs(value),
  },
};

const GLOBAL_FUNCTIONS: { [name: string]: (...args: unknown[]) => unknown } = {
  String: (value) => String(value),
  Number: (value) => Number(value),
  Boolean: (value) => Boolean(value),
};

class Evaluator {
  private steps = 0;

  evaluate(node: Node, scope: Scope): unknown {
    this.steps += 1;
    if (this.steps > STEP_LIMIT) {
      throw new ExpressionError("表达式计算步数过多，请缩小数据范围");
    }
    switch (node.kind) {
      case "literal":
        return node.value;
      case "identifier": {
        const value = scope.get(node.name);
        if (value === undefined && !scopeHas(scope, node.name)) {
          throw new ExpressionError(
            `第 ${node.line} 行第 ${node.column} 列：未知名字 ${node.name}；可用 data 与 json`,
          );
        }
        return value;
      }
      case "array":
        return node.items.map((item) => this.evaluate(item, scope));
      case "arrow":
        return this.arrow(node, scope);
      case "member":
        return this.member(node, scope);
      case "call":
        return this.call(node, scope);
      case "unary": {
        const value = this.evaluate(node.argument, scope);
        if (node.operator === "!") return !value;
        if (node.operator === "-") return -(value as number);
        return +(value as number);
      }
      case "binary": {
        if (node.operator === "&&") {
          const left = this.evaluate(node.left, scope);
          return left ? this.evaluate(node.right, scope) : left;
        }
        if (node.operator === "||") {
          const left = this.evaluate(node.left, scope);
          return left ? left : this.evaluate(node.right, scope);
        }
        if (node.operator === "??") {
          const left = this.evaluate(node.left, scope);
          return left === null || left === undefined
            ? this.evaluate(node.right, scope)
            : left;
        }
        const left = this.evaluate(node.left, scope);
        const right = this.evaluate(node.right, scope);
        return applyBinary(node.operator, left, right);
      }
    }
  }

  private arrow(node: { params: string[]; body: Node }, scope: Scope): Function {
    return (...args: unknown[]) => {
      const values = new Map<string, unknown>();
      node.params.forEach((param, index) => values.set(param, args[index]));
      return this.evaluate(node.body, new Scope(values, scope));
    };
  }

  private member(
    node: { object: Node; property: Node | string; line: number; column: number },
    scope: Scope,
  ): unknown {
    const object = this.evaluate(node.object, scope);
    const property = typeof node.property === "string"
      ? node.property
      : this.evaluate(node.property, scope);
    if (object === null || object === undefined) {
      throw new ExpressionError(
        `第 ${node.line} 行第 ${node.column} 列：不能读取空值的 ${String(property)}`,
      );
    }
    const key = typeof property === "number" ? String(property) : property;
    if (typeof key !== "string") {
      throw new ExpressionError("下标必须是字符串或数字");
    }
    if (DANGEROUS.has(key)) {
      throw new ExpressionError(`不允许访问 ${key}`);
    }
    return (object as { [key: string]: unknown })[key];
  }

  private call(
    node: { callee: Node; args: Node[]; line: number; column: number },
    scope: Scope,
  ): unknown {
    const args = node.args.map((arg) => this.evaluate(arg, scope));
    if (node.callee.kind === "identifier") {
      const name = node.callee.name;
      if (DANGEROUS.has(name)) throw new ExpressionError(`不允许调用 ${name}`);
      const global = GLOBAL_FUNCTIONS[name];
      if (global !== undefined) return global(...args);
      throw new ExpressionError(
        `第 ${node.line} 行第 ${node.column} 列：只支持对象方法调用，例如 data.items.filter(...)`,
      );
    }
    if (node.callee.kind === "arrow") {
      const callable = this.evaluate(node.callee, scope);
      return (callable as (...values: unknown[]) => unknown)(...args);
    }
    if (node.callee.kind !== "member") {
      throw new ExpressionError("只能调用成员方法");
    }
    const object = this.evaluate(node.callee.object, scope);
    const property = typeof node.callee.property === "string"
      ? node.callee.property
      : this.evaluate(node.callee.property, scope);
    if (typeof property !== "string" || DANGEROUS.has(property)) {
      throw new ExpressionError(`不允许调用 ${String(property)}`);
    }
    if (object === null || object === undefined) {
      throw new ExpressionError(
        `第 ${node.line} 行第 ${node.column} 列：不能调用空值的 ${property}`,
      );
    }
    const namespace = Object.values(GLOBAL_NAMESPACES).includes(object);
    const allowed = namespace
      ? typeof (object as { [key: string]: unknown })[property] === "function"
      : Array.isArray(object) ? ARRAY_METHODS.has(property) : STRING_METHODS.has(property);
    if (!allowed) {
      throw new ExpressionError(`不支持的方法 ${property}`);
    }
    const method = (object as { [key: string]: unknown })[property];
    if (typeof method !== "function") {
      throw new ExpressionError(`${property} 不是可调用的方法`);
    }
    return Reflect.apply(method, object, args);
  }
}

function scopeHas(scope: Scope, name: string): boolean {
  return scope.get(name) !== undefined || GLOBAL_NAMESPACES[name] !== undefined ||
    GLOBAL_FUNCTIONS[name] !== undefined;
}

function applyBinary(operator: string, left: unknown, right: unknown): unknown {
  switch (operator) {
    case "===": return left === right;
    case "!==": return left !== right;
    /* eslint-disable eqeqeq */
    case "==": return left == right;
    case "!=": return left != right;
    /* eslint-enable eqeqeq */
    case "<": return (left as number) < (right as number);
    case "<=": return (left as number) <= (right as number);
    case ">": return (left as number) > (right as number);
    case ">=": return (left as number) >= (right as number);
    case "+": return (left as number) + (right as number);
    case "-": return (left as number) - (right as number);
    case "*": return (left as number) * (right as number);
    case "/": return (left as number) / (right as number);
    case "%": return (left as number) % (right as number);
  }
  throw new ExpressionError(`不支持运算符 ${operator}`);
}

export interface Evaluation {
  value: unknown;
}

/**
 * Evaluates one expression against the current JSON. A leading `.` is shorthand
 * for `data`, so `.filter(x => x.age > 18)` works on a root array.
 */
export function evaluateExpression(source: string, root: JsonValue): Evaluation {
  let text = source.trim();
  if (text === "") throw new ExpressionError("请输入 JavaScript 表达式");
  if (text.startsWith(".")) text = `data${text}`;
  const parser = new Parser(tokenize(text));
  const node = parser.parse();
  const scope = new Scope(new Map<string, unknown>([
    ["data", root as unknown],
    ["json", root as unknown],
    ...Object.entries(GLOBAL_NAMESPACES),
  ]));
  const value = new Evaluator().evaluate(node, scope);
  if (typeof value === "function") {
    throw new ExpressionError("表达式返回了函数，而不是数据");
  }
  return { value };
}
