import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const skill = await readFile(new URL("../SKILL.md", import.meta.url), "utf8");

test("portable skill frontmatter contains name, description, and version metadata", () => {
  const frontmatter = skill.match(/^---\n([\s\S]*?)\n---/);
  assert.ok(frontmatter);
  const keys = [...frontmatter[1].matchAll(/^([a-z][a-z-]*):/gm)].map((match) => match[1]);
  assert.deepEqual(keys, ["name", "description", "metadata"]);
  assert.match(frontmatter[1], /^  version: "[^"\r\n]+"$/m);
  assert.match(frontmatter[1], /^name: nobs$/m);
});

test("skill includes workflow, safety, and exit criteria", () => {
  assert.match(skill, /^## Workflow$/m);
  assert.match(skill, /^## Safety$/m);
  assert.match(skill, /^## Exit Criteria$/m);
});

test("every capability stimulus requires actual nobs invocation", async () => {
  const spec = await readFile(new URL("../evals/nobs/eval.yaml", import.meta.url), "utf8");
  const stimuli = spec.split(/\r?\n  - name:/).slice(1);
  assert.ok(stimuli.length > 0);
  for (const stimulus of stimuli) {
    assert.match(stimulus, /- type: skill-invocation\s+config:\s+required: \[nobs\]/,
      `Missing mandatory invocation guard: ${stimulus.split(/\r?\n/)[0].trim()}`);
  }
  assert.match(spec, /skill-invocation: 0\.2/);
  assert.match(spec, /^  threshold: 1\.0$/m);
});
