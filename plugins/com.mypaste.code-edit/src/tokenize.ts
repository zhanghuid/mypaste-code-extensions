/**
 * The editor's syntax tokenizer: comments, strings, numbers, identifiers and
 * keywords, one pass over the source. It returns tokens rather than HTML; the
 * document escapes every token before it becomes a span, and nothing here
 * touches the DOM.
 */

export type CodeLanguage =
  | "css"
  | "go"
  | "html"
  | "javascript"
  | "json"
  | "php"
  | "python"
  | "rust"
  | "shell"
  | "sql"
  | "typescript"
  | "yaml";

export interface CodeToken {
  text: string;
  kind: string;
}

/**
 * The twelve languages this editor can highlight, one keyword list each. The
 * package owns its own table: it shares nothing with the MyPaste host or the
 * other surface packages, so a language added elsewhere reaches this
 * page only by an update here.
 */
const KEYWORDS: Record<CodeLanguage, ReadonlySet<string>> = {
  css: new Set(["important", "media", "supports"]),
  go: new Set([
    "break", "case", "chan", "const", "continue", "default", "defer", "else",
    "fallthrough", "for", "func", "go", "goto", "if", "import", "interface",
    "map", "package", "range", "return", "select", "struct", "switch", "type",
    "var",
  ]),
  html: new Set(),
  javascript: new Set([
    "async", "await", "break", "case", "catch", "class", "const", "continue",
    "default", "delete", "do", "else", "export", "extends", "finally", "for",
    "from", "function", "if", "import", "in", "instanceof", "let", "new",
    "of", "return", "static", "super", "switch", "throw", "try", "typeof",
    "var", "void", "while", "with", "yield",
  ]),
  json: new Set(),
  php: new Set([
    "abstract", "and", "array", "as", "break", "callable", "case", "catch",
    "class", "clone", "const", "continue", "declare", "default", "do", "echo",
    "else", "elseif", "empty", "enddeclare", "endfor", "endforeach", "endif",
    "endswitch", "endwhile", "enum", "extends", "final", "finally", "fn", "for",
    "foreach", "function", "global", "goto", "if", "implements", "include",
    "include_once", "instanceof", "insteadof", "interface", "isset", "list",
    "match", "namespace", "new", "or", "print", "private", "protected", "public",
    "readonly", "require", "require_once", "return", "static", "switch", "throw",
    "trait", "try", "unset", "use", "var", "while", "xor", "yield",
  ]),
  rust: new Set([
    "as", "async", "await", "break", "const", "continue", "crate", "dyn",
    "else", "enum", "extern", "false", "fn", "for", "if", "impl", "in",
    "let", "loop", "match", "mod", "move", "mut", "pub", "ref", "return",
    "self", "Self", "static", "struct", "super", "trait", "true", "type",
    "unsafe", "use", "where", "while",
  ]),
  python: new Set([
    "and", "as", "assert", "async", "await", "break", "class", "continue",
    "def", "del", "elif", "else", "except", "finally", "for", "from", "global",
    "if", "import", "in", "is", "lambda", "nonlocal", "not", "or", "pass",
    "raise", "return", "try", "while", "with", "yield",
  ]),
  shell: new Set([
    "case", "do", "done", "elif", "else", "esac", "export", "fi", "for",
    "function", "if", "in", "local", "readonly", "select", "then", "until",
    "while",
  ]),
  sql: new Set([
    "add", "alter", "and", "as", "asc", "begin", "by", "case", "commit",
    "create", "delete", "desc", "distinct", "drop", "else", "end", "exists",
    "from", "group", "having", "in", "index", "insert", "into", "join", "limit",
    "not", "null", "offset", "on", "or", "order", "primary", "references",
    "select", "set", "table", "then", "union", "unique", "update", "values",
    "when", "where", "with",
  ]),
  typescript: new Set([
    "abstract", "any", "as", "async", "await", "boolean", "break", "case",
    "catch", "class", "const", "continue", "declare", "default", "delete", "do",
    "else", "enum", "export", "extends", "finally", "for", "from", "function",
    "if", "implements", "import", "in", "infer", "instanceof", "interface",
    "keyof", "let", "namespace", "never", "new", "number", "of", "private",
    "protected", "public", "readonly", "return", "satisfies", "static",
    "string", "super", "switch", "throw", "try", "type", "typeof", "unknown",
    "var", "void", "while", "yield",
  ]),
  yaml: new Set(["false", "null", "true"]),
};

/** isCodeLanguage reads the keyword table rather than a second list. */
export function isCodeLanguage(value: string): value is CodeLanguage {
  return Object.hasOwn(KEYWORDS, value);
}

const LITERALS = new Set([
  "false", "nil", "null", "none", "true", "undefined",
]);

