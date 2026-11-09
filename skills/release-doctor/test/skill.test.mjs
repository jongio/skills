import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const skill = await readFile(new URL("../SKILL.md", import.meta.url), "utf8");

test("portable skill frontmatter contains name, description, and version metadata", () => {
  const frontmatter = skill.match(/^---\n([\s\S]*?)\n---/);
  assert.ok(frontmatter);
  const keys = [...frontmatter[1].matchAll(/^([a-z][a-z-]*):/gm)].map((match) => match[1]);
  assert.deepEqual(keys, ["name", "description", "metadata"]);
  assert.match(frontmatter[1], /^name: release-doctor$/m);
  assert.match(frontmatter[1], /^  version: "[^"]+"$/m);
});

test("skill includes workflow, safety, and exit criteria", () => {
  assert.match(skill, /^## Workflow$/m);
  assert.match(skill, /^## Safety$/m);
  assert.match(skill, /^## Exit Criteria$/m);
});

test("release-doctor checks unreleased commits, semver classification, cross-manifest version parity, and green HEAD CI", () => {
  assert.doesNotMatch(skill, /jongio/i, "SKILL.md must not hardcode personal account names");
  assert.match(skill, /releases\/latest/);
  assert.match(skill, /compare\/\{latestTag\}\.\.\.\{defaultBranch\}/);
  assert.match(skill, /package\.json/);
  assert.match(skill, /plugin\.json/);
  assert.match(skill, /extension\.yaml/);
  assert.match(skill, /CHANGELOG\.md/);
  assert.match(skill, /check-runs/);
  assert.match(skill, /\.github\/maintain\.json/);
});
