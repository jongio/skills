import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const MAX_DIFF_BYTES = 64 * 1024 * 1024;
export const LARGE_DIFF_WARN_BYTES = 2 * 1024 * 1024;

const CONTROL_OR_SPACE_RE = /[\u0000-\u0020\u007f-\u009f]/;
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f-\u009f]/;
const PR_NUMBER_RE = /^[1-9][0-9]{0,9}$/;
const WINDOWS_DRIVE_PREFIX_RE = /^[A-Za-z]:/;
const WINDOWS_RESERVED_SEGMENT_RE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const GIT_SHORTNAME_SEGMENT_RE = /^(?:\.git|git~[0-9]+|\.git[~.].*)$/i;

function pathIsWithin(candidate, root) {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

export function findUntrustedRepositoryRoot(startPath) {
  if (typeof startPath !== "string" || startPath.length === 0) {
    return null;
  }
  let start;
  try {
    start = fs.realpathSync.native(path.resolve(startPath));
    if (!fs.statSync(start).isDirectory()) {
      return null;
    }
  } catch {
    return null;
  }
  let current = start;
  let boundary = start;
  while (true) {
    if (fs.existsSync(path.join(current, ".git"))) {
      boundary = current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return boundary;
    }
    current = parent;
  }
}

function collectUntrustedRoots(roots) {
  const collected = new Set();
  for (const raw of roots) {
    if (typeof raw !== "string" || raw.length === 0) continue;
    try {
      const lexical = path.resolve(raw);
      const canonical = fs.realpathSync.native(lexical);
      if (fs.statSync(canonical).isDirectory()) {
        collected.add(lexical);
        collected.add(canonical);
        const repoBoundary = findUntrustedRepositoryRoot(canonical);
        if (repoBoundary) {
          collected.add(repoBoundary);
        }
      }
    } catch {
      // Ignore non-existent candidate directories
    }
  }
  return [...collected];
}

function executableExtensions(executable, platform, env) {
  if (platform !== "win32") return [""];
  const ext = path.extname(executable).toUpperCase();
  if (ext) {
    return ext === ".EXE" || ext === ".COM" ? [""] : [];
  }
  const configured = String(env.PATHEXT ?? ".COM;.EXE")
    .split(";")
    .map((entry) => entry.trim().toUpperCase())
    .filter((entry) => entry === ".EXE" || entry === ".COM");
  return [...new Set(configured.length > 0 ? configured : [".COM", ".EXE"])];
}

function verifiedExecutableFile(candidate) {
  try {
    const resolved = fs.realpathSync.native(candidate);
    if (!path.isAbsolute(resolved) || !fs.statSync(resolved).isFile()) {
      return null;
    }
    fs.accessSync(resolved, fs.constants.X_OK);
    return resolved;
  } catch {
    return null;
  }
}

function isUntrustedExecutable(resolvedPath, sourcePath, untrustedRoots) {
  const lexical = path.resolve(sourcePath);
  const lexicalPortable = lexical.replaceAll("\\", "/").toLowerCase();
  const canonicalPortable = resolvedPath.replaceAll("\\", "/").toLowerCase();
  if (
    lexicalPortable.includes("/node_modules/.bin/") ||
    canonicalPortable.includes("/node_modules/.bin/")
  ) {
    return true;
  }
  return untrustedRoots.some(
    (root) => pathIsWithin(resolvedPath, root) || pathIsWithin(lexical, root),
  );
}

export function resolveTrustedExecutable(
  executable,
  { env = process.env, platform = process.platform, untrustedRoots = [] } = {},
) {
  if (typeof executable !== "string" || executable.length === 0 || executable.includes("\0")) {
    throw new Error("Executable name must be a non-empty NUL-free string");
  }
  const normalizedRoots = collectUntrustedRoots(untrustedRoots);
  if (path.isAbsolute(executable)) {
    const resolved = verifiedExecutableFile(executable);
    if (!resolved) {
      throw new Error(`Executable not found: ${executable}`);
    }
    if (isUntrustedExecutable(resolved, executable, normalizedRoots)) {
      throw new Error(`Refusing to execute binary inside untrusted directory: ${executable}`);
    }
    return resolved;
  }
  if (executable.includes("/") || executable.includes("\\")) {
    throw new Error("Executable must be an absolute path or bare command name");
  }

  const extensions = executableExtensions(executable, platform, env);
  let skippedUntrusted = false;
  for (const dir of String(env.PATH ?? "").split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) continue;
    for (const ext of extensions) {
      const candidate = path.join(dir, `${executable}${ext}`);
      const resolved = verifiedExecutableFile(candidate);
      if (!resolved) continue;
      if (isUntrustedExecutable(resolved, candidate, normalizedRoots)) {
        skippedUntrusted = true;
        continue;
      }
      return resolved;
    }
  }
  if (skippedUntrusted) {
    throw new Error(`Refusing to execute '${executable}' found only in untrusted directories`);
  }
  throw new Error(`Required executable '${executable}' was not found in trusted PATH directories`);
}

