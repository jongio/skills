import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  MAX_DIFF_BYTES,
  assertSafeRepoRelativePath,
  resolveDiffContext,
} from "./diff-spec.mjs";

export const MAX_REVIEW_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_PATCH_FILE_BYTES = MAX_DIFF_BYTES;
export const MAX_COMMENTS_PER_REVIEW = 500;
export const MAX_COMMENT_BODY_CHARS = 16_384;
export const MAX_VIEWED_FILES_PER_REVIEW = 5_000;

const reviewWriteQueues = new Map();

export async function withReviewLock(lockKey, work) {
  const normalizedKey = path.resolve(String(lockKey));
  const previous = reviewWriteQueues.get(normalizedKey) ?? Promise.resolve();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const queued = previous.catch(() => {}).then(() => gate);
  reviewWriteQueues.set(normalizedKey, queued);
  try {
    await previous.catch(() => {});
    return await work();
  } finally {
    release();
    if (reviewWriteQueues.get(normalizedKey) === queued) {
      reviewWriteQueues.delete(normalizedKey);
    }
  }
}

const REPO_SLUG_RE = /^[A-Za-z0-9._-]+__[A-Za-z0-9._-]+$/;
const BRANCH_SLUG_RE = /^[A-Za-z0-9._-]+$/;
const REVIEW_ID_RE = /^[a-f0-9]{7,64}$/;
const REVIEW_PREFIX_RE = /^[a-f0-9]{4,64}$/;
const LINE_NUMBER_RE = /^[1-9][0-9]{0,7}$/;
const FORBIDDEN_BODY_CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;
const VALID_STATUSES = new Set(["draft", "pending", "addressed"]);
const VALID_SIDES = new Set(["left", "right"]);

export function resolveReviewsRoot(overrideDir) {
  const explicit = overrideDir ?? process.env.DIFF_REVIEWS_DIR;
  if (typeof explicit === "string" && explicit.trim().length > 0) {
    return path.resolve(explicit.trim());
  }
  const copilotHome = typeof process.env.COPILOT_HOME === "string" && process.env.COPILOT_HOME.trim().length > 0
    ? path.resolve(process.env.COPILOT_HOME.trim())
    : path.join(os.homedir(), ".copilot");
  return path.join(copilotHome, "diff-reviews");
}

export function assertSafeRepoSlug(repoSlug) {
  if (
    typeof repoSlug !== "string" ||
    repoSlug.length < 4 ||
    repoSlug.length > 160 ||
    repoSlug.includes("..") ||
    !REPO_SLUG_RE.test(repoSlug)
  ) {
    throw new Error(`Invalid repository slug: ${String(repoSlug)}`);
  }
  return repoSlug;
}

export function assertSafeBranchSlug(branchSlug) {
  if (
    typeof branchSlug !== "string" ||
    branchSlug.length < 1 ||
    branchSlug.length > 120 ||
    branchSlug === "." ||
    branchSlug === ".." ||
    branchSlug.includes("..") ||
    !BRANCH_SLUG_RE.test(branchSlug)
  ) {
    throw new Error(`Invalid branch slug: ${String(branchSlug)}`);
  }
  return branchSlug;
}

export function assertSafeReviewId(reviewId) {
  if (typeof reviewId !== "string" || !REVIEW_ID_RE.test(reviewId)) {
    throw new Error(`Invalid review ID: ${String(reviewId)}`);
  }
  return reviewId;
}

export function assertSafeReviewPrefix(prefix) {
  if (typeof prefix !== "string" || !REVIEW_PREFIX_RE.test(prefix)) {
    throw new Error("Review ID lookup prefix must be 4-64 lowercase hex characters");
  }
  return prefix;
}

function safeLstat(targetPath) {
  try {
    return fs.lstatSync(targetPath);
  } catch (error) {
    if (error && (error.code === "ENOENT" || error.code === "ERR_INVALID_ARG_VALUE")) return null;
    throw error;
  }
}

function tryChmod(targetPath, mode) {
  try {
    fs.chmodSync(targetPath, mode);
  } catch {
    // Windows ACLs ignore POSIX mode bits; best-effort enforcement.
  }
}

