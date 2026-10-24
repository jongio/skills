import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { createServer } from "node:http";
import { createGitHubClient } from "../extensions/github-client.mjs";
import { ghApiWithEtag, loadState } from "../skills/ci-hound/scripts/ci-hound-daemon.mjs";
import { createPrWatchState, evaluatePrPollTick, parsePrWatchArgs } from "../skills/pr/scripts/pr-watch-daemon.mjs";
import { configureStatuslines, SHARED_RUNTIME_FILES } from "../scripts/setup-statusline.mjs";
import { statuslineGitHub, requestedGitHubEnvironment, gitHubEnvironmentForHost } from "../extensions/github-transport.mjs";
import { render as renderPr } from "../extensions/pr-statusline/render.mjs";
import { render as renderIssue } from "../extensions/issue-statusline/render.mjs";
import { queryPrStatusWithGh } from "../extensions/pr-statusline/github.mjs";
import { queryIssueStatusWithGh } from "../extensions/issue-statusline/github.mjs";
import { prefetchStatuses, refreshTracker } from "../extensions/github-refresh.mjs";
import { readIssueCache } from "../extensions/issue-statusline/github.mjs";
import { IssueTracker, writeState as writeIssueState } from "../extensions/issue-statusline/tracker.mjs";
import { readState, writeState, SessionTracker } from "../extensions/pr-statusline/tracker.mjs";
import { clearSessionStatusline } from "../extensions/pr-statusline/session-statusline.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
test("both watchers consume a real bundled SDK 304 as validated cached data", async (t) => {
  const head = "b".repeat(40);
  const pr = { state: "OPEN", headRefOid: head, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN",
    reviewRequests: { nodes: [] }, reviews: { nodes: [] }, reviewThreads: { nodes: [] }, comments: { nodes: [] },
    commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [
      { __typename: "CheckRun", name: "CI", status: "IN_PROGRESS", conclusion: null },
    ] } } } }] } };
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/graphql") {
      response.end(JSON.stringify({ data: { repository: { pullRequest: pr } } }));
    } else if (request.headers["if-none-match"]) {
      response.writeHead(304, { etag: '"fixture"' });
      response.end();
    } else {
      response.setHeader("etag", '"fixture"');
      response.end(JSON.stringify(request.url.includes("/commits/") ? { sha: head } : { workflow_runs: [], total_count: 0 }));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const client = createGitHubClient({ baseUrl: `http://127.0.0.1:${server.address().port}`, env: { GH_TOKEN: "fixture-token", NO_PROXY: "*" } });
  t.after(async () => {
    server.closeAllConnections();
    await client.close();
    await new Promise((resolve) => server.close(resolve));
  });
  const request = (input) => client.request(input);
  request.cacheScope = () => client.cacheScope();
  const ciState = loadState("");
  await ghApiWithEtag("repos/fixture/repo/commits/main", ciState, request);
  const cached = await ghApiWithEtag("repos/fixture/repo/commits/main", ciState, request);
  assert.equal(cached.fromCache, true);
  assert.equal(cached.data.sha, head);
  const args = parsePrWatchArgs(["watch", "--repo", "fixture/repo", "--pr", "1", "--head", head, "--no-copilot"]);
  const state = createPrWatchState();
  await evaluatePrPollTick(args, request, state);
  const tick = await evaluatePrPollTick(args, request, state);
  assert.equal(tick.error, undefined);
  assert.equal(tick.status.cacheHits304, 1);
  assert.equal(tick.status.pendingChecksCount, 1);
});
test("expired standalone observations are visibly stale without a network refresh", (t) => {
  const home = fixture(t);
  const tracker = new SessionTracker("expired");
  tracker.add("https://github.com/example/widget/pull/1");
  Object.assign(tracker.state.prs[0], { status: "Cached checks", checkedAt: 1000 });
  writeState(tracker.snapshot(), home);
  assert.match(renderPr({ session_id: "expired" }, { home, now: 100000, color: false, links: false }), /stale/);
});
test("secondary-account observations reuse the real bundled adapter cache across collector ticks", async (t) => {
  const home = fixture(t);
  let calls = 0;
  const server = createServer((request, response) => {
    calls++;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(request.headers.authorization === "token secondary-token"
      ? { data: { repository: { issue: { state: "OPEN", title: "Private issue" } } } }
      : { errors: [{ message: "Could not resolve to a Repository" }] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const client = createGitHubClient({
    baseUrl: `http://127.0.0.1:${server.address().port}`, env: { NO_PROXY: "*" }, secondaryAccounts: true,
    run: async (args) => ({ ok: true, stdout: args[1] === "status"
      ? JSON.stringify({ hosts: { "github.com": [{ active: false, login: "secondary" }] } })
      : args.includes("--user") ? "secondary-token" : "primary-token" }),
  });
  t.after(async () => {
    server.closeAllConnections();
    await client.close();
    await new Promise((resolve) => server.close(resolve));
  });
  t.mock.method(statuslineGitHub, "request", (input, _host, options) => client.request(input, options));
  t.mock.method(statuslineGitHub, "cacheScope", (_host, options) => client.cacheScope(options));
  const url = "https://github.com/private/repo/issues/2";
  assert.equal((await prefetchStatuses("issue", [{ url }], { home, now: 1000 }))(url).title, "Private issue");
  assert.equal(calls, 2);
  assert.equal((await prefetchStatuses("issue", [{ url }], { home, now: 2000 }))(url).title, "Private issue");
  assert.equal(calls, 2, "the second tick uses the credential-matched cached observation");
  assert.equal(readIssueCache(home)[url].checkedAt, 1000);
});
test("SDK token access is explicit, minimal, and restricted to named GitHub credentials", () => {
  assert.deepEqual(requestedGitHubEnvironment({}), []);
  assert.deepEqual(requestedGitHubEnvironment({ COPILOT_STATUSLINE_TOKEN_ENV: "GH_TOKEN,GH_TOKEN" }), ["GH_TOKEN"]);
  assert.throws(() => requestedGitHubEnvironment({ COPILOT_STATUSLINE_TOKEN_ENV: "OTHER_SECRET" }), /supported/);
  const env = { GH_HOST: "enterprise.example", GH_ENTERPRISE_TOKEN: "fixture-enterprise", GH_TOKEN: "fixture-public" };
  assert.equal(gitHubEnvironmentForHost("enterprise.example", env).GH_ENTERPRISE_TOKEN, "fixture-enterprise");
  assert.equal(gitHubEnvironmentForHost("unrelated.example", env).GH_ENTERPRISE_TOKEN, undefined);
  assert.equal(gitHubEnvironmentForHost("unrelated.example", env).GH_TOKEN, undefined);
  const ghe = { GH_HOST: "one.ghe.com", GH_TOKEN: "fixture-ghe", GITHUB_TOKEN: "fixture-ghe-alias" };
  assert.equal(gitHubEnvironmentForHost("one.ghe.com", ghe).GH_TOKEN, "fixture-ghe");
  for (const host of ["two.ghe.com", "github.com"]) {
    assert.equal(gitHubEnvironmentForHost(host, ghe).GH_TOKEN, undefined);
    assert.equal(gitHubEnvironmentForHost(host, ghe).GITHUB_TOKEN, undefined);
  }
});
test("workspace branch hints never trigger unused lookup or enroll targets during owned refresh", async (t) => {
  const home = fixture(t);
  const directory = join(home, "session-state", "branch");
  mkdirSync(directory, { recursive: true });
  const workspace = join(directory, "workspace.yaml");
  writeFileSync(workspace, "repository: example/widget\nbranch: feature\n");
  let branches = 0;
  t.mock.method(statuslineGitHub, "cacheScope", async () => "fixture");
  t.mock.method(statuslineGitHub, "request", async ({ query, variables }) => {
    if (query.includes("pullRequests(")) branches++;
    const number = variables.head === "later" ? 2 : variables.number || 1;
    const info = { state: "OPEN", url: `https://github.com/example/widget/pull/${number}`, title: "Branch PR" };
    return { ok: true, cacheScope: "fixture",
      data: { data: { repository: query.includes("pullRequests(") ? { pullRequests: { nodes: [info] } } : { pullRequest: info } } } };
  });
  await refreshTracker("pr", "branch", { home, now: 1000 });
  assert.deepEqual(readState("branch", home).prs, []);
  assert.equal(branches, 0, "an inactive workspace does not cause discovery requests");
  const active = new SessionTracker("branch", readState("branch", home));
  active.manage("add", "https://github.com/example/widget/pull/1");
  writeState(active.snapshot(), home);
  await refreshTracker("pr", "branch", { home, now: 2000 });
  assert.equal(readState("branch", home).prs[0].url, "https://github.com/example/widget/pull/1");
  assert.equal(branches, 0);
  clearSessionStatusline({ session_id: "branch" }, { home, now: 3000 });
  await refreshTracker("pr", "branch", { home, now: 4000 });
  assert.deepEqual(readState("branch", home).prs, []);
  writeFileSync(workspace, "repository: example/widget\nbranch: later\n");
  await refreshTracker("pr", "branch", { home, now: 5000 });
  assert.deepEqual(readState("branch", home).prs, []);
  assert.equal(branches, 0, "new branch hints cannot undo a clear");
  const later = new SessionTracker("branch", readState("branch", home));
  later.manage("add", "https://github.com/example/widget/pull/2");
  writeState(later.snapshot(), home);
  await refreshTracker("pr", "branch", { home, now: 6000 });
  assert.deepEqual(readState("branch", home).prs.map((pr) => pr.url), ["https://github.com/example/widget/pull/2"]);
  assert.equal(branches, 0, "owned targets refresh directly without a duplicate branch query");
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
  assert.equal(renderPr({ session_id: "offline" }, { home, links: false, color: false }), "");
  assert.equal(renderIssue({ session_id: "offline" }, { home, links: false, color: false }), "");
  const prs = new SessionTracker("offline");
  prs.manage("add", "https://github.com/example/widget/pull/1");
  writeState(prs.snapshot(), home);
  const issues = new IssueTracker("offline");
  issues.manage("add", "https://github.com/example/widget/issues/2");
  writeIssueState(issues.snapshot(), home);
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
        disconnect: async () => {},
        rpc: { extensions: { list: async () => ({ extensions: [{ id: "plugin:fixture:daemon-notifications", pid: process.pid }] }),
          disable: async () => assert.fail("No legacy provider in this fixture") } },
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

test("plugin notification handover retires the manual provider and preserves single delivery/unsubscribe", (t) => {
  for (const entry of [
    join(root, "com.github.copilot", "extensions", "daemon-notifications", "extension.mjs"),
    join(root, "extensions", "com.github.copilot", "extensions", "daemon-notifications", "extension.mjs"),
  ]) {
    const home = fixture(t);
    const code = `
      import assert from "node:assert/strict";
      import { mkdirSync, writeFileSync, existsSync, readdirSync } from "node:fs";
      import { join } from "node:path";
      import { registerHooks } from "node:module";
      import { createEventWriter } from ${JSON.stringify(pathToFileURL(join(root, "runtime", "github-client", "events.mjs")).href)};
      const timers = new Map(), logs = [], disabled = [], configurations = {}, observers = { manual: [], plugin: [] };
      let stage = "manual", nextTimer = 0;
      globalThis.setInterval = (callback) => {
        const handle = { id: ++nextTimer, unref() {} };
        timers.set(handle, callback);
        return handle;
      };
      globalThis.clearInterval = (handle) => timers.delete(handle);
      const sessions = Object.fromEntries(["manual", "plugin"].map((kind) => [kind, {
        sessionId: "handover", log: async (text) => logs.push({ kind, text }),
        on: (callback) => observers[kind].push(callback), disconnect: async () => {},
        send: () => assert.fail("No model calls"), sendAndWait: () => assert.fail("No model calls"),
        rpc: { extensions: {
          list: async () => ({ extensions: stage === "manual"
            ? [{ id: "user:daemon-notifications", pid: process.pid }]
            : [{ id: "user:daemon-notifications", pid: process.pid + 1 },
               { id: "plugin:fixture:daemon-notifications", pid: process.pid }] }),
          disable: async ({ id }) => {
            assert.equal(id, "user:daemon-notifications");
            disabled.push(id);
            for (const observe of observers.manual) observe({ type: "session.shutdown" });
          },
        } },
      }]));
      globalThis.joinSessionFixture = async (value) => {
        if (value.tools?.length) configurations[stage] = value;
        return sessions[stage];
      };
      const sdk = "data:text/javascript," + encodeURIComponent("export const joinSession = globalThis.joinSessionFixture;");
      registerHooks({ resolve(specifier, context, next) {
        return specifier === "@github/copilot-sdk/extension" ? { url: sdk, shortCircuit: true } : next(specifier, context);
      } });
      const legacy = join(process.env.COPILOT_HOME, "extensions", "daemon-notifications", "extension.mjs");
      mkdirSync(join(process.env.COPILOT_HOME, "extensions", "daemon-notifications"), { recursive: true });
      writeFileSync(legacy, "manual entrypoint fixture");
      await import(${JSON.stringify(pathToFileURL(join(root, "extensions", "daemon-notifications", "extension.mjs")).href + "?manual")});
      const manualTool = configurations.manual.tools.find((tool) => tool.name === "daemon_notifications");
      const { file } = JSON.parse(manualTool.handler({ action: "subscribe", watcher: "ci" }));
      const emit = createEventWriter(file, "ci-hound");
      stage = "plugin";
      await import(${JSON.stringify(pathToFileURL(entry).href)});
      emit({ events: [{ type: "JOB_FAILED", repo: "fixture/repo" }] });
      for (const poll of [...timers.values()]) await poll();
      assert.equal(logs.length, 1, "one event is delivered by exactly one active provider");
      assert.equal(logs[0].kind, "plugin");
      assert.deepEqual(disabled, ["user:daemon-notifications"]);
      assert.equal(timers.size, 1);
      assert.equal(existsSync(legacy), false);
      assert.equal(readdirSync(join(process.env.COPILOT_HOME, "extensions", "daemon-notifications"))
        .filter((name) => name.startsWith("extension.mjs.disabled-")).length, 1);
      const pluginTool = configurations.plugin.tools.find((tool) => tool.name === "daemon_notifications");
      assert.equal(JSON.parse(pluginTool.handler({ action: "status" })).length, 1);
      pluginTool.handler({ action: "unsubscribe", watcher: "ci" });
      emit({ events: [{ type: "JOB_FAILED", repo: "fixture/repo" }] });
      for (const poll of [...timers.values()]) await poll();
      assert.equal(logs.length, 1, "unsubscribe cannot leave a legacy provider polling");
      assert.equal(timers.size, 0);
      for (const observe of observers.plugin) observe({ type: "session.shutdown" });
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
      cwd: root, encoding: "utf8", timeout: 30000, windowsHide: true,
      env: { ...process.env, COPILOT_HOME: home },
    });
    assert.equal(result.status, 0, result.stderr);
  }
});

    test("SDK denial prevents PR and issue collectors from accessing credentials or GitHub", (t) => {
      const home = fixture(t);
      for (const id of ["pr-statusline", "issue-statusline"]) {
        const code = `
          import assert from "node:assert/strict";
          import { registerHooks } from "node:module";
          const { statuslineGitHub } = await import(${JSON.stringify(pathToFileURL(join(root, "extensions", "github-transport.mjs")).href)});
          let calls = 0;
          statuslineGitHub.request = statuslineGitHub.cacheScope = async () => { calls++; throw new Error("Access before approval"); };
          globalThis.deniedSession = async (options) => {
            assert.deepEqual(options.requestedEnvironmentVariables, ["GH_TOKEN"]);
            throw new Error("Permission denied");
          };
          const sdk = "data:text/javascript," + encodeURIComponent("export const joinSession = globalThis.deniedSession;");
          registerHooks({ resolve(specifier, context, next) {
            return specifier === "@github/copilot-sdk/extension" ? { url: sdk, shortCircuit: true } : next(specifier, context);
          } });
          await assert.rejects(import(${JSON.stringify(pathToFileURL(join(root, "extensions", id, "extension.mjs")).href)}), /Permission denied/);
          assert.equal(calls, 0);
        `;
        const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
          cwd: root, encoding: "utf8", timeout: 30000, windowsHide: true,
          env: { ...process.env, COPILOT_HOME: home, COPILOT_STATUSLINE_TOKEN_ENV: "GH_TOKEN",
            GH_TOKEN: "", GITHUB_TOKEN: "", GH_ENTERPRISE_TOKEN: "", GITHUB_ENTERPRISE_TOKEN: "" },
        });
        assert.equal(result.status, 0, result.stderr);
      }
    });

    test("the real statusline adapter never forwards an environment token to an unrelated host", () => {
      for (const profile of [
        { host: "enterprise.example", variable: "GH_ENTERPRISE_TOKEN", denied: ["unrelated.example"] },
        { host: "one.ghe.com", variable: "GH_TOKEN", denied: ["two.ghe.com", "github.com"] },
        { host: "one.ghe.com", variable: "GITHUB_TOKEN", denied: ["two.ghe.com", "github.com"] },
      ]) {
      const code = `
        import assert from "node:assert/strict";
        import { createServer } from "node:http";
        import { registerHooks } from "node:module";
        const requests = [];
        const server = createServer((request, response) => {
          requests.push(request.headers.authorization);
          response.setHeader("content-type", "application/json");
          response.end(JSON.stringify({ data: { repository: { pullRequest: { state: "OPEN" } } } }));
        });
        await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
        globalThis.fixtureOrigin = "http://127.0.0.1:" + server.address().port;
        const wrapper = "data:text/javascript," + encodeURIComponent(
          "import { createGitHubClient as actual } from " + ${JSON.stringify(JSON.stringify(pathToFileURL(join(root, "extensions", "github-client.mjs")).href))} + ";" +
          "export const createGitHubClient = options => actual({ ...options, baseUrl: globalThis.fixtureOrigin + '/api/v3'," +
          "env: { ...(options.env || process.env), NO_PROXY: '*', no_proxy: '*' }," +
          "run: async () => ({ ok: false, stdout: '', stderr: 'No configured credential' }) });"
        );
        registerHooks({ resolve(specifier, context, next) {
          return specifier === "./github-client.mjs" && context.parentURL?.endsWith("/github-transport.mjs")
            ? { url: wrapper, shortCircuit: true } : next(specifier, context);
        } });
        const { queryPrStatusWithGh } = await import(${JSON.stringify(pathToFileURL(join(root, "extensions", "pr-statusline", "github.mjs")).href)});
        const { statuslineGitHub } = await import(${JSON.stringify(pathToFileURL(join(root, "extensions", "github-transport.mjs")).href)});
        try {
          for (const host of ${JSON.stringify(profile.denied)}) {
            await assert.rejects(queryPrStatusWithGh("https://" + host + "/fixture/repo/pull/1"), /authentication required/);
          }
          assert.equal(requests.length, 0);
          assert.equal((await queryPrStatusWithGh(${JSON.stringify(`https://${profile.host}/fixture/repo/pull/1`)})).state, "OPEN");
          assert.deepEqual(requests, ["token fixture-host"]);
        } finally {
          server.closeAllConnections();
          await statuslineGitHub.close();
          await new Promise((resolve) => server.close(resolve));
        }
      `;
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
        cwd: root, encoding: "utf8", timeout: 30000, windowsHide: true,
        env: { ...process.env, GH_HOST: profile.host, GH_ENTERPRISE_TOKEN: "",
          GITHUB_ENTERPRISE_TOKEN: "", GH_TOKEN: "", GITHUB_TOKEN: "", [profile.variable]: "fixture-host" },
      });
      assert.equal(result.status, 0, result.stderr);
      }
    });
