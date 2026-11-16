// Pure-JS isomorphic unified diff parser, split-row pairer, word-diff helper,
// and bounded linear-time syntax tokenizer. Zero Node-only imports so both
// server/CLI modules and browser Preact views can share identical logic.

export const DEFAULT_MAX_PARSED_FILES = 2_000;
export const DEFAULT_MAX_LINES_PER_FILE = 25_000;
export const MAX_TOKENIZE_LINE_CHARS = 1_000;
export const MAX_WORD_DIFF_CHARS = 400;

const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f-\u009f]/;
const WINDOWS_DRIVE_PREFIX_RE = /^[A-Za-z]:/;
const WINDOWS_RESERVED_SEGMENT_RE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const GIT_SHORTNAME_SEGMENT_RE = /^(?:\.git|git~[0-9]+|\.git[~.].*)$/i;

const UTF8_ENCODER = new TextEncoder();
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: false });

export const normalizeRepoRelativePath = normalizeCanonicalPath;

export function unquoteGitHeaderPath(raw) {
  if (typeof raw !== "string") return "";
  const trimmed = raw.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    const inner = trimmed.slice(1, -1);
    const bytes = [];
    for (let i = 0; i < inner.length; i += 1) {
      const ch = inner[i];
      if (ch !== "\\") {
        const encoded = UTF8_ENCODER.encode(ch);
        for (let b = 0; b < encoded.length; b += 1) bytes.push(encoded[b]);
        continue;
      }
      const next = inner[i + 1];
      if (next === undefined) {
        bytes.push(0x5c);
        break;
      }
      if (next >= "0" && next <= "7") {
        let octal = next;
        let step = 1;
        while (step < 3 && inner[i + 1 + step] >= "0" && inner[i + 1 + step] <= "7") {
          octal += inner[i + 1 + step];
          step += 1;
        }
        bytes.push(Number.parseInt(octal, 8) & 0xff);
        i += step;
        continue;
      }
      i += 1;
      switch (next) {
        case "a": bytes.push(0x07); break;
        case "b": bytes.push(0x08); break;
        case "f": bytes.push(0x0c); break;
        case "n": bytes.push(0x0a); break;
        case "r": bytes.push(0x0d); break;
        case "t": bytes.push(0x09); break;
        case "v": bytes.push(0x0b); break;
        case "\\": bytes.push(0x5c); break;
        case '"': bytes.push(0x22); break;
        default: {
          const encoded = UTF8_ENCODER.encode(next);
          for (let b = 0; b < encoded.length; b += 1) bytes.push(encoded[b]);
          break;
        }
      }
    }
    return UTF8_DECODER.decode(new Uint8Array(bytes));
  }
  return trimmed;
}

export function normalizeCanonicalPath(rawUnquotedPath) {
  if (typeof rawUnquotedPath !== "string") return "";
  let text = rawUnquotedPath;
  if (!text || text === "/dev/null" || text.length > 4096) return "";
  if (CONTROL_CHAR_RE.test(text)) return "";
  text = text.replaceAll("\\", "/").replace(/\/{2,}/g, "/");
  if (text.startsWith("./")) text = text.slice(2);
  if (text.startsWith("/") || WINDOWS_DRIVE_PREFIX_RE.test(text)) return "";
  const segments = text.split("/");
  if (
    segments.some(
      (seg) =>
        !seg ||
        seg === "." ||
        seg === ".." ||
        GIT_SHORTNAME_SEGMENT_RE.test(seg) ||
        WINDOWS_RESERVED_SEGMENT_RE.test(seg),
    )
  ) {
    return "";
  }
  return text;
}

function stripHeaderPrefix(rawHeaderPath, prefix) {
  const unquoted = unquoteGitHeaderPath(rawHeaderPath.replace(/\t.*$/, ""));
  if (unquoted === "/dev/null") return "";
  if (unquoted.startsWith(`${prefix}/`)) return unquoted.slice(prefix.length + 1);
  return unquoted;
}