function defaultExec(command, args, options = {}) {
  const resolvedCommand = resolveTrustedExecutable(command, {
    env: process.env,
    platform: process.platform,
    untrustedRoots: [options.cwd, process.cwd()],
  });
  const effectiveArgs = command === "git"
    ? ["-c", "core.fsmonitor=false", ...args]
    : args;
  return execFileSync(resolvedCommand, effectiveArgs, {
    cwd: options.cwd,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    maxBuffer: options.maxBuffer ?? MAX_DIFF_BYTES,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      LC_ALL: "C.UTF-8",
      LANG: "C.UTF-8",
      LESSCHARSET: "utf-8",
      GIT_TERMINAL_PROMPT: "0",
      GH_PROMPT_DISABLED: "1",
      NoDefaultCurrentDirectoryInExePath: "1",
    },
  });
}

export function assertSafeGitRef(ref, label = "Git ref") {
  if (typeof ref !== "string" || ref.length === 0 || ref.length > 256) {
    throw new Error(`${label} must be a non-empty string up to 256 characters`);
  }
  if (ref.startsWith("-")) {
    throw new Error(`${label} must not start with '-'`);
  }
  if (CONTROL_OR_SPACE_RE.test(ref)) {
    throw new Error(`${label} contains forbidden whitespace or control characters`);
  }
  if (ref.includes("..")) {
    throw new Error(`${label} must be a single ref without range operators`);
  }
  if (ref.endsWith(".lock") || ref.includes("//") || ref.includes("\\") || ref.includes("@{")) {
    throw new Error(`${label} contains an unsafe ref sequence`);
  }
  return ref;
}

export function assertSafeRepoRelativePath(rawPath, label = "File path") {
  if (typeof rawPath !== "string" || rawPath.length === 0 || rawPath.length > 1024) {
    throw new Error(`${label} must be a non-empty string up to 1024 characters`);
  }
  if (CONTROL_CHAR_RE.test(rawPath)) {
    throw new Error(`${label} contains forbidden control characters`);
  }
  if (rawPath.startsWith(":")) {
    throw new Error(`Git pathspec magic prefixes (':') are not permitted in ${label.toLowerCase()}`);
  }
  if (
    rawPath.startsWith("/") ||
    rawPath.startsWith("\\") ||
    WINDOWS_DRIVE_PREFIX_RE.test(rawPath) ||
    path.win32.isAbsolute(rawPath) ||
    path.posix.isAbsolute(rawPath)
  ) {
    throw new Error(`${label} must be repository-relative, not an absolute or drive-qualified path`);
  }
  const normalized = rawPath.replaceAll("\\", "/");
  const segments = normalized.split("/");
  if (segments.some((seg) => seg.length === 0 || seg === ".")) {
    throw new Error(`${label} must not contain empty or '.' segments`);
  }
  if (segments.includes("..")) {
    throw new Error(`${label} must not contain '..' parent traversal segments`);
  }
  if (segments.some((seg) => GIT_SHORTNAME_SEGMENT_RE.test(seg))) {
    throw new Error(`${label} must not target '.git' metadata paths`);
  }
  if (segments.some((seg) => WINDOWS_RESERVED_SEGMENT_RE.test(seg))) {
    throw new Error(`${label} must not contain reserved device names`);
  }
  return normalized;
}

