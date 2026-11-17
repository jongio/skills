import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { createCanvasRuntime } from "../runtime/canvas-kit/server.mjs";
import { userStore } from "../runtime/canvas-kit/storage.mjs";
import { hasIcon } from "../runtime/canvas-kit/icons.mjs";
import { html, render } from "../runtime/canvas-kit/vendor/preact-htm-standalone.mjs";
import {
  computeFileFingerprint,
  createDiffCanvasConfig,
  isDomainCached,
  isDomainHydrated,
  openDiffInstance,
  reconcileViewedFiles,
} from "../runtime/canvas.mjs";
import {
  assertSafeCheckoutDir,
  assertSafeGitHubAccount,
  assertSafeGitRef,
  assertSafePathspecs,
  assertSafePrNumber,
  assertSafeRepoFullName,
  computeDomainId,
  encodeCopilotGhAccountEnvKey,
  loadDiff,
  probeDiffContext,
} from "../runtime/diff-loader.mjs";
import { parseDiffPatch } from "../runtime/parse-diff.mjs";
import { applySetup, findInstalledPluginDiffExtension, planSetup } from "../scripts/setup.mjs";

function makeTempDir(prefix) {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

async function* sseSnapshots(reader) {
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    let boundary;
    while ((boundary = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      if (frame.startsWith("data: ")) {
        yield JSON.parse(frame.slice(6));
      }
    }
  }
}

function capEndpoint(pathname, panelUrl) {
  const base = new URL(panelUrl);
  const url = new URL(pathname, base);
  url.search = base.search;
  return url;
}

test("diff-loader input guards reject option injection, path traversal, and malformed PR targets", () => {
  assert.equal(assertSafeRepoFullName("example-org/api-gateway"), "example-org/api-gateway");
  assert.throws(() => assertSafeRepoFullName("../evil"), /Invalid repository/);
  assert.throws(() => assertSafeRepoFullName("-flag/repo"), /Invalid repository/);

  assert.equal(assertSafeGitHubAccount("sample_emu"), "sample_emu");
  assert.equal(assertSafeGitHubAccount("example-user"), "example-user");
  assert.equal(
    encodeCopilotGhAccountEnvKey("sample_emu-dev"),
    "COPILOT_GH_ACCOUNT_github_2E_com_sample_5F_emu_2D_dev",
  );
  assert.throws(() => assertSafeGitHubAccount("-bad"), /Invalid GitHub account/);
  assert.throws(() => assertSafeGitHubAccount("bad/slash"), /Invalid GitHub account/);

  assert.equal(assertSafePrNumber(293), 293);
  assert.equal(assertSafePrNumber("42"), 42);
  assert.throws(() => assertSafePrNumber(0), /positive integer/);
  assert.throws(() => assertSafePrNumber("42abc"), /positive integer/);

  assert.equal(assertSafeGitRef("origin/main"), "origin/main");
  assert.throws(() => assertSafeGitRef("--output=/tmp/pwn"), /cannot start with '-' or ':'/);
  assert.throws(() => assertSafeGitRef(":/search"), /cannot start with '-' or ':'/);

  assert.deepEqual(assertSafePathspecs(["src\\router.ts", "./src/auth.ts"]), [
    "src/router.ts",
    "src/auth.ts",
  ]);
  assert.throws(() => assertSafePathspecs(["../outside.ts"]), /parent traversal/);
  assert.throws(() => assertSafePathspecs([":(top)secret"]), /magic prefixes/);

  const fakeCopilotHome = makeTempDir("diff-copilot-home-");
  try {
    assert.throws(
      () =>
        assertSafeCheckoutDir(path.join(fakeCopilotHome, "session-state", "abc"), {
          COPILOT_HOME: fakeCopilotHome,
        }),
      /Copilot internal state directory/,
    );
  } finally {
    fs.rmSync(fakeCopilotHome, { recursive: true, force: true });
  }
});

test("diff-loader refuses climbing from a subdirectory into a home-directory Git repository", async (t) => {
  const subDir = makeTempDir("diff-subdir-");
  t.after(() => fs.rmSync(subDir, { recursive: true, force: true }));

  await assert.rejects(
    () =>
      loadDiff(
        { mode: "git", cwd: subDir, spec: "", paths: [] },
        {
          execFn: async () => `${os.homedir()}\n`,
        },
      ),
    /home-directory Git repository/,
  );
});

test("local Git mode loads merge-base + working-tree diffs, enforces capability/origin/source guards, and streams SSE updates", async (t) => {
  const repoDir = makeTempDir("diff-canvas-git-");
  const coordinatorDir = makeTempDir("diff-canvas-coord-");
  const storeHome = makeTempDir("diff-canvas-home-");
  const prevHome = process.env.COPILOT_HOME;
  process.env.COPILOT_HOME = storeHome;

  t.after(() => {
    if (prevHome === undefined) delete process.env.COPILOT_HOME;
    else process.env.COPILOT_HOME = prevHome;
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(coordinatorDir, { recursive: true, force: true });
    fs.rmSync(storeHome, { recursive: true, force: true });
  });

  const git = (...args) =>
    execFileSync("git", args, { cwd: repoDir, encoding: "utf8", windowsHide: true });
  git("init", "-b", "main");
  git("config", "user.name", "Canvas Test");
  git("config", "user.email", "canvas@example.invalid");
  git("remote", "add", "origin", "https://github.com/example-org/canvas-demo.git");

  fs.mkdirSync(path.join(repoDir, "src"), { recursive: true });
  fs.writeFileSync(path.join(repoDir, "src", "service.ts"), "export const v = 1;\n", "utf8");
  git("add", ".");
  git("commit", "-m", "initial");

  // Record origin/main ref so default merge-base resolution exercises origin/main
  const mainSha = git("rev-parse", "HEAD").trim();
  git("update-ref", "refs/remotes/origin/main", mainSha);

  git("checkout", "-b", "feat/canvas");
  fs.writeFileSync(path.join(repoDir, "src", "service.ts"), "export const v = 2;\n", "utf8");
  git("add", ".");
  git("commit", "-m", "branch commit");

  // Also add an unstaged working-tree edit to confirm default diff includes both committed + working-tree changes
  fs.writeFileSync(
    path.join(repoDir, "src", "service.ts"),
    "export const v = 2;\nexport const extra = '</script>';\n",
    "utf8",
  );

  const diffConfig = createDiffCanvasConfig();
  assert.equal(diffConfig.isDomainHydrated({ cwd: repoDir }, { workspacePath: coordinatorDir }), false);

  const runtime = createCanvasRuntime(diffConfig);
  t.after(() => runtime.shutdown());

  // 1. Coordinator non-git empty open lands cleanly in unloaded ready state without leaking workstation paths
  const readyPanel = await runtime.openInstance({
    instanceId: "coord-ready",
    input: {},
    ctx: { workspacePath: coordinatorDir },
  });
  const readyState = await fetch(capEndpoint("/state", readyPanel.url)).then((r) => r.json());
  assert.equal(readyState.loaded, false);
  assert.equal(readyState.diffRev, 0);
  assert.equal(readyState.status, "draft");
  assert.equal(JSON.stringify(readyState).includes(coordinatorDir), false);
  await runtime.closeInstance("coord-ready");

  // 2. Open repo default diff across two panels and verify capability token + Sec-Fetch-Site + Origin + removed load_diff
  const panelOne = await runtime.openInstance({
    instanceId: "diff-1",
    input: { cwd: repoDir },
    ctx: { workspacePath: coordinatorDir },
  });
  assert.equal(diffConfig.isDomainHydrated({ cwd: repoDir }, { workspacePath: coordinatorDir }), true);
  assert.equal(
    diffConfig.isDomainHydrated({ cwd: repoDir, spec: "--staged" }, { workspacePath: coordinatorDir }),
    false,
  );
  const panelTwo = await runtime.openInstance({
    instanceId: "diff-2",
    input: { cwd: repoDir, focusFile: "src/service.ts" },
    ctx: { workspacePath: coordinatorDir },
  });

  // Capability token required on /state, /events, and /action
  assert.equal((await fetch(new URL("/state", panelOne.url))).status, 403);
  assert.equal((await fetch(new URL("/events", panelOne.url))).status, 403);
  assert.equal(
    (
      await fetch(new URL("/action", panelOne.url), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ actionName: "get_review", input: {} }),
      })
    ).status,
    403,
  );

  // Sec-Fetch-Site: cross-site rejected even with valid capability token
  assert.equal(
    (
      await fetch(capEndpoint("/state", panelOne.url), {
        headers: { "Sec-Fetch-Site": "cross-site" },
      })
    ).status,
    403,
  );

  // Forged Origin rejected on POST /action
  assert.equal(
    (
      await fetch(capEndpoint("/action", panelOne.url), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://evil.example",
        },
        body: JSON.stringify({ actionName: "get_review", input: {} }),
      })
    ).status,
    403,
  );

  // load_diff action is removed completely to preserve domain isolation across both UI and agent callers
  const uiSwitchAttempt = await fetch(capEndpoint("/action", panelOne.url), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      actionName: "load_diff",
      input: { spec: "--unstaged" },
    }),
  });
  assert.equal(uiSwitchAttempt.status, 400);
  const uiSwitchJson = await uiSwitchAttempt.json();
  assert.equal(uiSwitchJson.code, "unknown_action");

  await assert.rejects(
    () =>
      runtime.invokeFromAgent(
        "load_diff",
        { cwd: repoDir },
        { instanceId: "diff-1", workspacePath: coordinatorDir },
      ),
    /Unknown action: load_diff/,
  );

  // 3. SSE live updates + zero workstation paths in /state, /events, and get_review
  const sseAbort = new AbortController();
  const sseRes = await fetch(capEndpoint("/events", panelTwo.url), {
    signal: AbortSignal.any([sseAbort.signal, AbortSignal.timeout(10_000)]),
  });
  const sseReader = sseRes.body.getReader();
  t.after(async () => {
    sseAbort.abort();
    await sseReader.cancel().catch(() => {});
  });
  const stream = sseSnapshots(sseReader);
  const initialSnap = (await stream.next()).value;
  assert.equal(initialSnap.loaded, true);
  assert.equal(initialSnap.diffRev, 1);
  assert.equal(initialSnap.status, "draft");
  assert.equal(initialSnap.files.length, 1);
  assert.equal(initialSnap.stats.additions, 2);
  assert.equal(initialSnap.stats.deletions, 1);
  assert.equal(JSON.stringify(initialSnap).includes(repoDir), false);

  await Promise.all([
    fetch(capEndpoint("/action", panelOne.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        actionName: "add_comment",
        input: { file: "src/service.ts", line: 1, side: "right", body: "First UI note" },
      }),
    }).then((r) => r.json()),
    runtime.invokeFromAgent(
      "add_comment",
      { file: "src/service.ts", line: 2, side: "right", body: "Second agent note" },
      { instanceId: "diff-1" },
    ),
  ]);

  let twoCommentsSnap = null;
  while (true) {
    const { value: snap, done } = await stream.next();
    if (done) break;
    if (snap.comments.length === 2) {
      twoCommentsSnap = snap;
      break;
    }
  }
  assert.equal(twoCommentsSnap.comments.length, 2);
  assert.equal(twoCommentsSnap.diffRev, 1, "Comment mutations must not increment diffRev");

  // Refresh increments diffRev
  await runtime.invokeFromAgent("refresh", {}, { instanceId: "diff-1", workspacePath: coordinatorDir });
  let refreshedSnap = null;
  while (true) {
    const { value: snap, done } = await stream.next();
    if (done) break;
    if (snap.diffRev === 2) {
      refreshedSnap = snap;
      break;
    }
  }
  await stream.return?.();
  assert.equal(refreshedSnap.diffRev, 2);

  const reviewSummary = await runtime.invokeFromAgent("get_review", {}, { instanceId: "diff-1" });
  assert.equal(reviewSummary.commentCount, 2);
  assert.equal(JSON.stringify(reviewSummary).includes(repoDir), false);

  // Persisted Git userStore artifact never stores workstation cwd paths or unconfigured.json
  const gitArtifactsDir = path.join(storeHome, "extensions", "diff", "artifacts");
  const savedGitFiles = fs.readdirSync(gitArtifactsDir);
  assert.equal(savedGitFiles.includes("unconfigured.json"), false);
  for (const fileName of savedGitFiles) {
    const rawArtifact = fs.readFileSync(path.join(gitArtifactsDir, fileName), "utf8");
    assert.equal(rawArtifact.includes(repoDir), false);
    const parsedArtifact = JSON.parse(rawArtifact);
    assert.equal(parsedArtifact.source?.cwd, undefined);
  }

  // Switching an open panel to another target via openInstance updates its domainId without mutating the previous domain
  await runtime.openInstance({
    instanceId: "diff-1",
    input: { cwd: repoDir, spec: "--staged" },
    ctx: { workspacePath: coordinatorDir },
  });
  const stagedReviewOnOne = await runtime.invokeFromAgent("get_review", {}, { instanceId: "diff-1" });
  assert.equal(stagedReviewOnOne.source.spec, "--staged");
  assert.equal(stagedReviewOnOne.commentCount, 0);
  const preservedDefaultOnTwo = await runtime.invokeFromAgent("get_review", {}, { instanceId: "diff-2" });
  assert.equal(preservedDefaultOnTwo.source.spec, "");
  assert.equal(preservedDefaultOnTwo.commentCount, 2);

  // Unconfigured session switching via openInstance never leaks into another unconfigured session
  await runtime.openInstance({
    instanceId: "diff-coord",
    input: {},
    ctx: { workspacePath: coordinatorDir },
  });
  await runtime.openInstance({
    instanceId: "diff-coord",
    input: { cwd: repoDir },
    ctx: { workspacePath: coordinatorDir },
  });
  assert.equal(fs.existsSync(path.join(gitArtifactsDir, "unconfigured.json")), false);

  const runtimeIsolated = createCanvasRuntime(createDiffCanvasConfig());
  t.after(() => runtimeIsolated.shutdown());
  const secondUnconfigured = await runtimeIsolated.openInstance({
    instanceId: "diff-coord-2",
    input: {},
    ctx: { workspacePath: coordinatorDir },
  });
  const secondSnap = await (await fetch(capEndpoint("/state", secondUnconfigured.url))).json();
  assert.equal(secondSnap.loaded, false);
  assert.equal(secondSnap.files.length, 0);
  assert.equal(secondSnap.comments.length, 0);

  // Failing refresh scrubs workstation paths from state.error
  const failingRuntime = createCanvasRuntime(
    createDiffCanvasConfig({
      execFn: async (cmd, args) => {
        if (args.includes("--show-toplevel")) return repoDir;
        if (args.includes("--show-current")) return "feat/canvas";
        if (args.includes("diff")) {
          throw new Error(`fatal: unable to read ${repoDir}\\secret-file.txt or /Users/alice/repo/key.pem`);
        }
        return "";
      },
    }),
  );
  t.after(() => failingRuntime.shutdown());
  const warmErrPanel = await failingRuntime.openInstance({
    instanceId: "diff-err-warm",
    input: { cwd: repoDir },
    ctx: { workspacePath: repoDir },
  });
  const warmErrSnap = await (await fetch(capEndpoint("/state", warmErrPanel.url))).json();
  assert.equal(warmErrSnap.loaded, false);
  assert.equal(warmErrSnap.error.includes(repoDir), false);
  assert.equal(warmErrSnap.error.includes("/Users/alice"), false);
  assert.equal(warmErrSnap.error.includes("<path>"), true);

  await assert.rejects(
    () =>
      failingRuntime.openInstance({
        instanceId: "diff-err-cold",
        input: { cwd: repoDir, spec: "--staged" },
        ctx: { workspacePath: repoDir },
      }),
    (err) => {
      assert.equal(err.message.includes(repoDir), false);
      assert.equal(err.message.includes("/Users/alice"), false);
      assert.equal(err.message.includes("<path>"), true);
      return true;
    },
  );
});

