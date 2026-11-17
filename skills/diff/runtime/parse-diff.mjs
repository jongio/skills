// runtime/parse-diff.mjs - Pure-JS unified diff parser for the Diff canvas.
// Zero external dependencies and zero Node-only imports.

export {
  pairSplitRows,
  computeInlineWordDiff,
  tokenizeCodeLine,
  buildFileTree,
} from "./web/diff-view-model.mjs";

export const DEFAULT_MAX_PARSED_FILES = 2_000;
export const DEFAULT_MAX_LINES_PER_FILE = 25_000;

const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f-\u009f]/;
const WINDOWS_DRIVE_PREFIX_RE = /^[A-Za-z]:/;
const WINDOWS_RESERVED_SEGMENT_RE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const GIT_SHORTNAME_SEGMENT_RE = /^(?:\.git|git~[0-9]+|\.git[~.].*)$/i;

const UTF8_ENCODER = new TextEncoder();
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: false });

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

export const normalizeRepoRelativePath = normalizeCanonicalPath;

function stripHeaderPrefix(rawHeaderPath, prefix) {
  const unquoted = unquoteGitHeaderPath(rawHeaderPath.replace(/\t.*$/, ""));
  if (unquoted === "/dev/null") return "";
  if (unquoted.startsWith(`${prefix}/`)) return unquoted.slice(prefix.length + 1);
  return unquoted;
}

function scanQuotedTokenEnd(str, openQuoteIdx) {
  let i = openQuoteIdx + 1;
  while (i < str.length) {
    if (str[i] === "\\") {
      i += 2;
      continue;
    }
    if (str[i] === '"') return i;
    i += 1;
  }
  return -1;
}

function parseGitDiffPaths(line) {
  const rest = line.slice("diff --git ".length).trim();
  if (rest.startsWith('"')) {
    const endIdx = scanQuotedTokenEnd(rest, 0);
    if (endIdx > 0) {
      const first = unquoteGitHeaderPath(rest.slice(0, endIdx + 1));
      const second = unquoteGitHeaderPath(rest.slice(endIdx + 1).trim());
      return {
        oldPath: first.startsWith("a/") ? first.slice(2) : first,
        newPath: second.startsWith("b/") ? second.slice(2) : second,
      };
    }
  }
  if (!rest.startsWith('"') && rest.endsWith('"')) {
    let searchFrom = 0;
    while (searchFrom < rest.length) {
      const spaceQuoteIdx = rest.indexOf(' "', searchFrom);
      if (spaceQuoteIdx === -1) break;
      const endIdx = scanQuotedTokenEnd(rest, spaceQuoteIdx + 1);
      if (endIdx === rest.length - 1) {
        const first = unquoteGitHeaderPath(rest.slice(0, spaceQuoteIdx).trim());
        const second = unquoteGitHeaderPath(rest.slice(spaceQuoteIdx + 1));
        return {
          oldPath: first.startsWith("a/") ? first.slice(2) : first,
          newPath: second.startsWith("b/") ? second.slice(2) : second,
        };
      }
      searchFrom = spaceQuoteIdx + 2;
    }
  }
  const marker = " b/";
  if (rest.startsWith("a/") && rest.length >= 7 && (rest.length - 5) % 2 === 0) {
    const pathLen = (rest.length - 5) / 2;
    const candidate = rest.slice(2, 2 + pathLen);
    if (rest.slice(2 + pathLen) === ` b/${candidate}`) {
      return { oldPath: candidate, newPath: candidate };
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
      totalFiles: 0,
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
    fileCount: files.length,
    totalFiles: totalFilesSeen,
    additions: totalAdditions,
    deletions: totalDeletions,
    truncatedFiles,
    files,
  };
}
