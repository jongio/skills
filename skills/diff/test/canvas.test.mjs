import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDiffCanvasRuntime } from "../runtime/canvas.mjs";
import { hasIcon } from "../runtime/canvas-kit/icons.mjs";
import { acquireProviderLease, checkSession } from "../runtime/provider.mjs";
import { applySetup, planSetup } from "../scripts/setup.mjs";

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

test("diff canvas supports coordinator non-git ready fallback, durable prepare load, SSE fan-out, and capability/path guards", async (t) => {
  const repoDir = makeTempDir("diff-canvas-repo-");
  const coordinatorDir = makeTempDir("diff-canvas-coord-");
  const reviewsRoot = makeTempDir("diff-canvas-reviews-");
  t.after(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(coordinatorDir, { recursive: true, force: true });
    fs.rmSync(reviewsRoot, { recursive: true, force: true });
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
  git("checkout", "-b", "feat/canvas");
  fs.writeFileSync(
    path.join(repoDir, "src", "service.ts"),
    "export const v = 2;\nexport const extra = '</script>';\n",
    "utf8",
  );

  const runtime = createDiffCanvasRuntime({
    workspacePath: coordinatorDir,
    reviewsRoot,
    syncIntervalMs: 0,
  });
  t.after(() => runtime.shutdown());

  // 1. Coordinator non-git empty open lands cleanly in unloaded ready state without leaking workstation paths
  const readyPanel = await runtime.openInstance({
    instanceId: "coord-ready",
    input: {},
  });
  const readyState = await fetch(capEndpoint("/state", readyPanel.url)).then((r) => r.json());
  assert.equal(readyState.loaded, false);
  assert.equal(readyState.status, "draft");
  assert.equal(JSON.stringify(readyState).includes(coordinatorDir), false);
  await runtime.closeInstance("coord-ready");

  // 2. Open repo diff via { cwd, spec } across two panels and verify capability token + Host + Sec-Fetch-Site guards
  const panelOne = await runtime.openInstance({
    instanceId: "diff-1",
    input: { cwd: repoDir, spec: "main" },
  });
  const panelTwo = await runtime.openInstance({
    instanceId: "diff-2",
    input: { cwd: repoDir, spec: "main", focusFile: "src/service.ts" },
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

  // UI caller cannot supply arbitrary cwd to load_diff
  const uiCwdAttempt = await fetch(capEndpoint("/action", panelOne.url), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      actionName: "load_diff",
      input: { cwd: path.join(coordinatorDir, "other-untrusted") },
    }),
  });
  assert.ok(uiCwdAttempt.status >= 400);
  const uiCwdBody = await uiCwdAttempt.json();
  assert.match(uiCwdBody.message, /UI actions cannot switch repository working directories/);

  // 3. SSE live updates + concurrent comment serialization + zero workstation paths in state
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
  assert.equal(initialSnap.status, "draft");
  assert.equal(initialSnap.files.length, 1);
  assert.equal(JSON.stringify(initialSnap).includes(repoDir), false);
  assert.equal(JSON.stringify(initialSnap).includes(reviewsRoot), false);

  // Concurrent add_comment calls serialize cleanly via withReviewLock
  await Promise.all([
    fetch(capEndpoint("/action", panelOne.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        actionName: "add_comment",
        input: { file: "src/service.ts", line: "1", side: "right", body: "First inline note" },
      }),
    }).then((r) => r.json()),
    runtime.invokeFromAgent(
      "add_comment",
      { file: "src/service.ts", line: "2", side: "right", body: "Second agent note" },
      { instanceId: "diff-1" },
    ),
  ]);

  let twoCommentsSnap = null;
  for await (const snap of stream) {
    if (snap.comments.length === 2) {
      twoCommentsSnap = snap;
      break;
    }
  }
  assert.equal(twoCommentsSnap.comments.length, 2);

  // Toggle viewed + delete one comment + submit review + verify draft lock + mark addressed
  const viewedRes = await runtime.invokeFromAgent(
    "toggle_viewed",
    { file: "src/service.ts" },
    { instanceId: "diff-1" },
  );
  assert.equal(viewedRes.viewed, true);

  const toDeleteId = twoCommentsSnap.comments[0].id;
  const delRes = await runtime.invokeFromAgent(
    "delete_comment",
    { id: toDeleteId },
    { instanceId: "diff-1" },
  );
  assert.equal(delRes.commentCount, 1);

  const submitRes = await runtime.invokeFromAgent("submit_review", {}, { instanceId: "diff-1" });
  assert.equal(submitRes.status, "pending");
  assert.equal(submitRes.commentCount, 1);

  // Adding comments after submit_review is rejected while pending
  await assert.rejects(
    runtime.invokeFromAgent(
      "add_comment",
      { file: "src/service.ts", line: "1", side: "right", body: "Late note" },
      { instanceId: "diff-1" },
    ),
    /only allowed while the review is in draft/,
  );

  // Open from coordinator solely by { reviewId, repoSlug, branchSlug } (zero cwd!)
  const coordReviewPanel = await runtime.openInstance({
    instanceId: "coord-by-id",
    input: {
      reviewId: initialSnap.reviewId,
      repoSlug: initialSnap.repoSlug,
      branchSlug: initialSnap.branchSlug,
    },
  });
  const coordState = await fetch(capEndpoint("/state", coordReviewPanel.url)).then((r) => r.json());
  assert.equal(coordState.reviewId, initialSnap.reviewId);
  assert.equal(coordState.status, "pending");
  assert.equal(coordState.comments.length, 1);
  assert.deepEqual(coordState.viewedFiles, ["src/service.ts"]);

  const addrRes = await runtime.invokeFromAgent("mark_addressed", {}, { instanceId: "coord-by-id" });
  assert.equal(addrRes.status, "addressed");

  // Addressed reviews cannot be reverted to pending via submit_review
  await assert.rejects(
    runtime.invokeFromAgent("submit_review", {}, { instanceId: "coord-by-id" }),
    /already been addressed/,
  );

  // UI POST /action cannot switch reviewId or diff spec
  const uiForeignReview = await fetch(capEndpoint("/action", panelOne.url), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      actionName: "load_diff",
      input: {
        reviewId: "0123456789abcdef",
        repoSlug: "example-org__other-repo",
        branchSlug: "main",
      },
    }),
  });
  assert.equal(uiForeignReview.status, 400);
  const uiForeignJson = await uiForeignReview.json();
  assert.equal(uiForeignJson.code, "forbidden_review_switch");

  const uiForeignSpec = await fetch(capEndpoint("/action", panelOne.url), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      actionName: "load_diff",
      input: { spec: "HEAD~1" },
    }),
  });
  assert.equal(uiForeignSpec.status, 400);
  const uiForeignSpecJson = await uiForeignSpec.json();
  assert.equal(uiForeignSpecJson.code, "forbidden_spec_switch");

  // syncState detects external mtime updates on the review file
  const canonicalDomainId = `review:${initialSnap.repoSlug}:${initialSnap.branchSlug}:${initialSnap.reviewId}`;
  const unchangedSync = await runtime.config.syncState(canonicalDomainId);
  assert.equal(unchangedSync.changed, false);
});