test("working-tree Git diffs include untracked non-ignored files, skip symlinks/ignored files, and check untracked before HEAD~1 fallback", async (t) => {
  const repoDir = makeTempDir("diff-untracked-git-");
  t.after(() => fs.rmSync(repoDir, { recursive: true, force: true }));

  const git = (...args) =>
    execFileSync("git", args, { cwd: repoDir, encoding: "utf8", windowsHide: true });
  git("init", "-b", "main");
  git("config", "user.name", "Untracked Test");
  git("config", "user.email", "untracked@example.invalid");

  fs.writeFileSync(path.join(repoDir, ".gitignore"), "*.secret\n", "utf8");
  fs.mkdirSync(path.join(repoDir, "src"), { recursive: true });
  fs.writeFileSync(path.join(repoDir, "src", "base.ts"), "export const a = 1;\n", "utf8");
  git("add", ".");
  git("commit", "-m", "first");

  fs.writeFileSync(path.join(repoDir, "src", "base.ts"), "export const a = 2;\n", "utf8");
  git("add", ".");
  git("commit", "-m", "second");

  // Tracked tree is clean on main, so without untracked support default mode would fall back to HEAD~1..HEAD.
  fs.writeFileSync(
    path.join(repoDir, "src", "untracked.ts"),
    "export const fresh = true;\nexport const two = 2;\n",
    "utf8",
  );
  fs.writeFileSync(path.join(repoDir, "src", "icon.bin"), Buffer.from([0x89, 0x50, 0x00, 0x01]));
  fs.writeFileSync(path.join(repoDir, "ignored.secret"), "TOP_SECRET=1\n", "utf8");

  try {
    fs.symlinkSync(
      path.join(repoDir, "src", "base.ts"),
      path.join(repoDir, "src", "linked.ts"),
      "file",
    );
  } catch {
    // Symlink creation may require elevation on unprivileged Windows hosts; covered if permitted.
  }

  const defaultLoaded = await loadDiff({ mode: "git", cwd: repoDir, spec: "", paths: [] });
  const pathsLoaded = defaultLoaded.files.map((f) => f.canonicalPath);
  assert.ok(pathsLoaded.includes("src/untracked.ts"), "Default diff must include untracked text file");
  assert.ok(pathsLoaded.includes("src/icon.bin"), "Default diff must include untracked binary file");
  assert.equal(pathsLoaded.includes("src/base.ts"), false, "Must not fall back to HEAD~1..HEAD when untracked files exist");
  assert.equal(pathsLoaded.includes("ignored.secret"), false, "Must exclude gitignored files");
  assert.equal(pathsLoaded.includes("src/linked.ts"), false, "Must skip symlinks");

  const untrackedText = defaultLoaded.files.find((f) => f.canonicalPath === "src/untracked.ts");
  assert.equal(untrackedText.status, "added");
  assert.equal(untrackedText.additions, 2);
  const untrackedBin = defaultLoaded.files.find((f) => f.canonicalPath === "src/icon.bin");
  assert.equal(untrackedBin.isBinary, true);

  const unstagedScoped = await loadDiff({
    mode: "git",
    cwd: repoDir,
    spec: "--unstaged",
    paths: ["src/untracked.ts"],
  });
  assert.deepEqual(
    unstagedScoped.files.map((f) => f.canonicalPath),
    ["src/untracked.ts"],
  );
});

test("GitHub PR mode supports explicit secondary account auth and automatic COPILOT_GH_ACCOUNT fallback without persisting tokens", async () => {
  const seenCalls = [];
  const fakeEnv = {
    ...process.env,
    COPILOT_GH_ACCOUNT_github_2E_com_sample_5F_emu: "gho_synthetic_emu_token_value_123456",
  };

  // 1. Explicit account resolves COPILOT_GH_ACCOUNT_github_2E_com_<encoded>
  const explicitRes = await loadDiff(
    { mode: "pr", repo: "sample-team/emu-repo", pr: 17, account: "sample_emu" },
    {
      env: fakeEnv,
      execFn: async (cmd, args, opts) => {
        seenCalls.push({ args, ghToken: opts?.env?.GH_TOKEN, ghHost: opts?.env?.GH_HOST });
        if (args[1] === "view") {
          return JSON.stringify({ number: 17, headRefName: "feat/auth", baseRefName: "main" });
        }
        return [
          "diff --git a/src/emu.ts b/src/emu.ts",
          "--- a/src/emu.ts",
          "+++ b/src/emu.ts",
          "@@ -1,1 +1,1 @@",
          "-export const ok = false;",
          "+export const ok = true;",
        ].join("\n");
      },
    },
  );
  assert.equal(explicitRes.files.length, 1);
  assert.equal(seenCalls[0].ghToken, "gho_synthetic_emu_token_value_123456");
  assert.equal(seenCalls[0].ghHost, "github.com");
  assert.equal(JSON.stringify(explicitRes).includes("gho_synthetic_emu_token_value_123456"), false);

  // 2. Omitted account automatically retries COPILOT_GH_ACCOUNT_github_2E_com_* on GraphQL Could not resolve / 404
  let defaultAttempts = 0;
  const fallbackRes = await loadDiff(
    { mode: "pr", repo: "sample-team/emu-repo", pr: 18 },
    {
      env: fakeEnv,
      execFn: async (cmd, args, opts) => {
        if (!opts?.env?.GH_TOKEN) {
          defaultAttempts += 1;
          throw new Error("GraphQL: Could not resolve to a Repository with the name 'sample-team/emu-repo'.");
        }
        if (args[1] === "view") {
          return JSON.stringify({ number: 18, headRefName: "feat/auto", baseRefName: "main" });
        }
        return [
          "diff --git a/src/auto.ts b/src/auto.ts",
          "--- a/src/auto.ts",
          "+++ b/src/auto.ts",
          "@@ -1,1 +1,1 @@",
          "-export const auto = 0;",
          "+export const auto = 1;",
        ].join("\n");
      },
    },
  );
  assert.ok(defaultAttempts >= 1);
  assert.equal(fallbackRes.files[0].canonicalPath, "src/auto.ts");
});

test("GitHub PR mode works without a local checkout, persists lightweight state via userStore, reconciles stale comments on refresh, and notifies askAgent on Submit Review", async (t) => {
  const storeHome = makeTempDir("diff-pr-store-");
  const prevHome = process.env.COPILOT_HOME;
  process.env.COPILOT_HOME = storeHome;
  t.after(() => {
    if (prevHome === undefined) delete process.env.COPILOT_HOME;
    else process.env.COPILOT_HOME = prevHome;
    fs.rmSync(storeHome, { recursive: true, force: true });
  });

  let currentPatch = [
    "diff --git a/src/handler.ts b/src/handler.ts",
    "index 1111111..2222222 100644",
    "--- a/src/handler.ts",
    "+++ b/src/handler.ts",
    "@@ -1,2 +1,3 @@",
    " export function handle(req) {",
    "+  const token = req.headers['x-token'];",
    "   return token;",
    "diff --git a/src/constants.ts b/src/constants.ts",
    "index 4444444..5555555 100644",
    "--- a/src/constants.ts",
    "+++ b/src/constants.ts",
    "@@ -1,1 +1,1 @@",
    "-export const VERSION = 1;",
    "+export const VERSION = 2;",
  ].join("\n");

  const ghCalls = [];
  const mockExecFn = async (cmd, args) => {
    ghCalls.push({ cmd: path.basename(cmd).toLowerCase(), args });
    if (args[1] === "view") {
      return JSON.stringify({
        number: 293,
        title: 'Add diff canvas "custom title note"',
        headRefName: "feat/diff",
        baseRefName: "main",
      });
    }
    return currentPatch;
  };

  const customStore = (safeFile) => userStore("diff", safeFile);

  const runtimeOne = createCanvasRuntime(
    createDiffCanvasConfig({ execFn: mockExecFn, storeFactory: customStore }),
  );
  t.after(() => runtimeOne.shutdown());

  const askedPrompts = [];
  runtimeOne.setHost({
    ai: async () => "",
    askAgent: async (prompt) => {
      askedPrompts.push(prompt);
    },
  });

  // Open PR diff with NO workspacePath / NO local checkout
  const panel = await runtimeOne.openInstance({
    instanceId: "pr-293",
    input: { repo: "example-org/api-gateway", pr: 293 },
    ctx: { workspacePath: "" },
  });
  assert.equal(ghCalls.length, 2);
  assert.deepEqual(ghCalls[0].args, [
    "pr",
    "diff",
    "293",
    "--repo",
    "example-org/api-gateway",
    "--color",
    "never",
  ]);
  assert.deepEqual(ghCalls[1].args, [
    "pr",
    "view",
    "293",
    "--repo",
    "example-org/api-gateway",
    "--json",
    "number,title,headRefName,baseRefName,headRefOid,baseRefOid,state",
  ]);

  // Add comment + toggle viewed + submit review from UI (triggers askAgent)
  const addRes = await fetch(capEndpoint("/action", panel.url), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      actionName: "add_comment",
      input: {
        file: "src/handler.ts",
        line: 2,
        side: "right",
        body: "Validate header format before use",
      },
    }),
  }).then((r) => r.json());
  assert.equal(addRes.ok, true);
  assert.equal(addRes.result.comment.stale, false);

  // Edit comment before submitting
  const editedCommentId = addRes.result.comment.id;
  const editHttp = await fetch(capEndpoint("/action", panel.url), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      actionName: "edit_comment",
      input: {
        commentId: editedCommentId,
        body: "Validate X-Token header format and length before use",
      },
    }),
  }).then((r) => r.json());
  assert.equal(editHttp.ok, true);
  assert.equal(editHttp.result.comment.body, "Validate X-Token header format and length before use");
  assert.ok(editHttp.result.comment.updatedAt);

  await runtimeOne.invokeFromAgent(
    "toggle_viewed",
    { file: "src/handler.ts" },
    { instanceId: "pr-293" },
  );
  await runtimeOne.invokeFromAgent(
    "toggle_viewed",
    { file: "src/constants.ts" },
    { instanceId: "pr-293" },
  );

  const submitHttp = await fetch(capEndpoint("/action", panel.url), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      actionName: "submit_review",
      input: { notifyAgent: true },
    }),
  }).then((r) => r.json());
  assert.equal(submitHttp.ok, true);
  assert.equal(submitHttp.result.status, "pending");
  assert.equal(submitHttp.result.commentCount, 1);
  assert.equal(submitHttp.result.notifiedAgent, true);
  assert.equal(askedPrompts.length, 1);
  assert.match(askedPrompts[0], /example-org\/api-gateway#293/);
  assert.match(askedPrompts[0], /instanceId "pr-293"/);
  assert.equal(askedPrompts[0].includes("custom title note"), false);
  assert.match(askedPrompts[0], /get_review/);
  assert.match(askedPrompts[0], /untrusted data/i);

  // Verify durable JSON on disk strips parsed `files` hunks
  const artifactPath = path.join(
    storeHome,
    "extensions",
    "diff",
    "artifacts",
    "pr__example-org__api-gateway__293.json",
  );
  const savedDiskJson = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  assert.equal("files" in savedDiskJson, false);
  assert.equal(savedDiskJson.status, "pending");
  assert.deepEqual(savedDiskJson.viewedFiles, ["src/handler.ts", "src/constants.ts"]);
  assert.equal(typeof savedDiskJson.viewedFileFingerprints?.["src/handler.ts"], "string");
  assert.equal(typeof savedDiskJson.viewedFileFingerprints?.["src/constants.ts"], "string");
  assert.equal(savedDiskJson.comments.length, 1);

  await runtimeOne.shutdown();

  // Simulate new commit pushed to PR #293 changing line 2 of src/handler.ts while src/constants.ts stays unchanged
  currentPatch = [
    "diff --git a/src/handler.ts b/src/handler.ts",
    "index 1111111..3333333 100644",
    "--- a/src/handler.ts",
    "+++ b/src/handler.ts",
    "@@ -1,2 +1,3 @@",
    " export function handle(req) {",
    "+  const token = sanitizeToken(req.headers['x-token']);",
    "   return token;",
    "diff --git a/src/constants.ts b/src/constants.ts",
    "index 4444444..5555555 100644",
    "--- a/src/constants.ts",
    "+++ b/src/constants.ts",
    "@@ -1,1 +1,1 @@",
    "-export const VERSION = 1;",
    "+export const VERSION = 2;",
  ].join("\n");

  const runtimeTwo = createCanvasRuntime(
    createDiffCanvasConfig({ execFn: mockExecFn, storeFactory: customStore }),
  );
  t.after(() => runtimeTwo.shutdown());

  await runtimeTwo.openInstance({
    instanceId: "pr-293-reopened",
    input: { repo: "example-org/api-gateway", pr: 293 },
    ctx: { workspacePath: "" },
  });

  const restoredReview = await runtimeTwo.invokeFromAgent(
    "get_review",
    {},
    { instanceId: "pr-293-reopened" },
  );
  assert.equal(restoredReview.status, "pending");
  assert.deepEqual(
    restoredReview.viewedFiles,
    ["src/constants.ts"],
    "Modified src/handler.ts must automatically unmark Viewed while unchanged src/constants.ts stays Viewed",
  );
  assert.equal(restoredReview.comments.length, 1);
  assert.equal(restoredReview.comments[0].stale, true);

  const addrRes = await runtimeTwo.invokeFromAgent(
    "mark_addressed",
    {},
    { instanceId: "pr-293-reopened" },
  );
  assert.equal(addrRes.status, "addressed");

  // Mutating review actions while status === "addressed" all throw uniform review_locked message
  const expectedLockedRe =
    /Review has already been addressed; call reopen_review or start a New Review Round first/;
  await assert.rejects(
    () =>
      runtimeTwo.invokeFromAgent(
        "add_comment",
        { file: "src/handler.ts", line: 2, side: "right", body: "Blocked add" },
        { instanceId: "pr-293-reopened" },
      ),
    expectedLockedRe,
  );
  await assert.rejects(
    () =>
      runtimeTwo.invokeFromAgent(
        "edit_comment",
        { commentId: restoredReview.comments[0].id, body: "Blocked while addressed" },
        { instanceId: "pr-293-reopened" },
      ),
    expectedLockedRe,
  );
  await assert.rejects(
    () =>
      runtimeTwo.invokeFromAgent(
        "delete_comment",
        { id: restoredReview.comments[0].id },
        { instanceId: "pr-293-reopened" },
      ),
    expectedLockedRe,
  );
  await assert.rejects(
    () =>
      runtimeTwo.invokeFromAgent(
        "submit_review",
        { notifyAgent: false },
        { instanceId: "pr-293-reopened" },
      ),
    expectedLockedRe,
  );

  // Refresh with identical diff keeps status === "addressed"
  await runtimeTwo.invokeFromAgent("refresh", {}, { instanceId: "pr-293-reopened" });
  assert.equal(
    (await runtimeTwo.invokeFromAgent("get_review", {}, { instanceId: "pr-293-reopened" })).status,
    "addressed",
  );

  // Refresh with changed diff fingerprint automatically reopens "addressed" -> "draft"
  currentPatch = [
    "diff --git a/src/handler.ts b/src/handler.ts",
    "index 1111111..4444444 100644",
    "--- a/src/handler.ts",
    "+++ b/src/handler.ts",
    "@@ -1,2 +1,3 @@",
    " export function handle(req) {",
    "+  const token = verifyAndSanitize(req.headers['x-token']);",
    "   return token;",
  ].join("\n");
  const autoReopenRes = await runtimeTwo.invokeFromAgent("refresh", {}, { instanceId: "pr-293-reopened" });
  assert.equal(autoReopenRes.status, "draft");

  // Mark addressed again and test explicit reopen_review (keep comments vs clearComments)
  await runtimeTwo.invokeFromAgent("mark_addressed", {}, { instanceId: "pr-293-reopened" });
  const manualReopenKeep = await runtimeTwo.invokeFromAgent(
    "reopen_review",
    { clearComments: false },
    { instanceId: "pr-293-reopened" },
  );
  assert.equal(manualReopenKeep.status, "draft");
  assert.equal(manualReopenKeep.commentCount, 1);

  const manualReopenClear = await runtimeTwo.invokeFromAgent(
    "reopen_review",
    { clearComments: true },
    { instanceId: "pr-293-reopened" },
  );
  assert.equal(manualReopenClear.status, "draft");
  assert.equal(manualReopenClear.commentCount, 0);
});

