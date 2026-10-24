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
  assert.equal(existsSync(join(home, "daemon-notifications")), false);
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
