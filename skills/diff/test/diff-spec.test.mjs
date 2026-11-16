import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertSafeGitRef,
  assertSafePathspecs,
  computeReviewId,
  normalizeDiffFilePath,
  parseDiffSpecArgs,
  parseRemoteRepoSlug,
  parseUnifiedDiff,
  resolveDiffContext,
  resolveTrustedExecutable,
} from "../scripts/diff-spec.mjs";

function makeTempGitRepo() {
  const rawDir = fs.mkdtempSync(path.join(os.tmpdir(), "diff-spec-test-"));
  const repoDir = fs.realpathSync.native(rawDir);
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: repoDir,
      encoding: "utf8",
      windowsHide: true,
    });

  git("init", "-b", "main");
  git("config", "user.name", "Test Bot");
  git("config", "user.email", "test@example.invalid");
  git("remote", "add", "origin", "https://github.com/example-org/sample-widget.git");
  return { repoDir, git };
}

test("parseDiffSpecArgs handles all supported diff modes and path filters", () => {
  assert.deepEqual(parseDiffSpecArgs([]), { kind: "default", pathspecs: [] });
  assert.deepEqual(parseDiffSpecArgs(["--staged"]), { kind: "staged", pathspecs: [] });
  assert.deepEqual(parseDiffSpecArgs(["--cached", "--", "src/a.js"]), {
    kind: "staged",
    pathspecs: ["src/a.js"],
  });
  assert.deepEqual(parseDiffSpecArgs(["--unstaged"]), { kind: "unstaged", pathspecs: [] });
  assert.deepEqual(parseDiffSpecArgs(["main"]), { kind: "ref", ref: "main", pathspecs: [] });
  assert.deepEqual(parseDiffSpecArgs(["main..feat/ui"]), {
    kind: "two-dot",
    baseRef: "main",
    headRef: "feat/ui",
    pathspecs: [],
  });
  assert.deepEqual(parseDiffSpecArgs(["main...feat/ui"]), {
    kind: "three-dot",
    baseRef: "main",
    headRef: "feat/ui",
    pathspecs: [],
  });
  assert.deepEqual(parseDiffSpecArgs(["pr"]), { kind: "pr", prNumber: null, pathspecs: [] });
  assert.deepEqual(parseDiffSpecArgs(["pr", "42"]), { kind: "pr", prNumber: "42", pathspecs: [] });
});

test("ref and pathspec validators block git option injection, magic prefixes, and traversal", () => {
  assert.throws(() => assertSafeGitRef("--output=/tmp/pwn"), /must not start with '-'/);
  assert.throws(() => assertSafeGitRef("-p"), /must not start with '-'/);
  assert.throws(() => parseDiffSpecArgs(["--upload-pack=evil"]), /Unsupported diff option/);
  assert.throws(() => parseDiffSpecArgs(["pr", "42;whoami"]), /positive integer/);
  assert.throws(() => assertSafePathspecs(["../secret.txt"]), /parent traversal/);
  assert.throws(() => assertSafePathspecs(["/etc/passwd"]), /repository-relative/);
  assert.throws(() => assertSafePathspecs(["C:relative.txt"]), /repository-relative/);
  assert.throws(() => assertSafePathspecs([".git/config"]), /metadata paths/);
  assert.throws(() => assertSafePathspecs(["GIT~1/config"]), /metadata paths/);
  assert.throws(() => assertSafePathspecs([":(top)src"]), /magic prefixes/);
});

test("parseUnifiedDiff preserves literal brace filenames without UI arrow rewriting", () => {
  const literalBraceDiff = [
    "diff --git a/{decoy => src}/auth.ts b/{decoy => src}/auth.ts",
    "new file mode 100644",
    "index 0000000..1111111",
    "--- /dev/null",
    "+++ b/{decoy => src}/auth.ts",
    "@@ -0,0 +1 @@",
    "+export const ok = true;",
  ].join("\n");
  const parsed = parseUnifiedDiff(literalBraceDiff);
  assert.equal(parsed.files[0].canonicalPath, "{decoy => src}/auth.ts");

  const start = performance.now();
  const padded = normalizeDiffFilePath(`${" ".repeat(3500)}tail.ts`);
  assert.equal(padded, "tail.ts");
  assert.ok(performance.now() - start < 200);
});

test("resolveTrustedExecutable skips untrusted repository directories and resolves absolute binary path", (t) => {
  const { repoDir } = makeTempGitRepo();
  t.after(() => fs.rmSync(repoDir, { recursive: true, force: true }));

  const fakeBinName = process.platform === "win32" ? "git.exe" : "git";
  const untrustedBin = path.join(repoDir, fakeBinName);
  fs.writeFileSync(untrustedBin, "stub", { mode: 0o755 });

  const resolvedGit = resolveTrustedExecutable("git", {
    env: {
      ...process.env,
      PATH: `${repoDir}${path.delimiter}${process.env.PATH ?? ""}`,
    },
    platform: process.platform,
    untrustedRoots: [repoDir],
  });
  assert.ok(path.isAbsolute(resolvedGit));
  assert.notEqual(fs.realpathSync.native(resolvedGit), fs.realpathSync.native(untrustedBin));

  assert.throws(
    () =>
      resolveTrustedExecutable("git", {
        env: { ...process.env, PATH: repoDir },
        platform: process.platform,
        untrustedRoots: [repoDir],
      }),
    /untrusted directories|not found/,
  );
});

