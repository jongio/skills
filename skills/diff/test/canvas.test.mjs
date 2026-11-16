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
import { createDiffCanvasConfig } from "../runtime/canvas.mjs";
import {
  assertSafeCheckoutDir,
  assertSafeGitRef,
  assertSafePathspecs,
  assertSafePrNumber,
  assertSafeRepoFullName,
  loadDiff,
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

  const runtime = createCanvasRuntime(createDiffCanvasConfig());
  t.after(() => runtime.shutdown());

  // 1. Coordinator non-git empty open lands cleanly in unloaded ready state without leaking workstation paths
  const readyPanel = await runtime.openInstance({
    instanceId: "coord-ready",
    input: {},
    ctx: { workspacePath: coordinatorDir },
  });
  const readyState = await fetch(capEndpoint("/state", readyPanel.url)).then((r) => r.json());
  assert.equal(readyState.loaded, false);
  assert.equal(readyState.status, "draft");
  assert.equal(JSON.stringify(readyState).includes(coordinatorDir), false);
  await runtime.closeInstance("coord-ready");

  // 2. Open repo default diff across two panels and verify capability token + Sec-Fetch-Site + Origin + UI source guards
  const panelOne = await runtime.openInstance({
    instanceId: "diff-1",
    input: { cwd: repoDir },
    ctx: { workspacePath: coordinatorDir },
  });
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

  // UI caller cannot invoke load_diff even for spec/paths-only changes
  for (const uiLoadInput of [{ cwd: coordinatorDir }, { spec: "--unstaged" }, {}]) {
    const uiSwitchAttempt = await fetch(capEndpoint("/action", panelOne.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        actionName: "load_diff",
        input: uiLoadInput,
      }),
    });
    assert.equal(uiSwitchAttempt.status, 400);
    const uiSwitchJson = await uiSwitchAttempt.json();
    assert.equal(uiSwitchJson.code, "forbidden_source_switch");
  }

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
  for await (const snap of stream) {
    if (snap.comments.length === 2) {
      twoCommentsSnap = snap;
      break;
    }
  }
  assert.equal(twoCommentsSnap.comments.length, 2);

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

  // Unconfigured session loading repoDir via load_diff never leaks into another unconfigured session
  await runtime.invokeFromAgent(
    "load_diff",
    { cwd: repoDir },
    { instanceId: "diff-coord", workspacePath: coordinatorDir },
  );
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
    "number,title,headRefName,baseRefName",
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

  await runtimeOne.invokeFromAgent(
    "toggle_viewed",
    { file: "src/handler.ts" },
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
  assert.deepEqual(savedDiskJson.viewedFiles, ["src/handler.ts"]);
  assert.equal(savedDiskJson.comments.length, 1);

  await runtimeOne.shutdown();

  // Simulate new commit pushed to PR #293 changing line 2, then reopen in a brand-new runtime
  currentPatch = [
    "diff --git a/src/handler.ts b/src/handler.ts",
    "index 1111111..3333333 100644",
    "--- a/src/handler.ts",
    "+++ b/src/handler.ts",
    "@@ -1,2 +1,3 @@",
    " export function handle(req) {",
    "+  const token = sanitizeToken(req.headers['x-token']);",
    "   return token;",
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
  assert.deepEqual(restoredReview.viewedFiles, ["src/handler.ts"]);
  assert.equal(restoredReview.comments.length, 1);
  assert.equal(restoredReview.comments[0].stale, true);

  const addrRes = await runtimeTwo.invokeFromAgent(
    "mark_addressed",
    {},
    { instanceId: "pr-293-reopened" },
  );
  assert.equal(addrRes.status, "addressed");
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
}

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

function matchesSimpleSelector(el, selector) {
  if (selector.startsWith(".")) {
    const targetCls = selector.slice(1);
    return el.className.split(/\s+/).includes(targetCls);
  }
  if (selector === "[data-canonical-file]") {
    return el.getAttribute("data-canonical-file") !== null;
  }
  return el.localName.toLowerCase() === selector.toLowerCase();
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

  // Guard against JSX empty fragments (`<>` / `</>`) which crash vendored `htm`
  assert.doesNotMatch(appSource, /<>|<\/>/, "app.mjs must never use <>...</> with htm");
  assert.doesNotMatch(appSource, /innerHTML|dangerouslySetInnerHTML/);
  assert.doesNotMatch(htmlSource, /https?:\/\//i);
  assert.doesNotMatch(htmlSource, /http-equiv="Content-Security-Policy"/i);

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
  const prevSvg = globalThis.SVGElement;
  const prevSkip = globalThis.__DIFF_SKIP_AUTO_MOUNT__;
  t.after(() => {
    globalThis.document = prevDoc;
    globalThis.SVGElement = prevSvg;
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
  globalThis.document = createStrictDocument();

  // Verify the strict DOM shim throws InvalidCharacterError on empty tag `""` just like Chromium
  assert.throws(() => globalThis.document.createElement(""), { name: "InvalidCharacterError" });

  const { DiffCanvasApp, LARGE_FILE_CHANGED_LINES_THRESHOLD } = await import(
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
  const state = {
    domain: "pr__example-org__demo__293",
    loaded: true,
    error: null,
    title: "example-org/demo#293",
    status: "draft",
    stats: {
      fileCount: parsed.fileCount,
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
    ],
    files: parsed.files,
    focusedFile: null,
    focusedLine: null,
    focusSeq: 0,
  };

  const container = globalThis.document.createElement("div");
  render(
    html`<${DiffCanvasApp} state=${state} invoke=${async () => ({})} />`,
    container,
  );

  const mainEl = container.querySelector("main");
  assert.ok(mainEl, "<main class='dv-main'> must mount without InvalidCharacterError");
  assert.equal(mainEl.className, "dv-main");

  const fileCards = mainEl.querySelectorAll(".dv-file-card");
  assert.equal(fileCards.length, 3);

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
  const clickHandler = [...(unifiedBtn.listeners.get("click") || [])][0];
  clickHandler.call(unifiedBtn, { type: "click", preventDefault() {}, stopPropagation() {} });
  // Flush Preact queued rerender
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(container.querySelector(".dv-table-unified"), "Unified diff table must mount cleanly");
});