export function assertSafePathspecs(pathspecs) {
  if (!Array.isArray(pathspecs)) {
    throw new Error("Pathspecs must be an array");
  }
  return pathspecs.map((item) => assertSafeRepoRelativePath(item, "Pathspec"));
}

export function assertSafePrNumber(value) {
  const text = String(value ?? "").trim();
  if (!PR_NUMBER_RE.test(text)) {
    throw new Error("Pull request number must be a positive integer");
  }
  return text;
}

export function unquoteGitPath(raw) {
  if (typeof raw !== "string") return "";
  const trimmed = raw.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    const inner = trimmed.slice(1, -1);
    const bytes = [];
    for (let i = 0; i < inner.length; i += 1) {
      const ch = inner[i];
      if (ch !== "\\") {
        bytes.push(...Buffer.from(ch, "utf8"));
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
        default: bytes.push(...Buffer.from(next, "utf8")); break;
      }
    }
    return Buffer.from(bytes).toString("utf8");
  }
  return trimmed;
}

export function normalizeRepoRelativePath(rawUnquotedPath) {
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

export function normalizeDiffFilePath(rawPath) {
  if (typeof rawPath !== "string" || rawPath.length > 4096) return "";
  let text = unquoteGitPath(rawPath).trim();
  if (!text || text === "/dev/null" || CONTROL_CHAR_RE.test(text)) return "";

  // Expand UI rename display labels: prefix/{old => new}/suffix or old -> new
  if (text.includes("{") && text.includes("}")) {
    const braceArrowRe = /\{([^{}]{0,1024}) (?:->|=>|\u2192) ([^{}]{0,1024})\}/g;
    if (braceArrowRe.test(text)) {
      text = text.replace(braceArrowRe, (_match, _oldPart, newPart) => newPart.trim());
    }
  } else if (text.includes(" -> ") || text.includes(" => ") || text.includes(" \u2192 ")) {
    const arrowParts = text.split(/ (?:->|=>|\u2192) /);
    if (arrowParts.length === 2 && arrowParts[1].trim()) {
      text = arrowParts[1].trim();
    }
  }

  text = text.replaceAll("\\", "/").replace(/\/{2,}/g, "/");
  if (text.startsWith("./")) text = text.slice(2);
  if (text.startsWith("/") || WINDOWS_DRIVE_PREFIX_RE.test(text)) return "";
  return text;
}

function stripDiffPrefix(rawHeaderPath, prefix) {
  const unquoted = unquoteGitPath(rawHeaderPath.replace(/\t.*$/, ""));
  if (unquoted === "/dev/null") return "";
  if (unquoted.startsWith(`${prefix}/`)) return unquoted.slice(prefix.length + 1);
  return unquoted;
}

function parseDiffGitHeaderPaths(line) {
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
    const first = unquoteGitPath(rest.slice(0, i + 1));
    const second = unquoteGitPath(rest.slice(i + 1).trim());
    return {
      oldPath: first.startsWith("a/") ? first.slice(2) : first,
      newPath: second.startsWith("b/") ? second.slice(2) : second,
    };
  }
  // Unquoted "a/<path> b/<path>": look for exact mirror first, otherwise last " b/"
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

export function parseUnifiedDiff(rawDiff) {
  if (typeof rawDiff !== "string" || rawDiff.length === 0) {
    return { fileCount: 0, additions: 0, deletions: 0, files: [] };
  }

  const lines = rawDiff.split("\n");
  const files = [];
  let current = null;
  let inHunk = false;
  let oldCursor = 0;
  let newCursor = 0;
  let totalAdditions = 0;
  let totalDeletions = 0;

  const finalizeFile = () => {
    if (!current) return;
    const rawCanonical = current.newPath || current.renameTo || current.oldPath || current.renameFrom || "";
    current.canonicalPath = normalizeRepoRelativePath(rawCanonical);
    files.push(current);
    current = null;
    inHunk = false;
  };

  for (let idx = 0; idx < lines.length; idx += 1) {
    const rawLine = lines[idx];
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;

    if (line.startsWith("diff --git ")) {
      finalizeFile();
      const parsed = parseDiffGitHeaderPaths(line);
      current = {
        oldPath: parsed.oldPath,
        newPath: parsed.newPath,
        renameFrom: "",
        renameTo: "",
        canonicalPath: "",
        status: "modified",
        additions: 0,
        deletions: 0,
        hunks: [],
      };
      continue;
    }

    if (!current) continue;

    const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (hunkMatch) {
      inHunk = true;
      const oldStart = Number.parseInt(hunkMatch[1], 10);
      const oldCount = hunkMatch[2] === undefined ? 1 : Number.parseInt(hunkMatch[2], 10);
      const newStart = Number.parseInt(hunkMatch[3], 10);
      const newCount = hunkMatch[4] === undefined ? 1 : Number.parseInt(hunkMatch[4], 10);
      oldCursor = oldStart;
      newCursor = newStart;
      current.hunks.push({ oldStart, oldCount, newStart, newCount });
      continue;
    }

    if (!inHunk) {
      if (line.startsWith("new file mode ")) {
        current.status = "added";
      } else if (line.startsWith("deleted file mode ")) {
        current.status = "deleted";
      } else if (line.startsWith("rename from ")) {
        current.status = "renamed";
        current.renameFrom = unquoteGitPath(line.slice("rename from ".length));
        current.oldPath = current.renameFrom;
      } else if (line.startsWith("rename to ")) {
        current.status = "renamed";
        current.renameTo = unquoteGitPath(line.slice("rename to ".length));
        current.newPath = current.renameTo;
      } else if (line.startsWith("--- ")) {
        const stripped = stripDiffPrefix(line.slice(4), "a");
        if (stripped) current.oldPath = stripped;
        else if (line.slice(4).trim() === "/dev/null") current.status = "added";
      } else if (line.startsWith("+++ ")) {
        const stripped = stripDiffPrefix(line.slice(4), "b");
        if (stripped) current.newPath = stripped;
        else if (line.slice(4).trim() === "/dev/null") current.status = "deleted";
      }
      continue;
    }

    // Inside a hunk: every '+' line (including bare '+' or '+++foo') is an addition,
    // and every '-' line (including bare '-' or '---foo') is a deletion.
    if (line.startsWith("+")) {
      current.additions += 1;
      totalAdditions += 1;
      newCursor += 1;
    } else if (line.startsWith("-")) {
      current.deletions += 1;
      totalDeletions += 1;
      oldCursor += 1;
    } else if (line.startsWith(" ")) {
      oldCursor += 1;
      newCursor += 1;
    } else if (line.startsWith("\\")) {
      // "\ No newline at end of file"
    } else if (line === "" && idx === lines.length - 1) {
      // Trailing newline after split("\n")
    } else {
      inHunk = false;
    }
  }

  finalizeFile();

  return {
    fileCount: files.length,
    additions: totalAdditions,
    deletions: totalDeletions,
    files,
  };
}

export function computeReviewId({ diffSpec, baseSha, headSha }) {
  if (typeof diffSpec !== "string" || !diffSpec) {
    throw new Error("diffSpec is required to compute reviewId");
  }
  if (typeof baseSha !== "string" || !baseSha) {
    throw new Error("baseSha is required to compute reviewId");
  }
  if (typeof headSha !== "string" || !headSha) {
    throw new Error("headSha is required to compute reviewId");
  }
  return createHash("sha256")
    .update(`${diffSpec}\n${baseSha}\n${headSha}`, "utf8")
    .digest("hex")
    .slice(0, 12);
}

function sanitizeSlugToken(raw, fallback) {
  const cleaned = String(raw ?? "")
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/\.{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!cleaned || cleaned === "." || cleaned === "..") return fallback;
  return cleaned.slice(0, 72);
}

export function parseRemoteRepoSlug(remoteUrl, fallbackDirName = "repo") {
  const fallbackRepo = sanitizeSlugToken(fallbackDirName, "repo");
  if (typeof remoteUrl !== "string" || !remoteUrl.trim()) {
    return `local__${fallbackRepo}`;
  }
  let text = remoteUrl.trim();
  if (text.endsWith(".git")) text = text.slice(0, -4);

  let pathname = "";
  if (text.includes("://")) {
    try {
      const parsed = new URL(text);
      pathname = parsed.pathname;
    } catch {
      pathname = "";
    }
  } else {
    const colonIdx = text.indexOf(":");
    if (colonIdx > 0 && !text.slice(0, colonIdx).includes("/")) {
      pathname = text.slice(colonIdx + 1);
    }
  }

  const parts = pathname
    .replaceAll("\\", "/")
    .split("/")
    .map((p) => p.trim())
    .filter(Boolean);

  if (parts.length >= 2) {
    const owner = sanitizeSlugToken(parts.at(-2), "local");
    const repo = sanitizeSlugToken(parts.at(-1), fallbackRepo);
    return `${owner}__${repo}`;
  }
  if (parts.length === 1) {
    return `local__${sanitizeSlugToken(parts[0], fallbackRepo)}`;
  }
  return `local__${fallbackRepo}`;
}

export function deriveBranchSlug(branchName) {
  const raw = typeof branchName === "string" && branchName.trim()
    ? branchName.trim()
    : "detached-head";
  if (/^[A-Za-z0-9._-]+$/.test(raw) && raw !== "." && raw !== ".." && !raw.includes("..") && raw.length <= 80) {
    return raw;
  }
  const readable = sanitizeSlugToken(raw.replaceAll("/", "--"), "branch").slice(0, 64);
  const digest = createHash("sha256").update(raw, "utf8").digest("hex").slice(0, 8);
  return `${readable}-${digest}`;
}

export function parseDiffSpecArgs(rawArgs = []) {
  if (!Array.isArray(rawArgs)) {
    throw new Error("Diff arguments must be an array");
  }
  const dashDashIndex = rawArgs.indexOf("--");
  const specTokens = dashDashIndex >= 0 ? rawArgs.slice(0, dashDashIndex) : [...rawArgs];
  const pathspecs = dashDashIndex >= 0 ? assertSafePathspecs(rawArgs.slice(dashDashIndex + 1)) : [];

  if (specTokens.length === 0) {
    return { kind: "default", pathspecs };
  }

  if (specTokens.length === 1 && (specTokens[0] === "--staged" || specTokens[0] === "--cached")) {
    return { kind: "staged", pathspecs };
  }

  if (specTokens.length === 1 && specTokens[0] === "--unstaged") {
    return { kind: "unstaged", pathspecs };
  }

  if (specTokens[0] === "pr") {
    if (specTokens.length > 2) {
      throw new Error("Usage: diff pr [<number>]");
    }
    const prNumber = specTokens.length === 2 ? assertSafePrNumber(specTokens[1]) : null;
    return { kind: "pr", prNumber, pathspecs };
  }

  for (const token of specTokens) {
    if (token.startsWith("-")) {
      throw new Error(`Unsupported diff option: ${token}`);
    }
  }

  if (specTokens.length > 1) {
    throw new Error(`Unexpected extra diff spec arguments: ${specTokens.slice(1).join(" ")}`);
  }

  const spec = specTokens[0];
  if (spec.includes("...")) {
    const parts = spec.split("...");
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw new Error(`Invalid three-dot range: ${spec}`);
    }
    return {
      kind: "three-dot",
      baseRef: assertSafeGitRef(parts[0], "Base ref"),
      headRef: assertSafeGitRef(parts[1], "Head ref"),
      pathspecs,
    };
  }

  if (spec.includes("..")) {
    const parts = spec.split("..");
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw new Error(`Invalid two-dot range: ${spec}`);
    }
    return {
      kind: "two-dot",
      baseRef: assertSafeGitRef(parts[0], "Base ref"),
      headRef: assertSafeGitRef(parts[1], "Head ref"),
      pathspecs,
    };
  }

  return {
    kind: "ref",
    ref: assertSafeGitRef(spec, "Git ref"),
    pathspecs,
  };
}

