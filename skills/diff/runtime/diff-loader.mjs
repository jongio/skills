// runtime/diff-loader.mjs - Safe Git and GitHub PR diff loader for the Diff canvas.
// Supports loading GitHub PR diffs (`gh pr diff`) with or without a local checkout,
// and local repository diffs (`git diff`) with strict ref/path validation.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { normalizeCanonicalPath, parseDiffPatch } from "./parse-diff.mjs";

const execFileAsync = promisify(execFile);

export const MAX_DIFF_BYTES = 32 * 1024 * 1024;
export const EXEC_TIMEOUT_MS = 30_000;
export const MAX_UNTRACKED_FILES = 200;
export const MAX_UNTRACKED_FILE_BYTES = 512 * 1024;
const BINARY_PROBE_BYTES = 8 * 1024;

const CONTROL_OR_SPACE_RE = /[\u0000-\u0020\u007f-\u009f]/;
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f-\u009f]/;
const REPO_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const GH_ACCOUNT_RE = /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,38})$/;
const GH_AUTH_OR_NOT_FOUND_RE =
  /Could not resolve to a Repository|Could not resolve to a PullRequest|HTTP 401|HTTP 403|HTTP 404|authentication|not logged into|gh auth login|Bad credentials|Resource not accessible/i;
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
  if (typeof startPath !== "string" || startPath.length === 0) return null;
  let start;
  try {
    start = fs.realpathSync.native(path.resolve(startPath));
    if (!fs.statSync(start).isDirectory()) return null;
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
    if (parent === current) return boundary;
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
        if (repoBoundary) collected.add(repoBoundary);
      }
    } catch {
      // Ignore missing directories
    }
  }
  return [...collected];
}

function executableExtensions(executable, platform, env) {
  if (platform !== "win32") return [""];
  const ext = path.extname(executable).toUpperCase();
  if (ext) return ext === ".EXE" || ext === ".COM" ? [""] : [];
  const configured = String(env.PATHEXT ?? ".COM;.EXE")
    .split(";")
    .map((entry) => entry.trim().toUpperCase())
    .filter((entry) => entry === ".EXE" || entry === ".COM");
  return [...new Set(configured.length > 0 ? configured : [".COM", ".EXE"])];
}