function looksLikeJSON(value: string): boolean {
  const first = value[0];
  if (first !== "{" && first !== "[") return false;
  try {
    JSON.parse(value);
    return true;
  } catch {
    // Detection intentionally reads only a bounded prefix. Large object or
    // array payloads may therefore be truncated before JSON.parse can finish;
    // quoted object keys still provide a strong, cheap format signal.
    return /^[\{\[]/.test(value) && /"[^"\n]+"\s*:/.test(value);
  }
}

export function detectCodeLanguage(value: string): CodeLanguage | null {
  const candidate = value.trim().slice(0, 8_000);
  if (candidate.length < 12) return null;

  if (looksLikeJSON(candidate)) return "json";
  if (/<!doctype\s+html/i.test(candidate)) return "html";
  // A shebang is an explicit declaration and outranks body heuristics: a
  // Python script full of `=` and `()` used to be read as JavaScript.
  if (/^#!.*\bpython[0-9.]*\b/.test(candidate)) return "python";
  if (/^#!.*\bnode\b/.test(candidate)) return "javascript";
  if (/(^|\n)\s*(?:package\s+\w+|func\s+\w+\s*\(|\w+\s*:=\s*)/.test(candidate)) {
    return "go";
  }
  if (
    /(^|\n)\s*(?:select|insert\s+into|update\s+\w+\s+set|delete\s+from|create\s+(?:table|index)|alter\s+table|pragma)\b/i
      .test(candidate)
  ) {
    return "sql";
  }
  if (/^#!\s*\/(?:usr\/bin\/env\s+)?(?:ba|z|k)?sh\b/m.test(candidate)) {
    return "shell";
  }
  if (/<\?php\b/i.test(candidate) || /(^|\n)\s*(?:namespace|use)\s+[A-Za-z_\\]/.test(candidate) && /\$[A-Za-z_]\w*/.test(candidate)) {
    return "php";
  }
  if (
    /(^|\n)\s*(?:pub\s+)?(?:fn|struct|enum|trait|impl)\s+[A-Za-z_]\w*/.test(candidate) ||
    /(^|\n)\s*use\s+[A-Za-z_]\w*(?:::\w+)+/.test(candidate)
  ) {
    return "rust";
  }
  if (
    /(^|\n)\s*(?:interface|type)\s+[A-Za-z_$]\w*[\s<{]/.test(candidate) ||
    /(^|\n)\s*(?:const|let|var)\s+[A-Za-z_$]\w*\s*:\s*[A-Za-z{[(]/.test(candidate) ||
    /\b(?:implements|keyof|readonly|satisfies)\b/.test(candidate)
  ) {
    return "typescript";
  }
  if (
    /(^|\n)\s*(?:const|let|var)\s+[A-Za-z_$]\w*\s*=/.test(candidate) ||
    /\b(?:function|class)\s+[A-Za-z_$]\w*/.test(candidate) ||
    /=>\s*[{(]?/.test(candidate) ||
    /\b(?:console\.(?:log|warn|error)|document\.|window\.)/.test(candidate)
  ) {
    return "javascript";
  }
  if (
    /(^|\n)\s*(?:def\s+\w+\s*\(|class\s+\w+(?:\([^)]*\))?\s*:|from\s+\S+\s+import\s+|import\s+\w+)/.test(candidate) ||
    /(^|\n)\s*if\s+.+:\s*(?:\n|$)/.test(candidate)
  ) {
    return "python";
  }
  if (
    /(^|\n)\s*(?:\$|sudo|brew|git|npm|pnpm|bun|go|curl|docker|kubectl)\s+[^\n]+/.test(candidate) ||
    /(^|\n)\s*(?:set\s+-[a-z]+|export\s+\w+=)/.test(candidate)
  ) {
    return "shell";
  }
  if (
    /(?:^|\n)\s*[.#]?[A-Za-z][^{}\n]*\{[^{}]*\n?[^{}]*:[^{}]+;/.test(candidate) &&
    (candidate.match(/[a-z-]+\s*:\s*[^;{}]+;/gi)?.length ?? 0) >= 2
  ) {
    return "css";
  }
  const lines = candidate.split("\n").filter((line) => line.trim() !== "");
  const yamlKeys = lines.filter((line) =>
    /^\s*(?:-\s*)?[A-Za-z_][\w.-]*\s*:\s*(?:.+)?$/.test(line)
  );
  if (
    lines.length >= 3 &&
    yamlKeys.length >= 3 &&
    yamlKeys.length / lines.length >= 0.6 &&
    !/[;{}]/.test(candidate)
  ) {
    return "yaml";
  }
  if ((candidate.match(/<\/?[a-z][\w:-]*(?:\s[^>]*)?>/gi)?.length ?? 0) >= 2) {
    return "html";
  }
  return null;
}

function commentStart(source: string, index: number, language: CodeLanguage): number {
  const pair = source.slice(index, index + 2);
  if (pair === "/*") {
    if (language === "json" || language === "html" || language === "shell" ||
        language === "python" || language === "yaml") {
      return 0;
    }
    const end = source.indexOf("*/", index + 2);
    return end < 0 ? source.length : end + 2;
  }
  if (pair === "//") {
    if (language === "json" || language === "sql" || language === "css" ||
        language === "html" || language === "shell" || language === "python" ||
        language === "yaml" || language === "php") {
      return 0;
    }
    const end = source.indexOf("\n", index + 2);
    return end < 0 ? source.length : end;
  }
  if (pair === "--" && language === "sql") {
    const end = source.indexOf("\n", index + 2);
    return end < 0 ? source.length : end;
  }
  if (source[index] === "#" &&
      (language === "shell" || language === "python" || language === "yaml" ||
        language === "php" || language === "rust")) {
    const end = source.indexOf("\n", index + 1);
    return end < 0 ? source.length : end;
  }
  if (source.startsWith("<!--", index) && language === "html") {
    const end = source.indexOf("-->", index + 4);
    return end < 0 ? source.length : end + 3;
  }
  return 0;
}

function stringEnd(source: string, index: number, language: CodeLanguage): number {
  const quote = source[index];
  if (quote !== '"' && quote !== "'" && quote !== "`") return 0;
  if (language === "json" && quote !== '"') return 0;
  let cursor = index + 1;
  while (cursor < source.length) {
    if (source[cursor] === "\\") {
      cursor += 2;
      continue;
    }
    if (source[cursor] === quote) return cursor + 1;
    cursor += 1;
  }
  return source.length;
}

function classifyIdentifier(
  source: string,
  start: number,
  end: number,
  language: CodeLanguage,
): string {
  const word = source.slice(start, end);
  const normalized = word.toLowerCase();
  if (KEYWORDS[language].has(normalized)) return "keyword";
  if (LITERALS.has(normalized)) return "literal";
  let next = end;
  while (next < source.length && /\s/.test(source[next] ?? "")) next += 1;
  const nextChar = source[next] ?? "";
  if (
    nextChar === ":" &&
    (language === "json" || language === "yaml" || language === "css" ||
      language === "javascript" || language === "typescript" || language === "php")
  ) {
    return "property";
  }
  if (language === "html" && nextChar === "=") return "property";
  if (nextChar === "(") return "function";
  if (
    (language === "typescript" || language === "javascript") &&
    /^[A-Z]/.test(word)
  ) {
    return "type";
  }
  return "";
}

function highlightHTMLTag(
  source: string,
  index: number,
): { tokens: CodeToken[]; end: number } | null {
  const match = /^<\/?([A-Za-z][\w:-]*)/.exec(source.slice(index));
  if (!match) return null;
  const prefixLength = match[0].startsWith("</") ? 2 : 1;
  const prefix = source.slice(index, index + prefixLength);
  return {
    tokens: [
      { text: prefix, kind: "" },
      { text: match[1] ?? "", kind: "tag" },
    ],
    end: index + match[0].length,
  };
}

// tokenizeCode is the one highlighter this document uses, so the live editor
// and every re-render read the same token stream.
export function tokenizeCode(source: string, language: CodeLanguage): CodeToken[] {
  const tokens: CodeToken[] = [];
  let emitted = 0;
  let cursor = 0;
  const emit = (text: string, kind = "") => {
    if (text) tokens.push({ text, kind });
  };
  while (cursor < source.length) {
    let end = commentStart(source, cursor, language);
    let kind = end > cursor ? "comment" : "";

    if (!kind) {
      end = stringEnd(source, cursor, language);
      if (end > cursor) kind = "string";
    }
    if (!kind) {
      const match = /^(?:0x[\da-f]+|\d+(?:\.\d+)?(?:e[+-]?\d+)?)/i.exec(
        source.slice(cursor),
      );
      if (match) {
        end = cursor + match[0].length;
        kind = "number";
      }
    }
    if (!kind && language === "html" && source[cursor] === "<") {
      const tag = highlightHTMLTag(source, cursor);
      if (tag) {
        emit(source.slice(emitted, cursor));
        for (const token of tag.tokens) emit(token.text, token.kind);
        emitted = tag.end;
        cursor = tag.end;
        continue;
      }
    }
    if (!kind) {
      const match = /^[A-Za-z_$][\w$-]*/.exec(source.slice(cursor));
      if (match) {
        end = cursor + match[0].length;
        kind = classifyIdentifier(source, cursor, end, language);
      }
    }
    if (!kind) {
      cursor += 1;
      continue;
    }

    emit(source.slice(emitted, cursor));
    emit(source.slice(cursor, end), kind);
    emitted = end;
    cursor = end;
  }
  emit(source.slice(emitted));
  return tokens;
}