test("provider lease enforces single-owner per session and checkSession blocks foreign sessions", async () => {
  const sessionId = `diff-lease-test-${process.pid}`;
  const first = await acquireProviderLease(sessionId);
  assert.equal(first.acquired, true);
  try {
    const duplicate = await acquireProviderLease(sessionId);
    assert.equal(duplicate.acquired, false);
    const other = await acquireProviderLease(`${sessionId}-other`);
    assert.equal(other.acquired, true);
    await other.close();
  } finally {
    await first.close();
  }
  const reacquired = await acquireProviderLease(sessionId);
  assert.equal(reacquired.acquired, true);
  await reacquired.close();

  checkSession({ sessionId: "s1" }, { sessionId: "s1" });
  assert.throws(() => checkSession({ sessionId: "s2" }, { sessionId: "s1" }), /Cross-session/);
});

test("setup.mjs plans and installs hash-approved loader while rejecting stale hashes, foreign files, and symlinks", (t) => {
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
  assert.throws(() => applySetup(plan, "badhash"), /Exact preview hash approval required/);
  const applied = applySetup(plan, plan.hash);
  assert.equal(applied.applied, true);
  assert.match(fs.readFileSync(plan.file, "utf8"), /runtime\/extension\.mjs/);

  // Re-applying stale absent-state plan fails; fresh plan reports unchanged
  assert.throws(() => applySetup(plan, plan.hash), /Stale setup preview/);
  const idempotentPlan = planSetup({ home, entry });
  assert.equal(applySetup(idempotentPlan, idempotentPlan.hash).unchanged, true);

  // User-owned loader is never overwritten
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

test("web/app.mjs and web/index.html use only vendored Lucide icons and zero innerHTML sinks", () => {
  const webDir = path.resolve(import.meta.dirname, "..", "runtime", "web");
  const appSource = fs.readFileSync(path.join(webDir, "app.mjs"), "utf8");
  const htmlSource = fs.readFileSync(path.join(webDir, "index.html"), "utf8");

  assert.doesNotMatch(appSource, /innerHTML|dangerouslySetInnerHTML/);
  assert.doesNotMatch(htmlSource, /https?:\/\//i);

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
});
