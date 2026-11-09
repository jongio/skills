import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const skill = await readFile(new URL("../SKILL.md", import.meta.url), "utf8");

test("portable skill frontmatter contains name, description, and version metadata", () => {
  const frontmatter = skill.match(/^---\n([\s\S]*?)\n---/);
  assert.ok(frontmatter);
  const keys = [...frontmatter[1].matchAll(/^([a-z][a-z-]*):/gm)].map((match) => match[1]);
  assert.deepEqual(keys, ["name", "description", "metadata"]);
  assert.match(frontmatter[1], /^name: repo-maintain$/m);
  assert.match(frontmatter[1], /^  version: "[^"]+"$/m);
});

test("skill includes workflow, safety, and exit criteria", () => {
  assert.match(skill, /^## Workflow$/m);
  assert.match(skill, /^## Safety$/m);
  assert.match(skill, /^## Exit Criteria$/m);
});

test("repo-maintain skill defines dynamic maintainer resolution, phases 0-6, stealth public mode, and 0-100 health score", () => {
  assert.doesNotMatch(skill, /jongio/i, "SKILL.md must not hardcode personal account names");
  assert.match(skill, /\.github\/repo-maintain\.json/);
  assert.match(skill, /\.github\/maintain\.json/);
  assert.match(skill, /\.github\/CODEOWNERS/);
  assert.match(skill, /gh repo view --json owner --jq '\.owner\.login'/);
  assert.match(skill, /gh api user --jq '\.login'/);
  assert.match(skill, /needs-maintainer-review/);
  assert.match(skill, /repo-maintain\/automated/);
  assert.match(skill, /lastMaintainSha == HEAD/);
  for (const subSkill of [
    "backlog-groom",
    "ci-doctor",
    "repo-ready",
    "deps-doctor",
    "secops-doctor",
    "refactor",
    "test-doctor",
    "doc-doctor",
    "skill-doctor",
    "eval-doctor",
    "release-doctor",
  ]) {
    assert.ok(skill.includes(subSkill), `repo-maintain SKILL.md must orchestrate ${subSkill}`);
  }
  assert.match(skill, /Stealth Public Mode/);
  assert.match(skill, /0-100 Repo Health Score/);
  assert.match(skill, /github\.event\.repository\.fork == false/);
  assert.match(skill, /autoMerge/);
  assert.match(skill, /copilotReview/);
  assert.match(skill, /Zero-Touch Auto-Create & Auto-Merge/);
  assert.match(skill, /pr --merge=auto --no-copilot/);
  assert.match(skill, /pr-watch-daemon\.mjs watch --no-copilot/);
  assert.match(skill, /RequiredAzdVersion/);
  assert.match(skill, /govulncheck/);
  assert.match(skill, /codeql-action\/\*/);
  assert.match(skill, /Needs My Attention/);
  assert.match(skill, /--match-head-commit <full-head-OID>/);
  assert.doesNotMatch(skill, /gh pr merge --auto --squash/);
});