function parseGitDiffPaths(line) {
  const rest = line.slice("diff --git ".length).trim();
  if (rest.startsWith('"')) {
    let i = 1;
    while (i < rest.length) {
      if (rest[i] === "\\") {
        i += 2;
        continue;
      }
      if (rest[i] === '"') break;
      i += 1;
    }
    const first = unquoteGitHeaderPath(rest.slice(0, i + 1));
    const second = unquoteGitHeaderPath(rest.slice(i + 1).trim());
    return {
      oldPath: first.startsWith("a/") ? first.slice(2) : first,
      newPath: second.startsWith("b/") ? second.slice(2) : second,
    };
  }
  const marker = " b/";
  if (rest.startsWith("a/")) {
    const body = rest.slice(2);
    if (body.length % 2 === 1 && body[(body.length - 1) / 2] === " ") {
      const half = (body.length - 1) / 2;
      const left = body.slice(0, half);
      const right = body.slice(half + 1);
      if (right === `b/${left}`) {
        return { oldPath: left, newPath: left };
      }
    }
  }
  const splitIdx = rest.lastIndexOf(marker);
  if (splitIdx > 0) {
    const first = rest.slice(0, splitIdx);
    const second = rest.slice(splitIdx + 3);
    return {
      oldPath: first.startsWith("a/") ? first.slice(2) : first,
      newPath: second,
    };
  }
  return { oldPath: "", newPath: "" };
}

export function detectLanguageFromPath(filePath) {
  const lower = String(filePath ?? "").toLowerCase();
  const base = lower.split("/").pop() || "";
  if (base === "dockerfile" || base.startsWith("dockerfile.")) return "sh";
  const dotIdx = base.lastIndexOf(".");
  const ext = dotIdx >= 0 ? base.slice(dotIdx + 1) : "";
  switch (ext) {
    case "js":
    case "mjs":
    case "cjs":
    case "jsx":
    case "ts":
    case "mts":
    case "cts":
    case "tsx":
      return "js";
    case "json":
    case "jsonc":
      return "json";
    case "py":
      return "py";
    case "sh":
    case "bash":
    case "zsh":
    case "ps1":
      return "sh";
    case "yml":
    case "yaml":
      return "yaml";
    case "css":
    case "scss":
      return "css";
    case "html":
    case "htm":
    case "xml":
    case "svg":
    case "mdc":
    case "md":
      return "markup";
    case "go":
      return "go";
    case "rs":
      return "rust";
    case "sql":
      return "sql";
    default:
      return "text";
  }
}

