import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import test from "node:test";

const skill = (await readFile(new URL("../SKILL.md", import.meta.url), "utf8")).replace(/\r\n/g, "\n");
const reference = await readFile(new URL("../references/test-quality.md", import.meta.url), "utf8");
const evalSpec = await readFile(new URL("../evals/test-doctor/eval.yaml", import.meta.url), "utf8");

test("portable skill frontmatter contains name, description, and version metadata", () => {
  const frontmatter = skill.match(/^---\n([\s\S]*?)\n---/);
  assert.ok(frontmatter);
  const keys = [...frontmatter[1].matchAll(/^([a-z][a-z-]*):/gm)].map((match) => match[1]);
  assert.deepEqual(keys, ["name", "description", "metadata"]);
  assert.match(frontmatter[1], /^  version: "[^"\r\n]+"$/m);
  assert.match(frontmatter[1], /^name: test-doctor$/m);
});

test("skill includes workflow, safety, and exit criteria", () => {
  assert.match(skill, /^## Workflow$/m);
  assert.match(skill, /^## Safety$/m);
  assert.match(skill, /^## Exit Criteria$/m);
});

test("instructions remain bounded, portable, and locally linked", () => {
  assert.ok(skill.split(/\r?\n/).length <= 250, "keep the main workflow small");
  assert.doesNotMatch(skill, /\{\{\s*references|_shared[\\/]|DEVX_WS|devx-[a-z]/);
  const links = [...skill.matchAll(/\]\((references\/[^)]+)\)/g)];
  assert.equal(links.length, 1, "one focused reference carries detailed checks");
  for (const [, relative] of links) {
    assert.ok(existsSync(new URL(`../${relative}`, import.meta.url)), relative);
  }
});

test("instructions keep audit mutation and repair boundaries explicit", () => {
  assert.match(skill, /Audit, report findings, stop\. Do not edit project files/);
  assert.match(skill, /Audit mode must not install dependencies/);
  assert.match(skill, /at most three repair passes/);
  assert.match(skill, /Reaching the limit is incomplete work, not success/);
  assert.match(skill, /ask before changing production code/);
  assert.match(skill, /Never lower coverage gates/);
  assert.match(skill, /blocked\. Never call an unobserved frontend healthy/);
});

test("checklist preserves independent evidence rather than blanket style rules", () => {
  assert.match(reference, /Stage inputs only/);
  assert.match(reference, /round trip proves self-consistency/);
  assert.match(reference, /truthiness contract/);
  assert.match(reference, /unique regression/);
  assert.match(skill, /Retries of failures are not repetitions of every test/);
  assert.match(skill, /absence of Playwright does not/);
});

test("capability cases are specific and behavioral graders remain decisive", () => {
  const cases = [...evalSpec.matchAll(/^  - name: (.+)$/gm)].map(([, name]) => name);
  assert.equal(cases.length, 7);
  assert.equal(new Set(cases).size, cases.length);
  assert.doesNotMatch(evalSpec, /representative request|follows-complete-workflow/);
  assert.match(evalSpec, /type: diff-empty/);
  assert.match(evalSpec, /path: test\/shipping\.test\.mjs/);
  const weights = Object.fromEntries(
    [...evalSpec.matchAll(/^    (prompt|diff-empty|file-matches): ([\d.]+)$/gm)]
      .map(([, type, weight]) => [type, Number(weight)]),
  );
  assert.equal(Object.keys(weights).length, 3);
  assert.ok(Math.abs(Object.values(weights).reduce((a, b) => a + b, 0) - 1) < 0.000001);
  const threshold = Number(evalSpec.match(/^  threshold: ([\d.]+)$/m)[1]);
  for (const behavior of ["diff-empty", "file-matches"]) {
    const total = weights.prompt + weights[behavior];
    assert.ok(weights.prompt / total < threshold, "prose cannot outvote failed behavior");
    assert.ok(weights[behavior] / total < threshold, "behavior cannot outvote failed judgment");
  }
});
