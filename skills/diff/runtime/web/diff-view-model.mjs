// Browser-safe pure-JS diff view-model helpers shared by `runtime/web/app.mjs`
// and `runtime/parse-diff.mjs`. Zero external dependencies, no DOM innerHTML,
// bounded O(N) tokenization and word diffing.

const MAX_TOKENIZE_LINE_LENGTH = 1000;
const MAX_INLINE_DIFF_LINE_LENGTH = 600;
const MAX_INLINE_DIFF_TOKENS = 140;

const JS_KEYWORDS = new Set([
  "async", "await", "break", "case", "catch", "class", "const", "continue",
  "default", "delete", "do", "else", "enum", "export", "extends", "false",
  "finally", "for", "from", "function", "if", "implements", "import", "in",
  "instanceof", "interface", "let", "new", "null", "of", "private",
  "protected", "public", "readonly", "return", "static", "super", "switch",
  "this", "throw", "true", "try", "type", "typeof", "undefined", "var",
  "void", "while", "with", "yield",
]);

const PY_KEYWORDS = new Set([
  "False", "None", "True", "and", "as", "assert", "async", "await", "break",
  "class", "continue", "def", "del", "elif", "else", "except", "finally",
  "for", "from", "global", "if", "import", "in", "is", "lambda", "nonlocal",
  "not", "or", "pass", "raise", "return", "self", "try", "while", "with",
  "yield",
]);

const GO_KEYWORDS = new Set([
  "break", "case", "chan", "const", "continue", "default", "defer", "else",
  "fallthrough", "false", "for", "func", "go", "goto", "if", "import",
  "interface", "map", "nil", "package", "range", "return", "select",
  "struct", "switch", "true", "type", "var",
]);

const RUST_KEYWORDS = new Set([
  "Self", "as", "async", "await", "break", "const", "continue", "crate",
  "dyn", "else", "enum", "extern", "false", "fn", "for", "if", "impl", "in",
  "let", "loop", "match", "mod", "move", "mut", "pub", "ref", "return",
  "self", "static", "struct", "super", "trait", "true", "type", "unsafe",
  "use", "where", "while",
]);

const SH_KEYWORDS = new Set([
  "case", "do", "done", "elif", "else", "esac", "export", "fi", "for",
  "function", "if", "in", "local", "return", "then", "until", "while",
]);

const SQL_KEYWORDS = new Set([
  "ADD", "ALL", "ALTER", "AND", "AS", "ASC", "BETWEEN", "BY", "CASE",
  "CREATE", "DELETE", "DESC", "DISTINCT", "DROP", "ELSE", "END", "EXISTS",
  "FROM", "GROUP", "HAVING", "IN", "INDEX", "INNER", "INSERT", "INTO", "IS",
  "JOIN", "LEFT", "LIKE", "LIMIT", "NOT", "NULL", "ON", "OR", "ORDER",
  "OUTER", "PRIMARY", "REFERENCES", "RIGHT", "SELECT", "SET", "TABLE",
  "THEN", "UNION", "UNIQUE", "UPDATE", "VALUES", "VIEW", "WHEN", "WHERE",
]);

const JSON_KEYWORDS = new Set(["true", "false", "null"]);
const YAML_KEYWORDS = new Set(["true", "false", "null", "True", "False", "NULL"]);
const CSS_KEYWORDS = new Set(["important", "inherit", "initial", "unset", "var", "calc"]);

const LANGUAGE_KEYWORDS = {
  js: JS_KEYWORDS,
  py: PY_KEYWORDS,
  go: GO_KEYWORDS,
  rust: RUST_KEYWORDS,
  sh: SH_KEYWORDS,
  sql: SQL_KEYWORDS,
  json: JSON_KEYWORDS,
  yaml: YAML_KEYWORDS,
  css: CSS_KEYWORDS,
};

function isLanguageKeyword(language, word) {
  if (language === "sql") {
    return SQL_KEYWORDS.has(word.toUpperCase());
  }
  const table = LANGUAGE_KEYWORDS[language];
  return Boolean(table && table.has(word));
}

function isIdentStart(ch) {
  const c = ch.charCodeAt(0);
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 36;
}