export function parseDiffPatch(
  rawDiff,
  {
    maxFiles = DEFAULT_MAX_PARSED_FILES,
    maxLinesPerFile = DEFAULT_MAX_LINES_PER_FILE,
  } = {},
) {
  if (typeof rawDiff !== "string" || rawDiff.length === 0) {
    return {
      fileCount: 0,
      additions: 0,
      deletions: 0,
      truncatedFiles: false,
      files: [],
    };
  }

  const lines = rawDiff.split("\n");
  const files = [];
  let truncatedFiles = false;
  let totalFilesSeen = 0;
  let current = null;
  let currentHunk = null;
  let currentLineCount = 0;
  let oldCursor = 0;
  let newCursor = 0;
  let totalAdditions = 0;
  let totalDeletions = 0;

  const finalizeFile = () => {
    if (!current) return;
    const rawTarget = current.newPath || current.renameTo || current.oldPath || current.renameFrom || "";
    const canonicalPath = normalizeCanonicalPath(rawTarget);
    const normOld = normalizeCanonicalPath(current.oldPath || current.renameFrom || "");
    const normNew = normalizeCanonicalPath(current.newPath || current.renameTo || "");
    const displayPath =
      current.status === "renamed" && normOld && normNew && normOld !== normNew
        ? `${normOld} -> ${normNew}`
        : canonicalPath || normNew || normOld || "(invalid-path)";

    current.canonicalPath = canonicalPath;
    current.displayPath = displayPath;
    current.language = detectLanguageFromPath(canonicalPath || normNew || normOld);

    if (files.length < maxFiles) {
      current.index = files.length;
      files.push(current);
    } else {
      truncatedFiles = true;
    }
    current = null;
    currentHunk = null;
    currentLineCount = 0;
  };

  for (let idx = 0; idx < lines.length; idx += 1) {
    const rawLine = lines[idx];
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;

    if (line.startsWith("diff --git ")) {
      finalizeFile();
      totalFilesSeen += 1;
      const parsed = parseGitDiffPaths(line);
      current = {
        index: 0,
        oldPath: parsed.oldPath,
        newPath: parsed.newPath,
        renameFrom: "",
        renameTo: "",
        canonicalPath: "",
        displayPath: "",
        status: "modified",
        isBinary: false,
        language: "text",
        additions: 0,
        deletions: 0,
        truncated: false,
        hunks: [],
      };
      continue;
    }

    if (!current) continue;

    const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/);
    if (hunkMatch) {
      const oldStart = Number.parseInt(hunkMatch[1], 10);
      const oldCount = hunkMatch[2] === undefined ? 1 : Number.parseInt(hunkMatch[2], 10);
      const newStart = Number.parseInt(hunkMatch[3], 10);
      const newCount = hunkMatch[4] === undefined ? 1 : Number.parseInt(hunkMatch[4], 10);
      const section = hunkMatch[5] ? hunkMatch[5].trim() : "";
      oldCursor = oldStart;
      newCursor = newStart;
      currentHunk = {
        header: `@@ -${hunkMatch[1]}${hunkMatch[2] !== undefined ? `,${hunkMatch[2]}` : ""} +${hunkMatch[3]}${hunkMatch[4] !== undefined ? `,${hunkMatch[4]}` : ""} @@`,
        section,
        oldStart,
        oldCount,
        newStart,
        newCount,
        lines: [],
      };
      if (!current.truncated) {
        current.hunks.push(currentHunk);
      }
      continue;
    }

    if (!currentHunk) {
      if (line.startsWith("new file mode ")) {
        current.status = "added";
      } else if (line.startsWith("deleted file mode ")) {
        current.status = "deleted";
      } else if (line.startsWith("rename from ")) {
        current.status = "renamed";
        current.renameFrom = unquoteGitHeaderPath(line.slice("rename from ".length));
        current.oldPath = current.renameFrom;
      } else if (line.startsWith("rename to ")) {
        current.status = "renamed";
        current.renameTo = unquoteGitHeaderPath(line.slice("rename to ".length));
        current.newPath = current.renameTo;
      } else if (line.startsWith("Binary files ") || line === "GIT binary patch") {
        current.isBinary = true;
        if (current.status === "modified") current.status = "binary";
      } else if (line.startsWith("--- ")) {
        const stripped = stripHeaderPrefix(line.slice(4), "a");
        if (stripped) current.oldPath = stripped;
        else if (line.slice(4).trim() === "/dev/null") current.status = "added";
      } else if (line.startsWith("+++ ")) {
        const stripped = stripHeaderPrefix(line.slice(4), "b");
        if (stripped) current.newPath = stripped;
        else if (line.slice(4).trim() === "/dev/null") current.status = "deleted";
      }
      continue;
    }

    if (line.startsWith("+")) {
      current.additions += 1;
      totalAdditions += 1;
      const lineNum = newCursor;
      newCursor += 1;
      if (currentLineCount < maxLinesPerFile) {
        currentHunk.lines.push({
          type: "add",
          oldLine: null,
          newLine: lineNum,
          text: line.slice(1),
        });
        currentLineCount += 1;
      } else {
        current.truncated = true;
      }
    } else if (line.startsWith("-")) {
      current.deletions += 1;
      totalDeletions += 1;
      const lineNum = oldCursor;
      oldCursor += 1;
      if (currentLineCount < maxLinesPerFile) {
        currentHunk.lines.push({
          type: "del",
          oldLine: lineNum,
          newLine: null,
          text: line.slice(1),
        });
        currentLineCount += 1;
      } else {
        current.truncated = true;
      }
    } else if (line.startsWith(" ")) {
      const oLine = oldCursor;
      const nLine = newCursor;
      oldCursor += 1;
      newCursor += 1;
      if (currentLineCount < maxLinesPerFile) {
        currentHunk.lines.push({
          type: "context",
          oldLine: oLine,
          newLine: nLine,
          text: line.slice(1),
        });
        currentLineCount += 1;
      } else {
        current.truncated = true;
      }
    } else if (line.startsWith("\\")) {
      if (currentLineCount < maxLinesPerFile) {
        currentHunk.lines.push({
          type: "meta",
          oldLine: null,
          newLine: null,
          text: line,
        });
        currentLineCount += 1;
      }
    } else if (line === "" && idx === lines.length - 1) {
      // Trailing newline after split("\n")
    } else {
      currentHunk = null;
    }
  }

  finalizeFile();

  return {
    fileCount: totalFilesSeen,
    additions: totalAdditions,
    deletions: totalDeletions,
    truncatedFiles,
    files,
  };
}

