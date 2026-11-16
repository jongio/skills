import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertSafeBranchSlug,
  assertSafeRepoSlug,
  assertSafeReviewId,
  findReviewByIdOrPrefix,
  getReviewFilePath,
  inspectCommentStaleness,
  listReviews,
  readReviewFile,
  resolveReviewsRoot,
  saveReviewRecord,
  validateCommentInput,
} from "../scripts/review-store.mjs";

function makeTempDir(prefix) {
  const raw = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return fs.realpathSync.native(raw);
}

test("resolveReviewsRoot honors explicit override, DIFF_REVIEWS_DIR, and COPILOT_HOME", () => {
  const prevDiffDir = process.env.DIFF_REVIEWS_DIR;
  const prevCopilotHome = process.env.COPILOT_HOME;
  try {
    const customDir = path.resolve(os.tmpdir(), "custom-diff-reviews-test");
    process.env.DIFF_REVIEWS_DIR = customDir;
    process.env.COPILOT_HOME = "/ignored";
    assert.equal(resolveReviewsRoot(), customDir);

    delete process.env.DIFF_REVIEWS_DIR;
    const copilotHome = path.resolve(os.tmpdir(), "custom-copilot-home");
    process.env.COPILOT_HOME = copilotHome;
    assert.equal(resolveReviewsRoot(), path.join(copilotHome, "diff-reviews"));
  } finally {
    if (prevDiffDir === undefined) delete process.env.DIFF_REVIEWS_DIR;
    else process.env.DIFF_REVIEWS_DIR = prevDiffDir;
    if (prevCopilotHome === undefined) delete process.env.COPILOT_HOME;
    else process.env.COPILOT_HOME = prevCopilotHome;
  }
});

test("slug and reviewId validators reject traversal and malformed tokens", () => {
  assert.throws(() => assertSafeRepoSlug("../escape"), /Invalid repository slug/);
  assert.throws(() => assertSafeBranchSlug("bad/slash"), /Invalid branch slug/);
  assert.throws(() => assertSafeReviewId("NOT-HEX!"), /Invalid review ID/);
  assert.throws(() => assertSafeReviewId("123"), /Invalid review ID/);
  assert.equal(assertSafeReviewId("a1b2c3d4e5f6"), "a1b2c3d4e5f6");
});

test("saveReviewRecord, listReviews, and findReviewByIdOrPrefix persist and query atomically", (t) => {
  const reviewsRoot = makeTempDir("diff-store-test-");
  t.after(() => fs.rmSync(reviewsRoot, { recursive: true, force: true }));

  const first = saveReviewRecord(reviewsRoot, {
    version: 1,
    reviewId: "a1b2c3d4e5f6",
    repoSlug: "example-org__alpha",
    branchSlug: "feat_login",
    branch: "feat/login",
    diffSpec: "default",
    status: "pending",
    comments: [
      { id: "comment-1001", file: "src/auth.ts", line: "14", side: "right", body: "Validate audience claim." },
    ],
  });

  assert.ok(fs.existsSync(first.filePath));
  const loaded = readReviewFile(reviewsRoot, first.filePath);
  assert.equal(loaded.reviewId, "a1b2c3d4e5f6");
  assert.equal(loaded.comments.length, 1);

  saveReviewRecord(reviewsRoot, {
    version: 1,
    reviewId: "a1b2ffff0000",
    repoSlug: "example-org__alpha",
    branchSlug: "feat_login",
    branch: "feat/login",
    diffSpec: "--staged",
    status: "addressed",
    addressedAt: "2026-10-01T00:00:00.000Z",
    comments: [],
  });

  const pendingOnly = listReviews({
    reviewsRoot,
    repoSlug: "example-org__alpha",
    includeAddressed: false,
  });
  assert.equal(pendingOnly.length, 1);
  assert.equal(pendingOnly[0].record.reviewId, "a1b2c3d4e5f6");

  const allEntries = listReviews({
    reviewsRoot,
    repoSlug: "example-org__alpha",
    includeAddressed: true,
  });
  assert.equal(allEntries.length, 2);

  // Prefix match across all reviews finds ambiguous 'a1b2' when allowAddressed=true
  assert.throws(
    () =>
      findReviewByIdOrPrefix({
        reviewsRoot,
        repoSlug: "example-org__alpha",
        idOrPrefix: "a1b2",
        allowAddressed: true,
      }),
    /Ambiguous review ID prefix/,
  );

  // Unambiguous prefix resolves cleanly
  const resolved = findReviewByIdOrPrefix({
    reviewsRoot,
    repoSlug: "example-org__alpha",
    idOrPrefix: "a1b2c3",
    allowAddressed: true,
  });
  assert.equal(resolved.record.reviewId, "a1b2c3d4e5f6");
});