function assertNoSymlinkChain(rootDir, targetPath) {
  const resolvedRoot = path.resolve(rootDir);
  const resolvedTarget = path.resolve(targetPath);

  const rootStat = safeLstat(resolvedRoot);
  if (rootStat && rootStat.isSymbolicLink()) {
    throw new Error(`Refusing symbolic link reviews root: ${resolvedRoot}`);
  }

  const rel = path.relative(resolvedRoot, resolvedTarget);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Path escapes reviews root: ${resolvedTarget}`);
  }
  if (!rel) return;

  let current = resolvedRoot;
  for (const segment of rel.split(path.sep)) {
    current = path.join(current, segment);
    const st = safeLstat(current);
    if (st && st.isSymbolicLink()) {
      throw new Error(`Refusing symbolic link in review storage path: ${current}`);
    }
  }
}

export function ensureContainedDirectory(reviewsRoot, ...segments) {
  const rootPath = path.resolve(reviewsRoot);
  const rootStat = safeLstat(rootPath);
  if (rootStat) {
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      throw new Error(`Reviews root must be a regular directory: ${rootPath}`);
    }
  } else {
    fs.mkdirSync(rootPath, { recursive: true, mode: 0o700 });
  }
  tryChmod(rootPath, 0o700);

  let current = rootPath;
  for (const seg of segments) {
    if (!seg || seg === "." || seg === ".." || seg.includes("/") || seg.includes("\\")) {
      throw new Error(`Unsafe directory segment: ${String(seg)}`);
    }
    current = path.join(current, seg);
    const st = safeLstat(current);
    if (st) {
      if (st.isSymbolicLink() || !st.isDirectory()) {
        throw new Error(`Review storage path must be a regular directory: ${current}`);
      }
    } else {
      fs.mkdirSync(current, { mode: 0o700 });
    }
    tryChmod(current, 0o700);
  }

  const realRoot = fs.realpathSync.native(rootPath);
  const realDir = fs.realpathSync.native(current);
  const rel = path.relative(realRoot, realDir);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Resolved directory escapes reviews root: ${realDir}`);
  }
  return current;
}

export function getReviewFilePath({ reviewsRoot, repoSlug, branchSlug, reviewId }) {
  const rootDir = resolveReviewsRoot(reviewsRoot);
  const safeRepo = assertSafeRepoSlug(repoSlug);
  const safeBranch = assertSafeBranchSlug(branchSlug);
  const safeId = assertSafeReviewId(reviewId);
  const dir = path.join(rootDir, safeRepo, safeBranch);
  assertNoSymlinkChain(rootDir, dir);
  const filePath = path.join(dir, `review-${safeId}.json`);
  assertNoSymlinkChain(rootDir, filePath);
  return filePath;
}

export function getStaticHtmlFilePath({ reviewsRoot, repoSlug, branchSlug, reviewId }) {
  const rootDir = resolveReviewsRoot(reviewsRoot);
  const safeRepo = assertSafeRepoSlug(repoSlug);
  const safeBranch = assertSafeBranchSlug(branchSlug);
  const safeId = assertSafeReviewId(reviewId);
  const dir = ensureContainedDirectory(rootDir, safeRepo, safeBranch);
  const filePath = path.join(dir, `diff-${safeId}.html`);
  assertNoSymlinkChain(rootDir, filePath);
  return filePath;
}

export function getPatchFilePath({ reviewsRoot, repoSlug, branchSlug, reviewId }) {
  const rootDir = resolveReviewsRoot(reviewsRoot);
  const safeRepo = assertSafeRepoSlug(repoSlug);
  const safeBranch = assertSafeBranchSlug(branchSlug);
  const safeId = assertSafeReviewId(reviewId);
  const dir = path.join(rootDir, safeRepo, safeBranch);
  assertNoSymlinkChain(rootDir, dir);
  const filePath = path.join(dir, `diff-${safeId}.patch`);
  assertNoSymlinkChain(rootDir, filePath);
  return filePath;
}

export function savePatchFile({ reviewsRoot, repoSlug, branchSlug, reviewId, patch }) {
  const rootDir = resolveReviewsRoot(reviewsRoot);
  const text = String(patch ?? "");
  if (Buffer.byteLength(text, "utf8") > MAX_PATCH_FILE_BYTES) {
    throw new Error(`Diff patch exceeds size limit (${MAX_PATCH_FILE_BYTES} bytes)`);
  }
  const filePath = getPatchFilePath({
    reviewsRoot: rootDir,
    repoSlug,
    branchSlug,
    reviewId,
  });
  writeSecureFileAtomic(rootDir, filePath, text);
  return { filePath };
}

