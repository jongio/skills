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
  assert.match(skill, /All PR and issue work requires an explicit\s+add/);
  assert.match(skill, /shell commands and GitHub writes\/results never enroll targets/);
  assert.match(skill, /unowned legacy references are dropped/);
  assert.match(skill, /Honor manual dismissal/);
});

test("custom names use session-bound controls without renaming terminals or changing settings", () => {
  assert.match(skill, /USE FOR: name this session, custom statusline name/);
  assert.match(skill, /"action":"name","name":"API migration"/);
  assert.match(skill, /"action":"clear-name"/);
  assert.match(skill, /\/session-statusline name <label>/);
  assert.match(skill, /\/session-statusline clear-name/);
  assert.match(skill, /use the user's supplied label; ask for it if missing/);
  assert.match(skill, /After setting or removing a name, query `session_statusline`/);
  assert.match(skill, /preserved on resume, not terminal tab titles or a global default/);
  assert.match(skill, /Clear and refresh preserve the custom name/);
  assert.match(skill, /naming does not enable it/);
});
