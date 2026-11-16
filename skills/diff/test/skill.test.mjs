import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const skill = await readFile(new URL("../SKILL.md", import.meta.url), "utf8");
const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
const evalYaml = await readFile(new URL("../evals/diff/eval.yaml", import.meta.url), "utf8");

test("portable skill frontmatter contains name, description, and version metadata", () => {
  const frontmatter = skill.match(/^---\n([\s\S]*?)\n---/);
  assert.ok(frontmatter);
  const keys = [...frontmatter[1].matchAll(/^([a-z][a-z-]*):/gm)].map((match) => match[1]);
  assert.deepEqual(keys, ["name", "description", "metadata"]);
  assert.match(frontmatter[1], /^name: diff$/m);
  assert.match(frontmatter[1], /^  version: "1\.0\.0"$/m);
});

test("skill includes workflow, safety, exit criteria, and untrusted-data boundary", () => {
  assert.match(skill, /^## Workflow$/m);
  assert.match(skill, /^## Safety$/m);
  assert.match(skill, /^## Exit Criteria$/m);
  assert.match(skill, /Untrusted data boundary/i);
  assert.match(skill, /Submit Review/);
});

test("tracked markdown and eval spec avoid Unicode dashes and YAML aliases", () => {
  for (const [label, content] of [
    ["SKILL.md", skill],
    ["README.md", readme],
    ["eval.yaml", evalYaml],
  ]) {
    assert.doesNotMatch(content, /[\u2013\u2014]/, `${label} must use ASCII '-'`);
  }
  assert.doesNotMatch(evalYaml, /(^|\s)&[A-Za-z0-9_-]+/m, "eval.yaml must not define YAML anchors");
  assert.doesNotMatch(evalYaml, /(^|\s)\*[A-Za-z0-9_-]+/m, "eval.yaml must not use YAML aliases");
  assert.doesNotMatch(evalYaml, /^\s*<<:/m, "eval.yaml must not use YAML merge keys");
});

test("eval spec enforces decisive mandatory guards on every stimulus", () => {
  assert.match(evalYaml, /threshold:\s*0\.85/);
  const stimuliBlocks = evalYaml.split(/\n  - name:\s+/).slice(1);
  assert.equal(stimuliBlocks.length, 3);
  for (const block of stimuliBlocks) {
    assert.match(block, /name:\s+diff-empty-/);
    assert.match(block, /name:\s+skill-invocation-/);
    assert.match(block, /name:\s+tool-calls-/);
  }
});
