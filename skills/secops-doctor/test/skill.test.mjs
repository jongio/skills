import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const skill = await readFile(new URL("../SKILL.md", import.meta.url), "utf8");

test("portable skill frontmatter contains name, description, and version metadata", () => {
  const frontmatter = skill.match(/^---\n([\s\S]*?)\n---/);
  assert.ok(frontmatter);
  const keys = [...frontmatter[1].matchAll(/^([a-z][a-z-]*):/gm)].map((match) => match[1]);
  assert.deepEqual(keys, ["name", "description", "metadata"]);
  assert.match(frontmatter[1], /^name: secops-doctor$/m);
  assert.match(frontmatter[1], /^  version: "[^"]+"$/m);
});

test("skill includes workflow, safety, and exit criteria", () => {
  assert.match(skill, /^## Workflow$/m);
  assert.match(skill, /^## Safety$/m);
  assert.match(skill, /^## Exit Criteria$/m);
});

test("secops-doctor enforces Public Repo Stealth Mode, OWASP/STRIDE, Cloudflare/container checks, and dynamic maintainer resolution", () => {
  assert.doesNotMatch(skill, /jongio/i, "SKILL.md must not hardcode personal account names");
  assert.match(skill, /Public Repo Stealth Mode/);
  assert.match(skill, /visibility == "PUBLIC"/);
  assert.match(skill, /Never write `CWE-\*`/);
  assert.match(skill, /STRIDE/);
  assert.match(skill, /OWASP/);
  assert.match(skill, /Cloudflare/);
  assert.match(skill, /Dockerfile/);
  assert.match(skill, /\.github\/maintain\.json/);
});