export function readPatchFile({ reviewsRoot, repoSlug, branchSlug, reviewId }) {
  const rootDir = resolveReviewsRoot(reviewsRoot);
  const resolved = getPatchFilePath({
    reviewsRoot: rootDir,
    repoSlug,
    branchSlug,
    reviewId,
  });

  const st = safeLstat(resolved);
  if (!st) return null;
  if (st.isSymbolicLink() || !st.isFile()) {
    throw new Error(`Diff patch file is not a regular file: ${resolved}`);
  }
  if (st.size > MAX_PATCH_FILE_BYTES) {
    throw new Error(`Diff patch file exceeds size limit (${MAX_PATCH_FILE_BYTES} bytes): ${resolved}`);
  }

  const realRoot = fs.realpathSync.native(rootDir);
  const realFile = fs.realpathSync.native(resolved);
  const rel = path.relative(realRoot, realFile);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Resolved diff patch file escapes reviews root: ${realFile}`);
  }

  return fs.readFileSync(resolved, "utf8");
}

export function writeSecureFileAtomic(reviewsRoot, targetPath, content) {
  const rootDir = resolveReviewsRoot(reviewsRoot);
  const resolvedTarget = path.resolve(targetPath);
  assertNoSymlinkChain(rootDir, resolvedTarget);

  const parentDir = path.dirname(resolvedTarget);
  const relParent = path.relative(rootDir, parentDir);
  if (!relParent || relParent.startsWith("..") || path.isAbsolute(relParent)) {
    throw new Error(`Target file must reside inside a repository/branch subdirectory of ${rootDir}`);
  }
  ensureContainedDirectory(rootDir, ...relParent.split(path.sep));

  const realRoot = fs.realpathSync.native(rootDir);
  const realParent = fs.realpathSync.native(parentDir);
  const realRel = path.relative(realRoot, realParent);
  if (realRel.startsWith("..") || path.isAbsolute(realRel)) {
    throw new Error(`Target directory escapes reviews root: ${realParent}`);
  }

  const existingStat = safeLstat(resolvedTarget);
  if (existingStat && (existingStat.isSymbolicLink() || !existingStat.isFile())) {
    throw new Error(`Refusing to overwrite non-regular file: ${resolvedTarget}`);
  }

  const nonce = randomBytes(8).toString("hex");
  const tmpPath = path.join(parentDir, `.tmp-${process.pid}-${nonce}`);
  const flags = fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY;
  let fd = -1;
  try {
    fd = fs.openSync(tmpPath, flags, 0o600);
    const bytes = Buffer.isBuffer(content) ? content : Buffer.from(String(content), "utf8");
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = -1;
    tryChmod(tmpPath, 0o600);

    const recheck = safeLstat(resolvedTarget);
    if (recheck && (recheck.isSymbolicLink() || !recheck.isFile())) {
      throw new Error(`Refusing to overwrite non-regular file: ${resolvedTarget}`);
    }
    fs.renameSync(tmpPath, resolvedTarget);
    tryChmod(resolvedTarget, 0o600);
  } catch (error) {
    if (fd !== -1) {
      try { fs.closeSync(fd); } catch {}
    }
    try { fs.rmSync(tmpPath, { force: true }); } catch {}
    throw error;
  }

  return resolvedTarget;
}

export function validateCommentInput(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Comment must be an object");
  }
  const rawFile = typeof raw.file === "string" ? raw.file.trim() : "";
  const normalizedFile = assertSafeRepoRelativePath(rawFile, "Comment file path");

  const line = String(raw.line ?? "").trim();
  if (!LINE_NUMBER_RE.test(line)) {
    throw new Error("Comment line must be a positive integer");
  }

  const side = String(raw.side ?? "").trim();
  if (!VALID_SIDES.has(side)) {
    throw new Error("Comment side must be 'left' or 'right'");
  }

  const body = typeof raw.body === "string" ? raw.body.trim() : "";
  if (!body) {
    throw new Error("Comment body must not be empty");
  }
  if (body.length > MAX_COMMENT_BODY_CHARS) {
    throw new Error(`Comment body exceeds ${MAX_COMMENT_BODY_CHARS} characters`);
  }
  if (FORBIDDEN_BODY_CONTROL_RE.test(body)) {
    throw new Error("Comment body must not contain control or terminal escape characters");
  }

  return {
    id: typeof raw.id === "string" && /^[A-Za-z0-9-]{8,64}$/.test(raw.id) ? raw.id : randomUUID(),
    file: normalizedFile,
    line,
    side,
    body,
    createdAt: typeof raw.createdAt === "string" && raw.createdAt ? raw.createdAt : new Date().toISOString(),
  };
}

function normalizeStatsSummary(stats) {
  if (!stats || typeof stats !== "object" || Array.isArray(stats)) return undefined;
  const toNonNeg = (val) => {
    const n = Number.parseInt(String(val ?? 0), 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  };
  return {
    fileCount: toNonNeg(stats.fileCount),
    additions: toNonNeg(stats.additions),
    deletions: toNonNeg(stats.deletions),
  };
}

export function validateReviewRecord(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new Error("Review record must be a JSON object");
  }
  if (record.version !== 1) {
    throw new Error(`Unsupported review schema version: ${String(record.version)}`);
  }
  const reviewId = assertSafeReviewId(record.reviewId);
  if (!VALID_STATUSES.has(record.status)) {
    throw new Error(`Invalid review status: ${String(record.status)}`);
  }
  if (!Array.isArray(record.comments) || record.comments.length > MAX_COMMENTS_PER_REVIEW) {
    throw new Error(`Review comments must be an array of at most ${MAX_COMMENTS_PER_REVIEW} items`);
  }
  if (record.viewedFiles !== undefined) {
    if (!Array.isArray(record.viewedFiles) || record.viewedFiles.length > MAX_VIEWED_FILES_PER_REVIEW) {
      throw new Error(`Viewed files must be an array of at most ${MAX_VIEWED_FILES_PER_REVIEW} items`);
    }
  }

  const viewedFiles = Array.isArray(record.viewedFiles)
    ? [
        ...new Set(
          record.viewedFiles.map((entry) =>
            assertSafeRepoRelativePath(String(entry ?? "").trim(), "Viewed file path"),
          ),
        ),
      ]
    : [];

  const normalized = {
    version: 1,
    reviewId,
    repoSlug: typeof record.repoSlug === "string" ? assertSafeRepoSlug(record.repoSlug) : undefined,
    branchSlug: typeof record.branchSlug === "string" ? assertSafeBranchSlug(record.branchSlug) : undefined,
    title: typeof record.title === "string" ? record.title.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").slice(0, 512) : "",
    diffSpec: String(record.diffSpec ?? ""),
    branch: String(record.branch ?? ""),
    baseSha: String(record.baseSha ?? ""),
    headSha: String(record.headSha ?? ""),
    createdAt: typeof record.createdAt === "string" && record.createdAt ? record.createdAt : new Date().toISOString(),
    closedAt: typeof record.closedAt === "string" ? record.closedAt : null,
    addressedAt: typeof record.addressedAt === "string" ? record.addressedAt : null,
    status: record.status,
    viewedFiles,
    comments: record.comments.map((c) => validateCommentInput(c)),
  };

  const stats = normalizeStatsSummary(record.stats);
  if (stats) {
    normalized.stats = stats;
  }

  return normalized;
}

export function readReviewFile(reviewsRoot, filePath) {
  const rootDir = resolveReviewsRoot(reviewsRoot);
  const resolved = path.resolve(filePath);
  assertNoSymlinkChain(rootDir, resolved);

  const st = safeLstat(resolved);
  if (!st) return null;
  if (st.isSymbolicLink() || !st.isFile()) {
    throw new Error(`Review file is not a regular file: ${resolved}`);
  }
  if (st.size > MAX_REVIEW_FILE_BYTES) {
    throw new Error(`Review file exceeds size limit (${MAX_REVIEW_FILE_BYTES} bytes): ${resolved}`);
  }

  const realRoot = fs.realpathSync.native(rootDir);
  const realFile = fs.realpathSync.native(resolved);
  const rel = path.relative(realRoot, realFile);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Resolved review file escapes reviews root: ${realFile}`);
  }

  const parsed = JSON.parse(fs.readFileSync(resolved, "utf8"));
  return validateReviewRecord(parsed);
}

