// test/kit-runtime.test.mjs — unit tests for the kit runtime primitives added to
// enforce the Canvas SDK contract: JSON-schema input/state validation
// (validate.mjs + server.mjs wiring), the SSRF/egress guard (net.mjs), and the
// concurrency-safe durable store (storage.mjs). No deps; Node 18+.
// Run: node test/kit-runtime.test.mjs

import assert from "node:assert/strict";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const KIT = join(ROOT, "kit");
// Dynamic import() needs a file:// URL on Windows (a bare C:\ path is rejected).
const imp = (file) => import(pathToFileURL(join(KIT, file)).href);

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
async function throwsAsync(fn, re) {
  let threw = null;
  try { await fn(); } catch (e) { threw = e; }
  assert.ok(threw, "expected the call to throw");
  if (re) assert.match(String(threw.message), re);
  return threw;
}

async function main() {
  console.log("create-canvas-app kit runtime tests (validate / net / storage)");

  // ---- validate.mjs --------------------------------------------------------
  const { validate } = await imp("validate.mjs");

  await test("validate: a valid object passes", () => {
    const schema = { type: "object", properties: { a: { type: "string" } }, required: ["a"], additionalProperties: false };
    assert.deepEqual(validate(schema, { a: "hi" }), []);
  });

  await test("validate: missing required + wrong type + unknown prop are all reported", () => {
    const schema = { type: "object", properties: { a: { type: "string" }, n: { type: "number" } }, required: ["a"], additionalProperties: false };
    const errs = validate(schema, { n: "not-a-number", extra: 1 });
    assert.ok(errs.some((e) => /a: required/.test(e)));
    assert.ok(errs.some((e) => /n: expected number/.test(e)));
    assert.ok(errs.some((e) => /extra: unexpected property/.test(e)));
  });

  await test("validate: enum, integer, and array items", () => {
    assert.ok(validate({ enum: ["open", "done"] }, "nope").length === 1);
    assert.deepEqual(validate({ type: "integer" }, 3), []);
    assert.ok(validate({ type: "integer" }, 3.5).length === 1);
    assert.deepEqual(validate({ type: "array", items: { type: "string" } }, ["a", "b"]), []);
    assert.ok(validate({ type: "array", items: { type: "string" } }, ["a", 2]).length === 1);
  });

  await test("validate: bounds (minLength / minimum) and a permissive empty schema", () => {
    assert.ok(validate({ type: "string", minLength: 2 }, "x").length === 1);
    assert.ok(validate({ type: "number", minimum: 0 }, -1).length === 1);
    assert.deepEqual(validate(undefined, { anything: true }), []); // no schema = anything
  });

  await test("validate: an optional property explicitly set to undefined is treated as absent", () => {
    // { value, article } where `article` is an unset variable is idiomatic JS; over
    // a JSON boundary `undefined` is dropped, so the validator must NOT type-check it.
    const schema = {
      type: "object",
      properties: { value: { type: "string" }, article: { type: "object" } },
      required: ["value"],
      additionalProperties: false,
    };
    assert.deepEqual(validate(schema, { value: "up", article: undefined }), [], "undefined optional prop must pass");
    // A REQUIRED property explicitly set to undefined is still missing.
    assert.ok(validate(schema, { value: undefined }).some((e) => /value: required/.test(e)));
    // An UNKNOWN key set to undefined is not an unexpected property (it's absent).
    assert.deepEqual(validate(schema, { value: "up", bogus: undefined }), [], "undefined unknown key = absent");
  });

  await test("validate: prototype-named keys can't escape additionalProperties (in-operator hole)", () => {
    const schema = { type: "object", properties: { title: { type: "string" } }, additionalProperties: false };
    // These keys all exist on Object.prototype; `key in props` would treat them as
    // declared. Object.hasOwn must reject them as unexpected properties.
    for (const bad of ["toString", "constructor", "valueOf", "hasOwnProperty", "__proto__"]) {
      const errs = validate(schema, JSON.parse(`{"title":"ok","${bad}":1}`));
      assert.ok(errs.some((e) => e.includes(`${bad}: unexpected property`)), `${bad} must be rejected`);
    }
    // A prototype-named REQUIRED key that is absent must still be reported missing.
    assert.ok(validate({ type: "object", required: ["toString"] }, {}).some((e) => /toString: required/.test(e)));
    // An additionalProperties SUBSCHEMA must apply to a prototype-named extra key.
    assert.ok(validate({ type: "object", properties: {}, additionalProperties: { type: "number" } }, JSON.parse('{"toString":"x"}')).length === 1);
  });

  // ---- server.mjs: input + state validation --------------------------------
  const { createCanvasRuntime, CanvasKitError } = await imp("server.mjs");

  function makeRuntime() {
    return createCanvasRuntime({
      id: "t", displayName: "T", description: "", assetsDir: KIT,
      createInitialState: () => ({ count: 0 }),
      stateSchema: { type: "object", properties: { count: { type: "integer", minimum: 0 } }, required: ["count"], additionalProperties: false },
      actions: {
        set_count: {
          inputSchema: { type: "object", properties: { count: { type: "integer" } }, required: ["count"], additionalProperties: false },
          handler: ({ set, input }) => { set((s) => ({ ...s, count: input.count })); return { count: input.count }; },
        },
        // Same effect as set_count but MUTATES state in place (returns the same
        // object) — exercises the stateSchema rollback deep-snapshot path.
        set_count_inplace: {
          inputSchema: { type: "object", properties: { count: { type: "integer" } }, required: ["count"], additionalProperties: false },
          handler: ({ set, input }) => { set((s) => { s.count = input.count; return s; }); return { count: input.count }; },
        },
      },
    });
  }

  await test("runtime: valid action input passes and mutates state", async () => {
    const rt = makeRuntime();
    const res = await rt.invoke("set_count", { count: 5 }, { domainId: "d" });
    assert.equal(res.count, 5);
    assert.equal((await rt.getState("d")).count, 5);
  });

  await test("runtime: bad input type is rejected as invalid_input before the handler", async () => {
    const rt = makeRuntime();
    const err = await throwsAsync(() => rt.invoke("set_count", { count: "x" }, { domainId: "d" }), /Invalid input/);
    assert.ok(err instanceof CanvasKitError);
    assert.equal(err.code, "invalid_input");
    assert.equal((await rt.getState("d")).count, 0, "state must be untouched when input is rejected");
  });

  await test("runtime: unknown property is rejected (additionalProperties:false)", async () => {
    const rt = makeRuntime();
    const err = await throwsAsync(() => rt.invoke("set_count", { count: 1, bogus: 2 }, { domainId: "d" }));
    assert.equal(err.code, "invalid_input");
  });

  await test("runtime: a handler that produces invalid state is rolled back and fails", async () => {
    const rt = makeRuntime();
    await rt.invoke("set_count", { count: 3 }, { domainId: "d" }); // valid baseline
    // count = -1 violates stateSchema (minimum 0) -> rejected + rolled back.
    await throwsAsync(() => rt.invoke("set_count", { count: -1 }, { domainId: "d" }), /invalid state/);
    assert.equal((await rt.getState("d")).count, 3, "state must roll back to the last valid value");
  });

  await test("runtime: an IN-PLACE mutation that produces invalid state also rolls back", async () => {
    const rt = makeRuntime();
    await rt.invoke("set_count_inplace", { count: 3 }, { domainId: "d" }); // valid baseline
    // In-place mutation to -1 violates stateSchema. A reference-only snapshot would
    // point at the mutated object and "restore" the corrupt value; a deep snapshot
    // must bring count back to 3.
    await throwsAsync(() => rt.invoke("set_count_inplace", { count: -1 }, { domainId: "d" }), /invalid state/);
    assert.equal((await rt.getState("d")).count, 3, "in-place mutation must roll back to the last valid value");
  });

  // ---- net.mjs: SSRF / egress guard (offline; IP literals, no DNS) ---------
  const { isBlockedAddress, assertPublicUrl, safeFetch } = await imp("net.mjs");

  await test("net: isBlockedAddress flags loopback/link-local/private, allows public", () => {
    for (const ip of ["127.0.0.1", "169.254.169.254", "10.0.0.1", "192.168.1.1", "::1"]) {
      assert.equal(isBlockedAddress(ip), true, `${ip} should be blocked`);
    }
    assert.equal(isBlockedAddress("8.8.8.8"), false);
  });

  await test("net: assertPublicUrl blocks loopback/metadata/localhost/bad-scheme, allows a public IP", async () => {
    await throwsAsync(() => assertPublicUrl("http://127.0.0.1/"), /Blocked/);
    await throwsAsync(() => assertPublicUrl("http://169.254.169.254/"), /Blocked/);
    await throwsAsync(() => assertPublicUrl("http://localhost/"), /Blocked host/);
    await throwsAsync(() => assertPublicUrl("ftp://8.8.8.8/"), /protocol/);
    await assertPublicUrl("http://8.8.8.8/"); // public IP literal — resolves, no DNS, no fetch
  });

  await test("net: IPv4-mapped IPv6 (hex form new URL normalizes to) is still blocked", async () => {
    // new URL("http://[::ffff:127.0.0.1]/").hostname -> "[::ffff:7f00:1]"
    assert.equal(isBlockedAddress("::ffff:7f00:1"), true, "::ffff:7f00:1 = 127.0.0.1");
    assert.equal(isBlockedAddress("::ffff:a9fe:a9fe"), true, "::ffff:a9fe:a9fe = 169.254.169.254 (IMDS)");
    assert.equal(isBlockedAddress("::ffff:0808:0808"), false, "::ffff:8.8.8.8 is public");
    assert.equal(isBlockedAddress("2001:db8::7f00:1"), false, "a public v6 must NOT be misread as 127.0.0.1");
    // the full path through URL normalization must reject loopback + metadata:
    await throwsAsync(() => assertPublicUrl("http://[::ffff:127.0.0.1]/"), /Blocked/);
    await throwsAsync(() => assertPublicUrl("http://[::ffff:169.254.169.254]/latest/meta-data/"), /Blocked/);
  });

  await test("net: safeFetch refuses a blocked target before connecting", async () => {
    await throwsAsync(() => safeFetch("http://127.0.0.1:1/"), /Blocked/);
  });

  await test("net: safeFetch re-checks the guard on every redirect hop (no SSRF via 30x)", async () => {
    // A public host that 302-redirects to the metadata endpoint must NOT be chased.
    // Stub fetch to (a) assert we asked for manual redirects and (b) hand back a
    // 302 -> Location: link-local. safeFetch must re-run assertPublicUrl on the hop
    // and throw, and must have called fetch exactly once (never reached the target).
    const realFetch = globalThis.fetch;
    let calls = 0;
    let sawManual = false;
    globalThis.fetch = async (_url, opts) => {
      calls++;
      if (opts && opts.redirect === "manual") sawManual = true;
      return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } });
    };
    try {
      await throwsAsync(() => safeFetch("http://8.8.8.8/"), /Blocked/);
      assert.equal(sawManual, true, "safeFetch must request redirect:'manual'");
      assert.equal(calls, 1, "must not follow the redirect into blocked space");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  await test("net: safeFetch follows a redirect to another PUBLIC host and returns its response", async () => {
    const realFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async (url) => {
      calls++;
      if (calls === 1) return new Response(null, { status: 302, headers: { location: "http://9.9.9.9/final" } });
      return new Response("ok", { status: 200 });
    };
    try {
      const res = await safeFetch("http://8.8.8.8/");
      assert.equal(res.status, 200);
      assert.equal(calls, 2, "should have followed exactly one hop");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  // ---- storage.mjs: concurrency-safe save + tiers --------------------------
  const home = await mkdtemp(join(tmpdir(), "ck-storage-"));
  process.env.COPILOT_HOME = home;
  const { userStore, sessionStore } = await imp("storage.mjs");

  await test("storage: concurrent saves to one domain all resolve without EPERM and leave valid JSON", async () => {
    const store = userStore("concurrency-ext", "d.json");
    // Fire many saves at once — the old temp name (pid+ms) collided under this,
    // failing a rename with EPERM on Windows. Unique temp names must fix it.
    await Promise.all(Array.from({ length: 12 }, (_, i) => store.save({ n: i })));
    const loaded = await store.load();
    assert.ok(loaded && typeof loaded.n === "number", "final file is valid JSON");
    const dir = join(home, "extensions", "concurrency-ext", "artifacts");
    const leftover = (await readdir(dir)).filter((f) => f.endsWith(".tmp"));
    assert.deepEqual(leftover, [], "no orphaned .tmp files remain");
  });

  await test("storage: sessionStore is rooted under session-state/<id>/extensions/<name>", () => {
    const store = sessionStore("sess-123", "my-ext", "d.json");
    assert.match(store.file.replace(/\\/g, "/"), /session-state\/sess-123\/extensions\/my-ext\/d\.json$/);
  });

  await test("storage: sessionStore('..') can't escape the session-state root", () => {
    // ".." would otherwise join one level above session-state. The sanitizer must
    // collapse the dot-run so the resolved path stays inside session-state/.
    const store = sessionStore("..", "my-ext", "d.json");
    const root = resolve(join(home, "session-state"));
    assert.ok(
      resolve(store.file).startsWith(root + sep),
      `resolved path must stay under session-state (got ${store.file})`,
    );
  });

  await rm(home, { recursive: true, force: true });
  console.log(`\n${passed} checks passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
