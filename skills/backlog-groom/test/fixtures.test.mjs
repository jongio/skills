import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const root = new URL("../evals/backlog-groom/", import.meta.url);
const expected = [
  "multi-repo-sources", "issues-only", "missing-source", "merged-not-selected",
  "changed-head", "closure-and-parent", "view-populations", "ownership-and-dates",
  "shared-fields", "done-card", "serialization", "resume-and-pagination",
  "concurrent-view", "ui-blocked",
];
const spec = (await readFile(new URL("eval.yaml", root), "utf8")).replace(/\r\n/g, "\n");

test("every required synthetic scenario has one staged fixture and decisive rubric", async () => {
  const cases = spec.split(/^  - name: /m).slice(1);
  assert.deepEqual(cases.map((block) => block.split("\n")[0]), expected);
  const graders = [...spec.matchAll(/^        name: (.+)$/gm)].map(([, name]) => name);
  assert.equal(graders.length, expected.length * 2);
  assert.equal(new Set(graders).size, graders.length, "grader names must be globally unique");
  const files = (await readdir(new URL("fixtures/", root))).sort();
  assert.deepEqual(files, expected.map((name) => `${name}.md`).sort());
  for (const block of cases) {
    const name = block.split("\n")[0];
    assert.ok(block.includes(`src: fixtures/${name}.md`), name);
    assert.match(block, /dest: scenario\.md/);
    assert.match(block, /Read scenario\.md/);
    assert.match(block, /type: diff-empty/);
    assert.match(block, /type: prompt/);
    assert.match(block, /Score 1/i);
    assert.match(block, /rubric:/);
    const fixture = await readFile(new URL(`fixtures/${name}.md`, root), "utf8");
    assert.match(fixture, /Synthetic/);
    assert.match(fixture, /## Observations/);
    assert.match(fixture, /## Request/);
    assert.doesNotMatch(fixture, /C:\\Users\\|@[\w-]+/i);
    for (const [, owner] of fixture.matchAll(/\b([\w.-]+)\/[\w.-]+#\d+/g)) {
      assert.ok(["example-org", "sample-team"].includes(owner), "issue references must use synthetic owners");
    }
  }
});

test("all evals are bounded offline rehearsals, not claimed live integration tests", () => {
  assert.match(spec, /runs: 1/);
  assert.match(spec, /timeout: 5m/);
  assert.match(spec, /Offline synthetic/);
  assert.equal((spec.match(/No network or mutations/g) ?? []).length, expected.length);
  const weights = Object.fromEntries(
    [...spec.matchAll(/^    (prompt|diff-empty): ([\d.]+)$/gm)]
      .map(([, kind, value]) => [kind, Number(value)]),
  );
  assert.equal(weights.prompt + weights["diff-empty"], 1);
  const threshold = Number(spec.match(/^  threshold: ([\d.]+)$/m)[1]);
  assert.ok(weights.prompt < threshold);
  assert.ok(weights["diff-empty"] < threshold);
});