export function saveReviewRecord(reviewsRoot, record) {
  const rootDir = resolveReviewsRoot(reviewsRoot);
  const validated = validateReviewRecord(record);
  if (!validated.repoSlug || !validated.branchSlug) {
    throw new Error("Review record requires repoSlug and branchSlug for storage");
  }
  const filePath = getReviewFilePath({
    reviewsRoot: rootDir,
    repoSlug: validated.repoSlug,
    branchSlug: validated.branchSlug,
    reviewId: validated.reviewId,
  });
  writeSecureFileAtomic(rootDir, filePath, `${JSON.stringify(validated, null, 2)}\n`);
  return { filePath, record: validated };
}

export async function prepareDiffReview({
  specArgs = [],
  cwd = process.cwd(),
  reviewsRoot,
  execFn,
} = {}) {
  const rootDir = resolveReviewsRoot(reviewsRoot);
  const ctx = resolveDiffContext(specArgs, { cwd, exec: execFn });
  const reviewFile = getReviewFilePath({
    reviewsRoot: rootDir,
    repoSlug: ctx.repoSlug,
    branchSlug: ctx.branchSlug,
    reviewId: ctx.reviewId,
  });

  return withReviewLock(reviewFile, async () => {
    let existing = null;
    try {
      existing = readReviewFile(rootDir, reviewFile);
    } catch {
      existing = null;
    }

    const statsSummary = {
      fileCount: ctx.stats.fileCount,
      additions: ctx.stats.additions,
      deletions: ctx.stats.deletions,
    };

    const nextRecord = {
      version: 1,
      reviewId: ctx.reviewId,
      repoSlug: ctx.repoSlug,
      branchSlug: ctx.branchSlug,
      title: ctx.title,
      diffSpec: ctx.diffSpec,
      branch: ctx.branch,
      baseSha: ctx.baseSha,
      headSha: ctx.headSha,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      closedAt: existing?.closedAt ?? null,
      addressedAt: existing?.addressedAt ?? null,
      status: existing?.status ?? "draft",
      viewedFiles: existing?.viewedFiles ?? [],
      stats: statsSummary,
      comments: existing?.comments ?? [],
    };

    const savedReview = saveReviewRecord(rootDir, nextRecord);
    const savedPatch = savePatchFile({
      reviewsRoot: rootDir,
      repoSlug: ctx.repoSlug,
      branchSlug: ctx.branchSlug,
      reviewId: ctx.reviewId,
      patch: ctx.patch,
    });

    return {
      status: "prepared",
      reviewId: ctx.reviewId,
      repoSlug: ctx.repoSlug,
      branchSlug: ctx.branchSlug,
      title: ctx.title,
      diffSpec: ctx.diffSpec,
      branch: ctx.branch,
      baseSha: ctx.baseSha,
      headSha: ctx.headSha,
      largeDiffWarning: ctx.largeDiffWarning,
      stats: statsSummary,
      reviewFile: savedReview.filePath,
      patchFile: savedPatch.filePath,
      record: savedReview.record,
      patch: ctx.patch,
    };
  });
}