export function computeInlineWordDiff(delText, addText) {
  if (
    typeof delText !== "string" ||
    typeof addText !== "string" ||
    delText.length === 0 ||
    addText.length === 0 ||
    delText.length > MAX_WORD_DIFF_CHARS ||
    addText.length > MAX_WORD_DIFF_CHARS ||
    delText === addText
  ) {
    return null;
  }

  let prefixLen = 0;
  const minLen = Math.min(delText.length, addText.length);
  while (prefixLen < minLen && delText.charCodeAt(prefixLen) === addText.charCodeAt(prefixLen)) {
    prefixLen += 1;
  }

  let suffixLen = 0;
  while (
    suffixLen < minLen - prefixLen &&
    delText.charCodeAt(delText.length - 1 - suffixLen) === addText.charCodeAt(addText.length - 1 - suffixLen)
  ) {
    suffixLen += 1;
  }

  // Only highlight intra-line edits when lines actually share a meaningful anchor
  if (prefixLen === 0 && suffixLen === 0) {
    return null;
  }

  return {
    left: [
      delText.slice(0, prefixLen),
      delText.slice(prefixLen, delText.length - suffixLen),
      suffixLen > 0 ? delText.slice(delText.length - suffixLen) : "",
    ],
    right: [
      addText.slice(0, prefixLen),
      addText.slice(prefixLen, addText.length - suffixLen),
      suffixLen > 0 ? addText.slice(addText.length - suffixLen) : "",
    ],
  };
}

export function pairSplitRows(hunkLines) {
  if (!Array.isArray(hunkLines) || hunkLines.length === 0) return [];
  const rows = [];
  let idx = 0;

  while (idx < hunkLines.length) {
    const item = hunkLines[idx];
    if (item.type === "context") {
      rows.push({
        kind: "pair",
        left: item,
        right: item,
        wordDiff: null,
      });
      idx += 1;
      continue;
    }

    if (item.type === "meta") {
      rows.push({
        kind: "meta",
        text: item.text,
      });
      idx += 1;
      continue;
    }

    const dels = [];
    const adds = [];
    while (idx < hunkLines.length && hunkLines[idx].type === "del") {
      dels.push(hunkLines[idx]);
      idx += 1;
    }
    while (idx < hunkLines.length && hunkLines[idx].type === "add") {
      adds.push(hunkLines[idx]);
      idx += 1;
    }
    const pairCount = Math.max(dels.length, adds.length);
    for (let k = 0; k < pairCount; k += 1) {
      const left = dels[k] ?? null;
      const right = adds[k] ?? null;
      const wordDiff = left && right ? computeInlineWordDiff(left.text, right.text) : null;
      rows.push({
        kind: "pair",
        left,
        right,
        wordDiff,
      });
    }
  }

  return rows;
}

