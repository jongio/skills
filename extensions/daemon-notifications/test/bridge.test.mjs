import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createNotificationBridge } from "../bridge.mjs";
import { createEventWriter } from "../../../runtime/github-client/events.mjs";

test("notifications are opt-in, session-bound, bounded, replay-aware, and never send model prompts", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "daemon-bridge-"));
  const logs = [];
  const session = { sessionId: "fixture", log: async (text) => logs.push(text),
    send: () => assert.fail("must not send prompts"), sendAndWait: () => assert.fail("must not call a model") };
  let time = 1000;
  let bridge = createNotificationBridge(session, { home, now: () => time });
  t.after(() => { bridge.stop(); rmSync(home, { recursive: true, force: true }); });
  assert.deepEqual(bridge.manage("status"), []);
  assert.equal(existsSync(join(home, "daemon-notifications", "fixture", "subscriptions.json")), false);
  await bridge.poll();
  assert.equal(logs.length, 0, "provider liveness does not opt into notifications");
  const unrelated = join(home, "settings.json");
  writeFileSync(unrelated, '{"custom":"preserve"}\n');
  t.mock.method(console, "error", () => {});
  createEventWriter(unrelated, "ci-hound")({ events: [{ type: "JOB_FAILED" }] });
  assert.equal(readFileSync(unrelated, "utf8"), '{"custom":"preserve"}\n');
  assert.throws(() => bridge.manage("subscribe", "../other"), /Watcher/);
  bridge.manage("subscribe", "constructor");
  assert.equal(bridge.manage("status")[0].watcher, "constructor");
  bridge.manage("unsubscribe", "constructor");
  const { file } = bridge.manage("subscribe", "ci");
  const emit = createEventWriter(file, "ci-hound");
  emit({ statuses: [{ repo: "fixture/repo", phase: "running", summary: "1/2 passed", secret: "not included" }] });
  assert.ok(!readFileSync(file, "utf8").includes("not included"));
  await bridge.poll();
  assert.equal(logs.length, 1);
  emit({ statuses: [{ repo: "fixture/repo", phase: "running", summary: "still running" }] });
  await bridge.poll();
  assert.equal(logs.length, 1, "unchanged status is coalesced");
  time += 60000;
  emit({ statuses: [{ repo: "fixture/repo", phase: "running", summary: "heartbeat" }] });
  await bridge.poll();
  assert.equal(logs.length, 2);
  emit({ events: [{ type: "JOB_FAILED", repo: "fixture/repo", body: "excluded review content" }] });
  appendFileSync(file, '{"partial":');
  await bridge.poll();
  assert.equal(logs.length, 3);
  bridge.stop();
  bridge = createNotificationBridge(session, { home, now: () => time });
  await bridge.poll();
  assert.equal(logs.length, 3, "completed records are not replayed after restart");
  const restartedWriter = createEventWriter(file, "ci-hound");
  restartedWriter({ events: [{ type: "ALL_GREEN" }] });
  await bridge.poll();
  await bridge.poll();
  assert.equal(logs.length, 4, "old and new streams are each deduplicated");
  for (let i = 0; i < 500; i++) restartedWriter({ events: [{ type: "STATUS", summary: "x".repeat(4000) }] });
  assert.ok(statSync(file).size < 512 * 1024);
  bridge.manage("unsubscribe", "ci");
  await bridge.poll();
  assert.deepEqual(bridge.manage("status"), []);
});

test("status coalescing is target-scoped, replay-aware, and bounded", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "daemon-targets-"));
  const logs = [];
  const session = { sessionId: "targets", log: async (text) => logs.push(text) };
  let time = 1000;
  let bridge = createNotificationBridge(session, { home, now: () => time });
  t.after(() => { bridge.stop(); rmSync(home, { recursive: true, force: true }); });
  const { file } = bridge.manage("subscribe", "ci");
  const emit = createEventWriter(file, "ci-hound");
  const targets = [
    { repo: "fixture/one" }, { repo: "fixture/two" },
    { repo: "fixture/one", pr: 1 }, { repo: "fixture/one", pr: 2 },
    { repo: "fixture/one", runId: 1 }, { repo: "fixture/one", runId: 2 },
  ];
  emit({ statuses: targets.map((target) => ({ ...target, phase: "running" })) });
  await bridge.poll();
  assert.equal(logs.length, targets.length, "the first update for every target is delivered");
  emit({ statuses: targets.map((target) => ({ ...target, phase: "running" })) });
  await bridge.poll();
  assert.equal(logs.length, targets.length, "same-target progress is coalesced");
  bridge.stop();
  bridge = createNotificationBridge(session, { home, now: () => time });
  emit({ statuses: targets.map((target) => ({ ...target, phase: "running" })) });
  await bridge.poll();
  assert.equal(logs.length, targets.length, "target phase watermarks survive restart");
  time = 0;
  emit({ statuses: [{ repo: "fixture/zero", phase: "running" }] });
  await bridge.poll();
  emit({ statuses: [{ repo: "fixture/zero", phase: "running" }] });
  await bridge.poll();
  assert.equal(logs.length, targets.length + 1, "timestamp zero is a valid coalescing watermark");
  for (let index = 0; index < 130; index++) {
    emit({ statuses: [{ repo: `fixture/target-${index}`, phase: "running" }] });
  }
  await bridge.poll();
  const state = JSON.parse(readFileSync(join(home, "daemon-notifications", "targets", "subscriptions.json"), "utf8"));
  assert.equal(Object.keys(state.ci.targets).length, 128);
});