test("review-store rejects symlinked directories under reviewsRoot", (t) => {
  const reviewsRoot = makeTempDir("diff-symlink-root-");
  const outsideDir = makeTempDir("diff-outside-dir-");
  t.after(() => {
    fs.rmSync(reviewsRoot, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  const symlinkRepoDir = path.join(reviewsRoot, "example-org__linked");
  fs.symlinkSync(outsideDir, symlinkRepoDir, "junction");

  assert.throws(
    () =>
      getReviewFilePath({
        reviewsRoot,
        repoSlug: "example-org__linked",
        branchSlug: "main",
        reviewId: "deadbeef1234",
      }),
    /Refusing symbolic link/,
  );
});

test("inspectCommentStaleness flags missing files, out-of-range lines, and traversal attempts", (t) => {
  const repoRoot = makeTempDir("diff-stale-repo-");
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));

  fs.mkdirSync(path.join(repoRoot, "src"), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, "src", "ok.ts"), "line 1\nline 2\nline 3", "utf8");

  const inspected = inspectCommentStaleness(repoRoot, [
    { id: "comment-0001", file: "src/ok.ts", line: "2", side: "right", body: "Looks fine" },
    { id: "comment-0002", file: "src/ok.ts", line: "99", side: "right", body: "Shifted away" },
    { id: "comment-0003", file: "src/deleted.ts", line: "1", side: "right", body: "Gone" },
    { id: "comment-0004", file: "../outside.ts", line: "1", side: "right", body: "Invalid path" },
  ]);

  assert.equal(inspected[0].stale, false);
  assert.equal(inspected[1].stale, true);
  assert.match(inspected[1].staleReason, /line-out-of-range/);
  assert.equal(inspected[2].stale, true);
  assert.equal(inspected[2].staleReason, "file-missing");
  assert.equal(inspected[3].stale, true);
  assert.equal(inspected[3].staleReason, "invalid-path");
});

test("validateCommentInput and findReviewByIdOrPrefix enforce path confinement and pending status", (t) => {
  const reviewsRoot = makeTempDir("diff-store-bounds-");
  t.after(() => fs.rmSync(reviewsRoot, { recursive: true, force: true }));

  assert.throws(
    () => validateCommentInput({ file: ".git/config", line: "1", side: "right", body: "check" }),
    /metadata paths/,
  );
  assert.throws(
    () => validateCommentInput({ file: "C:drive-rel.js", line: "1", side: "right", body: "check" }),
    /repository-relative/,
  );
  assert.throws(
    () => validateCommentInput({ file: "src/ok.js", line: "1", side: "right", body: "bad\u001b[31m" }),
    /control/,
  );

  const literalArrow = validateCommentInput({
    file: "{left => right}/item.ts",
    line: "2",
    side: "right",
    body: "Keep literal path intact.",
  });
  assert.equal(literalArrow.file, "{left => right}/item.ts");

  saveReviewRecord(reviewsRoot, {
    version: 1,
    reviewId: "feedface1234",
    repoSlug: "example-org__alpha",
    branchSlug: "feat_draft",
    branch: "feat/draft",
    diffSpec: "default",
    status: "draft",
    comments: [],
  });

  // Unsubmitted draft records must not match default pending resolution
  const pendingMatch = findReviewByIdOrPrefix({
    reviewsRoot,
    repoSlug: "example-org__alpha",
    idOrPrefix: "feedface",
    allowAddressed: false,
  });
  assert.equal(pendingMatch, null);
});
