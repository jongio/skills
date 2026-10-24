import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { configureStatuslines, SHARED_RUNTIME_FILES } from "../scripts/setup-statusline.mjs";
import { statuslineGitHub, requestedGitHubEnvironment, gitHubEnvironmentForHost } from "../extensions/github-transport.mjs";
import { render as renderPr } from "../extensions/pr-statusline/render.mjs";
import { render as renderIssue } from "../extensions/issue-statusline/render.mjs";
import { queryPrStatusWithGh } from "../extensions/pr-statusline/github.mjs";
import { queryIssueStatusWithGh } from "../extensions/issue-statusline/github.mjs";
import { prefetchStatuses, refreshTracker } from "../extensions/github-refresh.mjs";
import { readIssueCache } from "../extensions/issue-statusline/github.mjs";
import { readState, writeState, SessionTracker } from "../extensions/pr-statusline/tracker.mjs";
import { clearSessionStatusline } from "../extensions/pr-statusline/session-statusline.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
test("expired standalone observations are visibly stale without a network refresh", (t) => {
  const home = fixture(t);
  const tracker = new SessionTracker("expired");
  tracker.add("https://github.com/example/widget/pull/1");
  Object.assign(tracker.state.prs[0], { status: "Cached checks", checkedAt: 1000 });
  writeState(tracker.snapshot(), home);
  assert.match(renderPr({ session_id: "expired" }, { home, now: 100000, color: false, links: false }), /stale/);
});
test("SDK token access is explicit, minimal, and restricted to named GitHub credentials", () => {
  assert.deepEqual(requestedGitHubEnvironment({}), []);
  assert.deepEqual(requestedGitHubEnvironment({ COPILOT_STATUSLINE_TOKEN_ENV: "GH_TOKEN,GH_TOKEN" }), ["GH_TOKEN"]);
  assert.throws(() => requestedGitHubEnvironment({ COPILOT_STATUSLINE_TOKEN_ENV: "OTHER_SECRET" }), /supported/);
  const env = { GH_HOST: "enterprise.example", GH_ENTERPRISE_TOKEN: "fixture-enterprise", GH_TOKEN: "fixture-public" };
  assert.equal(gitHubEnvironmentForHost("enterprise.example", env).GH_ENTERPRISE_TOKEN, "fixture-enterprise");
  assert.equal(gitHubEnvironmentForHost("unrelated.example", env).GH_ENTERPRISE_TOKEN, undefined);
  assert.equal(gitHubEnvironmentForHost("unrelated.example", env).GH_TOKEN, undefined);
});
test("background branch discovery preserves clear boundaries and discovers later work", async (t) => {
  const home = fixture(t);
  const directory = join(home, "session-state", "branch");
  mkdirSync(directory, { recursive: true });
  const workspace = join(directory, "workspace.yaml");
  writeFileSync(workspace, "repository: example/widget\nbranch: feature\n");
  t.mock.method(statuslineGitHub, "cacheScope", async () => "fixture");
  t.mock.method(statuslineGitHub, "request", async ({ query, variables }) => {
    const number = variables.head === "later" ? 2 : variables.number || 1;
    const info = { state: "OPEN", url: `https://github.com/example/widget/pull/${number}`, title: "Branch PR" };
    return { ok: true, cacheScope: "fixture",
      data: { data: { repository: query.includes("pullRequests(") ? { pullRequests: { nodes: [info] } } : { pullRequest: info } } } };
  });
  await refreshTracker("pr", "branch", { home, now: 1000 });
  assert.equal(readState("branch", home).prs[0].url, "https://github.com/example/widget/pull/1");
  clearSessionStatusline({ session_id: "branch" }, { home, now: 2000 });
  await refreshTracker("pr", "branch", { home, now: 3000 });
  assert.deepEqual(readState("branch", home).prs, []);
  writeFileSync(workspace, "repository: example/widget\nbranch: later\n");
  await refreshTracker("pr", "branch", { home, now: 4000 });
  assert.deepEqual(readState("branch", home).prs.map((pr) => pr.url), ["https://github.com/example/widget/pull/2"]);
});
test("background refresh coalesces, preserves failed observation age, and isolates changed credentials", async (t) => {
  const home = fixture(t);
  const url = "https://github.com/example/widget/issues/2";
  const entered = Promise.withResolvers(), finish = Promise.withResolvers();
  let calls = 0;
  let scope = "first";
  t.mock.method(statuslineGitHub, "cacheScope", async () => scope);
  t.mock.method(statuslineGitHub, "request", async () => {
    calls++;
    entered.resolve();
    await finish.promise;
    return { ok: true, cacheScope: scope, data: { data: { repository: { issue: { state: "OPEN", title: "Fresh" } } } } };
  });
  const first = prefetchStatuses("issue", [{ url }], { home, now: 1000 });
  await entered.promise;
  const second = prefetchStatuses("issue", [{ url }], { home, now: 1000 });
  finish.resolve();
  assert.equal((await first)(url).title, "Fresh");
  assert.equal((await second)(url).title, "Fresh");
  assert.equal(calls, 1);
  t.mock.method(statuslineGitHub, "request", async () => ({ ok: false, status: 503, error: "offline", headers: {} }));
  const failed = await prefetchStatuses("issue", [{ url }], { home, now: 2000, force: true });
  assert.throws(() => failed(url), /offline/);
  assert.equal(readIssueCache(home)[url].checkedAt, 1000);
  scope = "second";
  await prefetchStatuses("issue", [{ url }], { home, now: 3000 });
  assert.equal(readIssueCache(home)[url].info, undefined);
});
test("invalid successful HTTP payloads never masquerade as a missing PR or issue", async () => {
  const request = async () => ({ ok: true, status: 200, data: {} });
  await assert.rejects(queryPrStatusWithGh("https://github.com/example/widget/pull/1", { request }), /missing/);
  await assert.rejects(queryIssueStatusWithGh("https://github.com/example/widget/issues/2", { request }), /missing/);
});
function fixture(t) {
  const path = realpathSync.native(mkdtempSync(join(tmpdir(), "github-portable-")));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

test("individually copied daemons import without node_modules or sibling skills", (t) => {
  const home = fixture(t);
  for (const id of ["ci-hound", "pr"]) {
    const folder = join(home, id);
    cpSync(join(root, "skills", id, "scripts"), folder, { recursive: true });
    const daemon = join(folder, id === "pr" ? "pr-watch-daemon.mjs" : "ci-hound-daemon.mjs");
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(pathToFileURL(daemon).href)})`], {
      cwd: home, encoding: "utf8", windowsHide: true, timeout: 30000,
    });
    assert.equal(result.status, 0, result.stderr);
  }
});

test("local setup ships every shared runtime asset and notifications do not enable footer components", (t) => {
  const home = fixture(t);
  configureStatuslines({ home, repoRoot: root, enabled: [], notifications: true });
  for (const file of SHARED_RUNTIME_FILES) assert.ok(existsSync(join(home, "extensions", file)), file);
  assert.ok(existsSync(join(home, "extensions", "daemon-notifications", "bridge.mjs")));
  assert.deepEqual(JSON.parse(readFileSync(join(home, "statusline-config.json"), "utf8")).enabled, []);
});

test("notification-only setup preserves an existing unrelated custom footer exactly", (t) => {
  const home = fixture(t);
  const text = '{"statusLine":{"type":"command","command":"custom-footer"},"footer":{"showCustom":true}}\n';
  writeFileSync(join(home, "settings.json"), text);
  configureStatuslines({ home, repoRoot: root, notifications: true, notificationOnly: true });
  assert.equal(readFileSync(join(home, "settings.json"), "utf8"), text);
  assert.equal(existsSync(join(home, "statusline-config.json")), false);
});

test("cold footer rendering and workspace discovery never contact GitHub", (t) => {
  const home = fixture(t);
  const path = join(home, "session-state", "offline");
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "events.jsonl"), JSON.stringify({
    type: "user.message", data: { content: "https://github.com/example/widget/pull/1 https://github.com/example/widget/issues/2" },
  }) + "\n");
  writeFileSync(join(path, "workspace.yaml"), "repository: example/widget\nbranch: feature\n");
  t.mock.method(statuslineGitHub, "request", () => assert.fail("footer made a GitHub request"));
  t.mock.method(statuslineGitHub, "cacheScope", () => assert.fail("footer tried to resolve credentials"));
  assert.match(renderPr({ session_id: "offline" }, { home, links: false, color: false }), /widget#1/);
  assert.match(renderIssue({ session_id: "offline" }, { home, links: false, color: false }), /widget#2/);
});

test("renderer imports never load the transport or SDK bundle", () => {
  const code = `
    import { registerHooks } from "node:module";
    registerHooks({ resolve(specifier, context, next) {
      if (/github-(?:transport|client)\\.mjs$/.test(specifier)) throw new Error("Renderer loaded the GitHub transport");
      return next(specifier, context);
    } });
    await import(${JSON.stringify(pathToFileURL(join(root, "extensions", "pr-statusline", "render.mjs")).href)});
    await import(${JSON.stringify(pathToFileURL(join(root, "extensions", "issue-statusline", "render.mjs")).href)});
    await import(${JSON.stringify(pathToFileURL(join(root, "extensions", "subagent-statusline", "render.mjs")).href)});
    await import(${JSON.stringify(pathToFileURL(join(root, "extensions", "worktree-statusline", "render.mjs")).href)});
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    cwd: root, encoding: "utf8", timeout: 30000, windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
});

