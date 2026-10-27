import assert from "node:assert/strict";
import test from "node:test";
import { actorFor, readSessionSources } from "../runtime/host.mjs";
import { acquireProvider } from "../runtime/provider.mjs";

test("runtime caller attribution cannot be replaced with input actor/session IDs", () => {
  assert.deepEqual(actorFor({ sessionId: "s", agentId: undefined }, "s"), { id: "primary", primary: true });
  assert.deepEqual(actorFor({ sessionId: "s", agentId: "worker" }, "s"), { id: "worker", primary: false });
  assert.throws(() => actorFor({ sessionId: "other", agentId: undefined }, "s"), /Cross-session/);
  assert.throws(() => actorFor({ sessionId: "s" }, "s"), /attribution unavailable/);
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