test("normalizeDiffFilePath and parseUnifiedDiff count blank +/- lines and normalize renames", () => {
  assert.equal(
    normalizeDiffFilePath("packages/{legacy => modern}/index.ts"),
    "packages/modern/index.ts",
  );
  assert.equal(normalizeDiffFilePath("src/old-name.mjs -> src/new-name.mjs"), "src/new-name.mjs");

  const sampleDiff = [
    "diff --git a/src/old.ts b/src/new.ts",
    "similarity index 82%",
    "rename from src/old.ts",
    "rename to src/new.ts",
    "index 1111111..2222222 100644",
    "--- a/src/old.ts",
    "+++ b/src/new.ts",
    "@@ -1,5 +1,6 @@",
    " const header = true;",
    "-const oldLine = '--- fake header';",
    "-",
    "+const newLine = '+++ fake header';",
    "+",
    "+const extraLine = 1;",
    " export default header;",
  ].join("\n");

  const stats = parseUnifiedDiff(sampleDiff);
  assert.equal(stats.fileCount, 1);
  assert.equal(stats.additions, 3);
  assert.equal(stats.deletions, 2);
  assert.equal(stats.files[0].canonicalPath, "src/new.ts");
  assert.equal(stats.files[0].status, "renamed");
});

test("parseRemoteRepoSlug normalizes HTTPS and SSH GitHub URLs safely", () => {
  assert.equal(
    parseRemoteRepoSlug("https://github.com/example-org/sample-repo.git", "fallback"),
    "example-org__sample-repo",
  );
  assert.equal(
    parseRemoteRepoSlug("git@github.com:sample-team/core-service.git", "fallback"),
    "sample-team__core-service",
  );
});

test("resolveDiffContext includes both committed branch work and uncommitted edits on feature branches", (t) => {
  const { repoDir, git } = makeTempGitRepo();
  t.after(() => fs.rmSync(repoDir, { recursive: true, force: true }));

  fs.writeFileSync(path.join(repoDir, "app.txt"), "base line\n", "utf8");
  git("add", "app.txt");
  git("commit", "-m", "initial commit");

  git("checkout", "-b", "feat/demo");
  fs.writeFileSync(path.join(repoDir, "app.txt"), "base line\ncommitted branch line\n", "utf8");
  git("add", "app.txt");
  git("commit", "-m", "branch commit");

  // Also add an unstaged working-tree edit!
  fs.writeFileSync(
    path.join(repoDir, "app.txt"),
    "base line\ncommitted branch line\nunstaged working line\n",
    "utf8",
  );

  const openCtx = resolveDiffContext([], { cwd: repoDir });
  assert.equal(openCtx.repoSlug, "example-org__sample-widget");
  assert.equal(openCtx.branch, "feat/demo");
  assert.match(openCtx.patch, /\+committed branch line/);
  assert.match(openCtx.patch, /\+unstaged working line/);
  assert.equal(openCtx.stats.additions, 2);

  // Canonical reviewId must match identically when `review resolve` re-evaluates!
  const resolveCtx = resolveDiffContext([], { cwd: repoDir });
  assert.equal(resolveCtx.reviewId, openCtx.reviewId);

  // Path-filtered reviewId must differ deterministically from unfiltered reviewId.
  const filteredId = computeReviewId({
    diffSpec: `${openCtx.diffSpec} -- app.txt`,
    baseSha: openCtx.baseSha,
    headSha: openCtx.headSha,
  });
  assert.notEqual(filteredId, openCtx.reviewId);
});

test("resolveDiffContext falls back cleanly on default branch with clean history", (t) => {
  const { repoDir, git } = makeTempGitRepo();
  t.after(() => fs.rmSync(repoDir, { recursive: true, force: true }));

  fs.writeFileSync(path.join(repoDir, "a.txt"), "one\n", "utf8");
  git("add", "a.txt");
  git("commit", "-m", "first");

  // Single-commit clean repo -> empty patch
  const singleCtx = resolveDiffContext([], { cwd: repoDir });
  assert.equal(singleCtx.patch.trim(), "");

  // Second commit on main with clean working tree -> falls back to HEAD~1..HEAD
  fs.writeFileSync(path.join(repoDir, "a.txt"), "one\ntwo\n", "utf8");
  git("add", "a.txt");
  git("commit", "-m", "second");

  const secondCtx = resolveDiffContext([], { cwd: repoDir });
  assert.match(secondCtx.patch, /\+two/);
  assert.equal(secondCtx.diffSpec, "HEAD~1..HEAD");
});