test("setup.mjs installs standalone loader idempotently, skips/cleans up when plugin provides diff, and rejects symlinks", (t) => {
  const home = makeTempDir("diff-setup-home-");
  const skillDir = makeTempDir("diff-setup-skill-");
  t.after(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(skillDir, { recursive: true, force: true });
  });

  const entry = path.join(skillDir, "runtime", "extension.mjs");
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.writeFileSync(entry, "// stub\n", "utf8");

  const plan = planSetup({ home, entry });
  assert.equal(plan.pluginManaged, false);
  assert.throws(() => applySetup(plan, "badhash"), /Exact preview hash approval required/);
  const applied = applySetup(plan);
  assert.equal(applied.applied, true);
  assert.match(fs.readFileSync(plan.file, "utf8"), /runtime\/extension\.mjs/);

  // Second run is idempotent
  const secondPlan = planSetup({ home, entry });
  assert.equal(applySetup(secondPlan).unchanged, true);

  // When an installed plugin provides com.github.copilot/extensions/diff/extension.mjs,
  // setup.mjs detects it and removes the redundant standalone loader!
  const pluginExt = path.join(
    home,
    "installed-plugins",
    "jongio-skills",
    "com.github.copilot",
    "extensions",
    "diff",
    "extension.mjs",
  );
  fs.mkdirSync(path.dirname(pluginExt), { recursive: true });
  fs.writeFileSync(pluginExt, "// plugin loader\n", "utf8");
  assert.equal(findInstalledPluginDiffExtension(home), pluginExt);

  const pluginPlan = planSetup({ home, entry });
  assert.equal(pluginPlan.pluginManaged, true);
  const pluginApplied = applySetup(pluginPlan);
  assert.equal(pluginApplied.removedStandaloneLoader, true);
  assert.equal(fs.existsSync(plan.file), false);

  // User-owned custom loader is preserved
  fs.mkdirSync(path.dirname(plan.file), { recursive: true });
  fs.writeFileSync(plan.file, "// custom user extension\n", "utf8");
  assert.throws(() => planSetup({ home, entry }), /not managed by this skill/);

  // Symlinked extensions dir is rejected
  const homeWithLink = makeTempDir("diff-setup-link-");
  t.after(() => fs.rmSync(homeWithLink, { recursive: true, force: true }));
  fs.symlinkSync(
    path.join(homeWithLink, "dangling-dir"),
    path.join(homeWithLink, "extensions"),
    process.platform === "win32" ? "junction" : "dir",
  );
  assert.throws(() => planSetup({ home: homeWithLink, entry }), /symlink/i);
});

class StrictElement {
  constructor(tagName, namespaceURI = null) {
    this.nodeType = 1;
    this.namespaceURI = namespaceURI;
    this.tagName = namespaceURI ? tagName : tagName.toUpperCase();
    this.localName = tagName;
    this.childNodes = [];
    this.parentNode = null;
    this.attributes = new Map();
    this.style = {};
    this.listeners = new Map();
    this._innerHTML = "";
    this.value = "";
    this.checked = false;
    this.disabled = false;
    this.onclick = null;
    this.oninput = null;
    this.onchange = null;
    this.onkeydown = null;
    this.onmousedown = null;
  }

  get firstChild() {
    return this.childNodes[0] || null;
  }

  get nextSibling() {
    if (!this.parentNode) return null;
    const idx = this.parentNode.childNodes.indexOf(this);
    return idx >= 0 ? this.parentNode.childNodes[idx + 1] || null : null;
  }

  set className(val) {
    this.setAttribute("class", String(val ?? ""));
  }

  get className() {
    return this.getAttribute("class") || "";
  }

  set innerHTML(val) {
    this._innerHTML = String(val ?? "");
    this.childNodes = [];
  }

  get innerHTML() {
    return this._innerHTML;
  }

  get textContent() {
    return this.childNodes.map((c) => c.textContent).join("");
  }

  set textContent(val) {
    this.childNodes = [];
    if (val !== "" && val !== null && val !== undefined) {
      this.appendChild(new StrictText(String(val)));
    }
  }

  setAttribute(name, value) {
    this.attributes.set(String(name), String(value));
  }

  getAttribute(name) {
    return this.attributes.has(String(name)) ? this.attributes.get(String(name)) : null;
  }

  removeAttribute(name) {
    this.attributes.delete(String(name));
  }

  appendChild(node) {
    return this.insertBefore(node, null);
  }

  insertBefore(node, refNode) {
    if (node.parentNode) {
      node.parentNode.removeChild(node);
    }
    node.parentNode = this;
    if (!refNode) {
      this.childNodes.push(node);
    } else {
      const idx = this.childNodes.indexOf(refNode);
      if (idx === -1) this.childNodes.push(node);
      else this.childNodes.splice(idx, 0, node);
    }
    return node;
  }

  removeChild(node) {
    const idx = this.childNodes.indexOf(node);
    if (idx >= 0) {
      this.childNodes.splice(idx, 1);
      node.parentNode = null;
    }
    return node;
  }

  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
  }

  removeEventListener(type, fn) {
    this.listeners.get(type)?.delete(fn);
  }

  querySelectorAll(selector) {
    const out = [];
    const visit = (el) => {
      for (const child of el.childNodes) {
        if (child.nodeType !== 1) continue;
        if (matchesSimpleSelector(child, selector)) out.push(child);
        visit(child);
      }
    };
    visit(this);
    return out;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  scrollIntoView() {
    StrictElement.scrollHistory.push(this);
  }
}
StrictElement.scrollHistory = [];

class StrictSVGElement extends StrictElement {}

class StrictText {
  constructor(data) {
    this.nodeType = 3;
    this.data = String(data);
    this.parentNode = null;
  }

  get nextSibling() {
    if (!this.parentNode) return null;
    const idx = this.parentNode.childNodes.indexOf(this);
    return idx >= 0 ? this.parentNode.childNodes[idx + 1] || null : null;
  }

  get textContent() {
    return this.data;
  }

  set textContent(val) {
    this.data = String(val);
  }
}

function matchesSingleSelector(el, rawSel) {
  const selector = rawSel.trim();
  if (!selector) return false;
  if (selector.startsWith(".")) {
    const targetCls = selector.slice(1);
    return el.className.split(/\s+/).includes(targetCls);
  }
  if (selector === "[data-canonical-file]") {
    return el.getAttribute("data-canonical-file") !== null;
  }
  const attrMatch = selector.match(/^([a-z0-9-]+)?\[([a-z0-9-]+)="([^"]*)"\]$/i);
  if (attrMatch) {
    const [, tagPart, attrName, attrVal] = attrMatch;
    if (tagPart && el.localName.toLowerCase() !== tagPart.toLowerCase()) {
      return false;
    }
    return el.getAttribute(attrName) === attrVal;
  }
  return el.localName.toLowerCase() === selector.toLowerCase();
}

function matchesSimpleSelector(el, selector) {
  return String(selector)
    .split(",")
    .some((part) => matchesSingleSelector(el, part));
}

function createStrictDocument() {
  const validTagRe = /^[a-z][a-z0-9-]*$/i;
  return {
    createElement(tag) {
      if (typeof tag !== "string" || !validTagRe.test(tag)) {
        const err = new Error(
          `Failed to execute 'createElement' on 'Document': The tag name provided ('${tag}') is not a valid name.`,
        );
        err.name = "InvalidCharacterError";
        throw err;
      }
      return new StrictElement(tag);
    },
    createElementNS(ns, tag) {
      if (typeof tag !== "string" || !validTagRe.test(tag)) {
        const err = new Error(
          `Failed to execute 'createElementNS' on 'Document': The qualified name provided ('${tag}') is not valid.`,
        );
        err.name = "InvalidCharacterError";
        throw err;
      }
      return new StrictSVGElement(tag, ns);
    },
    createTextNode(text) {
      return new StrictText(text);
    },
    getElementById() {
      return null;
    },
  };
}