function tryExec(execFn, cmd, args, cwd) {
  try {
    return execFn(cmd, args, { cwd });
  } catch {
    return null;
  }
}

export function resolveDefaultBranch(cwd, execFn = defaultExec) {
  const originHead = tryExec(
    execFn,
    "git",
    ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
    cwd,
  )?.trim();

  const candidates = [
    originHead,
    "origin/main",
    "main",
    "origin/master",
    "master",
  ].filter(Boolean);

  const seen = new Set();
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    if (candidate.startsWith("-") || CONTROL_OR_SPACE_RE.test(candidate)) continue;
    const verified = tryExec(
      execFn,
      "git",
      ["rev-parse", "--verify", "--quiet", `${candidate}^{commit}`],
      cwd,
    )?.trim();
    if (verified) return candidate;
  }
  return null;
}

export function resolveRepoIdentity(cwd, execFn = defaultExec) {
  const topRaw = execFn("git", ["rev-parse", "--show-toplevel"], { cwd }).trim();
  const repoRoot = path.resolve(topRaw);
  const remoteUrl = tryExec(execFn, "git", ["config", "--get", "remote.origin.url"], repoRoot)?.trim() ?? "";
  const branchRaw = tryExec(execFn, "git", ["branch", "--show-current"], repoRoot)?.trim() ?? "";
  const branch = branchRaw || "detached-head";
  const repoSlug = parseRemoteRepoSlug(remoteUrl, path.basename(repoRoot));
  const branchSlug = deriveBranchSlug(branch);
  return { repoRoot, remoteUrl, branch, repoSlug, branchSlug };
}