function isIdentPart(ch) {
  const c = ch.charCodeAt(0);
  return (
    (c >= 65 && c <= 90) ||
    (c >= 97 && c <= 122) ||
    (c >= 48 && c <= 57) ||
    c === 95 ||
    c === 36
  );
}

function isDigit(ch) {
  const c = ch.charCodeAt(0);
  return c >= 48 && c <= 57;
}

export function pairSplitRows(lines) {
  if (!Array.isArray(lines)) return [];
  const rows = [];
  let idx = 0;

  while (idx < lines.length) {
    const line = lines[idx];
    if (line.type === "context") {
      rows.push({ kind: "pair", left: line, right: line });
      idx += 1;
      continue;
    }
    if (line.type === "meta") {
      rows.push({ kind: "meta", text: line.text });
      idx += 1;
      continue;
    }

    const deletions = [];
    const additions = [];
    while (idx < lines.length && lines[idx].type === "del") {
      deletions.push(lines[idx]);
      idx += 1;
    }
    while (idx < lines.length && lines[idx].type === "add") {
      additions.push(lines[idx]);
      idx += 1;
    }

    const pairCount = Math.max(deletions.length, additions.length);
    for (let p = 0; p < pairCount; p += 1) {
      const left = deletions[p] ?? null;
      const right = additions[p] ?? null;
      const inlineDiff =
        left && right ? computeInlineWordDiff(left.text, right.text) : null;
      rows.push({
        kind: "pair",
        left,
        right,
        leftSegments: inlineDiff ? inlineDiff.left : null,
        rightSegments: inlineDiff ? inlineDiff.right : null,
      });
    }
  }

  return rows;
}

function splitWordTokens(text) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (isIdentPart(ch)) {
      let j = i + 1;
      while (j < text.length && isIdentPart(text[j])) j += 1;
      out.push(text.slice(i, j));
      i = j;
    } else if (ch === " " || ch === "\t") {
      let j = i + 1;
      while (j < text.length && (text[j] === " " || text[j] === "\t")) j += 1;
      out.push(text.slice(i, j));
      i = j;
    } else {
      const cp = text.codePointAt(i);
      const step = cp !== undefined && cp > 0xffff ? 2 : 1;
      out.push(text.slice(i, i + step));
      i += step;
    }
  }
  return out;
}

export function computeInlineWordDiff(oldText, newText) {
  if (
    typeof oldText !== "string" ||
    typeof newText !== "string" ||
    oldText === newText ||
    oldText.length > MAX_INLINE_DIFF_LINE_LENGTH ||
    newText.length > MAX_INLINE_DIFF_LINE_LENGTH
  ) {
    return null;
  }

  const a = splitWordTokens(oldText);
  const b = splitWordTokens(newText);
  if (a.length > MAX_INLINE_DIFF_TOKENS || b.length > MAX_INLINE_DIFF_TOKENS) {
    return null;
  }

  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  if (prefix === 0 && suffix === 0) {
    return null;
  }

  const leftPrefix = a.slice(0, prefix).join("");
  const leftChanged = a.slice(prefix, a.length - suffix).join("");
  const leftSuffix = suffix > 0 ? a.slice(a.length - suffix).join("") : "";

  const rightPrefix = b.slice(0, prefix).join("");
  const rightChanged = b.slice(prefix, b.length - suffix).join("");
  const rightSuffix = suffix > 0 ? b.slice(b.length - suffix).join("") : "";

  const left = [];
  if (leftPrefix) left.push({ text: leftPrefix, changed: false });
  if (leftChanged) left.push({ text: leftChanged, changed: true });
  if (leftSuffix) left.push({ text: leftSuffix, changed: false });

  const right = [];
  if (rightPrefix) right.push({ text: rightPrefix, changed: false });
  if (rightChanged) right.push({ text: rightChanged, changed: true });
  if (rightSuffix) right.push({ text: rightSuffix, changed: false });

  return { left, right };
}

