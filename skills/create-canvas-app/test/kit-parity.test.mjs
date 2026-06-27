// test/kit-parity.test.mjs — the canonical kit/ and the copy bundled inside the
// reference extension (reference/decision-log/canvas-kit/) must be byte-identical.
//
// The repo ships the kit twice on purpose: kit/ is the source of truth users copy
// into their own extension, and reference/decision-log/canvas-kit/ shows the real
// installed shape. This test guarantees they never silently drift.
//
// Run: node test/kit-parity.test.mjs

import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const A = join(ROOT, "kit");
const B = join(ROOT, "reference", "decision-log", "canvas-kit");

async function walk(dir) {
  const out = [];
  for (const ent of await readdir(dir, { withFileTypes: true })) {
    const abs = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...(await walk(abs)));
    else out.push(abs);
  }
  return out.sort();
}

// scripts/sync-kit.mjs records the synced kit version in this out-of-band marker.
// It is metadata, not a kit file, so it is excluded from the byte-parity contract.
const VERSION_MARKER = ".kit-version.json";

let passed = 0;
async function test(name, fn) {
  await fn();
  passed++;
  console.log(`  ok  ${name}`);
}

async function main() {
  console.log("kit/ <-> reference canvas-kit/ parity");

  const aRaw = (await walk(A)).map((p) => relative(A, p).replace(/\\/g, "/"));
  const bRaw = (await walk(B)).map((p) => relative(B, p).replace(/\\/g, "/"));

  await test("canonical kit/ does not contain the vendored-only version marker", () => {
    assert.ok(!aRaw.includes(VERSION_MARKER), `kit/ must not contain ${VERSION_MARKER} (it belongs only in vendored copies)`);
  });

  const aFiles = aRaw.filter((f) => f !== VERSION_MARKER);
  const bFiles = bRaw.filter((f) => f !== VERSION_MARKER);

  await test("same file list in both kit copies", () => {
    assert.deepEqual(aFiles, bFiles);
  });

  await test("version.mjs is part of the kit and exports KIT_VERSION", async () => {
    assert.ok(aFiles.includes("version.mjs"), "kit/version.mjs must exist");
    assert.ok(bFiles.includes("version.mjs"), "reference canvas-kit/version.mjs must exist");
    const { KIT_VERSION } = await import(new URL("../kit/version.mjs", import.meta.url));
    assert.equal(typeof KIT_VERSION, "string");
    assert.ok(KIT_VERSION.length > 0, "KIT_VERSION must be a non-empty string");
  });

  for (const rel of aFiles) {
    await test(`identical contents: ${rel}`, async () => {
      const [a, b] = await Promise.all([
        readFile(join(A, rel)),
        readFile(join(B, rel)),
      ]);
      assert.ok(a.equals(b), `${rel} differs between kit/ and reference canvas-kit/`);
    });
  }

  console.log(`\n${passed} checks passed`);
}

main().catch((e) => {
  console.error(`FAIL  ${e.message}`);
  process.exit(1);
});
