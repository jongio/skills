import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createCanvasRuntime, CanvasKitError } from "./canvas-kit/server.mjs";
import { validate } from "./canvas-kit/validate.mjs";
import { parseDiffPatch, normalizeRepoRelativePath } from "../scripts/parse-diff.mjs";
import {
  assertSafeBranchSlug,
  assertSafeRepoSlug,
  assertSafeReviewId,
  getReviewFilePath,
  prepareDiffReview,
  readPatchFile,
  readReviewFile,
  resolveReviewsRoot,
  saveReviewRecord,
  validateCommentInput,
  withReviewLock,
} from "../scripts/review-store.mjs";

const ASSETS_DIR = fileURLToPath(new URL("./web", import.meta.url));
const MAX_SPEC_CHARS = 1024;
const MAX_SPEC_TOKENS = 64;
const MAX_COMMENTS_PER_REVIEW = 500;
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/;

export const DIFF_OPEN_INPUT_SCHEMA = {
  type: "object",
  properties: {
    cwd: { type: "string", maxLength: 4096 },
    spec: { type: "string", maxLength: MAX_SPEC_CHARS },
    reviewId: { type: "string", maxLength: 128 },
    repoSlug: { type: "string", maxLength: 200 },
    branchSlug: { type: "string", maxLength: 200 },
    focusFile: { type: "string", maxLength: 4096 },
  },
  additionalProperties: false,
};

export function tokenizeSpecString(spec) {
  if (spec === undefined || spec === null) return [];
  if (typeof spec !== "string") {
    throw new CanvasKitError("invalid_input", "spec must be a string");
  }
  if (spec.length > MAX_SPEC_CHARS || CONTROL_CHAR_RE.test(spec)) {
    throw new CanvasKitError("invalid_input", "spec contains invalid characters or exceeds maximum length");
  }
  const trimmed = spec.trim();
  if (!trimmed) return [];

  const tokens = [];
  let current = "";
  let quote = "";
  for (let i = 0; i < trimmed.length; i += 1) {
    const ch = trimmed[i];
    if (quote) {
      if (ch === "\\" && i + 1 < trimmed.length && trimmed[i + 1] === quote) {
        current += quote;
        i += 1;
        continue;
      }
      if (ch === quote) {
        quote = "";
        continue;
      }
      current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === " " || ch === "\t") {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
        if (tokens.length > MAX_SPEC_TOKENS) {
          throw new CanvasKitError("invalid_input", "spec contains too many arguments");
        }
      }
      continue;
    }
    current += ch;
  }
  if (quote) {
    throw new CanvasKitError("invalid_input", "spec contains an unclosed quote");
  }
  if (current.length > 0) {
    tokens.push(current);
    if (tokens.length > MAX_SPEC_TOKENS) {
      throw new CanvasKitError("invalid_input", "spec contains too many arguments");
    }
  }
  return tokens;
}

export function createEmptyDiffState(error = null) {
  return {
    loaded: false,
    error,
    reviewId: null,
    repoSlug: null,
    branchSlug: null,
    title: "Diff Viewer",
    diffSpec: "",
    branch: "",
    status: "draft",
    createdAt: null,
    closedAt: null,
    addressedAt: null,
    stats: {
      fileCount: 0,
      additions: 0,
      deletions: 0,
    },
    viewedFiles: [],
    comments: [],
    files: [],
    truncatedFiles: false,
    focusedFile: null,
    focusedLine: null,
    focusSeq: 0,
  };
}

export function summarizeReviewState(state) {
  if (!state?.loaded) {
    return {
      loaded: false,
      error: state?.error ?? null,
      reviewId: null,
      status: "draft",
      commentCount: 0,
      comments: [],
      viewedFiles: [],
      stats: { fileCount: 0, additions: 0, deletions: 0 },
    };
  }
  return {
    loaded: true,
    reviewId: state.reviewId,
    repoSlug: state.repoSlug,
    branchSlug: state.branchSlug,
    title: state.title,
    diffSpec: state.diffSpec,
    branch: state.branch,
    status: state.status,
    createdAt: state.createdAt,
    closedAt: state.closedAt,
    addressedAt: state.addressedAt,
    stats: state.stats,
    viewedFiles: state.viewedFiles,
    commentCount: Array.isArray(state.comments) ? state.comments.length : 0,
    comments: state.comments,
  };
}

