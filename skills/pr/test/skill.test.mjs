import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const skill = (await readFile(new URL("../SKILL.md", import.meta.url), "utf8")).replace(/\r\n/g, "\n");
const evalSpec = await readFile(new URL("../evals/pr/eval.yaml", import.meta.url), "utf8");

test("portable skill frontmatter contains only name and description", () => {
  const frontmatter = skill.match(/^---\n([\s\S]*?)\n---/);
  assert.ok(frontmatter);
  const keys = [...frontmatter[1].matchAll(/^([a-z][a-z-]*):/gm)].map((match) => match[1]);
  assert.deepEqual(keys, ["name", "description"]);
  assert.match(frontmatter[1], /^name: pr$/m);
});

test("skill includes workflow, safety, and exit criteria", () => {
  assert.match(skill, /^## Workflow$/m);
  assert.match(skill, /^## Safety$/m);
  assert.match(skill, /^## Exit Criteria$/m);
});

test("workflow remains concise and covers preflight, review routing, monitoring, and merge", () => {
  assert.ok(skill.split("\n").length <= 60, "keep SKILL.md short and sweet");
  assert.doesNotMatch(skill, /devx|devy/i);
  assert.match(skill, /create a dedicated PR branch first/i);
  assert.match(skill, /commit intended uncommitted changes first/i);
  assert.match(skill, /npx skills add jongio\/skills --skill test-doctor/);
  assert.match(skill, /light security review/i);
  assert.match(skill, /linter and build/i);
  assert.match(skill, /Never automatically add Copilot as a reviewer on \*\*private\*\* repositories/);
  assert.match(skill, /resolve automated\/bot threads/i);
  assert.match(skill, /keep human threads with open questions open/i);
  assert.match(skill, /rebase/i);
  assert.match(skill, /auto-merge/i);
});

test("eval spec covers private repo reviewer rules, comment resolution, and balanced grader weights", () => {
  assert.doesNotMatch(evalSpec, /devx|devy/i);
  const cases = [...evalSpec.matchAll(/^  - name: (.+)$/gm)].map(([, name]) => name);
  assert.deepEqual(cases, [
    "private-repo-skips-auto-copilot-review",
    "bot-vs-human-comment-resolution",
  ]);
  assert.match(evalSpec, /type: diff-empty/);
  assert.match(evalSpec, /type: skill-invocation/);
  const weights = Object.fromEntries(
    [...evalSpec.matchAll(/^    (prompt|diff-empty|skill-invocation): ([\d.]+)$/gm)]
      .map(([, type, weight]) => [type, Number(weight)]),
  );
  assert.equal(Object.keys(weights).length, 3);
  assert.ok(Math.abs(Object.values(weights).reduce((a, b) => a + b, 0) - 1) < 0.000001);
  const threshold = Number(evalSpec.match(/^  threshold: ([\d.]+)$/m)[1]);
  for (const requiredGrader of ["diff-empty", "skill-invocation"]) {
    const scoreWithoutRequired = 1 - weights[requiredGrader];
    assert.ok(
      scoreWithoutRequired < threshold,
      `${requiredGrader} failure must prevent passing threshold`,
    );
  }
});