export function listReviews({ reviewsRoot, repoSlug, includeAddressed = false } = {}) {
  const rootDir = resolveReviewsRoot(reviewsRoot);
  const rootStat = safeLstat(rootDir);
  if (!rootStat) return [];
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(`Reviews root must be a regular directory: ${rootDir}`);
  }

  const repoFilter = repoSlug ? assertSafeRepoSlug(repoSlug) : null;
  const repoDirs = repoFilter
    ? [repoFilter]
    : fs.readdirSync(rootDir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.isSymbolicLink() && REPO_SLUG_RE.test(d.name))
        .map((d) => d.name);

  const results = [];
  for (const rSlug of repoDirs) {
    const rPath = path.join(rootDir, rSlug);
    const rStat = safeLstat(rPath);
    if (!rStat || rStat.isSymbolicLink() || !rStat.isDirectory()) continue;

    const branchEntries = fs.readdirSync(rPath, { withFileTypes: true });
    for (const bEntry of branchEntries) {
      if (!bEntry.isDirectory() || bEntry.isSymbolicLink() || !BRANCH_SLUG_RE.test(bEntry.name)) continue;
      const bPath = path.join(rPath, bEntry.name);
      const fileEntries = fs.readdirSync(bPath, { withFileTypes: true });
      for (const fEntry of fileEntries) {
        if (!fEntry.isFile() || fEntry.isSymbolicLink()) continue;
        const m = fEntry.name.match(/^review-([a-f0-9]{7,64})\.json$/);
        if (!m) continue;
        const fullPath = path.join(bPath, fEntry.name);
        try {
          const record = readReviewFile(rootDir, fullPath);
          if (!record) continue;
          if (!includeAddressed && record.status !== "pending") continue;
          results.push({
            filePath: fullPath,
            repoSlug: record.repoSlug ?? rSlug,
            branchSlug: record.branchSlug ?? bEntry.name,
            record,
          });
        } catch {
          // Skip malformed files when listing rather than crashing discovery
        }
      }
    }
  }

  results.sort((a, b) => String(b.record.createdAt).localeCompare(String(a.record.createdAt)));
  return results;
}