test("both plugin notification entry points register opt-in tools without model calls", (t) => {
  const home = fixture(t);
  for (const entry of [
    join(root, "com.github.copilot", "extensions", "daemon-notifications", "extension.mjs"),
    join(root, "extensions", "com.github.copilot", "extensions", "daemon-notifications", "extension.mjs"),
  ]) {
    const code = `
      import assert from "node:assert/strict";
      import { registerHooks } from "node:module";
      let configuration, observe;
      const logs = [];
      const session = { sessionId: "notification-fixture",
        log: async (text) => logs.push(text), on: (handler) => { observe = handler; },
        send: () => assert.fail("No model calls"), sendAndWait: () => assert.fail("No model calls") };
      globalThis.joinSessionFixture = async (value) => { configuration = value; return session; };
      const sdk = "data:text/javascript," + encodeURIComponent("export const joinSession = globalThis.joinSessionFixture;");
      registerHooks({ resolve(specifier, context, next) {
        return specifier === "@github/copilot-sdk/extension" ? { url: sdk, shortCircuit: true } : next(specifier, context);
      } });
      await import(${JSON.stringify(pathToFileURL(entry).href)});
      assert.equal(configuration.requestedEnvironmentVariables, undefined);
      const tool = configuration.tools.find((value) => value.name === "daemon_notifications");
      assert.deepEqual(JSON.parse(tool.handler({ action: "status" })), []);
      const subscription = JSON.parse(tool.handler({ action: "subscribe", watcher: "ci" }));
      assert.equal(subscription.enabled, true);
      assert.ok(subscription.file.endsWith("watcher-ci.jsonl"));
      await configuration.commands[0].handler({ args: "status" });
      assert.equal(logs.length, 1);
      tool.handler({ action: "unsubscribe", watcher: "ci" });
      observe({ type: "session.shutdown" });
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
      cwd: root, encoding: "utf8", timeout: 30000, windowsHide: true,
      env: { ...process.env, COPILOT_HOME: home },
    });
    assert.equal(result.status, 0, result.stderr);
  }
});
