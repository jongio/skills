// test/tooling.test.mjs — exercises the kit maintenance tooling: the version
// stamp, scripts/sync-kit.mjs (copy + record version), and
// scripts/check-kit-freshness.mjs (offline drift gate). No deps; Node 18+.
// Run:  node test/tooling.test.mjs

import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const KIT = join(ROOT, "kit");
const SYNC = join(ROOT, "scripts", "sync-kit.mjs");
const FRESH = join(ROOT, "scripts", "check-kit-freshness.mjs");

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

function run(args, cwd) {
  return spawnSync(process.execPath, args, { cwd, encoding: "utf8" });
}

async function walk(dir) {
  const out = [];
  for (const ent of await readdir(dir, { withFileTypes: true })) {
    const abs = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...(await walk(abs)));
    else out.push(abs);
  }
  return out.sort();
}
async function relFiles(dir) {
  return (await walk(dir)).map((p) => relative(dir, p).replace(/\\/g, "/")).sort();
}
async function exists(p) {
  try { await stat(p); return true; } catch { return false; }
}

async function main() {
  console.log("create-canvas-kit kit tooling tests");

  const { KIT_VERSION } = await import("../kit/version.mjs");
  const { VERSION_MARKER, syncKit } = await import("../scripts/sync-kit.mjs");

  await test("version.mjs exports a non-empty KIT_VERSION", () => {
    assert.equal(typeof KIT_VERSION, "string");
    assert.ok(KIT_VERSION.length > 0);
  });

  await test("client.mjs re-exports KIT_VERSION", async () => {
    const client = await import("../kit/client.mjs");
    assert.equal(client.KIT_VERSION, KIT_VERSION);
  });

  const work = await mkdtemp(join(tmpdir(), "ck-tooling-"));
  try {
    const extDir = join(work, "my-ext");

    // ---- sync-kit (CLI) ----------------------------------------------------
    await test("sync-kit CLI copies kit/ into <dir>/canvas-kit and records version", async () => {
      const out = run([SYNC, extDir], work);
      assert.equal(out.status, 0, out.stderr || out.stdout);

      const dest = join(extDir, "canvas-kit");
      // every kit file is present and byte-identical
      const kitFiles = await relFiles(KIT);
      for (const f of kitFiles) {
        const [a, b] = await Promise.all([readFile(join(KIT, f)), readFile(join(dest, f))]);
        assert.ok(a.equals(b), `synced ${f} differs from kit/`);
      }
      // the marker is written with the current version
      const marker = JSON.parse(await readFile(join(dest, VERSION_MARKER), "utf8"));
      assert.equal(marker.version, KIT_VERSION);
      assert.ok(marker.syncedAt, "marker should record syncedAt");
    });

    // ---- freshness: fresh = pass ------------------------------------------
    await test("check-kit-freshness passes on a freshly synced dir (exit 0)", () => {
      const out = run([FRESH, extDir], work);
      assert.equal(out.status, 0, out.stderr || out.stdout);
      assert.match(out.stdout, /fresh/i);
    });

    await test("check-kit-freshness also accepts an extensions parent dir", () => {
      const out = run([FRESH, work], work); // work/ holds my-ext/canvas-kit
      assert.equal(out.status, 0, out.stderr || out.stdout);
    });

    // ---- freshness: content drift = fail ----------------------------------
    await test("freshness FAILS when a vendored kit file is hand-edited (exit 1)", async () => {
      const f = join(extDir, "canvas-kit", "format.mjs");
      await writeFile(f, (await readFile(f, "utf8")) + "\n// drift\n", "utf8");
      const out = run([FRESH, extDir], work);
      assert.equal(out.status, 1, "expected non-zero exit on content drift");
      assert.match(out.stderr, /content differs/i);
    });

    // ---- freshness: version drift = fail ----------------------------------
    await test("freshness FAILS when the recorded version is stale (exit 1)", async () => {
      // re-sync to clean content, then corrupt only the version marker
      run([SYNC, extDir], work);
      const markerPath = join(extDir, "canvas-kit", VERSION_MARKER);
      const m = JSON.parse(await readFile(markerPath, "utf8"));
      m.version = "0000-00-00";
      await writeFile(markerPath, JSON.stringify(m, null, 2) + "\n", "utf8");
      const out = run([FRESH, extDir], work);
      assert.equal(out.status, 1, "expected non-zero exit on version drift");
      assert.match(out.stderr, /version drift/i);
    });

    // ---- freshness: missing marker = fail ---------------------------------
    await test("freshness FAILS when the version marker is missing (exit 1)", async () => {
      run([SYNC, extDir], work);
      await rm(join(extDir, "canvas-kit", VERSION_MARKER));
      const out = run([FRESH, extDir], work);
      assert.equal(out.status, 1, "expected non-zero exit when marker missing");
      assert.match(out.stderr, /missing .*kit-version/i);
    });

    // ---- freshness: corrupt marker = fail (distinct from missing) ----------
    await test("freshness FAILS with 'invalid' when the marker is corrupt JSON (exit 1)", async () => {
      run([SYNC, extDir], work);
      await writeFile(join(extDir, "canvas-kit", VERSION_MARKER), "{ not json", "utf8");
      const out = run([FRESH, extDir], work);
      assert.equal(out.status, 1, "expected non-zero exit on corrupt marker");
      assert.match(out.stderr, /invalid .*kit-version/i);
    });

    // ---- sync prunes stale extras so a re-sync repairs extra-file drift ----
    await test("sync-kit prunes stale extras; re-sync brings extra-file drift back to green", async () => {
      run([SYNC, extDir], work);
      const stray = join(extDir, "canvas-kit", "stale.mjs");
      await writeFile(stray, "// stale\n", "utf8");
      let out = run([FRESH, extDir], work);
      assert.equal(out.status, 1, "an extra vendored file should be drift");
      assert.match(out.stderr, /unexpected extra file/i);
      run([SYNC, extDir], work); // re-sync prunes the stray file
      assert.equal(await exists(stray), false, "sync should prune the stale file");
      out = run([FRESH, extDir], work);
      assert.equal(out.status, 0, out.stderr || out.stdout);
    });

    // ---- freshness: a bad/typo path fails loudly (not a silent green) ------
    await test("freshness FAILS on a non-existent path (exit 1)", () => {
      const out = run([FRESH, join(work, "does-not-exist")], work);
      assert.equal(out.status, 1, "a bad path must not silently pass the gate");
    });

    // ---- syncKit() importable API -----------------------------------------
    await test("syncKit() returns the dest + version and is idempotent", async () => {
      const ext2 = join(work, "ext2");
      const res = await syncKit(ext2);
      assert.equal(res.version, KIT_VERSION);
      assert.ok(await exists(join(ext2, "canvas-kit", "server.mjs")));
      assert.ok(await exists(join(ext2, "canvas-kit", VERSION_MARKER)));
    });
  } finally {
    await rm(work, { recursive: true, force: true });
  }

  console.log(`\n${passed} checks passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
