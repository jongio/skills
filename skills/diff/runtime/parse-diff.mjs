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
const MNEMONIC_SRC_PREFIXES = new Set(["a", "i", "c", "w", "o"]);
const MNEMONIC_DST_PREFIXES = new Set(["b", "i", "c", "w", "o"]);

export function unquoteGitHeaderPath(raw) {
  if (typeof raw !== "string" || raw.length === 0) return "";
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
    const endIdx = scanQuotedTokenEnd(raw, 0);
    if (endIdx === raw.length - 1) {
      const inner = raw.slice(1, -1);
      const bytes = [];
      for (let i = 0; i < inner.length; ) {
        const cp = inner.codePointAt(i);
        const stepChars = cp > 0xffff ? 2 : 1;
        const ch = String.fromCodePoint(cp);
        if (ch !== "\\") {
          const encoded = UTF8_ENCODER.encode(ch);
          for (let b = 0; b < encoded.length; b += 1) bytes.push(encoded[b]);
          i += stepChars;
          continue;
        }
        if (i + 1 >= inner.length) {
          bytes.push(0x5c);
          break;
        }
        const nextUnit = inner[i + 1];
        if (nextUnit >= "0" && nextUnit <= "7") {
          let octal = nextUnit;
          let step = 1;
          while (step < 3 && inner[i + 1 + step] >= "0" && inner[i + 1 + step] <= "7") {
            octal += inner[i + 1 + step];
            step += 1;
          }
          bytes.push(Number.parseInt(octal, 8) & 0xff);
          i += 1 + step;
          continue;
        }
        const nextCp = inner.codePointAt(i + 1);
        const nextChars = nextCp > 0xffff ? 2 : 1;
        const next = String.fromCodePoint(nextCp);
        i += 1 + nextChars;
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
  }
  return raw;
}

export function normalizeCanonicalPath(rawUnquotedPath) {
  if (typeof rawUnquotedPath !== "string") return "";
  let text = rawUnquotedPath;
  if (!text || text === "/dev/null" || text.length > 4096) return "";
  if (CONTROL_CHAR_RE.test(text)) return "";
  text = text.replace(/\/{2,}/g, "/");
  while (text.startsWith("./")) text = text.slice(2);
  if (
    !text ||
    text.startsWith("/") ||
    text.startsWith("\\\\") ||
    WINDOWS_DRIVE_PREFIX_RE.test(text)
  ) {
    return "";
  }
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
  if (text.includes("\\")) {
    const subSegments = text.split(/[/\\]/);
    if (
      subSegments.some(
        (part) =>
          part === "." ||
          part === ".." ||
          GIT_SHORTNAME_SEGMENT_RE.test(part) ||
          WINDOWS_RESERVED_SEGMENT_RE.test(part),
      )
    ) {
      return "";
    }
  }
  return text;
}

export const normalizeRepoRelativePath = normalizeCanonicalPath;

function extractHeaderToken(rawHeaderPath) {
  if (typeof rawHeaderPath !== "string" || rawHeaderPath.length === 0) return "";
  if (rawHeaderPath.startsWith('"')) {
    const endIdx = scanQuotedTokenEnd(rawHeaderPath, 0);
    if (endIdx > 0) {
      return unquoteGitHeaderPath(rawHeaderPath.slice(0, endIdx + 1));
    }
  }
  const tabIdx = rawHeaderPath.indexOf("\t");
  return tabIdx >= 0 ? rawHeaderPath.slice(0, tabIdx) : rawHeaderPath;
}

function stripHeaderPrefix(rawHeaderPath, prefix) {
  const unquoted = extractHeaderToken(rawHeaderPath);
  if (unquoted === "/dev/null") return "";
  if (prefix && unquoted.startsWith(`${prefix}/`)) {
    return unquoted.slice(prefix.length + 1);
  }
  return unquoted;
}

function isSupportedDiffPrefixPair(p1, p2) {
  return (
    p1 !== p2 &&
    MNEMONIC_SRC_PREFIXES.has(p1) &&
    MNEMONIC_DST_PREFIXES.has(p2)
  );
}

function stripDiffTokenPrefixes(first, second) {
  if (first.length > 2 && second.length > 2 && first[1] === "/" && second[1] === "/") {
    const p1 = first[0];
    const p2 = second[0];
    if (isSupportedDiffPrefixPair(p1, p2)) {
      return {
        oldPath: first.slice(2),
        newPath: second.slice(2),
        srcPrefix: p1,
        dstPrefix: p2,
      };
    }
  }
  return {
    oldPath: first,
    newPath: second,
    srcPrefix: "",
    dstPrefix: "",
  };
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
  const rest = line.slice("diff --git ".length);
  if (rest.startsWith('"')) {
    const endIdx = scanQuotedTokenEnd(rest, 0);
    if (endIdx > 0 && rest[endIdx + 1] === " ") {
      const first = unquoteGitHeaderPath(rest.slice(0, endIdx + 1));
      const second = unquoteGitHeaderPath(rest.slice(endIdx + 2));
      return stripDiffTokenPrefixes(first, second);
    }
  }
  if (!rest.startsWith('"') && rest.endsWith('"')) {
    let searchFrom = 0;
    while (searchFrom < rest.length) {
      const spaceQuoteIdx = rest.indexOf(' "', searchFrom);
      if (spaceQuoteIdx === -1) break;
      const endIdx = scanQuotedTokenEnd(rest, spaceQuoteIdx + 1);
      if (endIdx === rest.length - 1) {
        const first = unquoteGitHeaderPath(rest.slice(0, spaceQuoteIdx));
        const second = unquoteGitHeaderPath(rest.slice(spaceQuoteIdx + 1));
        return stripDiffTokenPrefixes(first, second);
      }
      searchFrom = spaceQuoteIdx + 2;
    }
  }
  if (rest.length >= 7 && rest[1] === "/" && (rest.length - 5) % 2 === 0) {
    const p1 = rest[0];
    const pathLen = (rest.length - 5) / 2;
    const candidate = rest.slice(2, 2 + pathLen);
    const sepAndSecond = rest.slice(2 + pathLen);
    if (
      sepAndSecond.length === pathLen + 3 &&
      sepAndSecond[0] === " " &&
      sepAndSecond[2] === "/" &&
      isSupportedDiffPrefixPair(p1, sepAndSecond[1]) &&
      sepAndSecond.slice(3) === candidate
    ) {
      return {
        oldPath: candidate,
        newPath: candidate,
        srcPrefix: p1,
        dstPrefix: sepAndSecond[1],
      };
    }
  }
  if (rest.length >= 3 && (rest.length - 1) % 2 === 0) {
    const half = (rest.length - 1) / 2;
    if (rest[half] === " " && rest.slice(0, half) === rest.slice(half + 1)) {
      const samePath = rest.slice(0, half);
      return {
        oldPath: samePath,
        newPath: samePath,
        srcPrefix: "",
        dstPrefix: "",
      };
    }
  }
  if (rest.length >= 7 && rest[1] === "/" && MNEMONIC_SRC_PREFIXES.has(rest[0])) {
    const p1 = rest[0];
    if (p1 === "a") {
      const splitIdx = rest.lastIndexOf(" b/");
      if (splitIdx > 1) {
        return {
          oldPath: rest.slice(2, splitIdx),
          newPath: rest.slice(splitIdx + 3),
          srcPrefix: "a",
          dstPrefix: "b",
        };
      }
    }
    for (const p2 of MNEMONIC_DST_PREFIXES) {
      if (!isSupportedDiffPrefixPair(p1, p2)) continue;
      const splitIdx = rest.lastIndexOf(` ${p2}/`);
      if (splitIdx > 1) {
        return {
          oldPath: rest.slice(2, splitIdx),
          newPath: rest.slice(splitIdx + 3),
          srcPrefix: p1,
          dstPrefix: p2,
        };
      }
    }
  }
  const singleSpaceIdx = rest.indexOf(" ");
  if (singleSpaceIdx > 0 && singleSpaceIdx === rest.lastIndexOf(" ")) {
    return {
      oldPath: rest.slice(0, singleSpaceIdx),
      newPath: rest.slice(singleSpaceIdx + 1),
      srcPrefix: "",
      dstPrefix: "",
    };
  }
  return { oldPath: "", newPath: "", srcPrefix: "a", dstPrefix: "b" };
}

function parseCombinedDiffPath(line) {
  const rawRest = line.startsWith("diff --cc ")
    ? line.slice("diff --cc ".length)
    : line.slice("diff --combined ".length);
  const pathText = extractHeaderToken(rawRest.trim());
  return {
    oldPath: pathText,
    newPath: pathText,
    srcPrefix: "a",
    dstPrefix: "b",
  };
}

function inferUnifiedHeaderPrefixes(rawOldLine, rawNewLine) {
  const oldTok = extractHeaderToken(rawOldLine.slice(4));
  const newTok = extractHeaderToken(rawNewLine.slice(4));
  const oldHasA = oldTok === "/dev/null" || oldTok.startsWith("a/");
  const newHasB = newTok === "/dev/null" || newTok.startsWith("b/");
  if (oldHasA && newHasB && (oldTok.startsWith("a/") || newTok.startsWith("b/"))) {
    return { srcPrefix: "a", dstPrefix: "b" };
  }
  return { srcPrefix: "", dstPrefix: "" };
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
  let currentHunkPrefixLen = 1;
  let combinedParentRemaining = [];
  let oldRemaining = 0;
  let newRemaining = 0;
  let currentLineCount = 0;
  let oldCursor = 0;
  let newCursor = 0;
  let totalAdditions = 0;
  let totalDeletions = 0;

  const createFileRecord = (parsed) => ({
    index: 0,
    oldPath: parsed.oldPath,
    newPath: parsed.newPath,
    srcPrefix: parsed.srcPrefix,
    dstPrefix: parsed.dstPrefix,
    renameFrom: "",
    renameTo: "",
    copyFrom: "",
    copyTo: "",
    canonicalPath: "",
    displayPath: "",
    status: "modified",
    isBinary: false,
    indexHeader: "",
    oldMode: "",
    newMode: "",
    language: "text",
    additions: 0,
    deletions: 0,
    truncated: false,
    hunks: [],
  });

  const finalizeFile = () => {
    if (!current) return;
    const rawTarget =
      current.status === "deleted"
        ? current.oldPath ||
          current.renameFrom ||
          current.copyFrom ||
          current.newPath ||
          ""
        : current.newPath ||
          current.renameTo ||
          current.copyTo ||
          current.oldPath ||
          current.renameFrom ||
          current.copyFrom ||
          "";
    const canonicalPath = normalizeCanonicalPath(rawTarget);
    const normOld = normalizeCanonicalPath(
      current.oldPath || current.renameFrom || current.copyFrom || "",
    );
    const normNew = normalizeCanonicalPath(
      current.newPath || current.renameTo || current.copyTo || "",
    );
    const displayPath =
      (current.status === "renamed" || current.status === "copied") &&
      normOld &&
      normNew &&
      normOld !== normNew
        ? `${normOld} -> ${normNew}`
        : canonicalPath || normNew || normOld || "(invalid-path)";

    current.canonicalPath = canonicalPath;
    current.displayPath = displayPath;
    current.language = detectLanguageFromPath(canonicalPath || normNew || normOld);
    delete current.srcPrefix;
    delete current.dstPrefix;

    if (files.length < maxFiles) {
      current.index = files.length;
      files.push(current);
    } else {
      truncatedFiles = true;
    }
    current = null;
    currentHunk = null;
    currentHunkPrefixLen = 1;
    combinedParentRemaining = [];
    oldRemaining = 0;
    newRemaining = 0;
    currentLineCount = 0;
  };

  const stripCr = (s) => (s.endsWith("\r") ? s.slice(0, -1) : s);

  for (let idx = 0; idx < lines.length; idx += 1) {
    const line = stripCr(lines[idx]);

    if (line.startsWith("diff --git ")) {
      finalizeFile();
      totalFilesSeen += 1;
      current = createFileRecord(parseGitDiffPaths(line));
      continue;
    }

    if (line.startsWith("diff --cc ") || line.startsWith("diff --combined ")) {
      finalizeFile();
      totalFilesSeen += 1;
      current = createFileRecord(parseCombinedDiffPath(line));
      continue;
    }

    const nextLine = idx + 1 < lines.length ? stripCr(lines[idx + 1]) : "";
    const hunkDrained =
      !currentHunk ||
      (newRemaining <= 0 &&
        (currentHunkPrefixLen > 1
          ? combinedParentRemaining.every((rem) => rem <= 0)
          : oldRemaining <= 0));
    if (
      hunkDrained &&
      line.startsWith("--- ") &&
      nextLine.startsWith("+++ ") &&
      (!current || current.hunks.length > 0 || current.isBinary)
    ) {
      finalizeFile();
      totalFilesSeen += 1;
      const prefixes = inferUnifiedHeaderPrefixes(line, nextLine);
      current = createFileRecord({
        oldPath: "",
        newPath: "",
        srcPrefix: prefixes.srcPrefix,
        dstPrefix: prefixes.dstPrefix,
      });
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
      oldRemaining = oldCount;
      newRemaining = newCount;
      combinedParentRemaining = [];
      currentHunkPrefixLen = 1;
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

    const combinedHunkMatch = line.match(
      /^(@{3,}) ((?:-\d+(?:,\d+)? )+)\+(\d+)(?:,(\d+))? \1(.*)$/,
    );
    if (combinedHunkMatch) {
      const markers = combinedHunkMatch[1];
      const parentSpecs = combinedHunkMatch[2].trim().split(" ");
      if (parentSpecs.length === markers.length - 1) {
        const parentRanges = parentSpecs.map((spec) => {
          const commaIdx = spec.indexOf(",");
          const start = Number.parseInt(
            commaIdx >= 0 ? spec.slice(1, commaIdx) : spec.slice(1),
            10,
          );
          const count =
            commaIdx >= 0 ? Number.parseInt(spec.slice(commaIdx + 1), 10) : 1;
          return { start, count };
        });
        const oldStart = parentRanges[0].start;
        const oldCount = parentRanges[0].count;
        const newStart = Number.parseInt(combinedHunkMatch[3], 10);
        const newCount =
          combinedHunkMatch[4] === undefined
            ? 1
            : Number.parseInt(combinedHunkMatch[4], 10);
        const section = combinedHunkMatch[5] ? combinedHunkMatch[5].trim() : "";
        oldCursor = oldStart;
        newCursor = newStart;
        oldRemaining = oldCount;
        newRemaining = newCount;
        combinedParentRemaining = parentRanges.map((r) => r.count);
        currentHunkPrefixLen = markers.length - 1;
        currentHunk = {
          header: line.slice(
            0,
            line.indexOf(` ${markers}`, markers.length) + markers.length + 1,
          ),
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
    }

    if (!currentHunk) {
      if (line.startsWith("new file mode ")) {
        current.status = "added";
        current.newMode = line.slice("new file mode ".length).trim();
      } else if (line.startsWith("deleted file mode ")) {
        current.status = "deleted";
        current.oldMode = line.slice("deleted file mode ".length).trim();
      } else if (line.startsWith("old mode ")) {
        current.oldMode = line.slice("old mode ".length).trim();
      } else if (line.startsWith("new mode ")) {
        current.newMode = line.slice("new mode ".length).trim();
      } else if (line.startsWith("index ")) {
        current.indexHeader = line.slice("index ".length).trim();
      } else if (line.startsWith("rename from ")) {
        current.status = "renamed";
        current.renameFrom = unquoteGitHeaderPath(line.slice("rename from ".length));
        current.oldPath = current.renameFrom;
      } else if (line.startsWith("rename to ")) {
        current.status = "renamed";
        current.renameTo = unquoteGitHeaderPath(line.slice("rename to ".length));
        current.newPath = current.renameTo;
      } else if (line.startsWith("copy from ")) {
        current.status = "copied";
        current.copyFrom = unquoteGitHeaderPath(line.slice("copy from ".length));
        current.oldPath = current.copyFrom;
      } else if (line.startsWith("copy to ")) {
        current.status = "copied";
        current.copyTo = unquoteGitHeaderPath(line.slice("copy to ".length));
        current.newPath = current.copyTo;
      } else if (line.startsWith("Binary files ") || line === "GIT binary patch") {
        current.isBinary = true;
        if (current.status === "modified") current.status = "binary";
      } else if (line.startsWith("--- ")) {
        const rawOld = line.slice(4);
        const stripped = stripHeaderPrefix(rawOld, current.srcPrefix);
        if (stripped) {
          if (!current.renameFrom && !current.copyFrom) {
            current.oldPath = stripped;
          }
        } else if (extractHeaderToken(rawOld) === "/dev/null") {
          current.status = "added";
        }
      } else if (line.startsWith("+++ ")) {
        const rawNew = line.slice(4);
        const stripped = stripHeaderPrefix(rawNew, current.dstPrefix);
        if (stripped) {
          if (!current.renameTo && !current.copyTo) {
            current.newPath = stripped;
          }
        } else if (extractHeaderToken(rawNew) === "/dev/null") {
          current.status = "deleted";
        }
      }
      continue;
    }

    if (currentHunkPrefixLen > 1) {
      if (line.startsWith("\\")) {
        if (currentLineCount < maxLinesPerFile) {
          currentHunk.lines.push({
            type: "meta",
            oldLine: null,
            newLine: null,
            text: line,
          });
          currentLineCount += 1;
        }
        continue;
      }
      if (
        line === "" &&
        newRemaining > 0 &&
        combinedParentRemaining.every((rem) => rem > 0)
      ) {
        const oLine = oldCursor;
        const nLine = newCursor;
        oldCursor += 1;
        newCursor += 1;
        oldRemaining -= 1;
        newRemaining -= 1;
        for (let p = 0; p < combinedParentRemaining.length; p += 1) {
          combinedParentRemaining[p] -= 1;
        }
        if (currentLineCount < maxLinesPerFile) {
          currentHunk.lines.push({
            type: "context",
            oldLine: oLine,
            newLine: nLine,
            text: "",
          });
          currentLineCount += 1;
        } else {
          current.truncated = true;
        }
        continue;
      }
      if (line.length >= currentHunkPrefixLen) {
        const prefixCols = line.slice(0, currentHunkPrefixLen);
        const hasPlus = prefixCols.includes("+");
        const hasMinus = prefixCols.includes("-");
        if (/^[+ -]+$/.test(prefixCols) && !(hasPlus && hasMinus)) {
          const bodyText = line.slice(currentHunkPrefixLen);
          if (hasMinus) {
            for (let p = 0; p < currentHunkPrefixLen; p += 1) {
              if (prefixCols[p] === "-") combinedParentRemaining[p] -= 1;
            }
            const inFirstParent = prefixCols[0] === "-";
            const oLine = inFirstParent ? oldCursor : null;
            if (inFirstParent) {
              oldCursor += 1;
              oldRemaining -= 1;
            }
            current.deletions += 1;
            totalDeletions += 1;
            if (currentLineCount < maxLinesPerFile) {
              currentHunk.lines.push({
                type: "del",
                oldLine: oLine,
                newLine: null,
                text: bodyText,
              });
              currentLineCount += 1;
            } else {
              current.truncated = true;
            }
          } else {
            for (let p = 0; p < currentHunkPrefixLen; p += 1) {
              if (prefixCols[p] === " ") combinedParentRemaining[p] -= 1;
            }
            const inFirstParent = prefixCols[0] === " ";
            const oLine = inFirstParent ? oldCursor : null;
            if (inFirstParent) {
              oldCursor += 1;
              oldRemaining -= 1;
            }
            const nLine = newCursor;
            newCursor += 1;
            newRemaining -= 1;
            if (!inFirstParent) {
              current.additions += 1;
              totalAdditions += 1;
              if (currentLineCount < maxLinesPerFile) {
                currentHunk.lines.push({
                  type: "add",
                  oldLine: null,
                  newLine: nLine,
                  text: bodyText,
                });
                currentLineCount += 1;
              } else {
                current.truncated = true;
              }
            } else if (currentLineCount < maxLinesPerFile) {
              currentHunk.lines.push({
                type: "context",
                oldLine: oLine,
                newLine: nLine,
                text: bodyText,
              });
              currentLineCount += 1;
            } else {
              current.truncated = true;
            }
          }
          continue;
        }
      }
      currentHunk = null;
      currentHunkPrefixLen = 1;
      combinedParentRemaining = [];
      continue;
    }

    if (line.startsWith("+")) {
      current.additions += 1;
      totalAdditions += 1;
      const lineNum = newCursor;
      newCursor += 1;
      newRemaining -= 1;
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
      oldRemaining -= 1;
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
      oldRemaining -= 1;
      newRemaining -= 1;
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
    } else if (line === "" && oldRemaining > 0 && newRemaining > 0) {
      const oLine = oldCursor;
      const nLine = newCursor;
      oldCursor += 1;
      newCursor += 1;
      oldRemaining -= 1;
      newRemaining -= 1;
      if (currentLineCount < maxLinesPerFile) {
        currentHunk.lines.push({
          type: "context",
          oldLine: oLine,
          newLine: nLine,
          text: "",
        });
        currentLineCount += 1;
      } else {
        current.truncated = true;
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
