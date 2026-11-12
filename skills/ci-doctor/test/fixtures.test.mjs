import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const root = new URL("../evals/ci-doctor/", import.meta.url);
const expected = [
  "etag-status-and-degraded-telemetry",
  "delivery-routing-go-vs-pr",
  "workflow-hardening-and-right-sizing",
];
const spec = (await readFile(new URL("eval.yaml", root), "utf8")).replace(/\r\n/g, "\n");

test("every synthetic ci-doctor scenario has a staged fixture, mandatory CI guard prefixes, and decisive rubric", async () => {
  const cases = spec.split(/^  - name: /m).slice(1);
  assert.deepEqual(
    cases.map((block) => block.split("\n")[0]),
    expected,
  );
  const graders = [...spec.matchAll(/^        name: (.+)$/gm)].map(([, name]) => name);
  assert.equal(graders.length, expected.length * 4);
  assert.equal(new Set(graders).size, graders.length, "grader names must be globally unique");

  const files = (await readdir(new URL("fixtures/", root))).sort();
  assert.deepEqual(files, expected.map((name) => `${name}.md`).sort());

  for (const block of cases) {
    const name = block.split("\n")[0];
    assert.ok(block.includes(`src: fixtures/${name}.md`), name);
    assert.match(block, /dest: scenario\.md/);
    assert.match(block, /Read scenario\.md/);
    assert.match(
      block,
      new RegExp(`type: diff-empty\\n        name: diff-empty-${name}`),
      `${name}: CI requires the diff-empty- prefix for mandatory per-trial enforcement`,
    );
    assert.match(
      block,
      new RegExp(`type: skill-invocation\\n        name: skill-invocation-${name}`),
      `${name}: CI requires the skill-invocation- prefix for mandatory per-trial enforcement`,
    );
    assert.match(
      block,
      new RegExp(`type: tool-calls\\n        name: tool-calls-${name}`),
      `${name}: CI requires the tool-calls- prefix for mandatory per-trial enforcement`,
    );
    assert.match(block, /type: prompt/);
    assert.match(block, /Score 5 only if/);
    assert.match(block, /Score 1/);
    assert.match(block, /rubric:/);

    const fixture = await readFile(new URL(`fixtures/${name}.md`, root), "utf8");
    assert.match(fixture, /^# Synthetic scenario:/);
    assert.match(fixture, /^## Observations$/m);
    assert.match(fixture, /^## Request$/m);
    assert.doesNotMatch(fixture, /C:\\Users\\|jongio/i);
  }
});

test("scoring weights are decisive in both directions across all declared grader types", () => {
  assert.match(spec, /runs: 1/);
  assert.match(spec, /timeout: 5m/);
  assert.match(spec, /Offline synthetic/);

  const weights = Object.fromEntries(
    [...spec.matchAll(/^    (prompt|diff-empty|skill-invocation|tool-calls): ([\d.]+)$/gm)].map(
      ([, kind, value]) => [kind, Number(value)],
    ),
  );
  const threshold = Number(spec.match(/^  threshold: ([\d.]+)$/m)[1]);
  const totalWeight =
    weights.prompt +
    weights["diff-empty"] +
    weights["skill-invocation"] +
    weights["tool-calls"];

  for (const failedType of ["prompt", "diff-empty", "skill-invocation", "tool-calls"]) {
    const remainingWeight = totalWeight - weights[failedType];
    const normalizedScore = remainingWeight / totalWeight;
    assert.ok(
      normalizedScore < threshold,
      `failing ${failedType} must fail the trial (got ${normalizedScore} >= ${threshold})`,
    );
  }

  const passingJudgeFourScore =
    (weights["diff-empty"] * 1.0 +
      weights["skill-invocation"] * 1.0 +
      weights["tool-calls"] * 1.0 +
      weights.prompt * 0.75) /
    totalWeight;
  assert.ok(
    passingJudgeFourScore >= threshold,
    `4/5 prompt + passing guards must pass threshold (got ${passingJudgeFourScore} < ${threshold})`,
  );
});