function parseReviewDomainId(domainId) {
  if (typeof domainId !== "string" || !domainId.startsWith("review:")) return null;
  const parts = domainId.split(":");
  if (parts.length !== 4) return null;
  const [, repoSlug, branchSlug, reviewId] = parts;
  try {
    assertSafeRepoSlug(repoSlug);
    assertSafeBranchSlug(branchSlug);
    assertSafeReviewId(reviewId);
    return { repoSlug, branchSlug, reviewId };
  } catch {
    return null;
  }
}

function makeReviewDomainId({ repoSlug, branchSlug, reviewId }) {
  assertSafeRepoSlug(repoSlug);
  assertSafeBranchSlug(branchSlug);
  assertSafeReviewId(reviewId);
  return `review:${repoSlug}:${branchSlug}:${reviewId}`;
}

function readReviewByCoords({ reviewsRoot, repoSlug, branchSlug, reviewId }) {
  const rootDir = resolveReviewsRoot(reviewsRoot);
  const filePath = getReviewFilePath({
    reviewsRoot: rootDir,
    repoSlug,
    branchSlug,
    reviewId,
  });
  const review = readReviewFile(rootDir, filePath);
  if (!review) return null;
  return { review, filePath, rootDir };
}

function normalizeOptionalFocusFile(rawFocusFile) {
  if (rawFocusFile === undefined || rawFocusFile === null || rawFocusFile === "") return null;
  const normalized = normalizeRepoRelativePath(rawFocusFile);
  if (!normalized) {
    throw new CanvasKitError("invalid_input", "focusFile must be a valid repository-relative path");
  }
  return normalized;
}