for (const order of ["standalone-first", "full-first"]) {
  test(`live full provider owns delivery and shared unsubscribe (${order})`, async (t) => {
    const home = mkdtempSync(join(tmpdir(), "daemon-authority-"));
    const logs = [], bridges = {};
    for (const provider of order === "full-first" ? ["full", "standalone"] : ["standalone", "full"]) {
      bridges[provider] = createNotificationBridge({
        sessionId: "authority", log: async (text) => logs.push({ provider, text }),
      }, { home, provider });
    }
    t.after(() => { Object.values(bridges).forEach((bridge) => bridge.stop()); rmSync(home, { recursive: true, force: true }); });
    const { file } = bridges.standalone.manage("subscribe", "ci");
    assert.equal(bridges.full.manage("status").length, 1, "opt-in is shared, not copied per provider");
    const emit = createEventWriter(file, "ci-hound");
    emit({ events: [{ type: "JOB_FAILED" }] });
    await Promise.all(Object.values(bridges).map((bridge) => bridge.poll()));
    assert.deepEqual(logs.map(({ provider }) => provider), ["full"]);
    bridges.standalone.manage("unsubscribe", "ci");
    emit({ events: [{ type: "WORKFLOW_FAILED" }] });
    await Promise.all(Object.values(bridges).map((bridge) => bridge.poll()));
    assert.equal(logs.length, 1);
  });
}

test("standalone delivery falls back when a full provider stops or loses its live lease", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "daemon-fallback-"));
  const logs = [];
  let time = 1000;
  const make = (provider) => createNotificationBridge({
    sessionId: "fallback", log: async () => logs.push(provider),
  }, { home, provider, now: () => time });
  const standalone = make("standalone");
  let full;
  t.after(() => { standalone.stop(); full?.stop(); rmSync(home, { recursive: true, force: true }); });
  const { file } = standalone.manage("subscribe", "ci");
  const emit = createEventWriter(file, "ci-hound");
  emit({ events: [{ type: "JOB_FAILED" }] });
  await standalone.poll();
  full = make("full");
  emit({ events: [{ type: "JOB_FAILED" }] });
  await standalone.poll(); await full.poll();
  full.stop();
  emit({ events: [{ type: "JOB_FAILED" }] });
  await standalone.poll();
  full = make("full");
  emit({ events: [{ type: "JOB_FAILED" }] });
  await full.poll();
  time += 15001;
  emit({ events: [{ type: "JOB_FAILED" }] });
  await standalone.poll();
  assert.deepEqual(logs, ["standalone", "full", "standalone", "full", "standalone"]);
});

test("full-provider takeover and unsubscribe cannot duplicate or resurrect an in-flight delivery", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "daemon-takeover-"));
  const entered = Promise.withResolvers(), finish = Promise.withResolvers();
  const logs = [];
  const standalone = createNotificationBridge({
    sessionId: "takeover", log: async () => { logs.push("standalone"); entered.resolve(); await finish.promise; },
  }, { home });
  let full;
  t.after(() => { finish.resolve(); standalone.stop(); full?.stop(); rmSync(home, { recursive: true, force: true }); });
  const { file } = standalone.manage("subscribe", "ci");
  const emit = createEventWriter(file, "ci-hound");
  emit({ events: [{ type: "JOB_FAILED" }] });
  const running = standalone.poll();
  await entered.promise;
  full = createNotificationBridge({ sessionId: "takeover", log: async () => logs.push("full") }, { home, provider: "full" });
  await full.poll();
  full.manage("unsubscribe", "ci");
  finish.resolve(); await running;
  emit({ events: [{ type: "WORKFLOW_FAILED" }] });
  await full.poll(); await standalone.poll();
  assert.deepEqual(logs, ["standalone"]);
  assert.deepEqual(full.manage("status"), []);
  assert.deepEqual(standalone.manage("status"), []);
});