function verifiedExecutableFile(candidate) {
  try {
    const resolved = fs.realpathSync.native(candidate);
    if (!path.isAbsolute(resolved) || !fs.statSync(resolved).isFile()) return null;
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
    if (!resolved) throw new Error("Executable not found");
    if (isUntrustedExecutable(resolved, executable, normalizedRoots)) {
      throw new Error("Refusing to execute binary inside untrusted directory");
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

async function defaultExec(command, args, options = {}) {
  const resolvedCommand = resolveTrustedExecutable(command, {
    env: process.env,
    platform: process.platform,
    untrustedRoots: [options.cwd, ...(options.untrustedRoots ?? []), process.cwd()],
  });
  const effectiveArgs =
    command === "git" ? ["-c", "core.fsmonitor=false", ...args] : args;
  const envOverrides = options.env && typeof options.env === "object" ? options.env : null;
  const childEnv = {
    ...process.env,
    LC_ALL: "C.UTF-8",
    LANG: "C.UTF-8",
    LESSCHARSET: "utf-8",
    GIT_TERMINAL_PROMPT: "0",
    GH_PROMPT_DISABLED: "1",
    NoDefaultCurrentDirectoryInExePath: "1",
    ...(envOverrides ?? {}),
  };
  if (envOverrides && typeof envOverrides.GH_TOKEN === "string" && envOverrides.GH_TOKEN) {
    childEnv.GITHUB_TOKEN = envOverrides.GH_TOKEN;
  }
  const { stdout } = await execFileAsync(resolvedCommand, effectiveArgs, {
    cwd: options.cwd || os.tmpdir(),
    encoding: "utf8",
    windowsHide: true,
    timeout: options.timeout ?? EXEC_TIMEOUT_MS,
    maxBuffer: options.maxBuffer ?? MAX_DIFF_BYTES,
    env: childEnv,
  });
  return stdout;
}

export function assertSafeGitHubAccount(rawAccount) {
  if (rawAccount === undefined || rawAccount === null || rawAccount === "") {
    return null;
  }
  if (typeof rawAccount !== "string") {
    throw new Error("GitHub account must be a string");
  }
  const trimmed = rawAccount.trim();
  if (!trimmed) return null;
  if (!GH_ACCOUNT_RE.test(trimmed)) {
    throw new Error(`Invalid GitHub account '${trimmed}'.`);
  }
  return trimmed;
}

export function encodeCopilotGhAccountEnvKey(account) {
  const safe = assertSafeGitHubAccount(account);
  if (!safe) throw new Error("GitHub account is required");
  const encoded = safe.replace(/[_-]/g, (ch) => (ch === "_" ? "_5F_" : "_2D_"));
  return `COPILOT_GH_ACCOUNT_github_2E_com_${encoded}`;
}

export function assertSafeRepoFullName(rawRepo) {
  const text = String(rawRepo ?? "").trim();
  const parts = text.split("/");
  if (
    parts.length !== 2 ||
    !REPO_SEGMENT_RE.test(parts[0]) ||
    !REPO_SEGMENT_RE.test(parts[1]) ||
    parts[0] === "." ||
    parts[0] === ".." ||
    parts[1] === "." ||
    parts[1] === ".."
  ) {
    throw new Error(`Invalid repository '${text}'. Expected owner/repo.`);
  }
  return `${parts[0]}/${parts[1]}`;
}

export function assertSafePrNumber(value) {
  let num;
  if (typeof value === "number") {
    num = value;
  } else {
    const text = String(value ?? "").trim();
    num = /^\d+$/.test(text) ? Number.parseInt(text, 10) : Number.NaN;
  }
  if (!Number.isInteger(num) || num < 1 || num > 999_999_999) {
    throw new Error("Pull request number must be a positive integer");
  }
  return num;
}

export function assertSafeGitRef(ref, label = "Git ref") {
  if (typeof ref !== "string" || ref.length === 0 || ref.length > 256) {
    throw new Error(`${label} must be a non-empty string up to 256 characters`);
  }
  if (ref.startsWith("-") || ref.startsWith(":")) {
    throw new Error(`${label} cannot start with '-' or ':'`);
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

export function assertSafeRepoRelativePath(
  rawPath,
  label = "File path",
  { platform = process.platform, preserveBackslashes = false } = {},
) {
  if (typeof rawPath !== "string" || rawPath.length === 0 || rawPath.length > 1024) {
    throw new Error(`${label} must be a non-empty string up to 1024 characters`);
  }
  if (CONTROL_CHAR_RE.test(rawPath)) {
    throw new Error(`${label} contains forbidden control characters`);
  }
  if (rawPath.startsWith(":")) {
    throw new Error(`Git pathspec magic prefixes (':') are not permitted in ${label.toLowerCase()}`);
  }
  const normalizeWinSeparators = platform === "win32" && !preserveBackslashes;
  if (
    rawPath.startsWith("/") ||
    rawPath.startsWith("\\\\") ||
    WINDOWS_DRIVE_PREFIX_RE.test(rawPath) ||
    path.posix.isAbsolute(rawPath) ||
    (normalizeWinSeparators &&
      (rawPath.startsWith("\\") || path.win32.isAbsolute(rawPath)))
  ) {
    throw new Error(`${label} must be repository-relative, not an absolute or drive-qualified path`);
  }
  const slashText = normalizeWinSeparators
    ? rawPath.replaceAll("\\", "/")
    : rawPath;
  const normalized =
    platform === "win32"
      ? slashText.replace(/^(?:\.[\\/])+/, "")
      : slashText.replace(/^(?:\.\/)+/, "");
  const segments = normalized.split("/");
  if (segments.some((seg) => seg.length === 0 || seg === ".")) {
    throw new Error(`${label} must not contain empty or '.' segments`);
  }
  if (segments.includes("..")) {
    throw new Error(`${label} must not contain '..' parent traversal segments`);
  }
  const checkSegments = normalized.includes("\\")
    ? normalized.split(/[/\\]/)
    : segments;
  if (checkSegments.includes("..") || checkSegments.includes(".")) {
    throw new Error(`${label} must not contain '.' or '..' traversal segments`);
  }
  if (checkSegments.some((seg) => GIT_SHORTNAME_SEGMENT_RE.test(seg))) {
    throw new Error(`${label} must not target '.git' metadata paths`);
  }
  if (checkSegments.some((seg) => WINDOWS_RESERVED_SEGMENT_RE.test(seg))) {
    throw new Error(`${label} must not contain reserved device names`);
  }
  return normalized;
}

export function assertSafePathspecs(paths, options = {}) {
  if (paths === undefined || paths === null) return [];
  if (!Array.isArray(paths)) throw new Error("paths must be an array of repository-relative paths");
  if (paths.length > 200) throw new Error("paths cannot exceed 200 entries");
  return paths.map((entry) =>
    assertSafeRepoRelativePath(entry, "Path filter", options),
  );
}

export function parseGitSpec(rawSpec) {
  const spec = typeof rawSpec === "string" ? rawSpec.trim() : "";
  if (!spec) return { kind: "default", spec: "" };
  if (spec === "--staged" || spec === "--cached") return { kind: "staged", spec: "--staged" };
  if (spec === "--unstaged") return { kind: "unstaged", spec: "--unstaged" };
  if (spec.startsWith("-")) {
    throw new Error(`Unsupported diff option: ${spec}`);
  }
  if (CONTROL_OR_SPACE_RE.test(spec)) {
    throw new Error("Diff spec must not contain whitespace or control characters");
  }
  if (spec.includes("...")) {
    const parts = spec.split("...");
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw new Error(`Invalid three-dot range: ${spec}`);
    }
    const baseRef = assertSafeGitRef(parts[0], "Base ref");
    const headRef = assertSafeGitRef(parts[1], "Head ref");
    return { kind: "three-dot", baseRef, headRef, spec: `${baseRef}...${headRef}` };
  }
  if (spec.includes("..")) {
    const parts = spec.split("..");
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw new Error(`Invalid two-dot range: ${spec}`);
    }
    const baseRef = assertSafeGitRef(parts[0], "Base ref");
    const headRef = assertSafeGitRef(parts[1], "Head ref");
    return { kind: "two-dot", baseRef, headRef, spec: `${baseRef}..${headRef}` };
  }
  const ref = assertSafeGitRef(spec, "Git ref");
  return { kind: "ref", ref, spec: ref };
}

function canonicalizeDirectoryKey(dirPath) {
  const resolved = path.resolve(dirPath);
  let canonical = resolved;
  try {
    canonical = fs.realpathSync.native(resolved);
  } catch {
    canonical = resolved;
  }
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

export function assertSafeCheckoutDir(dirPath, env = process.env) {
  const resolved = path.resolve(dirPath);
  const copilotHome = path.resolve(
    env?.COPILOT_HOME || path.join(os.homedir(), ".copilot"),
  );
  const targetKey = canonicalizeDirectoryKey(resolved);
  const homeKey = canonicalizeDirectoryKey(copilotHome);
  const homePrefix = homeKey.endsWith(path.sep) ? homeKey : `${homeKey}${path.sep}`;
  if (targetKey === homeKey || targetKey.startsWith(homePrefix)) {
    throw new Error(
      "Refusing to treat Copilot internal state directory as a Git checkout",
    );
  }
  return resolved;
}

function assertSafeResolvedRepoRoot(repoRoot, sourceCwd) {
  const rootKey = canonicalizeDirectoryKey(repoRoot);
  const cwdKey = canonicalizeDirectoryKey(sourceCwd);
  const userHomeKey = canonicalizeDirectoryKey(os.homedir());
  if (rootKey === userHomeKey && cwdKey !== userHomeKey) {
    throw new Error(
      "Refusing to climb from subdirectory into home-directory Git repository",
    );
  }
  return repoRoot;
}

function sanitizeSegment(raw, fallback = "item", maxLen = 48) {
  const cleaned = String(raw ?? "")
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/\.{2,}/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!cleaned || cleaned === "." || cleaned === "..") return fallback;
  const truncated = cleaned.slice(0, maxLen).replace(/^_+|_+$/g, "");
  if (!truncated || truncated === "." || truncated === "..") return fallback;
  return truncated;
}

function resolveLocalGitTopLevel(startDir) {
  let stat;
  try {
    stat = fs.statSync(startDir);
  } catch {
    return startDir;
  }
  if (!stat.isDirectory()) return startDir;

  let cur = path.resolve(startDir);
  while (true) {
    if (fs.existsSync(path.join(cur, ".git"))) {
      assertSafeResolvedRepoRoot(cur, startDir);
      try {
        return fs.realpathSync.native(cur);
      } catch {
        return cur;
      }
    }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return startDir;
}

export function normalizeDiffSource(
  input = {},
  workspacePath = "",
  { platform = process.platform } = {},
) {
  const hasPr = input?.pr !== undefined && input?.pr !== null;
  const paths = assertSafePathspecs(input?.paths, {
    platform,
    preserveBackslashes: hasPr,
  });
  const hasExplicitAccountProp = typeof input?.account === "string";
  const clearAccount = hasExplicitAccountProp && input.account.trim() === "";
  const account = clearAccount ? null : assertSafeGitHubAccount(input?.account);
  const rawRepo = typeof input?.repo === "string" && input.repo.trim() ? input.repo.trim() : "";

  if (rawRepo && !hasPr) {
    throw new Error("'pr' is required when 'repo' is provided");
  }
  if ((account || clearAccount) && !hasPr) {
    throw new Error("'pr' is required when 'account' is provided");
  }

  const explicitCwd = typeof input?.cwd === "string" && input.cwd.trim() ? input.cwd.trim() : "";
  const implicitCwd =
    !explicitCwd && typeof workspacePath === "string" && workspacePath.trim()
      ? workspacePath.trim()
      : "";

  let candidateCwd = "";
  if (explicitCwd) {
    candidateCwd = assertSafeCheckoutDir(explicitCwd);
  } else if (implicitCwd) {
    try {
      candidateCwd = assertSafeCheckoutDir(implicitCwd);
    } catch {
      candidateCwd = "";
    }
  }

  if (hasPr) {
    const pr = assertSafePrNumber(input.pr);
    const repo = rawRepo ? assertSafeRepoFullName(rawRepo) : null;
    let normalizedPrCwd = null;
    if (!repo && candidateCwd) {
      if (explicitCwd) {
        normalizedPrCwd = resolveLocalGitTopLevel(candidateCwd);
      } else {
        try {
          normalizedPrCwd = resolveLocalGitTopLevel(candidateCwd);
        } catch {
          normalizedPrCwd = "";
        }
      }
    }
    if (!repo && !normalizedPrCwd) {
      throw new Error("Provide 'repo' (owner/repo) or open from a local repository checkout for PR diffs");
    }
    return {
      mode: "pr",
      repo,
      pr,
      ...(account ? { account } : {}),
      ...(clearAccount ? { clearAccount: true } : {}),
      cwd: repo ? null : normalizedPrCwd,
      paths,
    };
  }

  const parsedSpec = parseGitSpec(input?.spec);
  if (!candidateCwd) {
    return null;
  }

  let normalizedGitCwd = candidateCwd;
  if (explicitCwd) {
    normalizedGitCwd = resolveLocalGitTopLevel(candidateCwd);
  } else {
    try {
      normalizedGitCwd = resolveLocalGitTopLevel(candidateCwd);
    } catch {
      return null;
    }
  }

  return {
    mode: "git",
    cwd: normalizedGitCwd,
    spec: parsedSpec.spec,
    paths,
  };
}

export function computeDomainIdForSource(source) {
  if (!source || typeof source !== "object") return "unconfigured";

  const paths = Array.isArray(source.paths) ? source.paths : [];
  const pathsSuffix =
    paths.length > 0
      ? `__p_${createHash("sha256").update(paths.join("\0"), "utf8").digest("hex").slice(0, 8)}`
      : "";

  if (source.mode === "pr") {
    if (source.repo) {
      const [owner = "", repo = ""] = source.repo.toLowerCase().split("/");
      const safeOwner = sanitizeSegment(owner, "owner", 36);
      const safeRepo = sanitizeSegment(repo, "repo", 36);
      const needsRepoDigest =
        safeOwner !== owner ||
        safeRepo !== repo ||
        owner.includes("__") ||
        repo.includes("__");
      const repoDigestSuffix = needsRepoDigest
        ? `__h_${createHash("sha256").update(`${owner}/${repo}`, "utf8").digest("hex").slice(0, 12)}`
        : "";
      return `pr__${safeOwner}__${safeRepo}${repoDigestSuffix}__${source.pr}${pathsSuffix}`;
    }
    if (!source.cwd) return "unconfigured";
    const cwdHash = createHash("sha256")
      .update(canonicalizeDirectoryKey(source.cwd), "utf8")
      .digest("hex")
      .slice(0, 10);
    return `pr__ws_${cwdHash}__${source.pr}${pathsSuffix}`;
  }

  if (source.mode === "git" && source.cwd) {
    const normKey = canonicalizeDirectoryKey(source.cwd);
    const baseName = sanitizeSegment(path.basename(source.cwd), "repo");
    const digest = createHash("sha256")
      .update(`${normKey}\0${source.spec || "default"}\0${paths.join("\0")}`, "utf8")
      .digest("hex")
      .slice(0, 12);
    return `git__${baseName}__${digest}`;
  }

  return "unconfigured";
}

export function computeDomainId(input = {}, workspacePath = "") {
  let source;
  try {
    source = normalizeDiffSource(input, workspacePath);
  } catch {
    return "unconfigured";
  }
  return computeDomainIdForSource(source);
}

export function sanitizePublicErrorMessage(err) {
  const raw = String(err?.message ?? err ?? "Unknown error");
  return raw
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b/g, "<redacted-token>")
    .replace(/[A-Za-z]:[\\/][^\s"'`)]+/g, "<path>")
    .replace(/(?:\\\\|\/\/)[^\s"'`)]+/g, "<path>")
    .replace(
      /(^|[\s"'`=(])\/(?:Users|home|var|private|tmp|opt|etc|mnt|Volumes|root|proc|sys|dev|run|srv|usr|bin|sbin)(?:\/[^\s"'`)]+)+/g,
      "$1<path>",
    )
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

function filterFilesByPaths(parsed, paths, { platform = process.platform } = {}) {
  if (!paths || paths.length === 0) return parsed;
  const hasLiteralCandidate = (spec) => {
    const prefix = spec.endsWith("/") ? spec : `${spec}/`;
    return parsed.files.some((file) => {
      const cands = [
        file.canonicalPath,
        normalizeCanonicalPath(file.oldPath),
        normalizeCanonicalPath(file.newPath),
      ];
      return cands.some((c) => c && (c === spec || c.startsWith(prefix)));
    });
  };
  const allowed = new Set();
  for (const spec of paths) {
    allowed.add(spec);
    if (
      platform === "win32" &&
      spec.includes("\\") &&
      !hasLiteralCandidate(spec)
    ) {
      const winFallback = normalizeCanonicalPath(spec.replaceAll("\\", "/"));
      if (winFallback) allowed.add(winFallback);
    }
  }
  const matches = (candidate) => {
    if (!candidate) return false;
    if (allowed.has(candidate)) return true;
    for (const prefixSpec of allowed) {
      const prefix = prefixSpec.endsWith("/") ? prefixSpec : `${prefixSpec}/`;
      if (candidate.startsWith(prefix)) return true;
    }
    return false;
  };

  const filtered = parsed.files
    .filter(
      (file) =>
        matches(file.canonicalPath) ||
        matches(normalizeCanonicalPath(file.oldPath)) ||
        matches(normalizeCanonicalPath(file.newPath)),
    )
    .map((file, index) => ({ ...file, index }));

  let additions = 0;
  let deletions = 0;
  for (const f of filtered) {
    additions += f.additions;
    deletions += f.deletions;
  }
  const extraTruncated = Math.max(0, (parsed.totalFiles ?? parsed.fileCount) - parsed.files.length);
  return {
    fileCount: filtered.length,
    totalFiles: parsed.truncatedFiles ? filtered.length + extraTruncated : filtered.length,
    additions,
    deletions,
    truncatedFiles: parsed.truncatedFiles,
    files: filtered,
  };
}

async function tryExec(execFn, cmd, args, options) {
  try {
    return await execFn(cmd, args, options);
  } catch {
    return null;
  }
}

async function resolveDefaultBranch(repoRoot, execFn) {
  const originHead = (
    await tryExec(
      execFn,
      "git",
      ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
      { cwd: repoRoot },
    )
  )?.trim();

  const candidates = [originHead, "origin/main", "main", "origin/master", "master"].filter(Boolean);
  const seen = new Set();
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    if (candidate.startsWith("-") || CONTROL_OR_SPACE_RE.test(candidate)) continue;
    const verified = (
      await tryExec(execFn, "git", ["rev-parse", "--verify", "--quiet", `${candidate}^{commit}`], {
        cwd: repoRoot,
      })
    )?.trim();
    if (verified) return candidate;
  }
  return null;
}

async function runGitDiff(execFn, repoRoot, refArgs, paths) {
  const args = [
    "-c",
    "core.quotepath=true",
    "diff",
    "--no-ext-diff",
    "--no-color",
    "--no-textconv",
    "--src-prefix=a/",
    "--dst-prefix=b/",
    ...refArgs,
    "--",
    ...paths,
  ];
  return execFn("git", args, { cwd: repoRoot, maxBuffer: MAX_DIFF_BYTES });
}

function isGhAuthOrNotFoundError(err) {
  const combined = `${err?.message ?? ""} ${err?.stderr ?? ""}`;
  return GH_AUTH_OR_NOT_FOUND_RE.test(combined);
}

async function resolveExplicitAccountToken(account, { execFn, execCwd, untrustedRoots, env }) {
  const expectedKey = encodeCopilotGhAccountEnvKey(account);
  const directVal = typeof env?.[expectedKey] === "string" ? env[expectedKey].trim() : "";
  if (directVal) return directVal;

  const lowerKey = expectedKey.toLowerCase();
  for (const [k, v] of Object.entries(env ?? {})) {
    if (k.toLowerCase() === lowerKey && typeof v === "string" && v.trim()) {
      return v.trim();
    }
  }

  const cliToken = (
    await tryExec(
      execFn,
      "gh",
      ["auth", "token", "--hostname", "github.com", "--user", account],
      { cwd: execCwd, untrustedRoots },
    )
  )?.trim();
  if (cliToken) return cliToken;

  throw new Error(
    `No GitHub token available for account '${account}'. Run 'gh auth login' or link the account in Copilot.`,
  );
}

function collectFallbackAccountTokens(env) {
  const prefix = "COPILOT_GH_ACCOUNT_github_2E_com_";
  const ambient = typeof env?.GH_TOKEN === "string" ? env.GH_TOKEN.trim() : "";
  const seen = new Set();
  if (ambient) seen.add(ambient);
  const tokens = [];
  for (const key of Object.keys(env ?? {}).sort()) {
    if (!key.startsWith(prefix)) continue;
    const raw = env[key];
    const trimmed = typeof raw === "string" ? raw.trim() : "";
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    tokens.push(trimmed);
  }
  return tokens;
}

function formatGitDiffHeaderPath(prefix, relPath) {
  const full = `${prefix}/${relPath}`;
  if (/[ "\\\t]/.test(full)) {
    return `"${full.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\t", "\\t")}"`;
  }
  return full;
}

function concatPatches(first, second) {
  if (!first) return second || "";
  if (!second) return first;
  return first.endsWith("\n") ? `${first}${second}` : `${first}\n${second}`;
}

async function buildUntrackedFilesPatch(
  execFn,
  repoRoot,
  paths,
  {
    currentPatchBytes = 0,
    maxPatchBytes = MAX_DIFF_BYTES,
    maxUntrackedFiles = MAX_UNTRACKED_FILES,
    maxUntrackedFileBytes = MAX_UNTRACKED_FILE_BYTES,
  } = {},
) {
  const rawList = await tryExec(
    execFn,
    "git",
    ["ls-files", "--others", "--exclude-standard", "-z", "--", ...paths],
    { cwd: repoRoot, maxBuffer: maxPatchBytes },
  );
  if (!rawList) {
    return {
      patch: "",
      truncatedFiles: false,
      skippedFiles: 0,
      preTruncatedPaths: new Set(),
    };
  }

  let repoRootReal;
  try {
    repoRootReal = fs.realpathSync.native(repoRoot);
  } catch {
    repoRootReal = path.resolve(repoRoot);
  }

  const rawEntries = rawList.split("\0").filter(Boolean);
  const chunks = [];
  const preTruncatedPaths = new Set();
  let usedBytes = Math.max(0, currentPatchBytes);
  let validCandidateCount = 0;
  let includedCount = 0;
  let truncatedFiles = false;

  for (const rawEntry of rawEntries) {
    const relPath = normalizeCanonicalPath(rawEntry);
    if (!relPath) continue;
    if (process.platform === "win32" && relPath.includes("\\")) continue;

    const absPath = path.resolve(repoRootReal, relPath);
    if (!pathIsWithin(absPath, repoRootReal)) continue;

    let lstat;
    try {
      lstat = fs.lstatSync(absPath);
    } catch {
      continue;
    }
    if (lstat.isSymbolicLink() || !lstat.isFile()) continue;

    try {
      const parentReal = fs.realpathSync.native(path.dirname(absPath));
      if (!pathIsWithin(parentReal, repoRootReal)) continue;
    } catch {
      continue;
    }

    validCandidateCount += 1;
    if (includedCount >= maxUntrackedFiles) {
      truncatedFiles = true;
      continue;
    }

    const headerA = formatGitDiffHeaderPath("a", relPath);
    const headerB = formatGitDiffHeaderPath("b", relPath);

    let chunk = "";
    let fileWasSizeTruncated = false;

    if (lstat.size === 0) {
      chunk = `diff --git ${headerA} ${headerB}\nnew file mode 100644\n--- /dev/null\n+++ ${headerB}\n`;
    } else {
      const toRead = Math.min(lstat.size, maxUntrackedFileBytes);
      let buf = null;
      let bytesRead = 0;
      let fd = null;
      try {
        const flags = (fs.constants.O_RDONLY ?? 0) | (fs.constants.O_NOFOLLOW ?? 0);
        fd = fs.openSync(absPath, flags);
        buf = Buffer.allocUnsafe(toRead);
        while (bytesRead < toRead) {
          const n = fs.readSync(fd, buf, bytesRead, toRead - bytesRead, bytesRead);
          if (n <= 0) break;
          bytesRead += n;
        }
      } catch {
        continue;
      } finally {
        if (fd !== null) {
          try {
            fs.closeSync(fd);
          } catch {
            // Ignore close errors
          }
        }
      }

      const slice = buf.subarray(0, bytesRead);
      const probeLen = Math.min(slice.length, BINARY_PROBE_BYTES);
      const isBinary = slice.subarray(0, probeLen).includes(0);

      if (isBinary) {
        const binaryDigest = createHash("sha256")
          .update(`${lstat.size}:`)
          .update(slice)
          .digest("hex")
          .slice(0, 12);
        chunk =
          `diff --git ${headerA} ${headerB}\n` +
          `new file mode 100644\n` +
          `index 0000000..${binaryDigest}\n` +
          `Binary files /dev/null and ${headerB} differ\n`;
      } else {
        fileWasSizeTruncated = lstat.size > bytesRead;
        let text = slice.toString("utf8");
        if (fileWasSizeTruncated && !text.endsWith("\n")) {
          const lastNl = text.lastIndexOf("\n");
          if (lastNl >= 0) {
            text = text.slice(0, lastNl + 1);
          }
        }
        const endedWithNewline = text.endsWith("\n");
        const rawLines = endedWithNewline ? text.slice(0, -1).split("\n") : text.split("\n");
        const cleanLines = rawLines.map((ln) => (ln.endsWith("\r") ? ln.slice(0, -1) : ln));
        const bodyLines = cleanLines.map((ln) => `+${ln}`);
        if (!endedWithNewline && !fileWasSizeTruncated) {
          bodyLines.push("\\ No newline at end of file");
        }
        chunk =
          `diff --git ${headerA} ${headerB}\n` +
          `new file mode 100644\n` +
          `--- /dev/null\n` +
          `+++ ${headerB}\n` +
          `@@ -0,0 +1,${cleanLines.length} @@\n` +
          `${bodyLines.join("\n")}\n`;
      }
    }

    const chunkBytes = Buffer.byteLength(chunk, "utf8");
    if (usedBytes + chunkBytes > maxPatchBytes) {
      truncatedFiles = true;
      continue;
    }

    usedBytes += chunkBytes;
    includedCount += 1;
    chunks.push(chunk);
    if (fileWasSizeTruncated) {
      preTruncatedPaths.add(relPath);
    }
  }

  return {
    patch: chunks.join(""),
    truncatedFiles,
    skippedFiles: Math.max(0, validCandidateCount - includedCount),
    preTruncatedPaths,
  };
}

const PR_VIEW_JSON_FIELDS =
  "number,title,headRefName,baseRefName,headRefOid,baseRefOid,state";
const MAX_PROBE_WORKTREE_FILES = 400;
const MAX_PROBE_HASH_TOTAL_BYTES = 4 * 1024 * 1024;

function computePrContextSignature(source, meta) {
  if (!meta || typeof meta !== "object") return null;
  const hash = createHash("sha256");
  hash.update(
    JSON.stringify({
      mode: "pr",
      repo: source.repo || null,
      pr: source.pr,
      headRefOid: typeof meta.headRefOid === "string" ? meta.headRefOid : "",
      baseRefOid: typeof meta.baseRefOid === "string" ? meta.baseRefOid : "",
      state: typeof meta.state === "string" ? meta.state : "",
      title: typeof meta.title === "string" ? meta.title.trim() : "",
      headRefName: typeof meta.headRefName === "string" ? meta.headRefName : "",
      baseRefName: typeof meta.baseRefName === "string" ? meta.baseRefName : "",
      paths: Array.isArray(source.paths) ? source.paths : [],
    }),
    "utf8",
  );
  return hash.digest("hex").slice(0, 32);
}

function sliceAfterNthSpace(text, spaceCount) {
  let idx = 0;
  for (let n = 0; n < spaceCount; n += 1) {
    const next = text.indexOf(" ", idx);
    if (next < 0) return "";
    idx = next + 1;
  }
  return text.slice(idx);
}

function extractWorktreeCandidatePathsFromPorcelainV2Z(rawStatus) {
  if (!rawStatus) return [];
  const tokens = rawStatus.split("\0");
  const candidates = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const entry = tokens[i];
    if (!entry) continue;
    if (entry.startsWith("? ")) {
      candidates.push(entry.slice(2));
    } else if (entry.startsWith("1 ")) {
      const xy = entry.slice(2, 4);
      const rel = sliceAfterNthSpace(entry, 8);
      if (xy[1] !== "." && rel) {
        candidates.push(rel);
      }
    } else if (entry.startsWith("2 ")) {
      const xy = entry.slice(2, 4);
      const rel = sliceAfterNthSpace(entry, 9);
      i += 1; // consume NUL-separated <origPath>
      if (xy[1] !== "." && rel) {
        candidates.push(rel);
      }
    } else if (entry.startsWith("u ")) {
      const rel = sliceAfterNthSpace(entry, 10);
      if (rel) {
        candidates.push(rel);
      }
    }
  }
  return candidates;
}

function collectWorktreeFileStamps(repoRoot, rawCandidatePaths) {
  if (!Array.isArray(rawCandidatePaths) || rawCandidatePaths.length === 0) {
    return [];
  }
  let repoRootReal;
  try {
    repoRootReal = fs.realpathSync.native(repoRoot);
  } catch {
    repoRootReal = path.resolve(repoRoot);
  }

  const normalizedUnique = [
    ...new Set(rawCandidatePaths.map((p) => normalizeCanonicalPath(p)).filter(Boolean)),
  ].sort();

  const stamps = [];
  let hashedBytesTotal = 0;

  for (let i = 0; i < normalizedUnique.length && i < MAX_PROBE_WORKTREE_FILES; i += 1) {
    const relPath = normalizedUnique[i];
    if (process.platform === "win32" && relPath.includes("\\")) continue;
    const absPath = path.resolve(repoRootReal, relPath);
    if (!pathIsWithin(absPath, repoRootReal)) continue;

    try {
      const parentReal = fs.realpathSync.native(path.dirname(absPath));
      if (!pathIsWithin(parentReal, repoRootReal)) continue;
    } catch {
      stamps.push(`${relPath}:missing`);
      continue;
    }

    let lstat;
    try {
      lstat = fs.lstatSync(absPath);
    } catch {
      stamps.push(`${relPath}:missing`);
      continue;
    }
    if (lstat.isSymbolicLink()) {
      try {
        const linkTarget = fs.readlinkSync(absPath, "utf8");
        const linkDigest = createHash("sha256")
          .update(linkTarget, "utf8")
          .digest("hex")
          .slice(0, 16);
        stamps.push(`${relPath}:symlink:${linkDigest}`);
      } catch {
        stamps.push(`${relPath}:symlink:unreadable`);
      }
      continue;
    }
    if (!lstat.isFile()) {
      stamps.push(`${relPath}:nonfile:${lstat.mode & 0o170000}`);
      continue;
    }

    const size = lstat.size;
    const mtimeStamp = Number(lstat.mtimeMs).toFixed(3);
    let contentDigest = "";

    if (
      size > 0 &&
      size <= MAX_UNTRACKED_FILE_BYTES &&
      hashedBytesTotal + size <= MAX_PROBE_HASH_TOTAL_BYTES
    ) {
      let fd = null;
      try {
        const flags = (fs.constants.O_RDONLY ?? 0) | (fs.constants.O_NOFOLLOW ?? 0);
        fd = fs.openSync(absPath, flags);
        const buf = Buffer.allocUnsafe(size);
        let bytesRead = 0;
        while (bytesRead < size) {
          const n = fs.readSync(fd, buf, bytesRead, size - bytesRead, bytesRead);
          if (n <= 0) break;
          bytesRead += n;
        }
        hashedBytesTotal += bytesRead;
        contentDigest = createHash("sha256")
          .update(buf.subarray(0, bytesRead))
          .digest("hex")
          .slice(0, 16);
      } catch {
        contentDigest = "unreadable";
      } finally {
        if (fd !== null) {
          try {
            fs.closeSync(fd);
          } catch {
            // Ignore close errors
          }
        }
      }
    }

    stamps.push(`${relPath}:${size}:${mtimeStamp}:${contentDigest}`);
  }

  return stamps;
}

async function computeGitContextSignature(execFn, repoRoot, parsedSpec, paths = []) {
  const revParse = async (ref) =>
    (
      await tryExec(execFn, "git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
        cwd: repoRoot,
      })
    )?.trim() ?? null;
  const mergeBase = async (a, b) =>
    (await tryExec(execFn, "git", ["merge-base", a, b], { cwd: repoRoot }))?.trim() ?? null;

  const branch =
    (await tryExec(execFn, "git", ["branch", "--show-current"], { cwd: repoRoot }))?.trim() ||
    "detached-head";
  const pathTail = paths.length > 0 ? ["--", ...paths] : ["--"];

  if (parsedSpec.kind === "two-dot" || parsedSpec.kind === "three-dot") {
    const baseOid = await revParse(parsedSpec.baseRef);
    if (!baseOid) {
      throw new Error(`Unknown base revision: ${parsedSpec.baseRef}`);
    }
    const headOid = await revParse(parsedSpec.headRef);
    if (!headOid) {
      throw new Error(`Unknown head revision: ${parsedSpec.headRef}`);
    }
    const specExpr =
      parsedSpec.kind === "two-dot"
        ? `${parsedSpec.baseRef}..${parsedSpec.headRef}`
        : `${parsedSpec.baseRef}...${parsedSpec.headRef}`;
    let rawRangeScope = "";
    if (paths.length > 0) {
      rawRangeScope = await execFn(
        "git",
        [
          "-c",
          "core.quotepath=true",
          "diff",
          "--raw",
          "--no-abbrev",
          "--no-ext-diff",
          "--no-color",
          "--no-textconv",
          specExpr,
          "--",
          ...paths,
        ],
        { cwd: repoRoot },
      );
    }
    return createHash("sha256")
      .update(
        JSON.stringify(
          paths.length > 0
            ? {
                mode: "git",
                kind: parsedSpec.kind,
                specExpr,
                paths,
                rawRangeScope,
              }
            : {
                mode: "git",
                kind: parsedSpec.kind,
                specExpr,
                baseOid,
                headOid,
                paths,
              },
        ),
        "utf8",
      )
      .digest("hex")
      .slice(0, 32);
  }

  if (parsedSpec.kind === "staged") {
    const headOid = await revParse("HEAD");
    const stagedRaw = headOid
      ? await execFn(
          "git",
          [
            "-c",
            "core.quotepath=true",
            "diff-index",
            "--cached",
            "--raw",
            "--no-abbrev",
            "--no-ext-diff",
            "HEAD",
            ...pathTail,
          ],
          { cwd: repoRoot },
        )
      : await execFn("git", ["ls-files", "--stage", "-z", ...pathTail], {
          cwd: repoRoot,
        });
    return createHash("sha256")
      .update(
        JSON.stringify({
          mode: "git",
          kind: "staged",
          branch,
          headOid,
          paths,
          stagedRaw,
        }),
        "utf8",
      )
      .digest("hex")
      .slice(0, 32);
  }

  const headOid = await revParse("HEAD");
  let refMeta = null;
  if (parsedSpec.kind === "ref") {
    const resolvedRef = await revParse(parsedSpec.ref);
    if (!resolvedRef) {
      throw new Error(`Unknown revision: ${parsedSpec.ref}`);
    }
    const mbOid = headOid ? ((await mergeBase(parsedSpec.ref, "HEAD")) ?? resolvedRef) : resolvedRef;
    refMeta = { ref: parsedSpec.ref, resolvedRef, mbOid };
  } else if (parsedSpec.kind === "default") {
    const defaultBranch = await resolveDefaultBranch(repoRoot, execFn);
    const defaultOid = defaultBranch ? await revParse(defaultBranch) : null;
    const mbOid = defaultBranch && headOid ? await mergeBase(defaultBranch, "HEAD") : null;
    const prevOid = headOid ? await revParse("HEAD~1") : null;
    refMeta = { defaultBranch, defaultOid, mbOid, prevOid };
  }

  const rawStatus = await execFn(
    "git",
    ["status", "--porcelain=v2", "-z", "--untracked-files=all", ...pathTail],
    { cwd: repoRoot },
  );
  const candidatePaths = extractWorktreeCandidatePathsFromPorcelainV2Z(rawStatus);
  const fileStamps = collectWorktreeFileStamps(repoRoot, candidatePaths);

  return createHash("sha256")
    .update(
      JSON.stringify({
        mode: "git",
        kind: parsedSpec.kind,
        branch,
        headOid,
        refMeta,
        paths,
        rawStatus,
        fileStamps,
      }),
      "utf8",
    )
    .digest("hex")
    .slice(0, 32);
}

async function resolvePrExecutionTarget(source, execFn) {
  let execCwd = os.tmpdir();
  const repoArgs = [];
  if (source.repo) {
    repoArgs.push("--repo", source.repo);
  } else if (source.cwd) {
    assertSafeCheckoutDir(source.cwd);
    let stat;
    try {
      stat = fs.statSync(source.cwd);
    } catch {
      throw new Error("Workspace directory does not exist");
    }
    if (!stat.isDirectory()) {
      throw new Error("Workspace path is not a directory");
    }
    const top = (
      await execFn("git", ["rev-parse", "--show-toplevel"], { cwd: source.cwd })
    ).trim();
    execCwd = assertSafeResolvedRepoRoot(path.resolve(top), source.cwd);
  }
  const untrustedRoots = source.cwd ? [source.cwd] : [];
  const prNumText = String(source.pr);
  const repoLabel = source.repo ? `${source.repo}#${source.pr}` : `PR #${source.pr}`;
  return { execCwd, repoArgs, untrustedRoots, prNumText, repoLabel };
}

async function executePrWithAccountFallback(source, { execFn, env, execCwd, untrustedRoots, repoLabel }, runPrCommands) {
  let resolvedAccount = null;
  let result;
  const explicitAccount = assertSafeGitHubAccount(source.account);
  const preferredAccount =
    !explicitAccount && !source.clearAccount
      ? assertSafeGitHubAccount(source.preferredAccount)
      : null;

  if (explicitAccount) {
    const token = await resolveExplicitAccountToken(explicitAccount, {
      execFn,
      execCwd,
      untrustedRoots,
      env,
    });
    try {
      result = await runPrCommands(token);
      resolvedAccount = explicitAccount;
    } catch (err) {
      if (isGhAuthOrNotFoundError(err)) {
        throw new Error(
          `Unable to load ${repoLabel} with GitHub account '${explicitAccount}': repository not found or account lacks access.`,
        );
      }
      throw err;
    }
  } else {
    let loadedViaPreferred = false;
    if (preferredAccount) {
      let prefToken = null;
      try {
        prefToken = await resolveExplicitAccountToken(preferredAccount, {
          execFn,
          execCwd,
          untrustedRoots,
          env,
        });
      } catch {
        prefToken = null;
      }
      if (prefToken) {
        try {
          result = await runPrCommands(prefToken);
          resolvedAccount = preferredAccount;
          loadedViaPreferred = true;
        } catch (prefErr) {
          if (!isGhAuthOrNotFoundError(prefErr)) {
            throw prefErr;
          }
        }
      }
    }

    if (!loadedViaPreferred) {
      try {
        result = await runPrCommands(null);
      } catch (primaryErr) {
        if (!isGhAuthOrNotFoundError(primaryErr)) {
          throw primaryErr;
        }
        const fallbackTokens = collectFallbackAccountTokens(env);
        let recovered = false;
        for (const candidateToken of fallbackTokens) {
          try {
            result = await runPrCommands(candidateToken);
            recovered = true;
            break;
          } catch (retryErr) {
            if (!isGhAuthOrNotFoundError(retryErr)) {
              throw retryErr;
            }
          }
        }
        if (!recovered) {
          const namedTarget = source.repo || repoLabel;
          throw new Error(
            `Unable to load ${repoLabel}: could not resolve '${namedTarget}' or authenticate with available GitHub accounts. Verify access via 'gh auth status' or pass 'account' in open_canvas input.`,
          );
        }
      }
    }
  }

  return { result, resolvedAccount };
}

export async function probeDiffContext(source, options = {}) {
  if (!source) {
    throw new Error("No diff source configured");
  }
  const execFn = options.execFn ?? defaultExec;
  const env = options.env ?? process.env;

  if (source.mode === "pr") {
    const { execCwd, repoArgs, untrustedRoots, prNumText, repoLabel } =
      await resolvePrExecutionTarget(source, execFn);
    const { result: rawMeta, resolvedAccount } = await executePrWithAccountFallback(
      source,
      { execFn, env, execCwd, untrustedRoots, repoLabel },
      async (tokenOverride) => {
        const envOpt = tokenOverride
          ? { env: { GH_HOST: "github.com", GH_TOKEN: tokenOverride } }
          : {};
        return execFn(
          "gh",
          ["pr", "view", prNumText, ...repoArgs, "--json", PR_VIEW_JSON_FIELDS],
          {
            cwd: execCwd,
            untrustedRoots,
            ...envOpt,
          },
        );
      },
    );
    const meta = JSON.parse(rawMeta);
    return {
      source: {
        mode: "pr",
        repo: source.repo,
        pr: source.pr,
        ...(resolvedAccount ? { account: resolvedAccount } : {}),
        cwd: source.cwd,
        paths: [...(source.paths ?? [])],
      },
      contextSignature: computePrContextSignature(source, meta),
    };
  }

  assertSafeCheckoutDir(source.cwd);
  let cwdStat;
  try {
    cwdStat = fs.statSync(source.cwd);
  } catch {
    throw new Error("Target directory does not exist");
  }
  if (!cwdStat.isDirectory()) {
    throw new Error("Target path is not a directory");
  }

  const repoRoot = assertSafeResolvedRepoRoot(
    path.resolve(
      (await execFn("git", ["rev-parse", "--show-toplevel"], { cwd: source.cwd })).trim(),
    ),
    source.cwd,
  );
  const parsedSpec = parseGitSpec(source.spec);
  const paths = source.paths ?? [];
  const contextSignature = await computeGitContextSignature(
    execFn,
    repoRoot,
    parsedSpec,
    paths,
  );
  return {
    source: {
      ...source,
      cwd: repoRoot,
      paths: [...paths],
    },
    contextSignature,
  };
}

export async function loadDiff(source, options = {}) {
  if (!source) {
    throw new Error("No diff source configured");
  }
  const execFn = options.execFn ?? defaultExec;
  const env = options.env ?? process.env;

  if (source.mode === "pr") {
    const { execCwd, repoArgs, untrustedRoots, prNumText, repoLabel } =
      await resolvePrExecutionTarget(source, execFn);

    const {
      result: [rawPatch, rawMeta],
      resolvedAccount,
    } = await executePrWithAccountFallback(
      source,
      { execFn, env, execCwd, untrustedRoots, repoLabel },
      async (tokenOverride) => {
        const envOpt = tokenOverride
          ? { env: { GH_HOST: "github.com", GH_TOKEN: tokenOverride } }
          : {};
        return Promise.all([
          execFn("gh", ["pr", "diff", prNumText, ...repoArgs, "--color", "never"], {
            cwd: execCwd,
            untrustedRoots,
            maxBuffer: MAX_DIFF_BYTES,
            ...envOpt,
          }),
          tryExec(
            execFn,
            "gh",
            ["pr", "view", prNumText, ...repoArgs, "--json", PR_VIEW_JSON_FIELDS],
            {
              cwd: execCwd,
              untrustedRoots,
              ...envOpt,
            },
          ),
        ]);
      },
    );

    let meta = null;
    if (rawMeta) {
      try {
        meta = JSON.parse(rawMeta);
      } catch {
        meta = null;
      }
    }

    const parsed = filterFilesByPaths(parseDiffPatch(rawPatch), source.paths);
    const prTitle = typeof meta?.title === "string" && meta.title.trim() ? meta.title.trim() : "";
    const title = prTitle ? `${repoLabel} - ${prTitle}` : repoLabel;
    const branch = typeof meta?.headRefName === "string" ? meta.headRefName : "";
    const contextSignature = computePrContextSignature(source, meta);

    return {
      source: {
        mode: "pr",
        repo: source.repo,
        pr: source.pr,
        ...(resolvedAccount ? { account: resolvedAccount } : {}),
        cwd: source.cwd,
        paths: [...(source.paths ?? [])],
      },
      diffSpec: repoLabel,
      title,
      branch,
      contextSignature,
      files: parsed.files,
      truncatedFiles: Boolean(parsed.truncatedFiles),
      stats: {
        fileCount: parsed.fileCount,
        totalFiles: parsed.totalFiles ?? parsed.fileCount,
        additions: parsed.additions,
        deletions: parsed.deletions,
        truncatedFiles: Boolean(parsed.truncatedFiles),
      },
    };
  }

  assertSafeCheckoutDir(source.cwd);
  let cwdStat;
  try {
    cwdStat = fs.statSync(source.cwd);
  } catch {
    throw new Error("Target directory does not exist");
  }
  if (!cwdStat.isDirectory()) {
    throw new Error("Target path is not a directory");
  }

  const repoRoot = assertSafeResolvedRepoRoot(
    path.resolve(
      (await execFn("git", ["rev-parse", "--show-toplevel"], { cwd: source.cwd })).trim(),
    ),
    source.cwd,
  );
  const branch =
    (await tryExec(execFn, "git", ["branch", "--show-current"], { cwd: repoRoot }))?.trim() ||
    "detached-head";

  const revParse = async (ref) =>
    (
      await tryExec(execFn, "git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
        cwd: repoRoot,
      })
    )?.trim() ?? null;
  const mergeBase = async (a, b) =>
    (await tryExec(execFn, "git", ["merge-base", a, b], { cwd: repoRoot }))?.trim() ?? null;

  const parsedSpec = parseGitSpec(source.spec);
  const paths = source.paths ?? [];
  let title = "";
  let rawPatch = "";
  let untrackedMeta = {
    patch: "",
    truncatedFiles: false,
    skippedFiles: 0,
    preTruncatedPaths: new Set(),
  };

  if (parsedSpec.kind === "staged") {
    title = "Staged Changes";
    rawPatch = await runGitDiff(execFn, repoRoot, ["--cached"], paths);
  } else if (parsedSpec.kind === "unstaged") {
    title = "Unstaged Changes";
    const trackedPatch = await runGitDiff(execFn, repoRoot, [], paths);
    untrackedMeta = await buildUntrackedFilesPatch(execFn, repoRoot, paths, {
      currentPatchBytes: Buffer.byteLength(trackedPatch, "utf8"),
    });
    rawPatch = concatPatches(trackedPatch, untrackedMeta.patch);
  } else if (parsedSpec.kind === "two-dot") {
    if (!(await revParse(parsedSpec.baseRef))) {
      throw new Error(`Unknown base revision: ${parsedSpec.baseRef}`);
    }
    if (!(await revParse(parsedSpec.headRef))) {
      throw new Error(`Unknown head revision: ${parsedSpec.headRef}`);
    }
    title = `${parsedSpec.baseRef}..${parsedSpec.headRef}`;
    rawPatch = await runGitDiff(
      execFn,
      repoRoot,
      [`${parsedSpec.baseRef}..${parsedSpec.headRef}`],
      paths,
    );
  } else if (parsedSpec.kind === "three-dot") {
    if (!(await revParse(parsedSpec.baseRef))) {
      throw new Error(`Unknown base revision: ${parsedSpec.baseRef}`);
    }
    if (!(await revParse(parsedSpec.headRef))) {
      throw new Error(`Unknown head revision: ${parsedSpec.headRef}`);
    }
    title = `${parsedSpec.baseRef}...${parsedSpec.headRef}`;
    rawPatch = await runGitDiff(
      execFn,
      repoRoot,
      [`${parsedSpec.baseRef}...${parsedSpec.headRef}`],
      paths,
    );
  } else if (parsedSpec.kind === "ref") {
    const resolvedRef = await revParse(parsedSpec.ref);
    if (!resolvedRef) {
      throw new Error(`Unknown revision: ${parsedSpec.ref}`);
    }
    const headCommit = await revParse("HEAD");
    const mb = headCommit ? ((await mergeBase(parsedSpec.ref, "HEAD")) ?? resolvedRef) : resolvedRef;
    title = `${parsedSpec.ref} vs working tree`;
    const trackedPatch = await runGitDiff(execFn, repoRoot, [mb], paths);
    untrackedMeta = await buildUntrackedFilesPatch(execFn, repoRoot, paths, {
      currentPatchBytes: Buffer.byteLength(trackedPatch, "utf8"),
    });
    rawPatch = concatPatches(trackedPatch, untrackedMeta.patch);
  } else {
    const headCommit = await revParse("HEAD");
    const defaultBranch = await resolveDefaultBranch(repoRoot, execFn);
    let resolved = false;
    let cachedUntracked = null;
    const getUntracked = async (trackedPatch) => {
      const trackedBytes = Buffer.byteLength(trackedPatch, "utf8");
      if (
        cachedUntracked &&
        trackedBytes + Buffer.byteLength(cachedUntracked.patch, "utf8") <= MAX_DIFF_BYTES
      ) {
        return cachedUntracked;
      }
      cachedUntracked = await buildUntrackedFilesPatch(execFn, repoRoot, paths, {
        currentPatchBytes: trackedBytes,
      });
      return cachedUntracked;
    };

    if (defaultBranch && headCommit) {
      const mb = await mergeBase(defaultBranch, "HEAD");
      if (mb) {
        const candidate = await runGitDiff(execFn, repoRoot, [mb], paths);
        const untracked = await getUntracked(candidate);
        if (candidate.trim().length > 0 || untracked.patch.length > 0) {
          title = `${defaultBranch} vs working tree`;
          untrackedMeta = untracked;
          rawPatch = concatPatches(candidate, untracked.patch);
          resolved = true;
        }
      }
    }

    if (!resolved && headCommit) {
      const uncommitted = await runGitDiff(execFn, repoRoot, ["HEAD"], paths);
      const untracked = await getUntracked(uncommitted);
      if (uncommitted.trim().length > 0 || untracked.patch.length > 0) {
        title = "Uncommitted Changes";
        untrackedMeta = untracked;
        rawPatch = concatPatches(uncommitted, untracked.patch);
        resolved = true;
      }
    }

    if (!resolved && headCommit) {
      const prevCommit = await revParse("HEAD~1");
      if (prevCommit) {
        title = "HEAD~1..HEAD";
        rawPatch = await runGitDiff(execFn, repoRoot, [prevCommit, headCommit], paths);
        resolved = true;
      }
    }

    if (!resolved) {
      title = "Working Tree";
      const staged = await runGitDiff(execFn, repoRoot, ["--cached"], paths);
      const tracked =
        staged.trim().length > 0 ? staged : await runGitDiff(execFn, repoRoot, [], paths);
      untrackedMeta = await getUntracked(tracked);
      rawPatch = concatPatches(tracked, untrackedMeta.patch);
    }
  }

  const parsed = parseDiffPatch(rawPatch);
  if (untrackedMeta.preTruncatedPaths.size > 0) {
    for (const file of parsed.files) {
      if (untrackedMeta.preTruncatedPaths.has(file.canonicalPath)) {
        file.truncated = true;
      }
    }
  }
  const truncatedFiles = Boolean(parsed.truncatedFiles || untrackedMeta.truncatedFiles);
  const totalFiles = (parsed.totalFiles ?? parsed.fileCount) + untrackedMeta.skippedFiles;
  let contextSignature = null;
  try {
    contextSignature = await computeGitContextSignature(
      execFn,
      repoRoot,
      parsedSpec,
      paths,
    );
  } catch {
    contextSignature = null;
  }

  return {
    source: {
      ...source,
      cwd: repoRoot,
      paths: [...paths],
    },
    diffSpec: source.spec || title,
    title,
    branch,
    contextSignature,
    files: parsed.files,
    truncatedFiles,
    stats: {
      fileCount: parsed.fileCount,
      totalFiles,
      additions: parsed.additions,
      deletions: parsed.deletions,
      truncatedFiles,
    },
  };
}

export async function resolveCurrentBranchPrNumber(cwd, options = {}) {
  const execFn = options.execFn ?? defaultExec;
  const env = options.env ?? process.env;
  const targetDir = cwd ? path.resolve(cwd) : process.cwd();

  assertSafeCheckoutDir(targetDir);
  let cwdStat;
  try {
    cwdStat = fs.statSync(targetDir);
  } catch {
    throw new Error("Target directory does not exist");
  }
  if (!cwdStat.isDirectory()) {
    throw new Error("Target path is not a directory");
  }

  const repoRoot = assertSafeResolvedRepoRoot(
    path.resolve(
      (await execFn("git", ["rev-parse", "--show-toplevel"], { cwd: targetDir })).trim(),
    ),
    targetDir,
  );
  const untrustedRoots = [targetDir, repoRoot];
  const explicitAccount = assertSafeGitHubAccount(options.account);

  const runViewNumber = (tokenOverride) => {
    const envOpt = tokenOverride
      ? { env: { GH_HOST: "github.com", GH_TOKEN: tokenOverride } }
      : {};
    return execFn("gh", ["pr", "view", "--json", "number"], {
      cwd: repoRoot,
      untrustedRoots,
      timeout: EXEC_TIMEOUT_MS,
      ...envOpt,
    });
  };

  let raw;
  if (explicitAccount) {
    const token = await resolveExplicitAccountToken(explicitAccount, {
      execFn,
      execCwd: repoRoot,
      untrustedRoots,
      env,
    });
    raw = await runViewNumber(token);
  } else {
    try {
      raw = await runViewNumber(null);
    } catch (primaryErr) {
      if (!isGhAuthOrNotFoundError(primaryErr)) {
        throw primaryErr;
      }
      const fallbackTokens = collectFallbackAccountTokens(env);
      let recovered = false;
      for (const candidateToken of fallbackTokens) {
        try {
          raw = await runViewNumber(candidateToken);
          recovered = true;
          break;
        } catch (retryErr) {
          if (!isGhAuthOrNotFoundError(retryErr)) {
            throw retryErr;
          }
        }
      }
      if (!recovered) {
        throw primaryErr;
      }
    }
  }

  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  const num = parsed?.number;
  if (!Number.isInteger(num) || num <= 0) {
    throw new Error("Could not resolve an open pull request number for the current branch");
  }
  return num;
}