export function findReviewByIdOrPrefix({
  reviewsRoot,
  repoSlug,
  idOrPrefix,
  allowAddressed = false,
  allowedStatuses,
}) {
  const rootDir = resolveReviewsRoot(reviewsRoot);
  const prefix = assertSafeReviewPrefix(idOrPrefix);
  const permitted = new Set(
    Array.isArray(allowedStatuses) && allowedStatuses.length > 0
      ? allowedStatuses
      : allowAddressed
        ? ["pending", "addressed"]
        : ["pending"],
  );
  const all = listReviews({ reviewsRoot: rootDir, repoSlug, includeAddressed: true });
  const matches = all.filter((entry) => {
    if (!permitted.has(entry.record.status)) return false;
    return entry.record.reviewId.startsWith(prefix);
  });

  if (matches.length === 0) return null;
  const exact = matches.find((entry) => entry.record.reviewId === prefix);
  if (exact) return exact;
  if (matches.length > 1) {
    throw new Error(
      `Ambiguous review ID prefix '${prefix}' matches ${matches.length} reviews: ${matches.map((m) => m.record.reviewId).join(", ")}`,
    );
  }
  return matches[0];
}

export function inspectCommentStaleness(repoRoot, comments) {
  const resolvedRepo = path.resolve(repoRoot);
  let realRepo = resolvedRepo;
  try {
    realRepo = fs.realpathSync.native(resolvedRepo);
  } catch {
    // Keep resolved path if realpath fails
  }

  const lineCountCache = new Map();

  return comments.map((comment) => {
    let normalized = "";
    try {
      normalized = assertSafeRepoRelativePath(String(comment.file ?? "").trim(), "Comment file path");
    } catch {
      return { ...comment, stale: true, staleReason: "invalid-path" };
    }

    const candidate = path.resolve(resolvedRepo, normalized);
    const rel = path.relative(resolvedRepo, candidate);
    if (!normalized || rel.startsWith("..") || path.isAbsolute(rel)) {
      return { ...comment, stale: true, staleReason: "invalid-path" };
    }

    const st = safeLstat(candidate);
    if (!st) {
      return { ...comment, stale: true, staleReason: "file-missing" };
    }
    if (st.isSymbolicLink() || !st.isFile()) {
      return { ...comment, stale: true, staleReason: "not-regular-file" };
    }

    let realTarget;
    try {
      realTarget = fs.realpathSync.native(candidate);
      const realRel = path.relative(realRepo, realTarget);
      if (realRel.startsWith("..") || path.isAbsolute(realRel)) {
        return { ...comment, stale: true, staleReason: "symlink-escape" };
      }
    } catch {
      return { ...comment, stale: true, staleReason: "unresolvable-path" };
    }

    if (comment.side === "right") {
      try {
        if (st.size <= 8 * 1024 * 1024) {
          let lineCount = lineCountCache.get(realTarget);
          if (lineCount === undefined) {
            lineCount = fs.readFileSync(candidate, "utf8").split("\n").length;
            lineCountCache.set(realTarget, lineCount);
          }
          const lineNum = Number.parseInt(comment.line, 10);
          if (lineNum > lineCount) {
            return { ...comment, stale: true, staleReason: `line-out-of-range (${lineNum} > ${lineCount})` };
          }
        }
      } catch {
        return { ...comment, stale: true, staleReason: "unreadable-file" };
      }
    }

    return { ...comment, stale: false, staleReason: null };
  });
}