function formatSpecWithPaths(baseSpec, pathspecs) {
  if (!pathspecs || pathspecs.length === 0) return baseSpec;
  return `${baseSpec} -- ${pathspecs.join(" ")}`;
}

function filterUnifiedDiffByPaths(rawDiff, pathspecs) {
  if (!pathspecs || pathspecs.length === 0 || !rawDiff) return rawDiff;
  const allowed = new Set(pathspecs);
  const matchesPath = (candidate) => {
    if (!candidate) return false;
    if (allowed.has(candidate)) return true;
    for (const spec of allowed) {
      const prefix = spec.endsWith("/") ? spec : `${spec}/`;
      if (candidate.startsWith(prefix)) return true;
    }
    return false;
  };

  const chunks = rawDiff.split(/(?=^diff --git )/m);
  const kept = chunks.filter((chunk) => {
    if (!chunk.startsWith("diff --git ")) return false;
    const parsed = parseUnifiedDiff(chunk);
    const file = parsed.files[0];
    if (!file) return false;
    return (
      matchesPath(file.canonicalPath) ||
      matchesPath(normalizeRepoRelativePath(file.oldPath)) ||
      matchesPath(normalizeRepoRelativePath(file.newPath))
    );
  });
  return kept.join("");
}

function runGitDiff(execFn, cwd, refArgs, pathspecs) {
  const args = [
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.quotepath=true",
    "diff",
    "--no-ext-diff",
    "--no-color",
    "--no-textconv",
    ...refArgs,
    "--",
    ...pathspecs,
  ];
  return execFn("git", args, { cwd, maxBuffer: MAX_DIFF_BYTES });
}

