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

const CONTROL_OR_SPACE_RE = /[\u0000-\u0020\u007f-\u009f]/;
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f-\u009f]/;
const REPO_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
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
  const { stdout } = await execFileAsync(resolvedCommand, effectiveArgs, {
    cwd: options.cwd || os.tmpdir(),
    encoding: "utf8",
    windowsHide: true,
    timeout: options.timeout ?? EXEC_TIMEOUT_MS,
    maxBuffer: options.maxBuffer ?? MAX_DIFF_BYTES,
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
  return stdout;
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
  const normalized = rawPath.replaceAll("\\", "/").replace(/^(?:\.\/)+/, "");
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

export function assertSafePathspecs(paths) {
  if (paths === undefined || paths === null) return [];
  if (!Array.isArray(paths)) throw new Error("paths must be an array of repository-relative paths");
  if (paths.length > 200) throw new Error("paths cannot exceed 200 entries");
  return paths.map((entry) => assertSafeRepoRelativePath(entry, "Path filter"));
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

function sanitizeSegment(raw, fallback = "item") {
  const cleaned = String(raw ?? "")
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/\.{2,}/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!cleaned || cleaned === "." || cleaned === "..") return fallback;
  return cleaned.slice(0, 48);
}

export function normalizeDiffSource(input = {}, workspacePath = "") {
  const paths = assertSafePathspecs(input?.paths);
  const rawRepo = typeof input?.repo === "string" && input.repo.trim() ? input.repo.trim() : "";
  const hasPr = input?.pr !== undefined && input?.pr !== null;

  if (rawRepo && !hasPr) {
    throw new Error("'pr' is required when 'repo' is provided");
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
    if (!repo && !candidateCwd) {
      throw new Error("Provide 'repo' (owner/repo) or open from a local repository checkout for PR diffs");
    }
    return {
      mode: "pr",
      repo,
      pr,
      cwd: repo ? null : candidateCwd,
      paths,
    };
  }

  const parsedSpec = parseGitSpec(input?.spec);
  if (!candidateCwd) {
    return null;
  }

  return {
    mode: "git",
    cwd: candidateCwd,
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
      const [owner, repo] = source.repo.toLowerCase().split("/");
      return `pr__${sanitizeSegment(owner, "owner")}__${sanitizeSegment(repo, "repo")}__${source.pr}${pathsSuffix}`;
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

function filterFilesByPaths(parsed, paths) {
  if (!paths || paths.length === 0) return parsed;
  const allowed = new Set(paths);
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
  return {
    fileCount: filtered.length,
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
    ...refArgs,
    "--",
    ...paths,
  ];
  return execFn("git", args, { cwd: repoRoot, maxBuffer: MAX_DIFF_BYTES });
}

export async function loadDiff(source, options = {}) {
  if (!source) {
    throw new Error("No diff source configured");
  }
  const execFn = options.execFn ?? defaultExec;

  if (source.mode === "pr") {
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

    const prNumText = String(source.pr);
    const [rawPatch, rawMeta] = await Promise.all([
      execFn("gh", ["pr", "diff", prNumText, ...repoArgs, "--color", "never"], {
        cwd: execCwd,
        untrustedRoots: source.cwd ? [source.cwd] : [],
        maxBuffer: MAX_DIFF_BYTES,
      }),
      tryExec(
        execFn,
        "gh",
        [
          "pr",
          "view",
          prNumText,
          ...repoArgs,
          "--json",
          "number,title,headRefName,baseRefName",
        ],
        {
          cwd: execCwd,
          untrustedRoots: source.cwd ? [source.cwd] : [],
        },
      ),
    ]);

    let meta = null;
    if (rawMeta) {
      try {
        meta = JSON.parse(rawMeta);
      } catch {
        meta = null;
      }
    }

    const parsed = filterFilesByPaths(parseDiffPatch(rawPatch), source.paths);
    const repoLabel = source.repo ? `${source.repo}#${source.pr}` : `PR #${source.pr}`;
    const prTitle = typeof meta?.title === "string" && meta.title.trim() ? meta.title.trim() : "";
    const title = prTitle ? `${repoLabel} - ${prTitle}` : repoLabel;
    const branch = typeof meta?.headRefName === "string" ? meta.headRefName : "";

    return {
      source: {
        ...source,
        paths: [...(source.paths ?? [])],
      },
      diffSpec: repoLabel,
      title,
      branch,
      files: parsed.files,
      truncatedFiles: Boolean(parsed.truncatedFiles),
      stats: {
        fileCount: parsed.fileCount,
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

  if (parsedSpec.kind === "staged") {
    title = "Staged Changes";
    rawPatch = await runGitDiff(execFn, repoRoot, ["--cached"], paths);
  } else if (parsedSpec.kind === "unstaged") {
    title = "Unstaged Changes";
    rawPatch = await runGitDiff(execFn, repoRoot, [], paths);
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
    rawPatch = await runGitDiff(execFn, repoRoot, [mb], paths);
  } else {
    const headCommit = await revParse("HEAD");
    const defaultBranch = await resolveDefaultBranch(repoRoot, execFn);
    let resolved = false;

    if (defaultBranch && headCommit) {
      const mb = await mergeBase(defaultBranch, "HEAD");
      if (mb) {
        const candidate = await runGitDiff(execFn, repoRoot, [mb], paths);
        if (candidate.trim().length > 0) {
          title = `${defaultBranch} vs working tree`;
          rawPatch = candidate;
          resolved = true;
        }
      }
    }

    if (!resolved && headCommit) {
      const uncommitted = await runGitDiff(execFn, repoRoot, ["HEAD"], paths);
      if (uncommitted.trim().length > 0) {
        title = "Uncommitted Changes";
        rawPatch = uncommitted;
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
      rawPatch =
        staged.trim().length > 0 ? staged : await runGitDiff(execFn, repoRoot, [], paths);
    }
  }

  const parsed = parseDiffPatch(rawPatch);
  return {
    source: {
      ...source,
      cwd: repoRoot,
      paths: [...paths],
    },
    diffSpec: source.spec || title,
    title,
    branch,
    files: parsed.files,
    truncatedFiles: Boolean(parsed.truncatedFiles),
    stats: {
      fileCount: parsed.fileCount,
      additions: parsed.additions,
      deletions: parsed.deletions,
      truncatedFiles: Boolean(parsed.truncatedFiles),
    },
  };
}
