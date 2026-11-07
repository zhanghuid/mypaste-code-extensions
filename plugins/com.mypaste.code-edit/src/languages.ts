/**
 * The editor's language table. The package owns it: MyPaste does not hand a
 * surface page its language list (D-1040), so the words, the tokens and
 * the detection heuristics all live here and reach the document only through
 * an update of this package.
 */

import type { CodeLanguage } from "./tokenize";

export interface LanguageChoice {
  value: CodeLanguage | "auto" | "text";
  label: string;
}

/** The select's fixed order: automatic first, plain text last. */
export const LANGUAGE_CHOICES: readonly LanguageChoice[] = [
  { value: "auto", label: "自动识别" },
  { value: "go", label: "Go" },
  { value: "javascript", label: "JavaScript" },
  { value: "typescript", label: "TypeScript" },
  { value: "python", label: "Python" },
  { value: "rust", label: "Rust" },
  { value: "php", label: "PHP" },
  { value: "html", label: "HTML" },
  { value: "css", label: "CSS" },
  { value: "json", label: "JSON" },
  { value: "yaml", label: "YAML" },
  { value: "sql", label: "SQL" },
  { value: "shell", label: "Shell" },
  { value: "text", label: "纯文本" },
];

export function languageLabel(language: CodeLanguage | null): string {
  if (!language) return "纯文本";
  return LANGUAGE_CHOICES.find((choice) => choice.value === language)?.label ??
    language;
}

function looksLikeJSON(value: string): boolean {
  const first = value[0];
  if (first !== "{" && first !== "[") return false;
  try {
    JSON.parse(value);
    return true;
  } catch {
    // Detection reads only a bounded prefix, so a large payload may be cut
    // before JSON.parse can finish; quoted object keys still signal JSON.
    return /^[\{\[]/.test(value) && /"[^"\n]+"\s*:/.test(value);
  }
}

/**
 * detectLanguage reads at most 8,000 characters. A shebang is an explicit
 * declaration and outranks the body heuristics; everything else is a guess
 * the user can correct in the select.
 */
export function detectLanguage(value: string): CodeLanguage | null {
  const candidate = value.trim().slice(0, 8_000);
  if (candidate.length < 12) return null;

  if (looksLikeJSON(candidate)) return "json";
  if (/<!doctype\s+html/i.test(candidate)) return "html";
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
  if (
    /<\?php\b/i.test(candidate) ||
    (/(^|\n)\s*(?:namespace|use)\s+[A-Za-z_\\]/.test(candidate) &&
      /\$[A-Za-z_]\w*/.test(candidate))
  ) {
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
    /(^|\n)\s*(?:def|class)\s+[A-Za-z_]\w*\s*[(:]/.test(candidate) ||
    /(^|\n)\s*(?:from\s+[\w.]+\s+import|import\s+[\w.]+)/.test(candidate) ||
    /(^|\n)\s*@[A-Za-z_]\w*/.test(candidate)
  ) {
    return "python";
  }
  if (
    /(^|\n)\s*(?:[.#]?[A-Za-z][\w-]*\s*\{|@media\b|@supports\b)/.test(candidate) &&
    /[,{]\s*(?:color|background|display|margin|padding|font|border|width|height)\b/
      .test(candidate)
  ) {
    return "css";
  }
  if (/(^|\n)\s*[\w.-]+\s*:\s*(?:$|[^\n]*\n\s+\S)/.test(candidate)) return "yaml";
  if (/<[A-Za-z][^>]*>/.test(candidate)) return "html";
  return null;
}
