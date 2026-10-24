import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const skill = await readFile(new URL("../SKILL.md", import.meta.url), "utf8");

test("portable skill frontmatter contains name, description, and version metadata", () => {
  const frontmatter = skill.match(/^---\n([\s\S]*?)\n---/);
  assert.ok(frontmatter);
  const keys = [...frontmatter[1].matchAll(/^([a-z][a-z-]*):/gm)].map((match) => match[1]);
  assert.deepEqual(keys, ["name", "description", "metadata"]);
  assert.match(frontmatter[1], /^name: session-statusline$/m);
  assert.match(frontmatter[1], /^  version: "[^"]+"$/m);
});

test("skill includes workflow, safety, and exit criteria", () => {
  assert.match(skill, /^## Workflow$/m);
  assert.match(skill, /^## Safety$/m);
  assert.match(skill, /^## Exit Criteria$/m);
});

test("manual controls use session-bound tools and preserve work and configuration", () => {
  for (const tool of ["session_statusline", "session_prs", "session_issues", "session_subagents"]) {
    assert.ok(skill.includes(`\`${tool}\``));
  }
  assert.match(skill, /"action":"clear"/);
  assert.match(skill, /not disable components/);
  assert.match(skill, /Never confuse an\s+issue with a PR or guess an agent ID/);
  assert.match(skill, /do not close issues\/PRs, stop agents/);
  assert.match(skill, /If the tools are unavailable/);
  assert.match(skill, /Do not claim it ran/);
});

test("active-work policy excludes reference-only enrollment and respects manual dismissal", () => {
  assert.match(skill, /References in conversation, attachments/);
  assert.match(skill, /Read-only review or monitoring requires an\s+explicit add/);
  assert.match(skill, /Honor manual dismissal/);
});