const KEYWORDS_BY_LANG = {
  js: new Set([
    "async", "await", "break", "case", "catch", "class", "const", "continue",
    "debugger", "default", "delete", "do", "else", "enum", "export", "extends",
    "false", "finally", "for", "from", "function", "get", "if", "implements",
    "import", "in", "instanceof", "interface", "let", "new", "null", "of",
    "package", "private", "protected", "public", "readonly", "return", "set",
    "static", "super", "switch", "this", "throw", "true", "try", "type",
    "typeof", "undefined", "var", "void", "while", "yield",
  ]),
  py: new Set([
    "False", "None", "True", "and", "as", "assert", "async", "await", "break",
    "class", "continue", "def", "del", "elif", "else", "except", "finally",
    "for", "from", "global", "if", "import", "in", "is", "lambda", "nonlocal",
    "not", "or", "pass", "raise", "return", "try", "while", "with", "yield",
  ]),
  sh: new Set([
    "case", "do", "done", "elif", "else", "esac", "export", "fi", "for",
    "function", "if", "in", "local", "readonly", "return", "set", "then",
    "unset", "until", "while",
  ]),
  go: new Set([
    "break", "case", "chan", "const", "continue", "default", "defer", "else",
    "fallthrough", "false", "for", "func", "go", "goto", "if", "import",
    "interface", "map", "nil", "package", "range", "return", "select", "struct",
    "switch", "true", "type", "var",
  ]),
  rust: new Set([
    "Self", "as", "async", "await", "break", "const", "continue", "crate",
    "dyn", "else", "enum", "extern", "false", "fn", "for", "if", "impl", "in",
    "let", "loop", "match", "mod", "move", "mut", "pub", "ref", "return",
    "self", "static", "struct", "super", "trait", "true", "type", "unsafe",
    "use", "where", "while",
  ]),
  sql: new Set([
    "ADD", "ALTER", "AND", "AS", "ASC", "BY", "CASE", "CREATE", "DELETE",
    "DESC", "DISTINCT", "DROP", "ELSE", "END", "FROM", "GROUP", "HAVING", "IN",
    "INDEX", "INNER", "INSERT", "INTO", "IS", "JOIN", "LEFT", "LIMIT", "NOT",
    "NULL", "ON", "OR", "ORDER", "PRIMARY", "REFERENCES", "RIGHT", "SELECT",
    "SET", "TABLE", "THEN", "TRIGGER", "UNION", "UNIQUE", "UPDATE", "VALUES",
    "VIEW", "WHEN", "WHERE",
  ]),
  json: new Set(["true", "false", "null"]),
  yaml: new Set(["true", "false", "null", "yes", "no"]),
};

function isIdentStart(code) {
  return (
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 95 ||
    code === 36
  );
}

function isIdentPart(code) {
  return isIdentStart(code) || (code >= 48 && code <= 57);
}

function isDigit(code) {
  return code >= 48 && code <= 57;
}