export function tokenizeCodeLine(text, language = "text") {
  const str = String(text ?? "");
  if (!str || language === "text" || str.length > MAX_TOKENIZE_LINE_LENGTH) {
    return [{ kind: "plain", text: str }];
  }

  const tokens = [];
  let plainBuf = "";
  const flushPlain = () => {
    if (plainBuf) {
      tokens.push({ kind: "plain", text: plainBuf });
      plainBuf = "";
    }
  };

  let i = 0;
  const len = str.length;
  while (i < len) {
    const ch = str[i];
    const next = i + 1 < len ? str[i + 1] : "";

    if (
      (language === "js" || language === "go" || language === "rust" || language === "css") &&
      ch === "/" &&
      next === "/"
    ) {
      flushPlain();
      tokens.push({ kind: "comment", text: str.slice(i) });
      break;
    }
    if (
      (language === "py" || language === "sh" || language === "yaml") &&
      ch === "#" &&
      (i === 0 || str[i - 1] === " " || str[i - 1] === "\t")
    ) {
      flushPlain();
      tokens.push({ kind: "comment", text: str.slice(i) });
      break;
    }

    if (
      ch === '"' ||
      (language !== "json" && ch === "'") ||
      (language === "js" && ch === "`")
    ) {
      flushPlain();
      const quote = ch;
      let j = i + 1;
      while (j < len) {
        if (str[j] === "\\") {
          j += 2;
          continue;
        }
        if (str[j] === quote) {
          j += 1;
          break;
        }
        j += 1;
      }
      let tokenKind = "string";
      if (language === "json" && quote === '"') {
        let k = j;
        while (k < len && (str[k] === " " || str[k] === "\t")) {
          k += 1;
        }
        if (str[k] === ":") {
          tokenKind = "property";
        }
      }
      tokens.push({ kind: tokenKind, text: str.slice(i, j) });
      i = j;
      continue;
    }

    if (isDigit(ch)) {
      flushPlain();
      let j = i + 1;
      while (
        j < len &&
        (isDigit(str[j]) ||
          str[j] === "." ||
          str[j] === "_" ||
          str[j] === "x" ||
          str[j] === "X" ||
          (str[j] >= "a" && str[j] <= "f") ||
          (str[j] >= "A" && str[j] <= "F"))
      ) {
        j += 1;
      }
      tokens.push({ kind: "number", text: str.slice(i, j) });
      i = j;
      continue;
    }

    if (isIdentStart(ch)) {
      let j = i + 1;
      while (j < len && isIdentPart(str[j])) j += 1;
      const word = str.slice(i, j);
      if (isLanguageKeyword(language, word)) {
        flushPlain();
        tokens.push({ kind: "keyword", text: word });
      } else {
        plainBuf += word;
      }
      i = j;
      continue;
    }

    plainBuf += ch;
    i += 1;
  }

  flushPlain();
  return tokens;
}

export function buildFileTree(files) {
  const root = new Map();
  if (!Array.isArray(files)) return [];

  for (const file of files) {
    const pathText = String(file?.canonicalPath || file?.displayPath || "");
    if (!pathText) continue;
    const parts = pathText.split("/").filter(Boolean);
    if (parts.length === 0) continue;

    let cursor = root;
    let prefix = "";
    for (let i = 0; i < parts.length - 1; i += 1) {
      const seg = parts[i];
      const dirKey = `dir:${seg}`;
      prefix = prefix ? `${prefix}/${seg}` : seg;
      let existing = cursor.get(dirKey);
      if (!existing) {
        existing = { kind: "dir", name: seg, path: prefix, childrenMap: new Map() };
        cursor.set(dirKey, existing);
      }
      cursor = existing.childrenMap;
    }

    const leaf = parts[parts.length - 1];
    cursor.set(`file:${file.index ?? pathText}:${leaf}`, {
      kind: "file",
      name: leaf,
      path: pathText,
      file,
    });
  }

  function serializeMap(map) {
    const items = [];
    for (const entry of map.values()) {
      if (entry.kind === "dir") {
        let dirEntry = entry;
        while (dirEntry.childrenMap.size === 1) {
          const [onlyChild] = dirEntry.childrenMap.values();
          if (onlyChild.kind !== "dir") break;
          dirEntry = {
            kind: "dir",
            name: `${dirEntry.name}/${onlyChild.name}`,
            path: onlyChild.path,
            childrenMap: onlyChild.childrenMap,
          };
        }
        items.push({
          kind: "dir",
          name: dirEntry.name,
          path: dirEntry.path,
          children: serializeMap(dirEntry.childrenMap),
        });
      } else {
        items.push(entry);
      }
    }

    items.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return items;
  }

  return serializeMap(root);
}
