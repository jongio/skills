import assert from "node:assert/strict";
import test from "node:test";
import { createProgressService } from "../runtime/progress.mjs";
import { createProgressCanvas } from "../runtime/canvas.mjs";
import { createCanvasRuntime } from "../runtime/canvas-kit/server.mjs";

test("real HTTP/SSE publishes reports to multiple panels without exposing task writes", async (t) => {
  let runtime;
  const service = await createProgressService({
    sessionId: "http-session",
    store: { load: async () => null, save: async () => {} },
    readSources: async () => ({ plan: { exists: true, content: "Plan" }, rows: [{ id: "a", title: "Test", status: "pending" }], dependencies: [] }),
    onChange: async () => { if (runtime) await runtime.invoke("get_status", {}, { domainId: "http-session" }); },
  });
  runtime = createCanvasRuntime(createProgressCanvas(service, "http-session"));
  t.after(() => runtime.shutdown());
  await service.refresh();
  await service.update({ action: "goal", goalId: "g", title: "Goal", taskIds: ["a"] }, { id: "primary", primary: true });
  const one = await runtime.openInstance({ instanceId: "one", input: {}, ctx: { sessionId: "http-session" } });
  const two = await runtime.openInstance({ instanceId: "two", input: {}, ctx: { sessionId: "http-session" } });
  const endpoint = (path, base) => {
    const url = new URL(path, base);
    url.search = new URL(base).search;
    return url;
  };
  assert.equal((await fetch(new URL("state", one.url))).status, 403);
  const controller = new AbortController();
  const stream = await fetch(endpoint("events", one.url), { signal: controller.signal });
  const reader = stream.body.getReader();
  t.after(async () => { controller.abort(); await reader.cancel().catch(() => {}); });
  await reader.read();
  await service.update({ action: "report", updateId: "r", taskId: "a", status: "blocked", message: "Need access", sequence: 1 }, { id: "worker", primary: false });
  const pushed = new TextDecoder().decode((await reader.read()).value);
  assert.match(pushed, /Need access/);
  const state = await fetch(endpoint("state", two.url)).then((r) => r.json());
  assert.equal(state.tasks[0].status, "pending");
  assert.equal(state.reports[0].status, "blocked");
  const response = await fetch(endpoint("action", one.url), { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ actionName: "report", input: { status: "done" } }) });
  assert.equal(response.status, 400);
  await assert.rejects(runtime.openInstance({ instanceId: "foreign", input: {}, ctx: { sessionId: "other" } }), /Cross-session/);
  await runtime.closeInstance("one");
  const reopened = await runtime.openInstance({ instanceId: "one", input: {}, ctx: { sessionId: "http-session" } });
  assert.equal((await fetch(endpoint("state", reopened.url)).then((r) => r.json())).reports.length, 1);
});
