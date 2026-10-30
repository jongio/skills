import assert from "node:assert/strict";
import test from "node:test";
import { actorFor, createProgressEventGate, isProgressEvent, readSessionSources, progressInputSchema } from "../runtime/host.mjs";
import { acquireProvider } from "../runtime/provider.mjs";
import { validate } from "../runtime/canvas-kit/validate.mjs";
import { createProgressService } from "../runtime/progress.mjs";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("runtime caller attribution cannot be replaced with input actor/session IDs", () => {
  assert.deepEqual(actorFor({ sessionId: "s", agentId: undefined }, "s"), { id: "primary", primary: true });
  assert.deepEqual(actorFor({ sessionId: "s", agentId: "worker" }, "s"), { id: "worker", primary: false });
  assert.throws(() => actorFor({ sessionId: "other", agentId: undefined }, "s"), /Cross-session/);
  assert.throws(() => actorFor({ sessionId: "s" }, "s"), /attribution unavailable/);
});

test("the public tool boundary accepts explicit null report origin but not numeric goals", () => {
  const input = { action: "report", goalId: null, updateId: "clear", sequence: 2, status: "working", message: "Resolved" };
  assert.deepEqual(validate(progressInputSchema, input), []);
  assert.ok(validate(progressInputSchema, { ...input, goalId: 7 }).length);
});

test("OS session lease prevents duplicate loaders and releases on close", async () => {
  const id = `provider-test-${process.pid}`;
  const first = await acquireProvider(id);
  assert.ok(first);
  try {
    assert.equal(await acquireProvider(id), null);
    const other = await acquireProvider(`${id}-other-session`);
    assert.ok(other);
    await other.close();
  } finally { await first.close(); }
  const next = await acquireProvider(id);
  assert.ok(next);
  await next.close();
});

test("source adapter preserves canonical dependencies and bounds hung RPC reads", async () => {
  const session = { rpc: { plan: {
    read: async () => ({ exists: true, content: "Plan" }),
    readSqlTodosWithDependencies: async () => ({ rows: [{ id: "a" }], dependencies: [{ todoId: "a", dependsOn: "b" }] }),
  } } };
  assert.deepEqual((await readSessionSources(session)).dependencies, [{ todoId: "a", dependsOn: "b" }]);
  session.rpc.plan.read = () => new Promise(() => {});
  await assert.rejects(readSessionSources(session, 10), /timed out/);
});

test("startup requests cannot overtake their completion while service hydration is in progress", async () => {
  let release;
  const loaded = new Promise((resolve) => { release = resolve; });
  let service;
  const events = createProgressEventGate((event) => service.observe(event));
  const initializing = createProgressService({
    sessionId: "startup-order",
    store: { load: async () => { await loaded; return null; }, save: async () => {} },
    readSources: async () => ({ plan: {}, rows: [], dependencies: [] }),
  });
  events.push({ type: "exit_plan_mode.requested", data: { requestId: "plan", summary: "Approve plan" } });
  release();
  service = await initializing;
  events.push({ type: "exit_plan_mode.completed", data: { requestId: "plan", approved: true } });
  await events.start();
  assert.deepEqual(service.snapshot().attention, []);
  await events.push({ type: "user_input.requested", data: { requestId: "next", question: "Next decision" } });
  assert.equal(service.snapshot().attention[0].message, "Next decision");
});

test("events arriving during an asynchronous startup drain remain FIFO", async () => {
  let release;
  const wait = new Promise((resolve) => { release = resolve; });
  const order = [];
  const events = createProgressEventGate(async (event) => {
    order.push(event);
    if (event === "request") await wait;
  });
  events.push("request");
  const started = events.start();
  events.push("completion");
  release();
  await started;
  await events.push("live");
  assert.deepEqual(order, ["request", "completion", "live"]);
});