function getFileMtimeMs(filePath) {
  try {
    return statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

function toInputOrLoadError(err) {
  if (err instanceof CanvasKitError) return err;
  const msg = String(err?.message ?? err);
  if (/invalid|must be|cannot start with|unknown option|requires|unclosed|disallowed/i.test(msg)) {
    return new CanvasKitError("invalid_input", msg);
  }
  return new CanvasKitError("diff_load_failed", msg);
}

export function createDiffCanvasConfig({
  defaultCwd = "",
  workspacePath = "",
  reviewsRoot,
  syncIntervalMs = 2500,
} = {}) {
  const configuredDefaultCwd = workspacePath || defaultCwd;
  // Keep local filesystem metadata private in Node memory so workstation paths
  // never appear in GET /state, SSE /events, or agent action results.
  const domainMeta = new Map();

  function loadHydratedReview({ repoSlug, branchSlug, reviewId, focusFile = null, focusSeq = 0, loadedCwd = "", loadedSpec = "" }) {
    assertSafeRepoSlug(repoSlug);
    assertSafeBranchSlug(branchSlug);
    assertSafeReviewId(reviewId);

    const found = readReviewByCoords({ reviewsRoot, repoSlug, branchSlug, reviewId });
    if (!found) {
      throw new CanvasKitError("not_found", `Prepared diff review '${reviewId}' was not found`);
    }
    const patch = readPatchFile({ reviewsRoot, repoSlug, branchSlug, reviewId });
    if (patch === null) {
      throw new CanvasKitError("not_found", `Prepared diff patch for '${reviewId}' was not found`);
    }

    const parsed = parseDiffPatch(patch);
    const { review, filePath } = found;
    const stats = {
      fileCount: parsed.fileCount,
      additions: parsed.additions,
      deletions: parsed.deletions,
    };
    const domainId = makeReviewDomainId({ repoSlug, branchSlug, reviewId });
    const prevMeta = domainMeta.get(domainId);
    domainMeta.set(domainId, {
      repoSlug,
      branchSlug,
      reviewId,
      reviewFilePath: filePath,
      lastMtimeMs: getFileMtimeMs(filePath),
      loadedCwd: loadedCwd || prevMeta?.loadedCwd || "",
      loadedSpec: loadedSpec !== "" ? loadedSpec : prevMeta?.loadedSpec || "",
    });

    const normalizedFocus = normalizeOptionalFocusFile(focusFile);
    return {
      loaded: true,
      error: null,
      reviewId: review.reviewId,
      repoSlug,
      branchSlug,
      title: review.title || review.diffSpec || "Diff",
      diffSpec: review.diffSpec || "",
      branch: review.branch || "",
      status: review.status || "draft",
      createdAt: review.createdAt,
      closedAt: review.closedAt ?? null,
      addressedAt: review.addressedAt ?? null,
      stats,
      viewedFiles: Array.isArray(review.viewedFiles) ? [...review.viewedFiles] : [],
      comments: Array.isArray(review.comments) ? [...review.comments] : [],
      files: parsed.files,
      truncatedFiles: Boolean(parsed.truncatedFiles),
      focusedFile: normalizedFocus,
      focusedLine: null,
      focusSeq: normalizedFocus ? Math.max(1, focusSeq) : focusSeq,
    };
  }

  async function resolveReviewInput(input = {}, ctx = {}, currentDomainId = "") {
    const hasReviewId = input.reviewId !== undefined && input.reviewId !== "";
    const hasRepoSlug = input.repoSlug !== undefined && input.repoSlug !== "";
    const hasBranchSlug = input.branchSlug !== undefined && input.branchSlug !== "";

    const existingMeta = currentDomainId ? domainMeta.get(currentDomainId) : null;

    if (hasReviewId || hasRepoSlug || hasBranchSlug) {
      if (!hasReviewId || !hasRepoSlug || !hasBranchSlug) {
        throw new CanvasKitError(
          "invalid_input",
          "reviewId, repoSlug, and branchSlug must all be provided together",
        );
      }
      if (input.cwd !== undefined || input.spec !== undefined) {
        throw new CanvasKitError(
          "invalid_input",
          "Provide either { reviewId, repoSlug, branchSlug } or { cwd, spec }, not both",
        );
      }
      if (
        ctx?.source === "ui" &&
        (!existingMeta ||
          existingMeta.reviewId !== input.reviewId ||
          existingMeta.repoSlug !== input.repoSlug ||
          existingMeta.branchSlug !== input.branchSlug)
      ) {
        throw new CanvasKitError(
          "forbidden_review_switch",
          "UI actions cannot switch active diff review targets",
        );
      }
      return loadHydratedReview({
        repoSlug: input.repoSlug,
        branchSlug: input.branchSlug,
        reviewId: input.reviewId,
        focusFile: input.focusFile,
      });
    }

    const fallbackWorkspace = String(ctx?.workspacePath || configuredDefaultCwd || "").trim();

    if (ctx?.source === "ui" && input.cwd !== undefined) {
      const requested = resolve(String(input.cwd));
      const allowedSet = new Set(
        [existingMeta?.loadedCwd, fallbackWorkspace]
          .filter(Boolean)
          .map((dir) => resolve(dir)),
      );
      if (!allowedSet.has(requested)) {
        throw new CanvasKitError("forbidden_cwd", "UI actions cannot switch repository working directories");
      }
    }

    if (
      ctx?.source === "ui" &&
      input.spec !== undefined &&
      input.spec !== (existingMeta?.loadedSpec || "")
    ) {
      throw new CanvasKitError(
        "forbidden_spec_switch",
        "UI actions cannot switch diff specifications",
      );
    }

    const targetCwd = String(
      input.cwd || existingMeta?.loadedCwd || fallbackWorkspace || "",
    ).trim();

    if (!targetCwd) {
      if (existingMeta?.reviewId) {
        return loadHydratedReview({
          repoSlug: existingMeta.repoSlug,
          branchSlug: existingMeta.branchSlug,
          reviewId: existingMeta.reviewId,
          focusFile: input.focusFile,
        });
      }
      throw new CanvasKitError(
        "missing_target",
        "Provide { reviewId, repoSlug, branchSlug } or { cwd, spec } when opening diff outside a Git workspace",
      );
    }

    const specString = input.spec !== undefined ? input.spec : existingMeta?.loadedSpec || "";
    const specArgs = tokenizeSpecString(specString);

    try {
      const prepared = await prepareDiffReview({
        cwd: targetCwd,
        specArgs,
        reviewsRoot,
      });
      return loadHydratedReview({
        repoSlug: prepared.repoSlug,
        branchSlug: prepared.branchSlug,
        reviewId: prepared.reviewId,
        focusFile: input.focusFile,
        loadedCwd: resolve(targetCwd),
        loadedSpec: specString,
      });
    } catch (err) {
      throw toInputOrLoadError(err);
    }
  }

  function requireLoadedMeta(state, domainId) {
    if (!state?.loaded || !state.reviewId || !state.repoSlug || !state.branchSlug) {
      throw new CanvasKitError("no_diff_loaded", "No diff review is currently loaded");
    }
    const existing = domainMeta.get(domainId);
    const reviewFilePath =
      existing?.reviewId === state.reviewId
        ? existing.reviewFilePath
        : getReviewFilePath({
            reviewsRoot: resolveReviewsRoot(reviewsRoot),
            repoSlug: state.repoSlug,
            branchSlug: state.branchSlug,
            reviewId: state.reviewId,
          });
    return {
      repoSlug: state.repoSlug,
      branchSlug: state.branchSlug,
      reviewId: state.reviewId,
      reviewFilePath,
    };
  }

  function assertFileInDiff(state, filePath) {
    const normalized = normalizeRepoRelativePath(filePath);
    if (!normalized) {
      throw new CanvasKitError("invalid_input", "file must be a valid repository-relative path");
    }
    const exists = Array.isArray(state.files) && state.files.some((f) => f.canonicalPath === normalized);
    if (!exists) {
      throw new CanvasKitError("not_found", `File '${normalized}' is not part of the loaded diff`);
    }
    return normalized;
  }

  return {
    id: "diff",
    displayName: "Diff Viewer",
    description:
      "GitHub-style side-by-side and unified diff viewer with collapsible file tree, inline line comments, viewed tracking, and review submission.",
    inputSchema: DIFF_OPEN_INPUT_SCHEMA,
    requireCapability: true,
    assetsDir: ASSETS_DIR,
    syncIntervalMs,

    resolveDomainId(input = {}, ctx = {}) {
      if (input?.repoSlug && input?.branchSlug && input?.reviewId) {
        return makeReviewDomainId({
          repoSlug: input.repoSlug,
          branchSlug: input.branchSlug,
          reviewId: input.reviewId,
        });
      }
      return `session:${ctx?.sessionId || "default"}`;
    },

    async loadState(domainId) {
      const parsed = parseReviewDomainId(domainId);
      if (!parsed) return null;
      try {
        return loadHydratedReview(parsed);
      } catch {
        return null;
      }
    },

    async createInitialState() {
      return createEmptyDiffState();
    },

    async syncState(domainId) {
      const meta = domainMeta.get(domainId);
      if (!meta?.reviewFilePath) return { changed: false };
      const currentMtime = getFileMtimeMs(meta.reviewFilePath);
      if (!currentMtime || currentMtime === meta.lastMtimeMs) {
        return { changed: false };
      }
      try {
        const nextState = loadHydratedReview({
          repoSlug: meta.repoSlug,
          branchSlug: meta.branchSlug,
          reviewId: meta.reviewId,
          loadedCwd: meta.loadedCwd,
          loadedSpec: meta.loadedSpec,
        });
        return { changed: true, state: nextState };
      } catch {
        return { changed: false };
      }
    },

    statusLine(_ctx, state) {
      if (!state?.loaded) return "Diff Viewer (ready)";
      const count = Array.isArray(state.comments) ? state.comments.length : 0;
      return `${state.title} · ${state.stats.fileCount} files (+${state.stats.additions}/-${state.stats.deletions}) · ${state.status} (${count} comments)`;
    },

    actions: {
      get_review: {
        description:
          "Read the active diff review metadata, status, file stats, viewed files, and inline comments without echoing raw diff hunks.",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        handler: async ({ state }) => summarizeReviewState(state),
      },

      load_diff: {
        description:
          "Load or re-prepare a diff from { reviewId, repoSlug, branchSlug } or { cwd, spec }.",
        inputSchema: DIFF_OPEN_INPUT_SCHEMA,
        handler: async ({ state, set, input, ctx }) => {
          const next = await resolveReviewInput(input, ctx, ctx?.domainId || "");
          if (next.loaded && next.focusedFile) {
            next.focusSeq = (state?.focusSeq || 0) + 1;
          }
          // Record active review metadata under this domainId as well so follow-up
          // actions on session-keyed domains find the exact review file.
          if (ctx?.domainId && next.loaded) {
            const canonicalId = makeReviewDomainId(next);
            const canonicalMeta = domainMeta.get(canonicalId);
            if (canonicalMeta) {
              domainMeta.set(ctx.domainId, { ...canonicalMeta });
            }
          }
          set(next);
          return summarizeReviewState(next);
        },
      },

      focus_file: {
        description: "Focus and scroll the viewer to a changed file (and optional 1-based line number).",
        inputSchema: {
          type: "object",
          required: ["file"],
          properties: {
            file: { type: "string", minLength: 1, maxLength: 4096 },
            line: { type: "integer", minimum: 1 },
          },
          additionalProperties: false,
        },
        handler: async ({ state, set, input }) => {
          if (!state?.loaded) {
            throw new CanvasKitError("no_diff_loaded", "No diff review is currently loaded");
          }
          const normalizedFile = assertFileInDiff(state, input.file);
          const focusedLine = input.line ?? null;
          set((cur) => ({
            ...cur,
            focusedFile: normalizedFile,
            focusedLine,
            focusSeq: (cur.focusSeq || 0) + 1,
          }));
          return { focusedFile: normalizedFile, focusedLine };
        },
      },

      toggle_viewed: {
        description: "Toggle the viewed state of a changed file and persist it in the review record.",
        inputSchema: {
          type: "object",
          required: ["file"],
          properties: {
            file: { type: "string", minLength: 1, maxLength: 4096 },
          },
          additionalProperties: false,
        },
        handler: async ({ state, set, input, ctx }) => {
          const meta = requireLoadedMeta(state, ctx?.domainId || "");
          const normalizedFile = assertFileInDiff(state, input.file);

          return withReviewLock(meta.reviewFilePath, async () => {
            const found = readReviewByCoords({
              reviewsRoot,
              repoSlug: meta.repoSlug,
              branchSlug: meta.branchSlug,
              reviewId: meta.reviewId,
            });
            if (!found) {
              throw new CanvasKitError("not_found", "Review file no longer exists");
            }
            const viewedSet = new Set(Array.isArray(found.review.viewedFiles) ? found.review.viewedFiles : []);
            let viewed;
            if (viewedSet.has(normalizedFile)) {
              viewedSet.delete(normalizedFile);
              viewed = false;
            } else {
              viewedSet.add(normalizedFile);
              viewed = true;
            }
            const viewedFiles = [...viewedSet];
            const updated = { ...found.review, viewedFiles };
            saveReviewRecord(found.rootDir, updated);
            const mtime = getFileMtimeMs(found.filePath);
            if (ctx?.domainId && domainMeta.has(ctx.domainId)) {
              domainMeta.get(ctx.domainId).lastMtimeMs = mtime;
            }
            const canonicalKey = makeReviewDomainId(meta);
            if (domainMeta.has(canonicalKey)) {
              domainMeta.get(canonicalKey).lastMtimeMs = mtime;
            }

            set((cur) => ({ ...cur, viewedFiles }));
            return { file: normalizedFile, viewed, viewedCount: viewedFiles.length };
          });
        },
      },

      add_comment: {
        description: "Add an inline review comment on a diff file and line while the review is in draft status.",
        inputSchema: {
          type: "object",
          required: ["file", "line", "side", "body"],
          properties: {
            file: { type: "string", minLength: 1, maxLength: 4096 },
            line: { type: ["integer", "string"] },
            side: { type: "string", enum: ["left", "right"] },
            body: { type: "string", minLength: 1, maxLength: 16384 },
          },
          additionalProperties: false,
        },
        handler: async ({ state, set, input, ctx }) => {
          const meta = requireLoadedMeta(state, ctx?.domainId || "");
          let validated;
          try {
            validated = validateCommentInput(input);
          } catch (err) {
            throw new CanvasKitError("invalid_input", String(err?.message ?? err));
          }
          assertFileInDiff(state, validated.file);

          return withReviewLock(meta.reviewFilePath, async () => {
            const found = readReviewByCoords({
              reviewsRoot,
              repoSlug: meta.repoSlug,
              branchSlug: meta.branchSlug,
              reviewId: meta.reviewId,
            });
            if (!found) {
              throw new CanvasKitError("not_found", "Review file no longer exists");
            }
            if (found.review.status !== "draft") {
              throw new CanvasKitError("review_locked", "Inline comments are only allowed while the review is in draft status");
            }
            if (found.review.comments.length >= MAX_COMMENTS_PER_REVIEW) {
              throw new CanvasKitError("comment_limit_reached", "Maximum comments per review reached");
            }
            const comment = {
              id: randomUUID(),
              file: validated.file,
              line: validated.line,
              side: validated.side,
              body: validated.body,
              createdAt: new Date().toISOString(),
            };
            const comments = [...found.review.comments, comment];
            const updated = { ...found.review, comments };
            saveReviewRecord(found.rootDir, updated);
            const mtime = getFileMtimeMs(found.filePath);
            if (ctx?.domainId && domainMeta.has(ctx.domainId)) {
              domainMeta.get(ctx.domainId).lastMtimeMs = mtime;
            }
            const canonicalKey = makeReviewDomainId(meta);
            if (domainMeta.has(canonicalKey)) {
              domainMeta.get(canonicalKey).lastMtimeMs = mtime;
            }

            set((cur) => ({ ...cur, comments }));
            return { comment, commentCount: comments.length };
          });
        },
      },

      delete_comment: {
        description: "Delete a draft inline review comment by ID.",
        inputSchema: {
          type: "object",
          required: ["id"],
          properties: {
            id: { type: "string", minLength: 1, maxLength: 128 },
          },
          additionalProperties: false,
        },
        handler: async ({ state, set, input, ctx }) => {
          const meta = requireLoadedMeta(state, ctx?.domainId || "");
          const targetId = String(input.id).trim();
          if (!targetId) {
            throw new CanvasKitError("invalid_input", "id must not be empty");
          }

          return withReviewLock(meta.reviewFilePath, async () => {
            const found = readReviewByCoords({
              reviewsRoot,
              repoSlug: meta.repoSlug,
              branchSlug: meta.branchSlug,
              reviewId: meta.reviewId,
            });
            if (!found) {
              throw new CanvasKitError("not_found", "Review file no longer exists");
            }
            if (found.review.status !== "draft") {
              throw new CanvasKitError("review_locked", "Deleting comments is only allowed while the review is in draft status");
            }
            const comments = found.review.comments.filter((c) => c.id !== targetId);
            const deleted = comments.length !== found.review.comments.length;
            if (!deleted) {
              throw new CanvasKitError("not_found", `Comment '${targetId}' was not found`);
            }
            const updated = { ...found.review, comments };
            saveReviewRecord(found.rootDir, updated);
            const mtime = getFileMtimeMs(found.filePath);
            if (ctx?.domainId && domainMeta.has(ctx.domainId)) {
              domainMeta.get(ctx.domainId).lastMtimeMs = mtime;
            }
            const canonicalKey = makeReviewDomainId(meta);
            if (domainMeta.has(canonicalKey)) {
              domainMeta.get(canonicalKey).lastMtimeMs = mtime;
            }

            set((cur) => ({ ...cur, comments }));
            return { deleted: true, commentCount: comments.length };
          });
        },
      },

      submit_review: {
        description: "Submit the active draft review so status transitions to pending.",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        handler: async ({ state, set, ctx }) => {
          const meta = requireLoadedMeta(state, ctx?.domainId || "");
          return withReviewLock(meta.reviewFilePath, async () => {
            const found = readReviewByCoords({
              reviewsRoot,
              repoSlug: meta.repoSlug,
              branchSlug: meta.branchSlug,
              reviewId: meta.reviewId,
            });
            if (!found) {
              throw new CanvasKitError("not_found", "Review file no longer exists");
            }
            if (found.review.status === "addressed") {
              throw new CanvasKitError("review_locked", "Review has already been addressed");
            }
            const closedAt = found.review.closedAt || new Date().toISOString();
            const updated = {
              ...found.review,
              status: "pending",
              closedAt,
            };
            saveReviewRecord(found.rootDir, updated);
            const mtime = getFileMtimeMs(found.filePath);
            if (ctx?.domainId && domainMeta.has(ctx.domainId)) {
              domainMeta.get(ctx.domainId).lastMtimeMs = mtime;
            }
            const canonicalKey = makeReviewDomainId(meta);
            if (domainMeta.has(canonicalKey)) {
              domainMeta.get(canonicalKey).lastMtimeMs = mtime;
            }

            set((cur) => ({
              ...cur,
              status: "pending",
              closedAt,
            }));
            return {
              reviewId: updated.reviewId,
              status: "pending",
              closedAt,
              commentCount: updated.comments.length,
            };
          });
        },
      },

      mark_addressed: {
        description: "Mark the active review as addressed after triage or remediation.",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        handler: async ({ state, set, ctx }) => {
          const meta = requireLoadedMeta(state, ctx?.domainId || "");
          return withReviewLock(meta.reviewFilePath, async () => {
            const found = readReviewByCoords({
              reviewsRoot,
              repoSlug: meta.repoSlug,
              branchSlug: meta.branchSlug,
              reviewId: meta.reviewId,
            });
            if (!found) {
              throw new CanvasKitError("not_found", "Review file no longer exists");
            }
            const addressedAt = new Date().toISOString();
            const closedAt = found.review.closedAt || addressedAt;
            const updated = {
              ...found.review,
              status: "addressed",
              closedAt,
              addressedAt,
            };
            saveReviewRecord(found.rootDir, updated);
            const mtime = getFileMtimeMs(found.filePath);
            if (ctx?.domainId && domainMeta.has(ctx.domainId)) {
              domainMeta.get(ctx.domainId).lastMtimeMs = mtime;
            }
            const canonicalKey = makeReviewDomainId(meta);
            if (domainMeta.has(canonicalKey)) {
              domainMeta.get(canonicalKey).lastMtimeMs = mtime;
            }

            set((cur) => ({
              ...cur,
              status: "addressed",
              closedAt,
              addressedAt,
            }));
            return {
              reviewId: updated.reviewId,
              status: "addressed",
              addressedAt,
            };
          });
        },
      },
    },
  };
}

export function createDiffCanvasRuntime(options = {}) {
  const config = createDiffCanvasConfig(options);
  const base = createCanvasRuntime(config);

  async function openInstance({ instanceId, input = {}, ctx = {} }) {
    const schemaErrors = validate(config.inputSchema, input ?? {}, "open input");
    if (schemaErrors.length > 0) {
      throw new CanvasKitError("invalid_input", `Invalid open input: ${schemaErrors.join("; ")}`);
    }

    const normalizedInput = { ...(input ?? {}) };
    const hasReviewCoords =
      Boolean(normalizedInput.reviewId) ||
      Boolean(normalizedInput.repoSlug) ||
      Boolean(normalizedInput.branchSlug);

    let effectiveOpenInput = normalizedInput;
    let pendingLoadInput = null;

    if (hasReviewCoords) {
      if (!normalizedInput.reviewId || !normalizedInput.repoSlug || !normalizedInput.branchSlug) {
        throw new CanvasKitError(
          "invalid_input",
          "reviewId, repoSlug, and branchSlug must all be provided together",
        );
      }
      if (normalizedInput.cwd !== undefined || normalizedInput.spec !== undefined) {
        throw new CanvasKitError(
          "invalid_input",
          "Provide either { reviewId, repoSlug, branchSlug } or { cwd, spec }, not both",
        );
      }
      pendingLoadInput = normalizedInput;
    } else {
      const candidateCwd = String(
        normalizedInput.cwd || ctx?.workspacePath || options.workspacePath || options.defaultCwd || "",
      ).trim();
      const explicitTarget = normalizedInput.cwd !== undefined || normalizedInput.spec !== undefined;

      if (candidateCwd) {
        try {
          const specArgs = tokenizeSpecString(normalizedInput.spec);
          const prepared = await prepareDiffReview({
            cwd: candidateCwd,
            specArgs,
            reviewsRoot: options.reviewsRoot,
          });
          effectiveOpenInput = {
            reviewId: prepared.reviewId,
            repoSlug: prepared.repoSlug,
            branchSlug: prepared.branchSlug,
            ...(normalizedInput.focusFile ? { focusFile: normalizedInput.focusFile } : {}),
          };
          pendingLoadInput = {
            cwd: candidateCwd,
            ...(normalizedInput.spec !== undefined ? { spec: normalizedInput.spec } : {}),
            ...(normalizedInput.focusFile ? { focusFile: normalizedInput.focusFile } : {}),
          };
        } catch (err) {
          if (explicitTarget) {
            throw toInputOrLoadError(err);
          }
          // Default workspacePath is not a Git repository (for example a coordinator
          // Project session opened with `{}`): open cleanly in ready state.
          effectiveOpenInput = {};
        }
      } else if (explicitTarget) {
        throw new CanvasKitError(
          "missing_target",
          "Provide cwd or { reviewId, repoSlug, branchSlug } when opening diff outside a Git workspace",
        );
      }
    }

    const opened = await base.openInstance({
      instanceId,
      input: effectiveOpenInput,
      ctx,
    });

    if (pendingLoadInput) {
      await base.invokeFromAgent("load_diff", pendingLoadInput, {
        ...ctx,
        instanceId,
      });
    }

    return opened;
  }

  return {
    ...base,
    config,
    openInstance,
  };
}
