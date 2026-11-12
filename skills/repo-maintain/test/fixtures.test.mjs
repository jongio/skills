import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const root = new URL("../evals/repo-maintain/", import.meta.url);
const expected = [
  "sha-receipt-fast-noop",
  "public-stealth-redaction",
  "companion-sync-and-escalation",
  "phase-isolation-and-health-score",
];
const spec = (await readFile(new URL("eval.yaml", root), "utf8")).replace(/\r\n/g, "\n");

test("every synthetic repo-maintain scenario has a staged fixture, mandatory CI guard prefixes, and decisive rubric", async () => {
  const cases = spec.split(/^  - name: /m).slice(1);
  assert.deepEqual(
    cases.map((block) => block.split("\n")[0]),
    expected,
  );
  const graders = [...spec.matchAll(/^        name: (.+)$/gm)].map(([, name]) => name);
  assert.equal(graders.length, expected.length * 3);
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
    assert.match(block, /type: prompt/);
    assert.match(block, /Score 5 only if/);
    assert.match(block, /Score 1/);
    assert.match(block, /rubric:/);

    const fixture = await readFile(new URL(`fixtures/${name}.md`, root), "utf8");
    assert.match(fixture, /^# Synthetic scenario:/);
    assert.match(fixture, /^## Observations$/m);
    assert.match(fixture, /^## Request$/m);
    assert.doesNotMatch(fixture, /C:\\Users\\|jongio|@[\w-]+/i);
    for (const [, owner] of fixture.matchAll(/\b([\w.-]+)\/[\w.-]+#\d+/g)) {
      assert.ok(
        ["example-org", "sample-team"].includes(owner),
        `issue/PR references must use synthetic owners (found ${owner})`,
      );
    }
  }
});

test("scoring weights are decisive in both directions across all declared grader types", () => {
  assert.match(spec, /runs: 1/);
  assert.match(spec, /timeout: 5m/);
  assert.match(spec, /Offline synthetic/);

  const weights = Object.fromEntries(
    [...spec.matchAll(/^    (prompt|diff-empty|skill-invocation): ([\d.]+)$/gm)].map(
      ([, kind, value]) => [kind, Number(value)],
    ),
  );
  const threshold = Number(spec.match(/^  threshold: ([\d.]+)$/m)[1]);
  const totalWeight = weights.prompt + weights["diff-empty"] + weights["skill-invocation"];

  // Failing any single grader type (score 0 while the other two score 1.0) must fall below threshold.
  for (const failedType of ["prompt", "diff-empty", "skill-invocation"]) {
    const remainingWeight = totalWeight - weights[failedType];
    const normalizedScore = remainingWeight / totalWeight;
    assert.ok(
      normalizedScore < threshold,
      `failing ${failedType} must fail the trial (got ${normalizedScore} >= ${threshold})`,
    );
  }

  // Passing both behavioral guards (1.0) plus a 4/5 judge score (0.75) must pass threshold.
  const passingJudgeFourScore =
    (weights["diff-empty"] * 1.0 + weights["skill-invocation"] * 1.0 + weights.prompt * 0.75) /
    totalWeight;
  assert.ok(
    passingJudgeFourScore >= threshold,
    `4/5 prompt + passing guards must pass threshold (got ${passingJudgeFourScore} < ${threshold})`,
  );
});
