import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { shippingCost } from "../evals/test-doctor/fixtures/shipping/shipping.mjs";

const fixture = fileURLToPath(new URL("../evals/test-doctor/fixtures/shipping/", import.meta.url));
const source = await readFile(path.join(fixture, "shipping.mjs"), "utf8");
const preciseTests = `
import assert from "node:assert/strict";
import test from "node:test";
import { shippingCost } from "../shipping.mjs";
test("documented shipping contracts", () => {
  assert.equal(shippingCost(0), 10);
  assert.equal(shippingCost(20), 10);
  assert.equal(shippingCost(99.99), 10);
  assert.equal(shippingCost(100), 0);
  assert.equal(shippingCost(120), 0);
  for (const invalid of [-1, NaN, Infinity, "20", null, undefined]) {
    assert.throws(() => shippingCost(invalid), RangeError);
  }
});
`;

async function runFixture(t, changedSource, tests) {
  const directory = await mkdtemp(path.join(tmpdir(), "test-doctor-fixture-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await cp(fixture, directory, { recursive: true });
  await writeFile(path.join(directory, "shipping.mjs"), changedSource);
  if (tests) await writeFile(path.join(directory, "test", "shipping.test.mjs"), tests);
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ["--test", "test/shipping.test.mjs"], {
    cwd: directory,
    env: environment,
    encoding: "utf8",
    timeout: 30_000,
    windowsHide: true,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null, result.stderr);
  return result;
}

test("fixture implementation independently satisfies the README contract", () => {
  for (const [subtotal, fee] of [[0, 10], [20, 10], [99.99, 10], [100, 0], [120, 0]]) {
    assert.equal(shippingCost(subtotal), fee);
  }
  for (const invalid of [-1, NaN, Infinity, "20", null, undefined]) {
    assert.throws(() => shippingCost(invalid), RangeError);
  }
});

test("fixture's existing tests pass despite missing meaningful protection", async (t) => {
  const result = await runFixture(t, source);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /charges standard shipping/);
  assert.match(result.stdout, /ships large orders free/);
});

test("fixture truthiness assertion fails to detect an incorrect fee", async (t) => {
  const mutant = source.replace("? 0 : 10", "? 0 : 11");
  assert.notEqual(mutant, source);
  const result = await runFixture(t, mutant);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("independent contract assertions pass against the correct implementation", async (t) => {
  const result = await runFixture(t, source, preciseTests);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /documented shipping contracts/);
});

test("independent contract assertions detect fee, cutoff, and validation regressions", async (t) => {
  const mutants = {
    fee: source.replace("? 0 : 10", "? 0 : 11"),
    cutoff: source.replace("subtotal >= 100", "subtotal > 100"),
    validation: source.replace('throw new RangeError("subtotal must be finite and nonnegative");', "return 10;"),
  };
  for (const [name, mutant] of Object.entries(mutants)) {
    await t.test(name, async (t) => {
      assert.notEqual(mutant, source);
      const result = await runFixture(t, mutant, preciseTests);
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.match(result.stdout + result.stderr, /AssertionError|ERR_ASSERTION/);
    });
  }
});