test("DiffCanvasApp mounts cleanly in strict Preact DOM (zero empty-fragment crashes, verified icons, auto-collapsed lockfiles & >600-line diffs)", async (t) => {
  const runtimeDir = path.resolve(import.meta.dirname, "..", "runtime");
  const webDir = path.join(runtimeDir, "web");
  const appSource = fs.readFileSync(path.join(webDir, "app.mjs"), "utf8");
  const htmlSource = fs.readFileSync(path.join(webDir, "index.html"), "utf8");
  const cssSource = fs.readFileSync(path.join(webDir, "style.css"), "utf8");

  // Guard against JSX empty fragments (`<>` / `</>`) which crash vendored `htm`
  assert.doesNotMatch(appSource, /<>|<\/>/, "app.mjs must never use <>...</> with htm");
  assert.doesNotMatch(appSource, /innerHTML|dangerouslySetInnerHTML/);
  assert.doesNotMatch(htmlSource, /https?:\/\//i);
  assert.doesNotMatch(htmlSource, /http-equiv="Content-Security-Policy"/i);

  // Guard against narrow side-panel toolbar clipping (.dv-toolbar must wrap cleanly without horizontal overflow)
  const dvToolbarBlock = cssSource.match(/\.dv-toolbar\s*\{([^}]*)\}/);
  assert.ok(dvToolbarBlock, ".dv-toolbar rule must exist in style.css");
  assert.match(dvToolbarBlock[1], /flex-wrap:\s*wrap\s*;/, ".dv-toolbar must wrap in narrow 550-750px side panels");
  assert.match(dvToolbarBlock[1], /overflow-x:\s*hidden\s*;/, ".dv-toolbar must avoid horizontal scroll clipping");
  const dvTitleGroupBlock = cssSource.match(/\.dv-title-group\s*\{([^}]*)\}/);
  assert.ok(dvTitleGroupBlock, ".dv-title-group rule must exist in style.css");
  assert.match(dvTitleGroupBlock[1], /flex:\s*1\s+1\s+180px\s*;/, ".dv-title-group must shrink/grow cleanly");

  // Guard against Flexbox vertical card crushing in .dv-main and 100%+96px split <col> overflow
  const dvMainBlock = cssSource.match(/\.dv-main\s*\{([^}]*)\}/);
  assert.ok(dvMainBlock, ".dv-main rule must exist in style.css");
  assert.match(dvMainBlock[1], /display:\s*block\s*;/, ".dv-main must be display: block to prevent column-flex shrink crushing");
  assert.doesNotMatch(dvMainBlock[1], /flex-direction:\s*column/, ".dv-main must not use column flex layout");
  assert.match(cssSource, /\.dv-file-card\s*\{[^}]*margin-bottom:\s*14px\s*;/, ".dv-file-card must define block vertical spacing");
  assert.match(cssSource, /\.dv-file-path\s*\{[^}]*text-overflow:\s*ellipsis\s*;/, ".dv-file-path must truncate cleanly without header overflow");
  assert.match(
    appSource,
    /calc\(\(100% - 96px\) \* \$\{splitLeftPct \/ 100\}\)/,
    "Split <col> left width must subtract the two 48px line-number columns",
  );
  assert.match(
    appSource,
    /calc\(\(100% - 96px\) \* \$\{\(100 - splitLeftPct\) \/ 100\}\)/,
    "Split <col> right width must subtract the two 48px line-number columns",
  );

  // Verify every static and dynamic Lucide icon referenced in app.mjs exists in vendored icons.mjs
  const iconMatches = [...appSource.matchAll(/<(?:\$\{Icon\}|Icon)\s+name="([a-z0-9-]+)"/g)];
  assert.ok(iconMatches.length >= 6);
  for (const m of iconMatches) {
    assert.equal(hasIcon(m[1]), true, `Icon '${m[1]}' must be vendored in runtime/canvas-kit/icons.mjs`);
  }
  for (const dynamicIcon of [
    "circle-dot",
    "circle-check",
    "message-square",
    "file-plus",
    "file-minus",
    "file-code",
    "chevron-right",
    "chevron-down",
    "folder",
    "folder-open",
  ]) {
    assert.equal(hasIcon(dynamicIcon), true, `Dynamic icon '${dynamicIcon}' must be vendored`);
  }

  // Rewrite browser `/kit/*` specifiers to local file URLs so Node executes the real `app.mjs`
  const tempDir = makeTempDir("diff-dom-mount-");
  const prevDoc = globalThis.document;
  const prevWin = globalThis.window;
  const prevSvg = globalThis.SVGElement;
  const prevRaf = globalThis.requestAnimationFrame;
  const prevSkip = globalThis.__DIFF_SKIP_AUTO_MOUNT__;
  t.after(() => {
    globalThis.document = prevDoc;
    globalThis.window = prevWin;
    globalThis.SVGElement = prevSvg;
    globalThis.requestAnimationFrame = prevRaf;
    globalThis.__DIFF_SKIP_AUTO_MOUNT__ = prevSkip;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const rewrittenSource = appSource
    .replace(
      'from "/kit/core-client.mjs"',
      `from ${JSON.stringify(pathToFileURL(path.join(runtimeDir, "canvas-kit", "core-client.mjs")).href)}`,
    )
    .replace(
      'from "/kit/icons.mjs"',
      `from ${JSON.stringify(pathToFileURL(path.join(runtimeDir, "canvas-kit", "icons.mjs")).href)}`,
    )
    .replace(
      'from "./diff-view-model.mjs"',
      `from ${JSON.stringify(pathToFileURL(path.join(webDir, "diff-view-model.mjs")).href)}`,
    );
  const tempAppPath = path.join(tempDir, "app.mjs");
  fs.writeFileSync(tempAppPath, rewrittenSource, "utf8");

  globalThis.__DIFF_SKIP_AUTO_MOUNT__ = true;
  globalThis.SVGElement = StrictSVGElement;
  globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
  const strictDoc = createStrictDocument();
  strictDoc.body = strictDoc.createElement("body");
  globalThis.document = strictDoc;

  const windowListeners = new Map();
  globalThis.window = {
    innerWidth: 1200,
    requestAnimationFrame: (cb) => setTimeout(cb, 0),
    addEventListener(type, fn) {
      if (!windowListeners.has(type)) windowListeners.set(type, new Set());
      windowListeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      windowListeners.get(type)?.delete(fn);
    },
  };

  // Verify the strict DOM shim throws InvalidCharacterError on empty tag `""` just like Chromium
  assert.throws(() => globalThis.document.createElement(""), { name: "InvalidCharacterError" });

  const { DiffCanvasApp, FileDiffCard, LARGE_FILE_CHANGED_LINES_THRESHOLD } = await import(
    pathToFileURL(tempAppPath).href
  );
  assert.equal(LARGE_FILE_CHANGED_LINES_THRESHOLD, 600);

  const bigAdditions = Array.from({ length: 610 }, (_, i) => `+export const line${i} = ${i};`).join(
    "\n",
  );
  const samplePatch = [
    "diff --git a/src/app.ts b/src/app.ts",
    "index 1111111..2222222 100644",
    "--- a/src/app.ts",
    "+++ b/src/app.ts",
    "@@ -1,3 +1,3 @@",
    " import { run } from './run.js';",
    "-export const count = oldVal + 1;",
    "+export const count = newVal + 1;",
    " run(count);",
    "diff --git a/package-lock.json b/package-lock.json",
    "index 3333333..4444444 100644",
    "--- a/package-lock.json",
    "+++ b/package-lock.json",
    "@@ -1,1 +1,2 @@",
    " {}",
    "+// lockfile",
    "diff --git a/src/generated.ts b/src/generated.ts",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/src/generated.ts",
    "@@ -0,0 +1,610 @@",
    bigAdditions,
  ].join("\n");

  const parsed = parseDiffPatch(samplePatch);
  parsed.files[0].truncated = true;
  const state = {
    domain: "pr__example-org__demo__293",
    loaded: true,
    diffRev: 1,
    truncatedFiles: true,
    error: null,
    title: "example-org/demo#293",
    status: "draft",
    stats: {
      fileCount: parsed.fileCount,
      totalFiles: 5,
      additions: parsed.additions,
      deletions: parsed.deletions,
    },
    viewedFiles: [],
    comments: [
      {
        id: "c1",
        file: "src/app.ts",
        line: 2,
        side: "right",
        body: "Check overflow on newVal",
        stale: true,
        createdAt: new Date().toISOString(),
      },
      {
        id: "c-outdated",
        file: "src/app.ts",
        line: 999,
        side: "right",
        body: "Comment outside visible hunk",
        stale: true,
        createdAt: new Date().toISOString(),
      },
      {
        id: "c-orphan",
        file: "src/deleted-earlier.ts",
        line: 12,
        side: "left",
        body: "Comment on file no longer in diff",
        stale: true,
        createdAt: new Date().toISOString(),
      },
    ],
    files: parsed.files,
    focusedFile: null,
    focusedLine: null,
    focusSeq: 0,
  };

  let fileCardRenderCalls = 0;
  let renderedCardPaths = [];
  const origCardRender = FileDiffCard.prototype.render;
  FileDiffCard.prototype.render = function (...args) {
    fileCardRenderCalls += 1;
    renderedCardPaths.push(this.props?.file?.canonicalPath || "");
    return origCardRender.apply(this, args);
  };
  t.after(() => {
    FileDiffCard.prototype.render = origCardRender;
  });

  const invokedActions = [];
  const container = globalThis.document.createElement("div");
  t.after(() => {
    render(null, container);
  });
  render(
    html`<${DiffCanvasApp}
      state=${state}
      invoke=${async (name, input) => {
        invokedActions.push({ name, input });
        return { ok: true };
      }}
    />`,
    container,
  );
  assert.equal(fileCardRenderCalls, 3);

  const mainEl = container.querySelector("main");
  assert.ok(mainEl, "<main class='dv-main'> must mount without InvalidCharacterError");
  assert.equal(mainEl.className, "dv-main");

  const fileCards = mainEl.querySelectorAll(".dv-file-card");
  assert.equal(fileCards.length, 3);

  // Verify mounted Split <colgroup> <col> widths sum to 100% (48px + calc(...) + 48px + calc(...))
  const splitTable = fileCards[0].querySelector(".dv-table-split");
  assert.ok(splitTable, "Expanded Split file card must mount .dv-table-split");
  const splitCols = splitTable.querySelectorAll("col");
  assert.equal(splitCols.length, 4);
  assert.equal(splitCols[1].style.width, "calc((100% - 96px) * 0.5)");
  assert.equal(splitCols[3].style.width, "calc((100% - 96px) * 0.5)");
  const filePathEl = fileCards[0].querySelector(".dv-file-path");
  assert.equal(filePathEl.getAttribute("title"), "src/app.ts");

  // Verify zero inline <svg> inside line-number cells (.dv-ln)
  const lineCells = mainEl.querySelectorAll("td").filter((td) => td.className.includes("dv-ln"));
  assert.ok(lineCells.length > 0);
  for (const td of lineCells) {
    assert.equal(td.querySelectorAll("svg").length, 0, ".dv-ln must not render per-line <svg>");
  }

  // Verify Stale comment badge mounted on src/app.ts
  assert.match(fileCards[0].textContent, /Check overflow on newVal/);
  assert.match(fileCards[0].textContent, /Stale/);

  // Verify package-lock.json and 610-line generated.ts auto-collapsed with "Show diff (+...)" CTA
  const collapsedNotices = mainEl.querySelectorAll(".dv-collapsed-notice");
  assert.equal(collapsedNotices.length, 2);
  assert.match(collapsedNotices[0].textContent, /Lockfile diff collapsed by default/);
  assert.match(collapsedNotices[0].textContent, /Show diff \(\+1 \/ -0\)/);
  assert.match(collapsedNotices[1].textContent, /Large file diff collapsed by default/);
  assert.match(collapsedNotices[1].textContent, /Show diff \(\+610 \/ -0\)/);

  // Switch to Unified mode and verify re-render succeeds with 0 errors
  const unifiedBtn = container
    .querySelectorAll("button")
    .find((btn) => btn.textContent.includes("Unified"));
  assert.ok(unifiedBtn);
  assert.equal(unifiedBtn.getAttribute("aria-pressed"), "false");
  const segGroups = container.querySelectorAll(".dv-seg");
  assert.equal(segGroups[0].getAttribute("role"), "group");

  // Verify truncation banners + unanchored + orphan comments + per-segment syntax tokens in Split mode first
  assert.match(mainEl.querySelector(".dv-truncation-banner").textContent, /Showing 3 of 5 changed files/);
  assert.ok(fileCards[0].querySelector(".dv-file-truncation-notice"));
  assert.match(fileCards[0].querySelector(".dv-unanchored-threads").textContent, /Outdated \/ file-level comments/);
  assert.match(fileCards[0].querySelector(".dv-unanchored-threads").textContent, /Comment outside visible hunk/);
  assert.match(mainEl.querySelector(".dv-orphan-comments-card").textContent, /Comment on file no longer in diff/);
  assert.ok(fileCards[0].querySelector(".tok-keyword"), "Modified Split lines must retain syntax token spans");
  assert.ok(fileCards[0].querySelector(".dv-word-add"), "Modified Split lines must retain word-diff highlights");

  // Verify keyboard accessibility on .dv-ln.commentable (Enter opens CommentComposer) + zero FileDiffCard re-renders while typing
  const commentableCell = fileCards[0]
    .querySelectorAll("td")
    .find((td) => td.className.includes("commentable"));
  assert.equal(commentableCell.getAttribute("role"), "button");
  assert.equal(commentableCell.getAttribute("tabIndex"), "0");
  const keyDownHandler = [...(commentableCell.listeners.get("keydown") || [])][0];
  keyDownHandler.call(commentableCell, {
    type: "keydown",
    key: "Enter",
    preventDefault() {},
    stopPropagation() {},
  });
  await new Promise((r) => setTimeout(r, 10));

  const composerTextarea = fileCards[0].querySelector("textarea");
  assert.ok(composerTextarea, "Pressing Enter on a commentable line number must mount CommentComposer");
  fileCardRenderCalls = 0;
  const inputHandler = [...(composerTextarea.listeners.get("input") || [])][0];
  composerTextarea.value = "Zero lag typing";
  inputHandler.call(composerTextarea, { type: "input", currentTarget: composerTextarea });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(fileCardRenderCalls, 0, "Typing inside CommentComposer must not re-render any FileDiffCard");

  // Verify SSE broadcast with identical diffRev (toggling viewed on package-lock.json) skips re-rendering src/app.ts and src/generated.ts
  const clonedFiles = JSON.parse(JSON.stringify(parsed.files));
  const nextSseState = {
    ...state,
    files: clonedFiles,
    viewedFiles: ["package-lock.json"],
  };
  fileCardRenderCalls = 0;
  render(
    html`<${DiffCanvasApp} state=${nextSseState} invoke=${async () => ({ ok: true })} />`,
    container,
  );
  assert.equal(
    fileCardRenderCalls,
    1,
    "SSE state update with unchanged diffRev must only re-render the single affected FileDiffCard",
  );

  // Verify Expand all / Collapse all toggle button in sidebar header
  const expandAllBtn = container
    .querySelectorAll("button")
    .find((btn) => btn.textContent.includes("Expand all"));
  assert.ok(expandAllBtn, "Sidebar header must render Expand all button when files are collapsed");

  const clickHandler = [...(unifiedBtn.listeners.get("click") || [])][0];
  clickHandler.call(unifiedBtn, { type: "click", preventDefault() {}, stopPropagation() {} });
  // Flush Preact queued rerender
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(container.querySelector(".dv-table-unified"), "Unified diff table must mount cleanly");
  assert.equal(unifiedBtn.getAttribute("aria-pressed"), "true");

  // Verify "New Review Round" button renders when status === "addressed"
  render(
    html`<${DiffCanvasApp}
      state=${{ ...nextSseState, status: "addressed" }}
      invoke=${async (name, input) => {
        invokedActions.push({ name, input });
        return { ok: true };
      }}
    />`,
    container,
  );
  const newRoundBtn = container
    .querySelectorAll("button")
    .find((btn) => btn.textContent.includes("New Review Round"));
  assert.ok(newRoundBtn, "Toolbar must render New Review Round button when status is addressed");

  // Verify clean working tree empty message vs filtered empty message
  render(
    html`<${DiffCanvasApp}
      state=${{
        ...nextSseState,
        diffRev: 2,
        truncatedFiles: false,
        comments: [],
        files: [],
        stats: { fileCount: 0, totalFiles: 0, additions: 0, deletions: 0 },
      }}
      invoke=${async () => ({ ok: true })}
    />`,
    container,
  );
  assert.match(container.textContent, /Working tree is clean - no changes detected\./);

  // Verify drag listener & body userSelect cleanup on unmount
  render(html`<${DiffCanvasApp} state=${nextSseState} invoke=${async () => ({ ok: true })} />`, container);
  const resizer = container.querySelector(".dv-resizer");
  const downHandler = [...(resizer.listeners.get("mousedown") || [])][0];
  downHandler.call(resizer, { type: "mousedown", clientX: 260, preventDefault() {} });
  assert.equal(strictDoc.body.style.userSelect, "none");
  assert.equal((windowListeners.get("mousemove") || new Set()).size, 1);
  render(null, container);
  assert.equal(strictDoc.body.style.userSelect, "");
  assert.equal((windowListeners.get("mousemove") || new Set()).size, 0);

  // Verify:
  // (a) busyAction isolation: clicking Viewed on 1 file when comments === [] re-renders ONLY that 1 FileDiffCard
  // (b) unchecking Viewed on an auto-collapsed lockfile keeps it auto-collapsed (does NOT explode it open)
  // (c) failed toggle_viewed does not collapse the file
  // (d) sidebar Viewed count reflects filteredFiles only (ignoring ghost viewedFiles)
  // (e) scrollToFile locates shifted oldLine / newLine rows accurately via data-old-line / data-new-line
  const shiftedPatch = [
    "diff --git a/src/shifted.ts b/src/shifted.ts",
    "index 1111111..2222222 100644",
    "--- a/src/shifted.ts",
    "+++ b/src/shifted.ts",
    "@@ -10,2 +25,2 @@",
    "-const deletedAtTen = true;",
    " const pairedOld11New25 = false;",
    "diff --git a/package-lock.json b/package-lock.json",
    "index 3333333..4444444 100644",
    "--- a/package-lock.json",
    "+++ b/package-lock.json",
    "@@ -1,1 +1,2 @@",
    " {}",
    "+// lockfile",
    "diff --git a/src/untouched.ts b/src/untouched.ts",
    "index 5555555..6666666 100644",
    "--- a/src/untouched.ts",
    "+++ b/src/untouched.ts",
    "@@ -1,1 +1,1 @@",
    "-export const v = 1;",
    "+export const v = 2;",
  ].join("\n");
  const shiftedParsed = parseDiffPatch(shiftedPatch);
  let cr2State = {
    domain: "pr__example-org__demo__300",
    loaded: true,
    diffRev: 1,
    truncatedFiles: false,
    error: null,
    title: "example-org/demo#300",
    status: "draft",
    stats: {
      fileCount: shiftedParsed.fileCount,
      totalFiles: shiftedParsed.totalFiles,
      additions: shiftedParsed.additions,
      deletions: shiftedParsed.deletions,
    },
    viewedFiles: ["ghost-deleted.ts", "package-lock.json"],
    comments: [],
    files: shiftedParsed.files,
    focusedFile: null,
    focusedLine: null,
    focusSeq: 0,
  };

  let shouldFailToggle = false;
  const cr2Container = globalThis.document.createElement("div");
  t.after(() => {
    render(null, cr2Container);
  });
  const rerenderCr2 = () =>
    render(
      html`<${DiffCanvasApp}
        state=${cr2State}
        invoke=${async (name, input) => {
          if (name === "toggle_viewed") {
            if (shouldFailToggle) throw new Error("Simulated network error");
            const set = new Set(cr2State.viewedFiles);
            if (set.has(input.file)) set.delete(input.file);
            else set.add(input.file);
            cr2State = { ...cr2State, viewedFiles: [...set] };
            return { ok: true };
          }
          return { ok: true };
        }}
      />`,
      cr2Container,
    );

  rerenderCr2();
  const sidebarHeader = cr2Container.querySelector(".dv-sidebar-header");
  assert.match(
    sidebarHeader.textContent,
    /1 viewed/,
    "Sidebar Viewed count must ignore ghost viewedFiles outside filteredFiles",
  );

  // Toggling Viewed on src/shifted.ts when comments === [] must NOT re-render package-lock.json or src/untouched.ts
  const cr2Cards = cr2Container.querySelectorAll(".dv-file-card");
  assert.equal(cr2Cards.length, 3);
  const shiftedCheckbox = cr2Cards[0].querySelector("input");
  fileCardRenderCalls = 0;
  shouldFailToggle = true;
  const shiftChange = [...(shiftedCheckbox.listeners.get("change") || [])][0];
  await shiftChange.call(shiftedCheckbox, { type: "change" });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(
    fileCardRenderCalls,
    0,
    "Failed toggle_viewed with 0 comments must trigger 0 FileDiffCard re-renders and must not collapse the file",
  );
  assert.equal(cr2Cards[0].className.includes("collapsed"), false);

  shouldFailToggle = false;
  renderedCardPaths = [];
  await shiftChange.call(shiftedCheckbox, { type: "change" });
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(
    renderedCardPaths,
    ["src/shifted.ts"],
    "busyAction + collapse during toggle_viewed must only re-render the 1 toggled FileDiffCard",
  );
  renderedCardPaths = [];
  rerenderCr2();
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(
    renderedCardPaths,
    ["src/shifted.ts"],
    "SSE viewedFiles update must only re-render the 1 toggled FileDiffCard",
  );
  assert.equal(cr2Cards[0].className.includes("collapsed"), true);

  // Unchecking Viewed on package-lock.json (auto-collapsed lockfile) must keep it auto-collapsed!
  const lockCheckbox = cr2Cards[1].querySelector("input");
  const lockChange = [...(lockCheckbox.listeners.get("change") || [])][0];
  await lockChange.call(lockCheckbox, { type: "change" });
  rerenderCr2();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(
    cr2Cards[1].className.includes("collapsed"),
    true,
    "Unchecking Viewed on package-lock.json must return it to auto-collapsed state instead of expanding",
  );
  assert.ok(
    cr2Cards[1].querySelector(".dv-collapsed-notice"),
    "Unchecked auto-collapsed lockfile must show its collapsed CTA again",
  );

  // Unchecking Viewed on normal file src/shifted.ts expands it back open
  await shiftChange.call(shiftedCheckbox, { type: "change" });
  rerenderCr2();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(cr2Cards[0].className.includes("collapsed"), false);

  // Verify scrollToFile finds both deleted line (oldLine=10) and paired shifted line (oldLine=11, newLine=25)
  StrictElement.scrollHistory = [];
  cr2State = {
    ...cr2State,
    focusedFile: "src/shifted.ts",
    focusedLine: 10,
    focusSeq: 1,
  };
  rerenderCr2();
  await new Promise((r) => setTimeout(r, 180));
  assert.equal(StrictElement.scrollHistory.length, 1);
  assert.equal(StrictElement.scrollHistory[0].localName, "tr");
  assert.equal(StrictElement.scrollHistory[0].getAttribute("data-old-line"), "10");
  assert.equal(StrictElement.scrollHistory[0].getAttribute("data-new-line"), null);

  cr2State = {
    ...cr2State,
    focusedFile: "src/shifted.ts",
    focusedLine: 11,
    focusSeq: 2,
  };
  rerenderCr2();
  await new Promise((r) => setTimeout(r, 180));
  assert.equal(StrictElement.scrollHistory.length, 2);
  assert.equal(StrictElement.scrollHistory[1].localName, "tr");
  assert.equal(StrictElement.scrollHistory[1].getAttribute("data-old-line"), "11");
  assert.equal(StrictElement.scrollHistory[1].getAttribute("data-new-line"), "25");

  // Even when package-lock.json was focused via focusFile, checking then unchecking Viewed keeps it collapsed
  cr2State = {
    ...cr2State,
    focusedFile: "package-lock.json",
    focusedLine: null,
    focusSeq: 3,
  };
  rerenderCr2();
  await new Promise((r) => setTimeout(r, 10));
  await lockChange.call(lockCheckbox, { type: "change" });
  rerenderCr2();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(cr2Cards[1].className.includes("collapsed"), true);
  await lockChange.call(lockCheckbox, { type: "change" });
  rerenderCr2();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(
    cr2Cards[1].className.includes("collapsed"),
    true,
    "Unchecking Viewed on focused package-lock.json must keep it collapsed",
  );

  // Domain switch must reset stale fileQuery, collapsedDirs, and actionError so new domain's focusedFile renders and scrolls
  const filterInput = cr2Container.querySelector(".dv-search-input");
  filterInput.value = "untouched";
  const filterHandler = [...(filterInput.listeners.get("input") || [])][0];
  filterHandler.call(filterInput, { type: "input", target: filterInput, currentTarget: filterInput });
  rerenderCr2();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(cr2Container.querySelectorAll(".dv-file-card").length, 1);

  shouldFailToggle = true;
  const untouchedCheckbox = cr2Container.querySelector(".dv-file-card").querySelector("input");
  const untouchedChange = [...(untouchedCheckbox.listeners.get("change") || [])][0];
  await untouchedChange.call(untouchedCheckbox, { type: "change" });
  shouldFailToggle = false;
  rerenderCr2();
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(cr2Container.querySelector(".dv-error-banner"));

  StrictElement.scrollHistory = [];
  cr2State = {
    ...cr2State,
    domain: "git__cr2_next_domain",
    diffRev: 2,
    files: [
      {
        canonicalPath: "src/new-domain-file.ts",
        displayPath: "src/new-domain-file.ts",
        status: "added",
        additions: 1,
        deletions: 0,
        hunks: [
          {
            header: "@@ -0,0 +1,1 @@",
            lines: [{ type: "add", oldLine: null, newLine: 1, content: "export const switched = true;" }],
          },
        ],
      },
    ],
    focusedFile: "src/new-domain-file.ts",
    focusedLine: null,
    focusSeq: 1,
  };
  rerenderCr2();
  await new Promise((r) => setTimeout(r, 180));
  assert.equal(
    cr2Container.querySelector(".dv-error-banner"),
    null,
    "Domain switch must clear stale actionError banner",
  );
  assert.equal(
    cr2Container.querySelectorAll(".dv-file-card").length,
    1,
    "Domain switch must clear stale fileQuery so new domain files render",
  );
  assert.equal(StrictElement.scrollHistory.length, 1);

  // Verify non-Copilot-App Submit Review handoff banner (notifiedAgent: false vs true)
  let nextNotifyAgentResult = false;
  const renderHandoff = (st) =>
    render(
      html`<${DiffCanvasApp}
        state=${st}
        invoke=${async (name) => {
          if (name === "submit_review") {
            return {
              status: "pending",
              commentCount: 1,
              notifiedAgent: nextNotifyAgentResult,
            };
          }
          if (name === "reopen_review") {
            return { status: "draft", commentCount: 1, clearedComments: false };
          }
          return { ok: true };
        }}
      />`,
      cr2Container,
    );

  let handoffState = {
    ...cr2State,
    status: "draft",
    comments: [
      {
        id: "h1",
        file: "src/new-domain-file.ts",
        line: 1,
        side: "right",
        body: "Needs check",
        stale: false,
        createdAt: new Date().toISOString(),
      },
    ],
  };
  renderHandoff(handoffState);
  let submitBtn = cr2Container
    .querySelectorAll("button")
    .find((btn) => btn.textContent.includes("Submit Review"));
  assert.ok(submitBtn);
  const submitClick = [...(submitBtn.listeners.get("click") || [])][0];
  await submitClick.call(submitBtn, { type: "click" });
  handoffState = { ...handoffState, status: "pending" };
  renderHandoff(handoffState);
  await new Promise((r) => setTimeout(r, 10));
  const handoffBanner = cr2Container.querySelector(".dv-handoff-banner");
  assert.ok(handoffBanner, "When notifiedAgent is false, .dv-handoff-banner must appear");
  assert.match(handoffBanner.textContent, /ask your agent to run \/diff review/);

  // Marking addressed clears manualHandoffNeeded automatically
  handoffState = { ...handoffState, status: "addressed" };
  renderHandoff(handoffState);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(cr2Container.querySelector(".dv-handoff-banner"), null);

  // In Copilot App (notifiedAgent: true), .dv-handoff-banner does NOT appear
  nextNotifyAgentResult = true;
  handoffState = { ...handoffState, status: "draft" };
  renderHandoff(handoffState);
  await new Promise((r) => setTimeout(r, 10));
  submitBtn = cr2Container
    .querySelectorAll("button")
    .find((btn) => btn.textContent.includes("Submit Review"));
  const submitClickApp = [...(submitBtn.listeners.get("click") || [])][0];
  await submitClickApp.call(submitBtn, { type: "click" });
  handoffState = { ...handoffState, status: "pending" };
  renderHandoff(handoffState);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(
    cr2Container.querySelector(".dv-handoff-banner"),
    null,
    "When notifiedAgent is true (Copilot App), .dv-handoff-banner must stay hidden",
  );

  // Verify !state.loaded Retry/Refresh button, labeled Refresh button, 'R' shortcut (ignored in inputs),
  // scrollTop preservation, check_updates live banner (0 FileDiffCard re-renders), draft-safe Auto-refresh,
  // and automatic card un-collapse when a viewed file's hunks change on refresh
  let refreshCalls = 0;
  let probeChangedResult = false;
  let probeSignatureResult = null;
  let refreshReturnPayload = { ok: true, changed: false, invalidatedViewedFiles: [] };
  let liveUiState = {
    domain: "pr__example-org__demo__401",
    loaded: false,
    diffRev: 0,
    contextSignature: null,
    error: "Temporary network failure",
    source: { mode: "pr", repo: "example-org/demo", pr: 401, paths: [] },
    title: "example-org/demo#401",
    status: "draft",
    stats: { fileCount: 0, totalFiles: 0, additions: 0, deletions: 0 },
    viewedFiles: [],
    comments: [],
    files: [],
    focusedFile: null,
    focusedLine: null,
    focusSeq: 0,
  };

  const renderLiveUi = () =>
    render(
      html`<${DiffCanvasApp}
        state=${liveUiState}
        invoke=${async (name) => {
          if (name === "check_updates") {
            return {
              ok: true,
              changed: probeChangedResult,
              ...(probeSignatureResult ? { contextSignature: probeSignatureResult } : {}),
              sourceMode: liveUiState.source?.mode || "pr",
              checkedAt: new Date().toISOString(),
            };
          }
          if (name === "refresh") {
            refreshCalls += 1;
            return refreshReturnPayload;
          }
          return { ok: true };
        }}
      />`,
      cr2Container,
    );

  // 1. !state.loaded screen renders labeled Retry button and triggers refresh
  renderLiveUi();
  const unloadedRetryBtn = cr2Container.querySelector(".dv-unloaded-retry-btn");
  assert.ok(unloadedRetryBtn, "!state.loaded card must render a Retry/Refresh button");
  assert.match(unloadedRetryBtn.textContent, /Retry/);
  const unloadedRetryClick = [...(unloadedRetryBtn.listeners.get("click") || [])][0];
  await unloadedRetryClick.call(unloadedRetryBtn, { type: "click" });
  assert.equal(refreshCalls, 1);

  // 2. Loaded screen renders labeled Refresh button, preserves scrollTop, shows feedback toast, and handles 'R' shortcut
  const refreshParsed = parseDiffPatch(
    [
      "diff --git a/src/alpha.ts b/src/alpha.ts",
      "index 1111111..2222222 100644",
      "--- a/src/alpha.ts",
      "+++ b/src/alpha.ts",
      "@@ -1,1 +1,1 @@",
      "-export const alpha = 1;",
      "+export const alpha = 2;",
      "diff --git a/src/beta.ts b/src/beta.ts",
      "index 3333333..4444444 100644",
      "--- a/src/beta.ts",
      "+++ b/src/beta.ts",
      "@@ -1,1 +1,1 @@",
      "-export const beta = 1;",
      "+export const beta = 2;",
    ].join("\n"),
  );
  liveUiState = {
    ...liveUiState,
    loaded: true,
    error: null,
    diffRev: 1,
    contextSignature: "sig_v1",
    stats: {
      fileCount: refreshParsed.fileCount,
      totalFiles: refreshParsed.totalFiles,
      additions: refreshParsed.additions,
      deletions: refreshParsed.deletions,
    },
    viewedFiles: ["src/alpha.ts", "src/beta.ts"],
    files: refreshParsed.files,
  };
  renderLiveUi();
  await new Promise((r) => setTimeout(r, 15));

  const toolbarRefreshBtn = cr2Container.querySelector(".dv-refresh-btn");
  assert.ok(toolbarRefreshBtn, "Toolbar must render .dv-refresh-btn");
  assert.match(toolbarRefreshBtn.textContent, /Refresh/, "Toolbar Refresh button must have visible 'Refresh' text label");

  const mainPaneEl = cr2Container.querySelector(".dv-main");
  mainPaneEl.scrollTop = 340;

  // Manually collapse both viewed cards (simulating user having checked Viewed on both)
  const liveCardsInitial = cr2Container.querySelectorAll(".dv-file-card");
  for (const card of liveCardsInitial) {
    const collapseBtn = card.querySelector(".dv-collapse-btn");
    const clickFn = [...(collapseBtn.listeners.get("click") || [])][0];
    clickFn.call(collapseBtn, { type: "click" });
  }
  renderLiveUi();
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(cr2Container.querySelectorAll(".dv-file-card")[0].className.includes("collapsed"), true);
  assert.equal(cr2Container.querySelectorAll(".dv-file-card")[1].className.includes("collapsed"), true);

  // Pressing 'r' inside an INPUT must NOT trigger refresh; pressing 'r' outside inputs MUST trigger refresh
  const keydownHandlers = [...(windowListeners.get("keydown") || [])];
  assert.ok(keydownHandlers.length >= 1, "Window keydown shortcut listener must be registered");
  const searchInputEl = cr2Container.querySelector(".dv-search-input");
  for (const fn of keydownHandlers) {
    fn({ key: "r", target: searchInputEl, preventDefault() {} });
    fn({ key: "r", ctrlKey: true, target: mainPaneEl, preventDefault() {} });
  }
  assert.equal(refreshCalls, 1, "Shortcut 'r' must ignore INPUT targets and Ctrl+R");

  let shortcutPrevented = false;
  for (const fn of keydownHandlers) {
    fn({
      key: "R",
      target: mainPaneEl,
      preventDefault() {
        shortcutPrevented = true;
      },
    });
  }
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(shortcutPrevented, true);
  assert.equal(refreshCalls, 2, "Pressing 'R' outside inputs must trigger refresh");
  assert.equal(mainPaneEl.scrollTop, 340, "Refresh must preserve .dv-main scrollTop");
  assert.match(
    cr2Container.querySelector(".dv-refresh-toast")?.textContent || "",
    /Already up to date/,
  );

  // 3. Background check_updates on window focus renders .dv-update-banner with 0 FileDiffCard re-renders
  probeChangedResult = true;
  fileCardRenderCalls = 0;
  for (const fn of windowListeners.get("focus") || []) {
    await fn();
  }
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(
    fileCardRenderCalls,
    0,
    "Background check_updates banner appearance must not re-render FileDiffCards",
  );
  const updateBanner = cr2Container.querySelector(".dv-update-banner");
  assert.ok(updateBanner, ".dv-update-banner must appear when check_updates reports changed: true");
  assert.match(updateBanner.textContent, /New changes detected in pull request/);
  assert.ok(cr2Container.querySelector(".dv-update-dot"), "Refresh button must show update indicator dot");

  // 4. Draft-safe Auto-refresh: pauses while an inline comment composer is open, then refreshes once closed
  // Expand first card so we can open a line composer
  const alphaCollapseBtn = cr2Container.querySelectorAll(".dv-file-card")[0].querySelector(".dv-collapse-btn");
  [...(alphaCollapseBtn.listeners.get("click") || [])][0].call(alphaCollapseBtn, { type: "click" });
  renderLiveUi();
  await new Promise((r) => setTimeout(r, 10));

  const commentableLineCell = cr2Container.querySelector(".commentable");
  assert.ok(commentableLineCell);
  [...(commentableLineCell.listeners.get("click") || [])][0].call(commentableLineCell, { type: "click" });
  renderLiveUi();
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(cr2Container.querySelector(".dv-composer"), "Inline comment composer should be open");

  const autoRefreshCheckbox = cr2Container
    .querySelector(".dv-update-banner")
    .querySelector("input");
  autoRefreshCheckbox.checked = true;
  [...(autoRefreshCheckbox.listeners.get("change") || [])][0].call(autoRefreshCheckbox, {
    type: "change",
    currentTarget: autoRefreshCheckbox,
    target: autoRefreshCheckbox,
  });
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(
    refreshCalls,
    2,
    "Auto-refresh must pause while a visible inline comment composer draft is open",
  );
  assert.match(
    cr2Container.querySelector(".dv-update-banner").textContent,
    /Auto-refresh paused while editing comment/,
  );

  // Collapsing alpha clears its hidden composer so Auto-refresh is never stuck paused!
  // Simulate server refresh invalidating src/alpha.ts (hunks changed) while keeping src/beta.ts viewed
  refreshReturnPayload = {
    ok: true,
    changed: true,
    invalidatedViewedFiles: ["src/alpha.ts"],
  };
  [...(alphaCollapseBtn.listeners.get("click") || [])][0].call(alphaCollapseBtn, { type: "click" });
  renderLiveUi();
  await new Promise((r) => setTimeout(r, 140));
  assert.equal(
    refreshCalls,
    3,
    "Collapsing the file with an open composer clears the hidden composer and runs deferred Auto-refresh",
  );
  assert.equal(
    cr2Container.querySelector(".dv-update-banner"),
    null,
    "Update banner must clear once refresh succeeds",
  );

  // Collapse both cards, then push SSE diffRev=2 where src/alpha.ts was invalidated from viewedFiles while src/beta.ts stayed viewed
  probeChangedResult = false;
  for (const card of cr2Container.querySelectorAll(".dv-file-card")) {
    if (!card.className.includes("collapsed")) {
      const btn = card.querySelector(".dv-collapse-btn");
      [...(btn.listeners.get("click") || [])][0].call(btn, { type: "click" });
    }
  }
  renderLiveUi();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(cr2Container.querySelectorAll(".dv-file-card")[0].className.includes("collapsed"), true);
  assert.equal(cr2Container.querySelectorAll(".dv-file-card")[1].className.includes("collapsed"), true);

  const refreshParsedV2 = parseDiffPatch(
    [
      "diff --git a/src/alpha.ts b/src/alpha.ts",
      "index 1111111..9999999 100644",
      "--- a/src/alpha.ts",
      "+++ b/src/alpha.ts",
      "@@ -1,1 +1,1 @@",
      "-export const alpha = 1;",
      "+export const alpha = 99;",
      "diff --git a/src/beta.ts b/src/beta.ts",
      "index 3333333..4444444 100644",
      "--- a/src/beta.ts",
      "+++ b/src/beta.ts",
      "@@ -1,1 +1,1 @@",
      "-export const beta = 1;",
      "+export const beta = 2;",
    ].join("\n"),
  );
  liveUiState = {
    ...liveUiState,
    diffRev: 2,
    contextSignature: "sig_v2",
    viewedFiles: ["src/beta.ts"],
    files: refreshParsedV2.files,
  };
  renderLiveUi();
  await new Promise((r) => setTimeout(r, 140));
  assert.equal(
    cr2Container.querySelectorAll(".dv-file-card")[0].className.includes("collapsed"),
    false,
    "File whose Viewed status was invalidated on refresh must automatically expand",
  );
  assert.equal(
    cr2Container.querySelectorAll(".dv-file-card")[1].className.includes("collapsed"),
    true,
    "Unchanged file that remained Viewed must stay collapsed across refresh",
  );

  // 5. Unanchored comment editing pauses Auto-refresh, and reverted contextSignature clears .dv-update-banner
  const specialTreeParsed = parseDiffPatch(
    [
      "diff --git a/constructor/util.ts b/constructor/util.ts",
      "index 1111111..2222222 100644",
      "--- a/constructor/util.ts",
      "+++ b/constructor/util.ts",
      "@@ -1,1 +1,1 @@",
      "-export const u = 1;",
      "+export const u = 2;",
    ].join("\n"),
  );
  liveUiState = {
    ...liveUiState,
    diffRev: 3,
    contextSignature: "sig_v3",
    viewedFiles: [],
    comments: [
      {
        id: "c_unanchored",
        file: "constructor/util.ts",
        line: 999,
        side: "right",
        body: "Outdated line note",
        stale: true,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    files: specialTreeParsed.files,
  };
  renderLiveUi();
  await new Promise((r) => setTimeout(r, 140));

  // Sidebar tree must render constructor/util.ts expanded by default (not hidden by Object.prototype.constructor)
  const sidebarTreeText = cr2Container.querySelector(".dv-sidebar")?.textContent || "";
  assert.match(sidebarTreeText, /constructor/);
  assert.match(sidebarTreeText, /util\.ts/);

  // Open Edit on the unanchored comment card -> activeEditCount > 0 pauses Auto-refresh
  const unanchoredEditBtn = cr2Container
    .querySelector(".dv-unanchored-threads")
    .querySelectorAll("button")
    .find((b) => b.textContent.trim() === "Edit");
  assert.ok(unanchoredEditBtn, "Unanchored comment card must render Edit button");
  [...(unanchoredEditBtn.listeners.get("click") || [])][0].call(unanchoredEditBtn, { type: "click" });
  renderLiveUi();
  await new Promise((r) => setTimeout(r, 140));

  const callsBeforeUnanchoredProbe = refreshCalls;
  probeChangedResult = true;
  probeSignatureResult = "sig_v4_dirty";
  for (const fn of windowListeners.get("focus") || []) {
    await fn();
  }
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(
    refreshCalls,
    callsBeforeUnanchoredProbe,
    "Auto-refresh must pause while editing an unanchored comment",
  );
  assert.match(
    cr2Container.querySelector(".dv-update-banner")?.textContent || "",
    /Auto-refresh paused while editing comment/,
  );

  // Revert changes so check_updates reports the matching sig_v3 signature -> banner clears automatically!
  probeChangedResult = false;
  probeSignatureResult = "sig_v3";
  for (const fn of windowListeners.get("focus") || []) {
    await fn();
  }
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(
    cr2Container.querySelector(".dv-update-banner"),
    null,
    "Reverting context changes back to current contextSignature must clear .dv-update-banner",
  );

  // 6. Filtered focus_file clears fileQuery and reveals focused file, copied badge renders, and !state.loaded displays title + saved comments + error heading
  const multiParsed = parseDiffPatch(
    [
      "diff --git a/src/first.ts b/src/first.ts",
      "index 1111111..2222222 100644",
      "--- a/src/first.ts",
      "+++ b/src/first.ts",
      "@@ -1,1 +1,1 @@",
      "-export const f = 1;",
      "+export const f = 2;",
      "diff --git a/src/base.ts b/src/copied-target.ts",
      "similarity index 90%",
      "copy from src/base.ts",
      "copy to src/copied-target.ts",
      "index 3333333..4444444 100644",
      "--- a/src/base.ts",
      "+++ b/src/copied-target.ts",
      "@@ -1,1 +1,1 @@",
      "-export const c = 1;",
      "+export const c = 2;",
    ].join("\n"),
  );
  liveUiState = {
    ...liveUiState,
    diffRev: 4,
    contextSignature: "sig_v4",
    comments: [],
    files: multiParsed.files,
    focusedFile: null,
    focusSeq: 0,
  };
  renderLiveUi();
  await new Promise((r) => setTimeout(r, 20));
  assert.match(
    cr2Container.querySelectorAll(".dv-file-card")[1]?.textContent || "",
    /copied/,
    "Copied file card must render 'copied' status badge",
  );

  const focusFilterInput = cr2Container.querySelector(".dv-search-input");
  assert.ok(focusFilterInput, "Toolbar filter input must exist");
  focusFilterInput.value = "first.ts";
  [...(focusFilterInput.listeners.get("input") || [])][0].call(focusFilterInput, {
    type: "input",
    target: focusFilterInput,
    currentTarget: focusFilterInput,
  });
  renderLiveUi();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(cr2Container.querySelectorAll(".dv-file-card").length, 1);

  // Agent triggers focus_file on src/copied-target.ts (excluded by "first.ts" filter) -> clears fileQuery and reveals both cards!
  StrictElement.scrollHistory = [];
  liveUiState = {
    ...liveUiState,
    focusedFile: "src/copied-target.ts",
    focusedLine: 1,
    focusSeq: 1,
  };
  renderLiveUi();
  await new Promise((r) => setTimeout(r, 180));
  assert.equal(
    cr2Container.querySelectorAll(".dv-file-card").length,
    2,
    "Agent focus_file on a filtered-out file must clear fileQuery and reveal the target file card",
  );
  assert.equal(
    StrictElement.scrollHistory.length > 0,
    true,
    "Agent focus_file after clearing fileQuery must scroll to the revealed target file/line",
  );

  // Subsequent diff refresh with unchanged focusSeq must NOT clear active fileQuery, uncollapse cards, or hijack scroll!
  const copiedCollapseBtn = cr2Container
    .querySelectorAll(".dv-file-card")[1]
    .querySelector(".dv-collapse-btn");
  [...(copiedCollapseBtn.listeners.get("click") || [])][0].call(copiedCollapseBtn, {
    type: "click",
  });
  renderLiveUi();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(
    cr2Container.querySelectorAll(".dv-file-card")[1].className.includes("collapsed"),
    true,
  );

  focusFilterInput.value = "first.ts";
  [...(focusFilterInput.listeners.get("input") || [])][0].call(focusFilterInput, {
    type: "input",
    target: focusFilterInput,
    currentTarget: focusFilterInput,
  });
  renderLiveUi();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(cr2Container.querySelectorAll(".dv-file-card").length, 1);

  StrictElement.scrollHistory = [];
  liveUiState = {
    ...liveUiState,
    diffRev: 5,
    contextSignature: "sig_v5",
    files: multiParsed.files.map((f) => ({ ...f })),
  };
  renderLiveUi();
  await new Promise((r) => setTimeout(r, 180));
  assert.equal(
    cr2Container.querySelectorAll(".dv-file-card").length,
    1,
    "Refreshing diff with unchanged focusSeq must preserve active fileQuery",
  );
  assert.equal(
    StrictElement.scrollHistory.length,
    0,
    "Refreshing diff with unchanged focusSeq must not re-scroll to historical focusedFile",
  );

  // Render !state.loaded with saved source, title, error, and 2 saved comments
  liveUiState = {
    domain: "pr__example-org__widgets__55",
    loaded: false,
    error: "GitHub API temporarily unavailable",
    source: { mode: "pr", repo: "example-org/widgets", pr: 55, paths: [] },
    title: "example-org/widgets#55 - Saved Offline PR",
    status: "pending",
    viewedFiles: [],
    comments: [
      { id: "s1", file: "a.ts", line: 1, side: "right", body: "One" },
      { id: "s2", file: "b.ts", line: 2, side: "right", body: "Two" },
    ],
    files: [],
  };
  renderLiveUi();
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(
    cr2Container.querySelector(".dv-title")?.textContent,
    "example-org/widgets#55 - Saved Offline PR",
  );
  assert.match(cr2Container.textContent, /Unable to load diff/);
  assert.match(cr2Container.textContent, /2 saved comments/);

  render(null, container);
  render(null, cr2Container);
  await new Promise((r) => setTimeout(r, 150));
});

test("cached-domain reopen retries after transient failure, preserves non-secret account in durable source, and computes fresh status", async (t) => {
  const storeHome = makeTempDir("diff-cached-reopen-");
  const prevHome = process.env.COPILOT_HOME;
  process.env.COPILOT_HOME = storeHome;
  t.after(() => {
    if (prevHome === undefined) delete process.env.COPILOT_HOME;
    else process.env.COPILOT_HOME = prevHome;
    fs.rmSync(storeHome, { recursive: true, force: true });
  });
  const customStore = (file) => userStore("diff", file);

  const samplePatch = [
    "diff --git a/src/private.ts b/src/private.ts",
    "index 1111111..2222222 100644",
    "--- a/src/private.ts",
    "+++ b/src/private.ts",
    "@@ -1,1 +1,2 @@",
    " export const ok = true;",
    "+export const emu = true;",
  ].join("\n");

  const fakeEnv = {
    ...process.env,
    COPILOT_GH_ACCOUNT_github_2E_com_sample_5F_emu: "ghs_secret_emu_token_value",
  };

  let failWithoutEmu = true;
  const seenTokens = [];
  const mockExecFn = async (_cmd, args, opts) => {
    const token = opts?.env?.GH_TOKEN || "";
    seenTokens.push(token);
    if (failWithoutEmu && token !== "ghs_secret_emu_token_value") {
      throw new Error("GraphQL: Could not resolve to a Repository with the name 'example-org/emu-repo'.");
    }
    if (args[0] === "pr" && args[1] === "diff") {
      return samplePatch;
    }
    if (args[0] === "pr" && args[1] === "view") {
      return JSON.stringify({
        number: 77,
        title: "EMU PR",
        headRefName: "feat/emu",
        baseRefName: "main",
      });
    }
    throw new Error(`Unexpected command: ${args.join(" ")}`);
  };

  // Seed a durable review file (e.g. from an earlier online session)
  await customStore("pr__example-org__emu-repo__77.json").save({
    domain: "pr__example-org__emu-repo__77",
    source: {
      mode: "pr",
      repo: "example-org/emu-repo",
      pr: 77,
      paths: [],
    },
    title: "example-org/emu-repo#77: EMU PR",
    status: "draft",
    viewedFiles: [],
    comments: [],
    updatedAt: new Date().toISOString(),
  });

  // 1. First open fails (e.g. offline/no fallback token initially) -> caches { loaded: false, error }
  const noFallbackEnv = { PATH: process.env.PATH };
  const cfg = createDiffCanvasConfig({
    execFn: mockExecFn,
    env: noFallbackEnv,
    storeFactory: customStore,
  });
  const rt = createCanvasRuntime(cfg);
  t.after(() => rt.shutdown());

  assert.equal(isDomainCached({ repo: "example-org/emu-repo", pr: 77 }, { workspacePath: "" }, cfg), false);
  const firstOpen = await rt.openInstance({
    instanceId: "emu-panel",
    input: { repo: "example-org/emu-repo", pr: 77 },
    ctx: { instanceId: "emu-panel", workspacePath: "" },
  });
  assert.equal(firstOpen.status, "Diff Viewer (ready)");
  assert.equal(isDomainHydrated({ repo: "example-org/emu-repo", pr: 77 }, { workspacePath: "" }, cfg), false);
  assert.equal(isDomainCached({ repo: "example-org/emu-repo", pr: 77 }, { workspacePath: "" }, cfg), true);

  // 2. Now token becomes available or user supplies `account: "sample_emu"` on reopen
  Object.assign(noFallbackEnv, fakeEnv);
  const reopenCtx = {
    instanceId: "emu-panel",
    input: { repo: "example-org/emu-repo", pr: 77, account: "sample_emu" },
    workspacePath: "",
  };
  const wasCached = isDomainCached(reopenCtx.input, reopenCtx, cfg);
  assert.equal(wasCached, true);

  const rawOpened = await rt.openInstance({
    instanceId: reopenCtx.instanceId,
    input: reopenCtx.input,
    ctx: reopenCtx,
  });
  if (wasCached) {
    await rt.invokeFromAgent("refresh", {}, reopenCtx);
  }
  const domainId = computeDomainId(reopenCtx.input, reopenCtx.workspacePath);
  const latestState = await rt.getState(domainId);
  const finalStatus = cfg.statusLine(reopenCtx, latestState);
  assert.notEqual(rawOpened.status, finalStatus);
  assert.match(finalStatus, /example-org\/emu-repo#77 - EMU PR \| 1 files \(\+1\/-0\) \| draft \(0 comments\)/);
  assert.equal(latestState.loaded, true);
  assert.equal(latestState.source.account, "sample_emu");
  assert.equal(JSON.stringify(latestState).includes("ghs_secret_emu_token_value"), false);

  // 3. Verify durable JSON saved non-secret `account: "sample_emu"` (never the token) and a cold getState restores it
  const savedDiskText = fs.readFileSync(
    path.join(storeHome, "extensions", "diff", "artifacts", "pr__example-org__emu-repo__77.json"),
    "utf8",
  );
  assert.equal(savedDiskText.includes("ghs_secret_emu_token_value"), false);
  const savedDiskObj = JSON.parse(savedDiskText);
  assert.equal(savedDiskObj.source.account, "sample_emu");

  await rt.shutdown();

  // Cold getState(domainId) with NO openInstance call reconstructs `account: "sample_emu"` from savedPublicSource!
  const coldCfg = createDiffCanvasConfig({
    execFn: mockExecFn,
    env: fakeEnv,
    storeFactory: customStore,
  });
  const coldRt = createCanvasRuntime(coldCfg);
  t.after(() => coldRt.shutdown());

  const coldState = await coldRt.getState("pr__example-org__emu-repo__77");
  assert.equal(coldState.loaded, true);
  assert.equal(coldState.source.account, "sample_emu");

  // 4. Verify typo'd explicit account on reopen rejects like cold open, cleans up pendingReopenSources,
  //    does NOT poison domainSources, account: "" clears saved account, and inherited unlinked account falls back cleanly
  await assert.rejects(
    openDiffInstance(coldRt, coldCfg, {
      instanceId: "emu-panel-2",
      input: { repo: "example-org/emu-repo", pr: 77, account: "nonexistent_acct" },
      workspacePath: "",
    }),
    /nonexistent_acct/,
  );
  assert.equal(coldRt._instances.has("emu-panel-2"), false);
  assert.equal(coldCfg._pendingReopenSources.size, 0);
  // Reopening without account still uses the prior working source ("sample_emu")!
  const recoveredOpen = await openDiffInstance(coldRt, coldCfg, {
    instanceId: "emu-panel-2",
    input: { repo: "example-org/emu-repo", pr: 77 },
    workspacePath: "",
  });
  assert.match(recoveredOpen.status, /1 files \(\+1\/-0\)/);
  const recoveredState = await coldRt.getState("pr__example-org__emu-repo__77");
  assert.equal(recoveredState.error, null);
  assert.equal(recoveredState.source.account, "sample_emu");

  // Now allow ambient auth and clear saved account explicitly via account: ""
  failWithoutEmu = false;
  await openDiffInstance(coldRt, coldCfg, {
    instanceId: "emu-panel-2",
    input: { repo: "example-org/emu-repo", pr: 77, account: "" },
    workspacePath: "",
  });
  const clearedState = await coldRt.getState("pr__example-org__emu-repo__77");
  assert.equal(clearedState.error, null);
  assert.equal(clearedState.source.account, undefined);

  // Seed an unlinked saved account and verify cold open without explicit account falls back to ambient auth
  await customStore("pr__example-org__emu-repo__78.json").save({
    domain: "pr__example-org__emu-repo__78",
    source: {
      mode: "pr",
      repo: "example-org/emu-repo",
      pr: 78,
      account: "unlinked_former_account",
      paths: [],
    },
    title: "example-org/emu-repo#78",
    status: "draft",
    viewedFiles: ["src/private.ts"],
    comments: [],
    updatedAt: new Date().toISOString(),
  });
  const fallbackCfg = createDiffCanvasConfig({
    execFn: mockExecFn,
    env: { PATH: process.env.PATH },
    storeFactory: customStore,
  });
  const fallbackRt = createCanvasRuntime(fallbackCfg);
  t.after(() => fallbackRt.shutdown());

  const fallbackOpened = await openDiffInstance(fallbackRt, fallbackCfg, {
    instanceId: "emu-panel-fallback",
    input: { repo: "example-org/emu-repo", pr: 78 },
    workspacePath: "",
  });
  assert.match(fallbackOpened.status, /1 files \(\+1\/-0\)/);
  const fallbackState = await fallbackRt.getState("pr__example-org__emu-repo__78");
  assert.equal(fallbackState.loaded, true);
  assert.equal(fallbackState.source.account, undefined);
  assert.deepEqual(fallbackState.viewedFiles, ["src/private.ts"]);
});

test("opening Git diff from a repository subdirectory shares repo-root domainId and saves durably, and openDiffInstance pushes SSE on cold domain switch", async (t) => {
  const storeHome = makeTempDir("diff-subdir-home-");
  const repoDir = makeTempDir("diff-subdir-repo-");
  const prevHome = process.env.COPILOT_HOME;
  process.env.COPILOT_HOME = storeHome;
  t.after(() => {
    if (prevHome === undefined) delete process.env.COPILOT_HOME;
    else process.env.COPILOT_HOME = prevHome;
    fs.rmSync(storeHome, { recursive: true, force: true });
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  execFileSync("git", ["init", "-b", "main"], { cwd: repoDir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "dev@example.com"], { cwd: repoDir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Example Dev"], { cwd: repoDir, stdio: "ignore" });

  const subDir = path.join(repoDir, "packages", "sub");
  fs.mkdirSync(subDir, { recursive: true });
  fs.writeFileSync(path.join(subDir, "mod.ts"), "export const x = 1;\n", "utf8");
  execFileSync("git", ["add", "."], { cwd: repoDir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: repoDir, stdio: "ignore" });

  fs.writeFileSync(path.join(subDir, "mod.ts"), "export const x = 2;\n", "utf8");

  // Subdirectory workspacePath resolves to exact same domainId as repoDir (for both Git and checkout-inferred PR)
  const rootDomainId = computeDomainId({}, repoDir);
  const subDomainId = computeDomainId({}, subDir);
  assert.equal(subDomainId, rootDomainId);
  assert.equal(computeDomainId({ pr: 42 }, subDir), computeDomainId({ pr: 42 }, repoDir));

  const customStore = (file) => userStore("diff", file);
  const cfg = createDiffCanvasConfig({ storeFactory: customStore });
  const rt = createCanvasRuntime(cfg);
  t.after(() => rt.shutdown());

  await openDiffInstance(rt, cfg, {
    instanceId: "subdir-panel",
    input: {},
    workspacePath: subDir,
  });
  await rt.invokeFromAgent(
    "add_comment",
    { file: "packages/sub/mod.ts", line: 1, side: "right", body: "Persisted from subdir" },
    { instanceId: "subdir-panel", workspacePath: subDir },
  );
  await rt.shutdown();

  // Restart runtime and open from repo root -> comment saved from subdir is loaded!
  const cfgReloaded = createDiffCanvasConfig({ storeFactory: customStore });
  const rtReloaded = createCanvasRuntime(cfgReloaded);
  t.after(() => rtReloaded.shutdown());

  await openDiffInstance(rtReloaded, cfgReloaded, {
    instanceId: "root-panel",
    input: {},
    workspacePath: repoDir,
  });
  const reloadedState = await rtReloaded.getState(rootDomainId);
  assert.equal(reloadedState.comments.length, 1);
  assert.equal(reloadedState.comments[0].body, "Persisted from subdir");

  // Reopening the already-cached Git domain with explicit input.cwd (subdirectory) must succeed cleanly without ReferenceError or false override classification
  const cachedSubdirReopen = await openDiffInstance(rtReloaded, cfgReloaded, {
    instanceId: "root-panel",
    input: { cwd: subDir },
    workspacePath: "",
  });
  assert.match(cachedSubdirReopen.status, /files \(\+/);

  // Now verify re-targeting an open instanceId with a live SSE client to a cold PR domain pushes SSE immediately!
  const prMockExec = async (_cmd, args) => {
    const prNum = Number(args[2]);
    if (args[0] === "pr" && args[1] === "diff") {
      return [
        `diff --git a/src/pr${prNum}.ts b/src/pr${prNum}.ts`,
        "new file mode 100644",
        "--- /dev/null",
        `+++ b/src/pr${prNum}.ts`,
        "@@ -0,0 +1,1 @@",
        `+export const pr = ${prNum};`,
      ].join("\n");
    }
    if (args[0] === "pr" && args[1] === "view") {
      return JSON.stringify({
        number: prNum,
        title: `PR Number ${prNum}`,
        headRefName: `feat/pr-${prNum}`,
        baseRefName: "main",
      });
    }
    throw new Error(`Unexpected command: ${args.join(" ")}`);
  };

  const sseCfg = createDiffCanvasConfig({ execFn: prMockExec, storeFactory: customStore });
  const sseRt = createCanvasRuntime(sseCfg);
  t.after(() => sseRt.shutdown());

  const openedPr1 = await openDiffInstance(sseRt, sseCfg, {
    instanceId: "switchable-panel",
    input: { repo: "example-org/widgets", pr: 1 },
    workspacePath: "",
  });
  assert.match(openedPr1.status, /PR Number 1/);

  const ac = new AbortController();
  t.after(() => ac.abort());

  const sseRes = await fetch(capEndpoint("/events", openedPr1.url), {
    headers: { Accept: "text/event-stream" },
    signal: ac.signal,
  });
  assert.equal(sseRes.status, 200);
  const streamIter = sseSnapshots(sseRes.body.getReader());

  const initialSse = await streamIter.next();
  assert.equal(initialSse.value.domain, "pr__example-org__widgets__1");
  assert.equal(initialSse.value.files[0].canonicalPath, "src/pr1.ts");

  // Re-target the SAME instanceId to cold uncached PR #2 (no focusFile, !wasCached)
  const openedPr2 = await openDiffInstance(sseRt, sseCfg, {
    instanceId: "switchable-panel",
    input: { repo: "example-org/widgets", pr: 2 },
    workspacePath: "",
  });
  assert.equal(openedPr2.url, openedPr1.url);
  assert.match(openedPr2.status, /PR Number 2/);

  const switchedSse = await Promise.race([
    streamIter.next(),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Timed out waiting for cold-domain switch SSE push")), 2000),
    ),
  ]);
  assert.equal(switchedSse.value.domain, "pr__example-org__widgets__2");
  assert.equal(switchedSse.value.files[0].canonicalPath, "src/pr2.ts");

  // Failing focusFile on a brand-new instanceId closes the newly started server and leaves focusedFile null
  await assert.rejects(
    openDiffInstance(sseRt, sseCfg, {
      instanceId: "leaked-panel",
      input: { repo: "example-org/widgets", pr: 3, focusFile: "src/missing.ts" },
      workspacePath: "",
    }),
    /not part of the loaded diff/,
  );
  assert.equal(sseRt._instances.has("leaked-panel"), false);
  const pr3State = await sseRt.getState("pr__example-org__widgets__3");
  assert.equal(pr3State.focusedFile, null);
  assert.equal(pr3State.focusSeq, 0);

  // Failing focusFile when re-targeting an already-open instanceId (both cold PR #4 and cached PR #3) restores inst.domainId & SSE
  await assert.rejects(
    openDiffInstance(sseRt, sseCfg, {
      instanceId: "switchable-panel",
      input: { repo: "example-org/widgets", pr: 4, focusFile: "src/missing.ts" },
      workspacePath: "",
    }),
    /not part of the loaded diff/,
  );
  assert.equal(sseRt._instances.get("switchable-panel").domainId, "pr__example-org__widgets__2");
  const coldRollbackEvent = await streamIter.next();
  assert.equal(coldRollbackEvent.value.domain, "pr__example-org__widgets__2");

  await assert.rejects(
    openDiffInstance(sseRt, sseCfg, {
      instanceId: "switchable-panel",
      input: { repo: "example-org/widgets", pr: 3, focusFile: "src/missing.ts" },
      workspacePath: "",
    }),
    /not part of the loaded diff/,
  );
  assert.equal(sseRt._instances.get("switchable-panel").domainId, "pr__example-org__widgets__2");
  // Wait for the refresh + restored SSE events on cached PR #3 rollback and verify last pushed state is PR #2
  const cachedAttemptEvent1 = await streamIter.next();
  const cachedAttemptEvent2 = await streamIter.next();
  assert.equal(cachedAttemptEvent1.value.domain, "pr__example-org__widgets__3");
  assert.equal(cachedAttemptEvent2.value.domain, "pr__example-org__widgets__2");

  ac.abort();
});

test("probeDiffContext, check_updates, and smart viewedFiles invalidation cover Git dirty re-saves, --staged isolation, untracked files, commit ranges, and PR headRefOid updates", async (t) => {
  const repoDir = makeTempDir("diff-probe-git-");
  const storeHome = makeTempDir("diff-probe-home-");
  const prevHome = process.env.COPILOT_HOME;
  process.env.COPILOT_HOME = storeHome;

  t.after(() => {
    if (prevHome === undefined) delete process.env.COPILOT_HOME;
    else process.env.COPILOT_HOME = prevHome;
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(storeHome, { recursive: true, force: true });
  });

  const git = (...args) =>
    execFileSync("git", args, { cwd: repoDir, encoding: "utf8", windowsHide: true });
  git("init", "-b", "main");
  git("config", "user.name", "Probe Test");
  git("config", "user.email", "probe@example.com");

  fs.mkdirSync(path.join(repoDir, "src"), { recursive: true });
  fs.writeFileSync(path.join(repoDir, "src", "a.ts"), "export const a = 1;\n", "utf8");
  fs.writeFileSync(path.join(repoDir, "src", "b.ts"), "export const b = 1;\n", "utf8");
  fs.writeFileSync(path.join(repoDir, "src", "staged.ts"), "export const s = 1;\n", "utf8");
  git("add", ".");
  git("commit", "-m", "initial");

  git("checkout", "-b", "feat/probe");
  fs.writeFileSync(path.join(repoDir, "src", "a.ts"), "export const a = 2;\n", "utf8");
  fs.writeFileSync(path.join(repoDir, "src", "b.ts"), "export const b = 2;\n", "utf8");

  let saveCount = 0;
  const countingStore = (safeFile) => {
    const inner = userStore("diff", safeFile);
    return {
      load: (fallback) => inner.load(fallback),
      save: async (val) => {
        saveCount += 1;
        return inner.save(val);
      },
    };
  };

  const cfg = createDiffCanvasConfig({ storeFactory: countingStore });
  const rt = createCanvasRuntime(cfg);
  t.after(() => rt.shutdown());

  await openDiffInstance(rt, cfg, {
    instanceId: "git-probe-panel",
    input: { cwd: repoDir },
    workspacePath: repoDir,
  });

  const savesBeforeProbe = saveCount;
  const initialProbe = await rt.invokeFromAgent(
    "check_updates",
    {},
    { instanceId: "git-probe-panel", workspacePath: repoDir },
  );
  assert.equal(initialProbe.ok, true);
  assert.equal(initialProbe.changed, false);
  assert.equal(initialProbe.sourceMode, "git");
  assert.equal(saveCount, savesBeforeProbe, "check_updates must not write durable state to disk");

  // Mark both src/a.ts and src/b.ts Viewed
  await rt.invokeFromAgent(
    "toggle_viewed",
    { file: "src/a.ts" },
    { instanceId: "git-probe-panel", workspacePath: repoDir },
  );
  await rt.invokeFromAgent(
    "toggle_viewed",
    { file: "src/b.ts" },
    { instanceId: "git-probe-panel", workspacePath: repoDir },
  );

  // Re-save already-dirty src/a.ts with the exact same byte length (20 bytes)
  fs.writeFileSync(path.join(repoDir, "src", "a.ts"), "export const a = 3;\n", "utf8");
  const dirtyResaveProbe = await rt.invokeFromAgent(
    "check_updates",
    {},
    { instanceId: "git-probe-panel", workspacePath: repoDir },
  );
  assert.equal(dirtyResaveProbe.changed, true, "Re-saving an already-dirty file must be detected");

  // Refresh invalidates Viewed on modified src/a.ts while preserving unchanged src/b.ts
  const refreshAfterEdit = await rt.invokeFromAgent(
    "refresh",
    {},
    { instanceId: "git-probe-panel", workspacePath: repoDir },
  );
  assert.equal(refreshAfterEdit.ok, true);
  assert.equal(refreshAfterEdit.changed, true);
  assert.deepEqual(refreshAfterEdit.invalidatedViewedFiles, ["src/a.ts"]);

  const reviewAfterEdit = await rt.invokeFromAgent(
    "get_review",
    {},
    { instanceId: "git-probe-panel", workspacePath: repoDir },
  );
  assert.deepEqual(reviewAfterEdit.viewedFiles, ["src/b.ts"]);

  const postRefreshProbe = await rt.invokeFromAgent(
    "check_updates",
    {},
    { instanceId: "git-probe-panel", workspacePath: repoDir },
  );
  assert.equal(postRefreshProbe.changed, false);

  // Untracked file inside a brand-new nested directory is detected on creation AND on edit
  fs.mkdirSync(path.join(repoDir, "src", "nested"), { recursive: true });
  fs.writeFileSync(path.join(repoDir, "src", "nested", "untracked.ts"), "export const u = 1;\n", "utf8");
  const untrackedCreatedProbe = await rt.invokeFromAgent(
    "check_updates",
    {},
    { instanceId: "git-probe-panel", workspacePath: repoDir },
  );
  assert.equal(untrackedCreatedProbe.changed, true);
  await rt.invokeFromAgent("refresh", {}, { instanceId: "git-probe-panel", workspacePath: repoDir });
  fs.writeFileSync(path.join(repoDir, "src", "nested", "untracked.ts"), "export const u = 2;\n", "utf8");
  const untrackedEditedProbe = await rt.invokeFromAgent(
    "check_updates",
    {},
    { instanceId: "git-probe-panel", workspacePath: repoDir },
  );
  assert.equal(untrackedEditedProbe.changed, true);

  // --staged isolation: unstaged edits and untracked files must NOT falsely trigger --staged!
  fs.writeFileSync(path.join(repoDir, "src", "staged.ts"), "export const s = 2;\n", "utf8");
  git("add", "src/staged.ts");

  await openDiffInstance(rt, cfg, {
    instanceId: "staged-probe-panel",
    input: { cwd: repoDir, spec: "--staged" },
    workspacePath: repoDir,
  });
  const stagedCleanProbe = await rt.invokeFromAgent(
    "check_updates",
    {},
    { instanceId: "staged-probe-panel", workspacePath: repoDir },
  );
  assert.equal(stagedCleanProbe.changed, false);

  // Edit unstaged src/a.ts and add another untracked file without git add
  fs.writeFileSync(path.join(repoDir, "src", "a.ts"), "export const a = 4;\n", "utf8");
  fs.writeFileSync(path.join(repoDir, "src", "nested", "extra.ts"), "export const e = 1;\n", "utf8");
  const stagedAfterUnstagedEdit = await rt.invokeFromAgent(
    "check_updates",
    {},
    { instanceId: "staged-probe-panel", workspacePath: repoDir },
  );
  assert.equal(
    stagedAfterUnstagedEdit.changed,
    false,
    "Unstaged working-tree edits and untracked files must not trigger --staged updates",
  );

  // Staging a new change DOES trigger --staged
  fs.writeFileSync(path.join(repoDir, "src", "staged.ts"), "export const s = 3;\n", "utf8");
  git("add", "src/staged.ts");
  const stagedAfterIndexUpdate = await rt.invokeFromAgent(
    "check_updates",
    {},
    { instanceId: "staged-probe-panel", workspacePath: repoDir },
  );
  assert.equal(stagedAfterIndexUpdate.changed, true);

  // Commit range (main..feat/probe) with and without path scoping
  git("commit", "-m", "commit staged.ts");
  const rangeBase = await probeDiffContext({
    mode: "git",
    cwd: repoDir,
    spec: "main..feat/probe",
    paths: [],
  });
  const rangeScopedB = await probeDiffContext({
    mode: "git",
    cwd: repoDir,
    spec: "main..feat/probe",
    paths: ["src/b.ts"],
  });
  // Unstaged edits do not change commit range signatures
  fs.writeFileSync(path.join(repoDir, "src", "a.ts"), "export const a = 5;\n", "utf8");
  assert.equal(
    (await probeDiffContext({ mode: "git", cwd: repoDir, spec: "main..feat/probe", paths: [] }))
      .contextSignature,
    rangeBase.contextSignature,
  );
  // Committing src/a.ts updates full range, while path-scoped src/b.ts range stays identical
  git("add", "src/a.ts");
  git("commit", "-m", "commit a.ts");
  assert.notEqual(
    (await probeDiffContext({ mode: "git", cwd: repoDir, spec: "main..feat/probe", paths: [] }))
      .contextSignature,
    rangeBase.contextSignature,
  );
  assert.equal(
    (
      await probeDiffContext({
        mode: "git",
        cwd: repoDir,
        spec: "main..feat/probe",
        paths: ["src/b.ts"],
      })
    ).contextSignature,
    rangeScopedB.contextSignature,
  );

  // PR check_updates runs ONLY 'gh pr view' (never 'gh pr diff') and swallows transient errors cleanly
  let prHeadOid = "1111111111111111111111111111111111111111";
  let prShouldFail = false;
  const prSubcommands = [];
  const prExecMock = async (_cmd, args) => {
    prSubcommands.push(args[1]);
    if (prShouldFail) {
      throw new Error("dial tcp: lookup api.github.com: i/o timeout");
    }
    if (args[0] === "pr" && args[1] === "diff") {
      return [
        "diff --git a/src/pr.ts b/src/pr.ts",
        "index 1111111..2222222 100644",
        "--- a/src/pr.ts",
        "+++ b/src/pr.ts",
        "@@ -1,1 +1,1 @@",
        "-export const pr = 1;",
        "+export const pr = 2;",
      ].join("\n");
    }
    if (args[0] === "pr" && args[1] === "view") {
      return JSON.stringify({
        number: 99,
        title: "Probe PR",
        headRefName: "feat/pr",
        baseRefName: "main",
        headRefOid: prHeadOid,
        baseRefOid: "0000000000000000000000000000000000000000",
        state: "OPEN",
      });
    }
    throw new Error(`Unexpected gh command: ${args.join(" ")}`);
  };

  const prCfg = createDiffCanvasConfig({ execFn: prExecMock, storeFactory: countingStore });
  const prRt = createCanvasRuntime(prCfg);
  t.after(() => prRt.shutdown());

  await openDiffInstance(prRt, prCfg, {
    instanceId: "pr-probe-panel",
    input: { repo: "example-org/service", pr: 99 },
    workspacePath: "",
  });

  prSubcommands.length = 0;
  const prUnchangedProbe = await prRt.invokeFromAgent(
    "check_updates",
    {},
    { instanceId: "pr-probe-panel" },
  );
  assert.equal(prUnchangedProbe.changed, false);
  assert.deepEqual(prSubcommands, ["view"], "PR check_updates must never invoke gh pr diff");

  prHeadOid = "2222222222222222222222222222222222222222";
  prSubcommands.length = 0;
  const prUpdatedProbe = await prRt.invokeFromAgent(
    "check_updates",
    {},
    { instanceId: "pr-probe-panel" },
  );
  assert.equal(prUpdatedProbe.changed, true);
  assert.deepEqual(prSubcommands, ["view"], "PR check_updates must only invoke gh pr view");

  prShouldFail = true;
  const prTransientProbe = await prRt.invokeFromAgent(
    "check_updates",
    {},
    { instanceId: "pr-probe-panel" },
  );
  assert.equal(prTransientProbe.ok, true);
  assert.equal(prTransientProbe.changed, false);
  assert.equal(prTransientProbe.transientError, true);
  const prStateAfterTransient = await prRt.getState("pr__example-org__service__99");
  assert.equal(prStateAfterTransient.error, null, "Transient probe error must not set state.error");

  // Direct unit check on reconcileViewedFiles
  const unitFiles = parseDiffPatch(
    [
      "diff --git a/src/keep.ts b/src/keep.ts",
      "--- a/src/keep.ts",
      "+++ b/src/keep.ts",
      "@@ -1,1 +1,1 @@",
      "-const k = 1;",
      "+const k = 2;",
    ].join("\n"),
  ).files;
  const keepFp = computeFileFingerprint(unitFiles[0]);
  const unitReconciled = reconcileViewedFiles(
    ["src/keep.ts", "src/removed.ts"],
    { "src/keep.ts": keepFp, "src/removed.ts": "deadbeef00000000" },
    unitFiles,
  );
  assert.deepEqual(unitReconciled.viewedFiles, ["src/keep.ts"]);
  assert.deepEqual(unitReconciled.invalidatedFiles, ["src/removed.ts"]);

  // Binary index header & file mode changes produce distinct fingerprints, and reserved property names round-trip cleanly
  const binV1 = parseDiffPatch(
    [
      "diff --git a/assets/icon.png b/assets/icon.png",
      "index 1111111..2222222 100644",
      "Binary files a/assets/icon.png and b/assets/icon.png differ",
      "diff --git a/scripts/run.sh b/scripts/run.sh",
      "old mode 100644",
      "new mode 100755",
    ].join("\n"),
  ).files;
  const binV2 = parseDiffPatch(
    [
      "diff --git a/assets/icon.png b/assets/icon.png",
      "index 1111111..3333333 100644",
      "Binary files a/assets/icon.png and b/assets/icon.png differ",
      "diff --git a/scripts/run.sh b/scripts/run.sh",
      "old mode 100755",
      "new mode 100644",
    ].join("\n"),
  ).files;
  assert.notEqual(computeFileFingerprint(binV1[0]), computeFileFingerprint(binV2[0]));
  assert.notEqual(computeFileFingerprint(binV1[1]), computeFileFingerprint(binV2[1]));

  const specialFilesV1 = parseDiffPatch(
    [
      "diff --git a/__proto__ b/__proto__",
      "index 1111111..2222222 100644",
      "--- a/__proto__",
      "+++ b/__proto__",
      "@@ -1,1 +1,1 @@",
      "-alpha",
      "+beta",
      "diff --git a/constructor b/constructor",
      "index 3333333..4444444 100644",
      "--- a/constructor",
      "+++ b/constructor",
      "@@ -1,1 +1,1 @@",
      "-one",
      "+two",
    ].join("\n"),
  ).files;
  const specialFilesV2 = parseDiffPatch(
    [
      "diff --git a/__proto__ b/__proto__",
      "index 1111111..9999999 100644",
      "--- a/__proto__",
      "+++ b/__proto__",
      "@@ -1,1 +1,1 @@",
      "-alpha",
      "+gamma",
      "diff --git a/constructor b/constructor",
      "index 3333333..4444444 100644",
      "--- a/constructor",
      "+++ b/constructor",
      "@@ -1,1 +1,1 @@",
      "-one",
      "+two",
    ].join("\n"),
  ).files;
  const initialSpecialMap = Object.create(null);
  initialSpecialMap["__proto__"] = computeFileFingerprint(specialFilesV1[0]);
  initialSpecialMap["constructor"] = computeFileFingerprint(specialFilesV1[1]);
  const roundTrippedJson = JSON.parse(JSON.stringify(initialSpecialMap));
  const reconciledSpecial = reconcileViewedFiles(
    ["__proto__", "constructor"],
    roundTrippedJson,
    specialFilesV2,
  );
  assert.deepEqual(reconciledSpecial.invalidatedFiles, ["__proto__"]);
  assert.deepEqual(reconciledSpecial.viewedFiles, ["constructor"]);
});

test("legacy unseeded viewedFileFingerprints survive offline/--domain saves, sub-ms & symlink stamps update probeDiffContext, and statusLine reports reload errors", async (t) => {
  const storeHome = makeTempDir("diff-cr3-regressions-");
  const prevHome = process.env.COPILOT_HOME;
  process.env.COPILOT_HOME = storeHome;
  t.after(() => {
    if (prevHome === undefined) delete process.env.COPILOT_HOME;
    else process.env.COPILOT_HOME = prevHome;
    fs.rmSync(storeHome, { recursive: true, force: true });
  });
  const customStore = (file) => userStore("diff", file);

  // 1. Seed legacy review JSON WITHOUT viewedFileFingerprints
  const domainId = "pr__example-org__legacy__10";
  await customStore(`${domainId}.json`).save({
    domain: domainId,
    source: { mode: "pr", repo: "example-org/legacy", pr: 10, paths: [] },
    title: "example-org/legacy#10: Legacy PR",
    status: "pending",
    viewedFiles: ["src/keep.ts", "src/gone.ts"],
    comments: [{ id: "c1", file: "src/keep.ts", line: 1, side: "right", body: "Check this" }],
    updatedAt: "2026-04-19T12:00:00.000Z",
  });

  let isOffline = true;
  const prPatch = [
    "diff --git a/src/keep.ts b/src/keep.ts",
    "index 1111111..2222222 100644",
    "--- a/src/keep.ts",
    "+++ b/src/keep.ts",
    "@@ -1,1 +1,2 @@",
    " export const keep = 1;",
    "+export const next = 2;",
  ].join("\n");

  const mockExec = async (_cmd, args) => {
    if (isOffline) {
      throw new Error("Network temporarily unreachable");
    }
    if (args[0] === "pr" && args[1] === "diff") {
      return prPatch;
    }
    if (args[0] === "pr" && args[1] === "view") {
      return JSON.stringify({
        number: 10,
        title: "Legacy PR",
        headRefName: "feat/legacy",
        baseRefName: "main",
        headRefOid: "aaaa1111",
        baseRefOid: "bbbb2222",
        state: "OPEN",
      });
    }
    throw new Error(`Unexpected command: ${args.join(" ")}`);
  };

  const cfg = createDiffCanvasConfig({ execFn: mockExec, storeFactory: customStore });
  const rt = createCanvasRuntime(cfg);
  t.after(() => rt.shutdown());

  // Offline --domain lookup + mark_addressed must NOT write viewedFileFingerprints: {} to disk
  await rt.invokeFromAgent(
    "mark_addressed",
    {},
    { targetDomainId: domainId, workspacePath: "" },
  );
  const rawAfterOfflineAddress = JSON.parse(
    fs.readFileSync(
      path.join(storeHome, "extensions", "diff", "artifacts", `${domainId}.json`),
      "utf8",
    ),
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(rawAfterOfflineAddress, "viewedFileFingerprints"),
    false,
    "Unseeded viewedFileFingerprints must stay omitted on offline/byDomain saves",
  );
  assert.deepEqual(rawAfterOfflineAddress.viewedFiles, ["src/keep.ts", "src/gone.ts"]);

  // Come back online and refresh -> src/keep.ts stays viewed and seeds its fingerprint!
  isOffline = false;
  const openedOnline = await openDiffInstance(rt, cfg, {
    instanceId: "legacy-panel",
    input: { repo: "example-org/legacy", pr: 10 },
    workspacePath: "",
  });
  assert.match(openedOnline.status, /Legacy PR/);
  const onlineState = await rt.getState(domainId);
  assert.deepEqual(
    onlineState.viewedFiles,
    ["src/keep.ts"],
    "Unseeded legacy viewedFiles must be preserved once diff loads",
  );
  assert.equal(typeof onlineState.viewedFileFingerprints?.["src/keep.ts"], "string");

  // Transient reload error WITHOUT source overrides on an already-loaded/saved domain appends reload error in statusLine
  isOffline = true;
  const reopenedWhileOffline = await openDiffInstance(rt, cfg, {
    instanceId: "legacy-panel",
    input: { repo: "example-org/legacy", pr: 10 },
    workspacePath: "",
  });
  assert.match(reopenedWhileOffline.status, /reload error: Network temporarily unreachable/);

  // Cached reopen with NO saved review and !loaded must reject rather than silently succeeding
  await assert.rejects(
    openDiffInstance(rt, cfg, {
      instanceId: "unsaved-panel",
      input: { repo: "example-org/legacy", pr: 999 },
      workspacePath: "",
    }),
    /Network temporarily unreachable/,
  );

  // 2. Sub-millisecond mtimeMs precision & symlink target changes in probeDiffContext
  const gitRepo = fs.realpathSync.native(makeTempDir("diff-subms-probe-"));
  t.after(() => fs.rmSync(gitRepo, { recursive: true, force: true }));
  execFileSync("git", ["init", "-b", "main"], { cwd: gitRepo, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: gitRepo, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: gitRepo, stdio: "ignore" });
  const bigFile = path.join(gitRepo, "big.bin");
  // Exceed MAX_UNTRACKED_FILE_BYTES (256 KiB) so stamp relies on size + mtimeMs (without contentDigest)
  const bufA = Buffer.alloc(300 * 1024, 0x41);
  fs.writeFileSync(bigFile, bufA);
  execFileSync("git", ["add", "big.bin"], { cwd: gitRepo, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: gitRepo, stdio: "ignore" });

  // Modify big.bin and set two timestamps within the SAME millisecond (1700000000.1231 vs 1700000000.1239)
  const bufB = Buffer.alloc(300 * 1024, 0x42);
  fs.writeFileSync(bigFile, bufB);
  fs.utimesSync(bigFile, 1700000000.1231, 1700000000.1231);
  const probeSubMs1 = await probeDiffContext({ mode: "git", cwd: gitRepo, spec: "HEAD", paths: [] });
  const stat1 = fs.lstatSync(bigFile);

  fs.utimesSync(bigFile, 1700000000.1239, 1700000000.1239);
  const stat2 = fs.lstatSync(bigFile);
  const probeSubMs2 = await probeDiffContext({ mode: "git", cwd: gitRepo, spec: "HEAD", paths: [] });
  if (Number(stat1.mtimeMs).toFixed(3) !== Number(stat2.mtimeMs).toFixed(3)) {
    assert.notEqual(
      probeSubMs1.contextSignature,
      probeSubMs2.contextSignature,
      "Sub-millisecond mtimeMs change on >256KiB dirty file must update contextSignature",
    );
  }

  // Test tracked symlink target update if platform permits symlink creation without elevation
  const linkPath = path.join(gitRepo, "tracked-link");
  let symlinkSupported = false;
  try {
    fs.symlinkSync("target-one.txt", linkPath);
    symlinkSupported = true;
  } catch {
    symlinkSupported = false;
  }
  if (symlinkSupported) {
    execFileSync("git", ["add", "tracked-link"], { cwd: gitRepo, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "add symlink"], { cwd: gitRepo, stdio: "ignore" });
    fs.unlinkSync(linkPath);
    fs.symlinkSync("target-two.txt", linkPath);
    const probeLink1 = await probeDiffContext({ mode: "git", cwd: gitRepo, spec: "HEAD", paths: [] });
    fs.unlinkSync(linkPath);
    fs.symlinkSync("target-three.txt", linkPath);
    const probeLink2 = await probeDiffContext({ mode: "git", cwd: gitRepo, spec: "HEAD", paths: [] });
    assert.notEqual(
      probeLink1.contextSignature,
      probeLink2.contextSignature,
      "Retargeting a dirty tracked symlink must update contextSignature without dereferencing",
    );
  }
});