export function resolveDiffContext(rawArgs = [], options = {}) {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const execFn = options.execFn ?? defaultExec;
  const parsedSpec = parseDiffSpecArgs(rawArgs);
  const identity = resolveRepoIdentity(cwd, execFn);
  const { repoRoot, branch, repoSlug, branchSlug } = identity;
  const { pathspecs } = parsedSpec;

  const revParse = (ref) =>
    tryExec(execFn, "git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], repoRoot)?.trim() ?? null;
  const mergeBase = (a, b) =>
    tryExec(execFn, "git", ["merge-base", a, b], repoRoot)?.trim() ?? null;

  let title = "";
  let diffSpec = "";
  let baseSha = "";
  let headSha = "";
  let patch = "";

  if (parsedSpec.kind === "staged") {
    const headCommit = revParse("HEAD") ?? "empty-tree";
    title = "Staged Changes";
    diffSpec = formatSpecWithPaths("--staged", pathspecs);
    baseSha = headCommit;
    headSha = "staged-index";
    patch = runGitDiff(execFn, repoRoot, ["--cached"], pathspecs);
  } else if (parsedSpec.kind === "unstaged") {
    const headCommit = revParse("HEAD") ?? "empty-tree";
    title = "Unstaged Changes";
    diffSpec = formatSpecWithPaths("--unstaged", pathspecs);
    baseSha = `${headCommit}:index`;
    headSha = "working-tree";
    patch = runGitDiff(execFn, repoRoot, [], pathspecs);
  } else if (parsedSpec.kind === "pr") {
    const prArgs = ["pr", "diff", ...(parsedSpec.prNumber ? [parsedSpec.prNumber] : []), "--color", "never"];
    const viewArgs = [
      "pr",
      "view",
      ...(parsedSpec.prNumber ? [parsedSpec.prNumber] : []),
      "--json",
      "number,baseRefOid,headRefOid,title",
    ];
    const rawPatch = execFn("gh", prArgs, { cwd: repoRoot, maxBuffer: MAX_DIFF_BYTES });
    patch = filterUnifiedDiffByPaths(rawPatch, pathspecs);

    let prMeta = null;
    const rawMeta = tryExec(execFn, "gh", viewArgs, repoRoot);
    if (rawMeta) {
      try {
        prMeta = JSON.parse(rawMeta);
      } catch {
        prMeta = null;
      }
    }
    const resolvedNum = prMeta?.number ? String(prMeta.number) : parsedSpec.prNumber ?? "current";
    title = prMeta?.number ? `PR #${prMeta.number}` : "Pull Request Diff";
    diffSpec = formatSpecWithPaths(`pr:${resolvedNum}`, pathspecs);
    baseSha = typeof prMeta?.baseRefOid === "string" && prMeta.baseRefOid
      ? prMeta.baseRefOid
      : revParse("HEAD") ?? "pr-base";
    headSha = typeof prMeta?.headRefOid === "string" && prMeta.headRefOid
      ? prMeta.headRefOid
      : createHash("sha256").update(rawPatch, "utf8").digest("hex").slice(0, 40);
  } else if (parsedSpec.kind === "two-dot") {
    const resolvedBase = revParse(parsedSpec.baseRef);
    if (!resolvedBase) throw new Error(`Unknown base revision: ${parsedSpec.baseRef}`);
    const resolvedHead = revParse(parsedSpec.headRef);
    if (!resolvedHead) throw new Error(`Unknown head revision: ${parsedSpec.headRef}`);
    title = `${parsedSpec.baseRef}..${parsedSpec.headRef}`;
    diffSpec = formatSpecWithPaths(`${parsedSpec.baseRef}..${parsedSpec.headRef}`, pathspecs);
    baseSha = resolvedBase;
    headSha = resolvedHead;
    patch = runGitDiff(execFn, repoRoot, [`${parsedSpec.baseRef}..${parsedSpec.headRef}`], pathspecs);
  } else if (parsedSpec.kind === "three-dot") {
    const resolvedBase = revParse(parsedSpec.baseRef);
    if (!resolvedBase) throw new Error(`Unknown base revision: ${parsedSpec.baseRef}`);
    const resolvedHead = revParse(parsedSpec.headRef);
    if (!resolvedHead) throw new Error(`Unknown head revision: ${parsedSpec.headRef}`);
    const mb = mergeBase(parsedSpec.baseRef, parsedSpec.headRef) ?? resolvedBase;
    title = `${parsedSpec.baseRef}...${parsedSpec.headRef}`;
    diffSpec = formatSpecWithPaths(`${parsedSpec.baseRef}...${parsedSpec.headRef}`, pathspecs);
    baseSha = mb;
    headSha = resolvedHead;
    patch = runGitDiff(execFn, repoRoot, [`${parsedSpec.baseRef}...${parsedSpec.headRef}`], pathspecs);
  } else if (parsedSpec.kind === "ref") {
    const resolvedRef = revParse(parsedSpec.ref);
    if (!resolvedRef) throw new Error(`Unknown revision: ${parsedSpec.ref}`);
    const headCommit = revParse("HEAD");
    const mb = headCommit ? (mergeBase(parsedSpec.ref, "HEAD") ?? resolvedRef) : resolvedRef;
    title = `${parsedSpec.ref} vs working tree`;
    diffSpec = formatSpecWithPaths(parsedSpec.ref, pathspecs);
    baseSha = mb;
    headSha = headCommit ? `${headCommit}:working-tree` : "working-tree";
    patch = runGitDiff(execFn, repoRoot, [mb], pathspecs);
  } else {
    // Default mode: compare merge-base(defaultBranch, HEAD) against working tree
    // so both committed branch work and uncommitted staged/unstaged edits appear.
    const headCommit = revParse("HEAD");
    const defaultBranch = resolveDefaultBranch(repoRoot, execFn);
    let resolved = false;

    if (defaultBranch && headCommit) {
      const mb = mergeBase(defaultBranch, "HEAD");
      if (mb) {
        const candidatePatch = runGitDiff(execFn, repoRoot, [mb], pathspecs);
        if (candidatePatch.trim().length > 0) {
          title = `${defaultBranch} vs working tree`;
          diffSpec = formatSpecWithPaths(`${defaultBranch}...working-tree`, pathspecs);
          baseSha = mb;
          headSha = `${headCommit}:working-tree`;
          patch = candidatePatch;
          resolved = true;
        }
      }
    }

    if (!resolved && headCommit) {
      const uncommittedPatch = runGitDiff(execFn, repoRoot, ["HEAD"], pathspecs);
      if (uncommittedPatch.trim().length > 0) {
        title = "Uncommitted Changes";
        diffSpec = formatSpecWithPaths("HEAD...working-tree", pathspecs);
        baseSha = headCommit;
        headSha = `${headCommit}:working-tree`;
        patch = uncommittedPatch;
        resolved = true;
      }
    }

    if (!resolved && headCommit) {
      const prevCommit = revParse("HEAD~1");
      if (prevCommit) {
        const lastCommitPatch = runGitDiff(execFn, repoRoot, [prevCommit, headCommit], pathspecs);
        title = "HEAD~1..HEAD";
        diffSpec = formatSpecWithPaths("HEAD~1..HEAD", pathspecs);
        baseSha = prevCommit;
        headSha = headCommit;
        patch = lastCommitPatch;
        resolved = true;
      }
    }

    if (!resolved) {
      title = "Working Tree";
      diffSpec = formatSpecWithPaths("working-tree", pathspecs);
      baseSha = headCommit ?? "empty-tree";
      headSha = "working-tree";
      const stagedPatch = runGitDiff(execFn, repoRoot, ["--cached"], pathspecs);
      patch = stagedPatch.trim().length > 0
        ? stagedPatch
        : runGitDiff(execFn, repoRoot, [], pathspecs);
    }
  }

  const reviewId = computeReviewId({ diffSpec, baseSha, headSha });
  const stats = parseUnifiedDiff(patch);
  const patchBytes = Buffer.byteLength(patch, "utf8");

  return {
    title,
    diffSpec,
    baseSha,
    headSha,
    reviewId,
    branch,
    repoSlug,
    branchSlug,
    repoRoot,
    patch,
    patchBytes,
    largeDiffWarning: patchBytes > LARGE_DIFF_WARN_BYTES,
    stats,
  };
}
