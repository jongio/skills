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
  assert.match(skill, /Describe intended cache and delivery transitions without executing them/);
});

test("referenced collection and cache protocol exists", async () => {
  const reference = await readFile(new URL("../references/session-audit.md", import.meta.url), "utf8");
  for (const phrase of ["activity", "outside the requested window", "optimistic concurrency", "tool outcomes", "no-change", "pending", "delivered", "skill-source-v1", "Changed sources are reconsidered", "report moved text separately"]) {
    assert.ok(reference.includes(phrase), `Missing cache rule: ${phrase}`);
  }
});

test("every capability scenario requires actual skill invocation", async () => {
  const spec = await readFile(new URL("../evals/skill-doctor/eval.yaml", import.meta.url), "utf8");
  const stimuli = spec.split(/\r?\n  - name:/).slice(1);
  assert.ok(stimuli.length > 0);
  for (const stimulus of stimuli) {
    assert.match(stimulus, /- type: skill-invocation\s+config:\s+required: \[skill-doctor\]/,
      `Missing mandatory invocation guard: ${stimulus.split(/\r?\n/)[0].trim()}`);
  }
  assert.match(spec, /skill-invocation: 0\.2/);
  assert.match(spec, /^  threshold: 0\.84$/m);
});

test("historical cache revisions and probes cover only cutoff-bounded evidence", async () => {
  const reference = await readFile(new URL("../references/session-audit.md", import.meta.url), "utf8");
  assert.match(reference, /exactly the cutoff-bounded evidence/);
  assert.match(reference, /Never use a current full-session revision for a historical cutoff/);
  assert.match(reference, /Metadata-only probes must use that same cutoff-bounded scope/);
});

test("source resolution and delivery state their required preconditions", () => {
  assert.match(skill, /If only an installed copy is known, ask for the canonical source path/);
  assert.match(skill, /Before retrying PR creation, look up the target repository and\s+head branch; reuse any existing PR/);
  assert.match(skill, /State and preserve required approvals before those actions; stop before merge/);
  assert.match(skill, /aim for at most 20 words per sentence/);
  assert.match(skill, /Preserve safety rules, decision branches, exceptions, and useful examples/);
});
