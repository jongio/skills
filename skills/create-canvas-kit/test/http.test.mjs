// test/http.test.mjs — standalone harness for the kit runtime (no SDK, no CLI).
//
// Boots the decision-log canvas's runtime directly and drives it over real HTTP
// the same way the canvas iframe would. Run: node test/http.test.mjs

import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(`FAIL  ${name}\n      ${e.message}`);
    process.exitCode = 1;
    throw e;
  }
}

function get(url, path) {
  return fetch(new URL(path, url)).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
}
function action(url, actionName, input) {
  return fetch(new URL("/action", url), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ actionName, input }),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
}

// Minimal SSE reader (avoids depending on a global EventSource).
function openSSE(url) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const frames = [];
    let buf = "";
    const req = http.get(
      { hostname: u.hostname, port: u.port, path: "/events", headers: { Accept: "text/event-stream" } },
      (res) => {
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          buf += chunk;
          let idx;
          while ((idx = buf.indexOf("\n\n")) >= 0) {
            const raw = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const line = raw.split("\n").find((l) => l.startsWith("data:"));
            if (line) {
              try { frames.push(JSON.parse(line.slice(5).trim())); } catch {}
            }
          }
        });
        resolve({ frames, close: () => req.destroy() });
      }
    );
  });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // Isolate durable storage to a temp COPILOT_HOME *before* importing canvas.mjs.
  const home = await mkdtemp(join(tmpdir(), "ck-test-"));
  process.env.COPILOT_HOME = home;

  const { canvasConfig } = await import("../reference/decision-log/canvas.mjs");
  const { createCanvasRuntime } = await import("../reference/decision-log/canvas-kit/server.mjs");

  const runtime = createCanvasRuntime(canvasConfig);

  console.log("decision-log kit runtime — standalone HTTP tests");

  const open = await runtime.openInstance({ instanceId: "inst-1", input: {}, ctx: { instanceId: "inst-1", input: {} } });

  await test("openInstance returns a loopback url + title + status", () => {
    assert.match(open.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    assert.equal(open.title, "Decision Log");
    assert.match(open.status, /0 decisions/);
  });

  await test("GET /state starts empty", async () => {
    const { status, body } = await get(open.url, "/state");
    assert.equal(status, 200);
    assert.deepEqual(body.decisions, []);
  });

  await test("GET / serves the canvas html shell", async () => {
    const res = await fetch(new URL("/", open.url));
    const text = await res.text();
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/html/);
    assert.match(text, /id="app"/);
  });

  await test("GET /kit/client.mjs serves the kit runtime", async () => {
    const res = await fetch(new URL("/kit/client.mjs", open.url));
    const text = await res.text();
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /javascript/);
    assert.match(text, /mountCanvas/);
  });

  await test("GET /kit/vendor/preact-htm-standalone.mjs serves vendored preact+htm", async () => {
    const res = await fetch(new URL("/kit/vendor/preact-htm-standalone.mjs", open.url));
    assert.equal(res.status, 200);
    assert.match(await res.text(), /export\{/);
  });

  await test("GET /kit/icons.mjs + vendored Lucide set serve offline", async () => {
    const icons = await fetch(new URL("/kit/icons.mjs", open.url));
    assert.equal(icons.status, 200);
    assert.match(await icons.text(), /export function Icon/);
    const data = await fetch(new URL("/kit/vendor/lucide.mjs", open.url));
    assert.equal(data.status, 200);
    const body = await data.text();
    assert.match(body, /export default/);
    // a few must-have Lucide names are present in the vendored data
    for (const name of ["plus", "trash-2", "circle-check", "list-todo"]) {
      assert.ok(body.includes(`"${name}":`), `missing icon ${name}`);
    }
  });

  let newId;
  await test("POST /action add_decision mutates shared state", async () => {
    const { status, body } = await action(open.url, "add_decision", { title: "Use Preact + htm", note: "no build" });
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    newId = body.result.id;
    assert.ok(newId);
    const after = await get(open.url, "/state");
    assert.equal(after.body.decisions.length, 1);
    assert.equal(after.body.decisions[0].title, "Use Preact + htm");
    assert.equal(after.body.decisions[0].status, "open");
  });

  await test("state persists durably to user artifacts", async () => {
    const file = join(home, "extensions", "decision-log", "artifacts", "default.json");
    const saved = JSON.parse(await readFile(file, "utf8"));
    assert.equal(saved.decisions.length, 1);
    assert.equal(saved.decisions[0].title, "Use Preact + htm");
  });

  await test("SSE pushes the latest state on action", async () => {
    const sse = await openSSE(open.url);
    await wait(80); // initial snapshot frame
    assert.ok(sse.frames.length >= 1, "expected initial snapshot frame");
    await action(open.url, "set_status", { id: newId, status: "decided" });
    await wait(120);
    const last = sse.frames.at(-1);
    assert.equal(last.decisions[0].status, "decided");
    sse.close();
  });

  await test("set_note, list_decisions, remove_decision work", async () => {
    await action(open.url, "set_note", { id: newId, note: "vendored, offline" });
    const list = await action(open.url, "list_decisions", {});
    assert.match(list.body.result.summary, /Use Preact \+ htm/);
    assert.equal(list.body.result.count, 1);
    const rm = await action(open.url, "remove_decision", { id: newId });
    assert.equal(rm.body.result.removed, 1);
    const after = await get(open.url, "/state");
    assert.equal(after.body.decisions.length, 0);
  });

  await test("unknown action returns a 400 with a code", async () => {
    const { status, body } = await action(open.url, "does_not_exist", {});
    assert.equal(status, 400);
    assert.equal(body.ok, false);
    assert.equal(body.code, "unknown_action");
  });

  await test("handler validation error surfaces as 500-ish failure", async () => {
    const { body } = await action(open.url, "add_decision", { title: "   " });
    assert.equal(body.ok, false);
    assert.match(body.message, /title is required/);
  });

  await test("domains are isolated (domain=feature-x vs default)", async () => {
    const open2 = await runtime.openInstance({
      instanceId: "inst-2",
      input: { domain: "feature-x" },
      ctx: { instanceId: "inst-2", input: { domain: "feature-x" } },
    });
    await action(open2.url, "add_decision", { title: "isolated decision" });
    const a = await get(open.url, "/state");   // default domain — emptied above
    const b = await get(open2.url, "/state");  // feature-x domain
    assert.equal(a.body.decisions.length, 0);
    assert.equal(b.body.decisions.length, 1);
    assert.equal(b.body.decisions[0].title, "isolated decision");
  });

  await test("path traversal is rejected", async () => {
    const res = await fetch(new URL("/..%2f..%2fcanvas.mjs", open.url));
    assert.ok(res.status === 403 || res.status === 404, `expected 403/404, got ${res.status}`);
  });

  await runtime.shutdown();
  await rm(home, { recursive: true, force: true });
  console.log(`\n${passed} checks passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