test("the host routes root cancellation through startup buffering but ignores delegate cancellation", async () => {
  const service = await createProgressService({
    sessionId: "startup-cancel",
    store: { load: async () => null, save: async () => {} },
    readSources: async () => ({ plan: {}, rows: [], dependencies: [] }),
  });
  const events = createProgressEventGate((event) => service.observe(event));
  const route = (event) => isProgressEvent(event) ? events.push(event) : undefined;
  route({ type: "user_input.requested", data: { requestId: "pending" } });
  route({ type: "abort", data: {} });
  await events.start();
  assert.deepEqual(service.snapshot().attention, []);
  await route({ type: "permission.requested", data: { requestId: "next" } });
  for (const event of [
    { type: "abort", agentId: "worker", data: {} },
    { type: "session.shutdown", data: { agentId: "worker" } },
  ]) {
    assert.equal(isProgressEvent(event), false);
    await route(event);
    assert.equal(service.snapshot().attention.length, 1);
  }
  await route({ type: "abort", data: {} });
  assert.deepEqual(service.snapshot().attention, []);
});

test("the actual board entrypoint refreshes canonical tracking without recursive native hooks", (t) => {
  const home = mkdtempSync(join(tmpdir(), "board-native-adapter-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const overrides = { COPILOT_HOME: home, LOCALAPPDATA: join(home, "appdata"), SESSION_ID: `board-adapter-${process.pid}` };
  const previous = new Map(Object.keys(overrides).map((key) => [key, process.env[key]]));
  try {
    Object.assign(process.env, overrides);
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import assert from "node:assert/strict";
      import { registerHooks } from "node:module";
      import { join } from "node:path";
      import { setTimeout as delay } from "node:timers/promises";
      let configuration, observer, reads = 0, readBarrier = null, releaseRead;
      const ownedPr = { url: "https://github.com/fixture/repo/pull/1", owned: true, headRefOid: "a".repeat(40) };
      const ownedIssue = { url: "https://github.com/fixture/repo/issues/9", owned: true };
      let prs = [ownedPr], issues = [];
      const sessionId = process.env.SESSION_ID;
      const session = {
        sessionId, workspacePath: join(process.env.COPILOT_HOME, "session-state", sessionId),
        on: (handler) => { observer = handler; return () => {}; }, getEvents: async () => [],
        log: async () => {}, disconnect: async () => {},
        rpc: {
          plan: { read: async () => ({ exists: true }), readSqlTodosWithDependencies: async () => ({
            rows: [{ id: "task", title: "Canonical task", status: "pending" }], dependencies: [],
          }) },
          tools: { execute: async ({ name, arguments: args }) => {
            assert.ok(++reads <= 14, "recursive native tracking read");
            assert.ok(["session_prs", "session_issues"].includes(name));
            assert.deepEqual(args, { action: "list" });
            if (readBarrier) await readBarrier;
            const result = { resultType: "success", textResultForLlm: JSON.stringify(name === "session_prs" ? prs : issues) };
            await configuration.hooks.onPostToolUse({ toolName: name, toolArgs: args, toolResult: result }, { sessionId });
            return result;
          } },
        },
      };
      globalThis.boardSdk = { createCanvas: (value) => value, CanvasError: class extends Error {},
        joinSession: async (value) => { configuration = value; return session; } };
      const sdk = "data:text/javascript," + encodeURIComponent("export const {createCanvas,CanvasError,joinSession}=globalThis.boardSdk;");
      registerHooks({ resolve(specifier, context, next) {
        return specifier === "@github/copilot-sdk/extension" ? { url: sdk, shortCircuit: true } : next(specifier, context);
      } });
      await import(${JSON.stringify(new URL("../runtime/extension.mjs", import.meta.url).href)});
      const tool = configuration.tools.find((entry) => entry.name === "session_progress").handler;
      const status = async () => JSON.parse(await tool({ action: "status" }, { sessionId, agentId: undefined }));
      const until = async (predicate) => {
        for (let attempt = 0; attempt < 100; attempt++) {
          const value = await status();
          if (predicate(value)) return value;
          await delay(10);
        }
        throw new Error("Canonical tracking snapshot did not arrive");
      };
      await configuration.hooks.onPostToolUse({ toolName: "session_prs", toolArgs: { action: "list" },
        toolResult: { resultType: "success", textResultForLlm: JSON.stringify(prs) } }, { sessionId });
      await until((value) => reads === 1 && value.references.prs.length === 1);
      prs = [];
      observer({ type: "session.info", data: { infoType: "notification", message: "Session tracking changed: prs",
        prs: [{ url: "https://github.com/other/repo/pull/9", owned: true }] } });
      await until((value) => reads === 2 && value.references.prs.length === 0);
      const panel = await configuration.canvases[0].open({ sessionId, instanceId: "test-panel", input: {} });
      const url = new URL("action", panel.url);
      url.search = new URL(panel.url).search;
      const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ actionName: "refresh", input: {} }), signal: AbortSignal.timeout(5000) });
      assert.equal(response.status, 200);
      await response.json();
      const final = await until((value) => reads === 4 && value.references.source.status === "verified");
      assert.deepEqual(final.references.prs, []);
      assert.equal(final.tasks[0].status, "pending");
      await tool({ action: "goal", goalId: "current-goal", title: "Current goal", taskIds: ["task"] },
        { sessionId, agentId: undefined });
      const currentGoal = (await status()).goals;
      await tool({ action: "references", prs: [ownedPr], issues: [ownedIssue] }, { sessionId, agentId: undefined });
      prs = []; issues = [];
      const pending = JSON.parse(await tool({ action: "refresh" }, { sessionId, agentId: undefined }));
      assert.notEqual(pending.references.source.status, "verified", "Direct refresh cannot return stale ownership as verified");
      assert.equal(pending.references.prs.length, 1, "Pending reads retain last-known history rather than inventing empty ownership");
      await until((value) => reads === 6 && value.references.source.status === "verified"
        && value.references.prs.length === 0 && value.references.issues.length === 0);
      await tool({ action: "references", prs: [ownedPr], issues: [ownedIssue] }, { sessionId, agentId: undefined });
      await configuration.hooks.onPostToolUse({ toolName: "session_statusline", toolArgs: { action: "refresh" },
        toolResult: { resultType: "success",
          textResultForLlm: "Refreshed this session's tracked statusline entries. Tracking and enabled components are unchanged." } }, { sessionId });
      const refreshed = await until((value) => reads === 8 && value.references.source.status === "verified"
        && value.references.prs.length === 0 && value.references.issues.length === 0);
      assert.equal(refreshed.tasks[0].status, "pending");
      assert.equal(refreshed.activeGoalId, "current-goal");
      assert.deepEqual(refreshed.goals, currentGoal, "Membership refresh must not erase canonical goal history");
      for (const surface of ["canvas", "statusline"]) {
        await tool({ action: "references", prs: [ownedPr], issues: [ownedIssue] }, { sessionId, agentId: undefined });
        readBarrier = new Promise((resolve) => { releaseRead = resolve; });
        if (surface === "canvas") {
          const refreshing = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ actionName: "refresh", input: {} }), signal: AbortSignal.timeout(5000) });
          assert.equal(refreshing.status, 200);
          await refreshing.json();
        } else {
          await configuration.hooks.onPostToolUse({ toolName: "session_statusline", toolArgs: { action: "refresh" },
            toolResult: { resultType: "success",
              textResultForLlm: "Refreshed this session's tracked statusline entries. Tracking and enabled components are unchanged." } }, { sessionId });
        }
        const uncertain = await status();
        const ci = await tool({ action: "ci", reference: "fixture/repo#1", headRefOid: ownedPr.headRefOid,
          status: "passed", passed: 1, total: 1, observedAt: new Date().toISOString() }, { sessionId, agentId: undefined });
        assert.equal(ci.resultType, "failure", surface + " must reject CI while canonical membership is pending");
        assert.match(ci.textResultForLlm, /ownership.*not verified/i);
        assert.equal(uncertain.references.source.known.prs, false);
        assert.equal(uncertain.references.prs.length, 1, "Uncertainty must retain last-known history");
        releaseRead(); readBarrier = null;
        const expectedReads = surface === "canvas" ? 10 : 12;
        await until((value) => reads === expectedReads && value.references.source.status === "verified"
          && value.references.prs.length === 0 && value.references.issues.length === 0);
      }
      console.log("native adapter boundaries passed");
      process.emit("SIGTERM");
    `], { encoding: "utf8", timeout: 15000, windowsHide: true, env: process.env });
    assert.ifError(result.error);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /native adapter boundaries passed/);
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
