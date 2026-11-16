// Browser-safe pure-JS diff view-model helpers shared by `runtime/web/app.mjs`
// and `scripts/parse-diff.mjs`. Zero external dependencies, no DOM innerHTML,
// bounded O(N) tokenization and word diffing.

const MAX_TOKENIZE_LINE_LENGTH = 1000;
const MAX_INLINE_DIFF_LINE_LENGTH = 600;
const MAX_INLINE_DIFF_TOKENS = 140;

const COMMON_KEYWORDS = new Set([
  "async", "await", "break", "case", "catch", "class", "const", "continue",
  "def", "default", "delete", "do", "elif", "else", "enum", "export", "extends",
  "false", "finally", "fn", "for", "from", "func", "function", "if", "impl",
  "import", "in", "interface", "let", "match", "mut", "new", "nil", "None",
  "null", "package", "private", "protected", "pub", "public", "readonly",
  "return", "self", "static", "struct", "super", "switch", "this", "throw",
  "trait", "true", "True", "False", "try", "type", "typeof", "undefined",
  "use", "var", "void", "where", "while", "with", "yield",
]);

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
      out.push(ch);
      i += 1;
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
      ch === "#"
    ) {
      flushPlain();
      tokens.push({ kind: "comment", text: str.slice(i) });
      break;
    }

    if (ch === '"' || ch === "'" || (language === "js" && ch === "`")) {
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
      tokens.push({ kind: "string", text: str.slice(i, j) });
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
      if (COMMON_KEYWORDS.has(word)) {
        flushPlain();
        tokens.push({ kind: "keyword", text: word });
      } else if (language === "json" && str[j] === ":") {
        flushPlain();
        tokens.push({ kind: "property", text: word });
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
    const pathText = String(file?.canonicalPath || file?.displayPath || "").trim();
    if (!pathText) continue;
    const parts = pathText.split("/").filter(Boolean);
    if (parts.length === 0) continue;

    let cursor = root;
    let prefix = "";
    for (let i = 0; i < parts.length - 1; i += 1) {
      const seg = parts[i];
      prefix = prefix ? `${prefix}/${seg}` : seg;
      let existing = cursor.get(seg);
      if (!existing || existing.kind !== "dir") {
        existing = { kind: "dir", name: seg, path: prefix, childrenMap: new Map() };
        cursor.set(seg, existing);
      }
      cursor = existing.childrenMap;
    }

    const leaf = parts[parts.length - 1];
    cursor.set(`file:${leaf}:${file.index ?? pathText}`, {
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
