// test/client.test.mjs — unit tests for the DOM-free canvas transport
// (connectCanvas in kit/client.mjs): the loopback wiring — initial /state fetch,
// SSE state pushes, connected flag, and POST /action invoke/errors — that used to
// be locked inside mountCanvas and only reachable through a real browser. Stubs
// global fetch and injects a fake EventSource, so no DOM/network is needed.
// No deps; Node 18+.  Run: node test/client.test.mjs

import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";

const KIT = join(fileURLToPath(new URL("..", import.meta.url)), "kit");
const { connectCanvas, CanvasActionError } = await import(pathToFileURL(join(KIT, "client.mjs")).href);

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(`FAIL  ${name}\n      ${e.stack || e.message}`);
    process.exitCode = 1;
    throw e;
  }
}
const flush = () => new Promise((r) => setImmediate(r));

// ---- test doubles ----------------------------------------------------------
// A fake EventSource: records the last instance so a test can drive its events.
class FakeES {
  constructor(url) {
    this.url = url;
    this.onmessage = null;
    this.onopen = null;
    this.onerror = null;
    FakeES.last = this;
  }
  message(data) { this.onmessage?.({ data: JSON.stringify(data) }); }
  raw(data) { this.onmessage?.({ data }); }
  open() { this.onopen?.(); }
  error() { this.onerror?.(); }
}

// A fetch stub for the two loopback endpoints the transport uses.
let stateBody;
let actionResponse;
let lastAction;
function installFetch() {
  lastAction = null;
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.endsWith("./state") || u.endsWith("/state")) {
      return { json: async () => stateBody };
    }
    if (u.endsWith("./action") || u.endsWith("/action")) {
      lastAction = JSON.parse(opts.body);
      return { json: async () => actionResponse };
    }
    throw new Error("unexpected fetch: " + u);
  };
}

const realFetch = globalThis.fetch;
try {
  console.log("create-canvas-app client transport tests (connectCanvas)");
  installFetch();

  // A single client drives the state/SSE tests; invoke error cases use fresh ones.
  stateBody = { items: ["a"], v: 1 };
  actionResponse = { ok: true, result: { done: true } };
  const states = [];
  const conns = [];
  const client = connectCanvas({
    EventSourceImpl: FakeES,
    onState: (s, c) => states.push({ s, c }),
    onConnected: (c) => conns.push(c),
  });

  await test("initial refresh fetches /state and fires onState", async () => {
    await flush();
    assert.deepEqual(client.state, { items: ["a"], v: 1 });
    assert.deepEqual(states.at(-1).s, { items: ["a"], v: 1 });
    assert.equal(client.connected, false, "no SSE open yet");
  });

  await test("an SSE message updates state and marks connected", () => {
    FakeES.last.message({ items: ["a", "b"], v: 2 });
    assert.deepEqual(client.state, { items: ["a", "b"], v: 2 });
    assert.equal(client.connected, true);
    assert.deepEqual(states.at(-1).s, { items: ["a", "b"], v: 2 });
    assert.equal(states.at(-1).c, true, "onState carries the connected flag");
  });

  await test("onopen/onerror flip connected and fire onConnected", () => {
    FakeES.last.error();
    assert.equal(client.connected, false);
    assert.equal(conns.at(-1), false);
    FakeES.last.open();
    assert.equal(client.connected, true);
    assert.equal(conns.at(-1), true);
  });

  await test("a malformed SSE frame is ignored (state unchanged, no throw)", () => {
    const before = client.state;
    FakeES.last.raw("{ not json");
    assert.equal(client.state, before, "state is untouched by a bad frame");
  });

  await test("invoke POSTs /action with the actionName + input and returns result", async () => {
    const r = await client.invoke("do_thing", { a: 1 });
    assert.deepEqual(r, { done: true });
    assert.deepEqual(lastAction, { actionName: "do_thing", input: { a: 1 } });
  });

  await test("invoke defaults missing input to {}", async () => {
    actionResponse = { ok: true, result: 5 };
    await client.invoke("no_input");
    assert.deepEqual(lastAction.input, {});
  });

  await test("invoke rejects with CanvasActionError on { ok:false }", async () => {
    actionResponse = { ok: false, code: "invalid_input", message: "nope" };
    await assert.rejects(
      () => client.invoke("bad"),
      (e) => e instanceof CanvasActionError && e.code === "invalid_input" && /nope/.test(e.message),
    );
  });

  await test("connectCanvas without an EventSource still refreshes (no throw)", async () => {
    stateBody = { ok: true };
    const only = [];
    const c2 = connectCanvas({ EventSourceImpl: null, onState: (s) => only.push(s) });
    await flush();
    assert.deepEqual(c2.state, { ok: true }, "refresh works without SSE");
    assert.equal(c2.connected, false);
    assert.equal(only.length, 1);
  });
} finally {
  globalThis.fetch = realFetch;
}

console.log(`\n${passed} checks passed`);
