import assert from "node:assert/strict";
import test from "node:test";
import { actorFor, createProgressEventGate, readSessionSources, progressInputSchema } from "../runtime/host.mjs";
import { acquireProvider } from "../runtime/provider.mjs";
import { validate } from "../runtime/canvas-kit/validate.mjs";
import { createProgressService } from "../runtime/progress.mjs";

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