test("same-role providers serialize delivery and inherit acknowledged watermarks on fallback", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "daemon-same-role-"));
  const logs = [];
  const bridges = ["first", "second"].map((name) => createNotificationBridge({
    sessionId: "same-role", log: async () => logs.push(name),
  }, { home, provider: "full" }));
  t.after(() => { bridges.forEach((bridge) => bridge.stop()); rmSync(home, { recursive: true, force: true }); });
  const { file } = bridges[0].manage("subscribe", "ci");
  const emit = createEventWriter(file, "ci-hound");
  emit({ events: [{ type: "JOB_FAILED" }] });
  await Promise.all(bridges.map((bridge) => bridge.poll()));
  assert.equal(logs.length, 1);
  bridges[logs[0] === "first" ? 0 : 1].stop();
  emit({ events: [{ type: "WORKFLOW_FAILED" }] });
  await Promise.all(bridges.map((bridge) => bridge.poll()));
  assert.equal(logs.length, 2, "fallback does not replay the acknowledged event");
});

test("failed logging releases delivery authority without acknowledging the event", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "daemon-log-failure-"));
  let calls = 0;
  const bridge = createNotificationBridge({
    sessionId: "log-failure", log: async () => { if (++calls === 1) throw new Error("Host unavailable"); },
  }, { home });
  t.after(() => { bridge.stop(); rmSync(home, { recursive: true, force: true }); });
  const { file } = bridge.manage("subscribe", "ci");
  createEventWriter(file, "ci-hound")({ events: [{ type: "JOB_FAILED" }] });
  await assert.rejects(bridge.poll(), /Host unavailable/);
  await bridge.poll(); await bridge.poll();
  assert.equal(calls, 2, "only the successful retry advances the shared watermark");
});

test("full-provider authority is session-local and unreadable authority fails closed", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "daemon-session-isolation-"));
  const logs = [];
  const full = createNotificationBridge({ sessionId: "other-session", log: async () => assert.fail("not opted in") },
    { home, provider: "full" });
  const standalone = createNotificationBridge({ sessionId: "this-session", log: async () => logs.push("standalone") }, { home });
  t.after(() => { full.stop(); standalone.stop(); rmSync(home, { recursive: true, force: true }); });
  const { file } = standalone.manage("subscribe", "ci");
  createEventWriter(file, "ci-hound")({ events: [{ type: "JOB_FAILED" }] });
  await standalone.poll(); await full.poll();
  assert.deepEqual(logs, ["standalone"]);
  const authority = join(home, "daemon-notifications", "this-session", "providers.json");
  const previous = readFileSync(authority, "utf8");
  writeFileSync(authority, "not json");
  try { await assert.rejects(standalone.poll(), SyntaxError); }
  finally { writeFileSync(authority, previous); }
  await standalone.poll();
  assert.equal(logs.length, 1, "failed authority reads never reset the replay watermark");
});

test("graceful stop renews pending log authority until delayed handover completes", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "daemon-delayed-stop-"));
  const timers = new Map(), logs = [];
  t.mock.method(globalThis, "setInterval", (callback) => {
    const handle = { unref() {} };
    timers.set(handle, callback);
    return handle;
  });
  t.mock.method(globalThis, "clearInterval", (handle) => timers.delete(handle));
  const entered = Promise.withResolvers(), finish = Promise.withResolvers();
  let time = 1000;
  const full = createNotificationBridge({
    sessionId: "delayed-stop", log: async () => { logs.push("full"); entered.resolve(); await finish.promise; },
  }, { home, provider: "full", now: () => time });
  const standalone = createNotificationBridge({
    sessionId: "delayed-stop", log: async () => logs.push("standalone"),
  }, { home, now: () => time });
  t.after(() => { finish.resolve(); full.stop(); standalone.stop(); rmSync(home, { recursive: true, force: true }); });
  const { file } = standalone.manage("subscribe", "ci");
  const emit = createEventWriter(file, "ci-hound");
  emit({ events: [{ type: "JOB_FAILED" }] });
  const running = full.poll();
  await entered.promise;
  full.stop();
  try {
    for (let tick = 0; tick < 4; tick++) {
      time += 5000;
      for (const callback of [...timers.values()]) await callback();
    }
    assert.deepEqual(logs, ["full"], "stop must not expire a still-running log's delivery authority");
  } finally { finish.resolve(); await running; }
  assert.equal(timers.size, 1, "the stopped provider releases its keepalive after logging settles");
  emit({ events: [{ type: "WORKFLOW_FAILED" }] });
  await standalone.poll();
  assert.deepEqual(logs, ["full", "standalone"]);
});
