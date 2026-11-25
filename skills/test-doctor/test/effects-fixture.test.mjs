import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const fixture = fileURLToPath(new URL("../evals/test-doctor/fixtures/effects/", import.meta.url));
const oracle = fileURLToPath(new URL("./oracles/effects.mjs", import.meta.url));
const evalSpec = readFileSync(new URL("../evals/test-doctor/eval.yaml", import.meta.url), "utf8").replace(/\r\n/g, "\n");

function graderScript(name) {
  const lines = evalSpec.split("\n");
  const start = lines.findIndex((line) => line.trim() === `name: ${name}`);
  assert.notEqual(start, -1, name);
  const block = lines.findIndex((line, index) => index > start && line.trim() === "- |");
  const indent = lines[block + 1].match(/^ */)[0].length;
  const body = [];
  for (const line of lines.slice(block + 1)) {
    if (line.trim() && line.match(/^ */)[0].length < indent) break;
    body.push(line.slice(indent));
  }
  return body.join("\n");
}

function workspace(setup = () => {}) {
  const dir = mkdtempSync(join(tmpdir(), "test-doctor-effects-"));
  cpSync(fixture, dir, { recursive: true });
  setup(dir);
  return dir;
}

function grade(name, dir, transform = (script) => script) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  try {
    return spawnSync(process.execPath, ["-e", transform(graderScript(name))], { cwd: dir, env, encoding: "utf8", timeout: 300_000 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const withOracle = (dir) => copyFileSync(oracle, join(dir, "test", "oracle.test.mjs"));
const mutants = [
  "concurrent-reserve",
  "error-after-dispatch-not-sent",
  "unknown-released",
  "rejection-erases-unknown",
  "fallback-after-dispatch",
  "cancel-as-not-sent",
  "audit-failure-releases",
  "not-sent-retained",
];

test("the original green effects tests miss every seeded mutant", () => {
  const result = grade("effects-seeded-mutants-killed", workspace());
  assert.equal(result.status, 1, result.stdout + result.stderr);
  for (const mutant of mutants) assert.match(result.stdout, new RegExp(`^survived ${mutant}$`, "m"));
  assert.match(result.stdout, /killed 0\/8 seeded mutants/);
});

test("contract tests for traced effect paths kill every seeded mutant", () => {
  const result = grade("effects-seeded-mutants-killed", workspace(withOracle));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  for (const mutant of mutants) assert.match(result.stdout, new RegExp(`^killed ${mutant}$`, "m"));
  assert.match(result.stdout, /killed 8\/8 seeded mutants/);
});

test("the mutant grader rejects production edits", () => {
  const result = grade("effects-seeded-mutants-killed", workspace((dir) => {
    withOracle(dir);
    const file = join(dir, "src", "transport.mjs");
    writeFileSync(file, readFileSync(file, "utf8").replace('return "unknown";', 'return "unknown"; // edited'));
  }));
  assert.equal(result.status, 1);
  assert.match(result.stdout, /protected file changed: src\/transport\.mjs/);
});

test("the mutant grader fails when a test process cannot start", () => {
  const result = grade("effects-seeded-mutants-killed", workspace(), (script) => {
    const updated = script.replace('cwd: dir, env, encoding: "utf8", timeout: 30000', 'cwd: path.join(dir, "missing"), env, encoding: "utf8", timeout: 30000');
    assert.notEqual(updated, script, "expected to find the test-process spawn call");
    return updated;
  });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /FAIL pristine test process did not complete/);
  assert.doesNotMatch(result.stdout, /killed \d+\/8 seeded mutants/);
});

test("the read-only control accepts report tests and rejects out-of-scope effect tests", () => {
  const reportOnly = grade("report-scope-stays-read-only", workspace((dir) => {
    mkdirSync(join(dir, "test", "unit"));
    writeFileSync(join(dir, "test", "unit", "report-edge.test.mjs"), [
      'import assert from "node:assert/strict";',
      'import test from "node:test";',
      'import { summarize } from "../../src/report.mjs";',
      'import { VoucherStore } from "../../src/vouchers.mjs";',
      'test("empty input lists no redeemed or uncertain vouchers", () => assert.equal(summarize(new VoucherStore(), []), ""));',
      "",
    ].join("\n"));
  }));
  assert.equal(reportOnly.status, 0, reportOnly.stdout + reportOnly.stderr);

  const scopeCreep = grade("report-scope-stays-read-only", workspace(withOracle));
  assert.equal(scopeCreep.status, 1);
  assert.match(scopeCreep.stdout, /effect tests added outside the requested scope: test[\\/]oracle\.test\.mjs/);
});