// Strict linear-time O(N) tokenizer with zero backtracking regular expressions.
export function tokenizeCodeLine(text, language = "text") {
  const str = String(text ?? "");
  if (!str) return [{ kind: "plain", value: "" }];
  if (language === "text" || str.length > MAX_TOKENIZE_LINE_CHARS) {
    return [{ kind: "plain", value: str }];
  }

  const keywords = KEYWORDS_BY_LANG[language] ?? null;
  const hashComment = language === "py" || language === "sh" || language === "yaml";
  const slashComment = language === "js" || language === "go" || language === "rust" || language === "css";
  const dashComment = language === "sql";

  const tokens = [];
  let plainBuf = "";
  const flushPlain = () => {
    if (plainBuf) {
      tokens.push({ kind: "plain", value: plainBuf });
      plainBuf = "";
    }
  };

  let i = 0;
  const len = str.length;
  while (i < len) {
    const ch = str[i];
    const code = str.charCodeAt(i);

    // Line comments
    if (slashComment && ch === "/" && str[i + 1] === "/") {
      flushPlain();
      tokens.push({ kind: "cmt", value: str.slice(i) });
      break;
    }
    if (slashComment && ch === "/" && str[i + 1] === "*") {
      flushPlain();
      const endIdx = str.indexOf("*/", i + 2);
      if (endIdx === -1) {
        tokens.push({ kind: "cmt", value: str.slice(i) });
        break;
      }
      tokens.push({ kind: "cmt", value: str.slice(i, endIdx + 2) });
      i = endIdx + 2;
      continue;
    }
    if (hashComment && ch === "#") {
      flushPlain();
      tokens.push({ kind: "cmt", value: str.slice(i) });
      break;
    }
    if (dashComment && ch === "-" && str[i + 1] === "-") {
      flushPlain();
      tokens.push({ kind: "cmt", value: str.slice(i) });
      break;
    }

    // String literals
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
      const rawToken = str.slice(i, j);
      // JSON/YAML keys followed by ':'
      let afterWs = j;
      while (afterWs < len && (str[afterWs] === " " || str[afterWs] === "\t")) afterWs += 1;
      const isKey = (language === "json" || language === "yaml") && str[afterWs] === ":";
      tokens.push({ kind: isKey ? "prop" : "str", value: rawToken });
      i = j;
      continue;
    }

    // Identifiers and keywords
    if (isIdentStart(code)) {
      let j = i + 1;
      while (j < len && isIdentPart(str.charCodeAt(j))) j += 1;
      const word = str.slice(i, j);
      const lookup = language === "sql" ? word.toUpperCase() : word;
      if (keywords && keywords.has(lookup)) {
        flushPlain();
        tokens.push({ kind: "kw", value: word });
      } else if (language === "yaml" && str[j] === ":") {
        flushPlain();
        tokens.push({ kind: "prop", value: word });
      } else {
        plainBuf += word;
      }
      i = j;
      continue;
    }

    // Numbers
    if (isDigit(code)) {
      flushPlain();
      let j = i + 1;
      while (
        j < len &&
        (isDigit(str.charCodeAt(j)) ||
          str[j] === "." ||
          str[j] === "_" ||
          str[j] === "x" ||
          str[j] === "X" ||
          (str.charCodeAt(j) >= 97 && str.charCodeAt(j) <= 102) ||
          (str.charCodeAt(j) >= 65 && str.charCodeAt(j) <= 70))
      ) {
        j += 1;
      }
      tokens.push({ kind: "num", value: str.slice(i, j) });
      i = j;
      continue;
    }

    plainBuf += ch;
    i += 1;
  }

  flushPlain();
  return tokens.length > 0 ? tokens : [{ kind: "plain", value: str }];
}

// Prototype-pollution-safe Map-backed directory tree with single-child folder compaction.
export function buildFileTree(files, filterQuery = "") {
  const needle = String(filterQuery ?? "").trim().toLowerCase();
  const root = {
    kind: "dir",
    name: "",
    path: "",
    children: new Map(),
    files: [],
  };

  for (const file of files) {
    const pathKey = file.canonicalPath || file.displayPath || "";
    if (needle && !pathKey.toLowerCase().includes(needle) && !String(file.displayPath ?? "").toLowerCase().includes(needle)) {
      continue;
    }
    const segments = pathKey.split("/").filter(Boolean);
    if (segments.length === 0) {
      root.files.push({ kind: "file", name: file.displayPath || "(file)", file });
      continue;
    }
    let cursor = root;
    let builtPath = "";
    for (let i = 0; i < segments.length - 1; i += 1) {
      const seg = segments[i];
      builtPath = builtPath ? `${builtPath}/${seg}` : seg;
      let child = cursor.children.get(seg);
      if (!child) {
        child = {
          kind: "dir",
          name: seg,
          path: builtPath,
          children: new Map(),
          files: [],
        };
        cursor.children.set(seg, child);
      }
      cursor = child;
    }
    cursor.files.push({
      kind: "file",
      name: segments[segments.length - 1],
      file,
    });
  }

  function compactDir(node) {
    const subdirs = [];
    for (const child of node.children.values()) {
      let current = child;
      while (current.children.size === 1 && current.files.length === 0) {
        const [onlyNext] = current.children.values();
        current = {
          kind: "dir",
          name: `${current.name}/${onlyNext.name}`,
          path: onlyNext.path,
          children: onlyNext.children,
          files: onlyNext.files,
        };
      }
      subdirs.push(compactDir(current));
    }
    subdirs.sort((a, b) => a.name.localeCompare(b.name));
    const sortedFiles = [...node.files].sort((a, b) => a.name.localeCompare(b.name));
    return {
      kind: "dir",
      name: node.name,
      path: node.path,
      subdirs,
      files: sortedFiles,
    };
  }

  return compactDir(root);
}
