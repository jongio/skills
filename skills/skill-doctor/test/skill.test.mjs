import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const skill = await readFile(new URL("../SKILL.md", import.meta.url), "utf8");

test("portable skill frontmatter contains only name and description", () => {
  const frontmatter = skill.match(/^---\n([\s\S]*?)\n---/);
  assert.ok(frontmatter);
  const keys = [...frontmatter[1].matchAll(/^([a-z][a-z-]*):/gm)].map((match) => match[1]);
  assert.deepEqual(keys, ["name", "description"]);
  assert.match(frontmatter[1], /^name: skill-doctor$/m);
});

test("skill includes workflow, safety, and exit criteria", () => {
  assert.match(skill, /^## Workflow$/m);
  assert.match(skill, /^## Safety$/m);
  assert.match(skill, /^## Exit Criteria$/m);
});

test("instructions stay concise and preserve the workflow boundaries", () => {
  assert.ok(skill.trim().split(/\s+/).length <= 700, "Keep the loaded skill under 700 words");
  assert.ok(skill.split("\n").length <= 100, "Keep detail in the linked reference");
  for (const phrase of ["7 days", "current directory", "one or two short", "dedicated worktree", "stop before merge", "incomplete read", "Scenario-only"]) {
    assert.ok(skill.includes(phrase), `Missing contract: ${phrase}`);
  }
  for (const phrase of ["every target skill", "even without session failures", "nonblank lines", "No code-golf", "equivalent decisions"]) {
    assert.ok(skill.includes(phrase), `Missing terseness rule: ${phrase}`);
  }
});

test("referenced collection and cache protocol exists", async () => {
  const reference = await readFile(new URL("../references/session-audit.md", import.meta.url), "utf8");
  for (const phrase of ["activity", "outside the requested window", "optimistic concurrency", "tool outcomes", "no-change", "pending", "delivered", "skill-source-v1", "Changed sources are reconsidered", "report moved text separately"]) {
    assert.ok(reference.includes(phrase), `Missing cache rule: ${phrase}`);
  }
});
