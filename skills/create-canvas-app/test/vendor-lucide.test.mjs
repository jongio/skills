// test/vendor-lucide.test.mjs — offline checks for scripts/vendor-lucide.mjs, the
// generator that rebuilds kit/vendor/lucide.mjs from a lucide-react install.
//
// Network installs are out of scope here: we feed the generator a tiny synthetic
// dist/esm/icons dir and assert the contract (sorting, key-strip, attr order,
// alias mapping, index-barrel exclusion, deterministic byte output, importable
// result). The byte-fidelity-vs-real-lucide guarantee is exercised by running the
// CLI against a pinned install during a sync; this test guards the pure logic.
//
// Run: node test/vendor-lucide.test.mjs

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const { generateIconData, renderVendorFile, assertSafeVersion } = await import("../scripts/vendor-lucide.mjs");

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

// A canonical lucide icon module defines `__iconNode` (attrs carry a `key` the
// vendor file strips); an alias module re-exports from a canonical `.mjs`; the
// `index.mjs` barrel re-exports everything and must be ignored, not aliased.
function canonicalModule(node) {
  return `const __iconNode = ${JSON.stringify(node)};\nexport { __iconNode };\nexport default {};\n`;
}
function aliasModule(canon) {
  return `export { default } from './${canon}.mjs';\n`;
}

async function main() {
  console.log("vendor-lucide generator tests");

  const dir = await mkdtemp(join(tmpdir(), "vendor-lucide-test-"));
  try {
    // circle written before apple on disk to prove output is sorted, not insertion-order.
    await writeFile(join(dir, "circle.mjs"), canonicalModule([["circle", { cx: "12", cy: "12", r: "10", key: "k1" }]]));
    await writeFile(join(dir, "apple.mjs"), canonicalModule([["path", { d: "M1 1", key: "k2" }], ["path", { d: "M2 2", key: "k3" }]]));
    await writeFile(join(dir, "circle-dot.mjs"), aliasModule("circle"));
    await writeFile(join(dir, "index.mjs"), `export { default as Circle } from './circle.mjs';\nexport { default as Apple } from './apple.mjs';\n`);
    // a sourcemap must be ignored entirely
    await writeFile(join(dir, "circle.mjs.map"), `{"version":3}`);

    const data = await generateIconData(dir);

    await test("canonical icons are sorted lexicographically", () => {
      assert.deepEqual(Object.keys(data.icons), ["apple", "circle"]);
    });

    await test("the lucide `key` attr is stripped, source attr order preserved", () => {
      assert.deepEqual(data.icons.circle, [["circle", { cx: "12", cy: "12", r: "10" }]]);
      assert.deepEqual(data.icons.apple, [["path", { d: "M1 1" }], ["path", { d: "M2 2" }]]);
    });

    await test("alias module maps to its canonical icon", () => {
      assert.deepEqual(data.aliases, { "circle-dot": "circle" });
    });

    await test("index.mjs barrel is excluded from icons and aliases", () => {
      assert.ok(!("index" in data.icons), "index must not be an icon");
      assert.ok(!("index" in data.aliases), "index must not be an alias");
    });

    await test("render is deterministic — same input yields identical bytes", () => {
      const a = renderVendorFile(data, "9.9.9");
      const b = renderVendorFile(data, "9.9.9");
      assert.equal(a, b);
    });

    await test("rendered file has the stamped header, compact JSON, trailing newline", () => {
      const src = renderVendorFile(data, "1.21.0");
      assert.match(src, /^\/\/ AUTO-GENERATED\. Do not edit by hand\.\n/);
      assert.match(src, /lucide-react@1\.21\.0/);
      assert.ok(!src.includes("\n  "), "JSON should be compact (no pretty-print indentation)");
      assert.ok(src.endsWith("\n"), "file must end with a trailing newline");
    });

    await test("rendered module is importable and round-trips the icon data", async () => {
      const out = join(dir, "out.mjs");
      await writeFile(out, renderVendorFile(data, "1.21.0"));
      const mod = await import(pathToFileURL(out).href);
      assert.deepEqual(mod.default.circle, [["circle", { cx: "12", cy: "12", r: "10" }]]);
      assert.equal(mod.aliases["circle-dot"], "circle");
    });

    await test("assertSafeVersion accepts semver, rejects shell-injection input", () => {
      for (const ok of ["1.21.0", "1.0.0", "1.21.0-beta.1", "10.2.3-rc.0"]) {
        assert.doesNotThrow(() => assertSafeVersion(ok), `should accept ${ok}`);
      }
      for (const bad of ["1.21.0 & calc", "1.21.0; rm -rf /", "$(whoami)", "1.21.0|x", "latest", "../evil", ""]) {
        assert.throws(() => assertSafeVersion(bad), /invalid lucide-react version/, `should reject ${JSON.stringify(bad)}`);
      }
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  console.log(`\n${passed} checks passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
