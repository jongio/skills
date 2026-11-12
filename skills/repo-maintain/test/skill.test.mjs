import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = async (relative) =>
  (await readFile(new URL(`../${relative}`, import.meta.url), "utf8")).replace(/\r\n/g, "\n");
const skill = await read("SKILL.md");

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

test("instructions are bounded, portable, and all relative reference links resolve", async () => {
  assert.ok(skill.split("\n").length <= 500);
  assert.doesNotMatch(skill, /DEVX_WS|_shared[\\/]|C:\\Users\\|installed-plugins/);
  const links = [...skill.matchAll(/\]\((references\/[^)]+)\)/g)].map(([, link]) => link);
  assert.deepEqual(new Set(links), new Set([
    "references/phase-playbooks.md",
    "references/health-score-rubric.md",
    "references/stealth-and-fleet.md",
  ]));
  for (const link of new Set(links)) {
    const content = await read(link);
    assert.ok(content.length > 200, `${link} must have substantial reference content`);
    assert.doesNotMatch(content, /jongio/i, `${link} must not hardcode personal account names`);
  }
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
  assert.match(skill, /scripts\/repo-maintain\.mjs/);
  assert.match(skill, /2 bounded repair attempts/);
});

const referenceContracts = [
  ["phase playbooks define SHA receipt, worktree reuse, and phase-scoped rollback", "references/phase-playbooks.md", [
    /lastMaintainSha/,
    /fast no-op: HEAD unchanged and healthy/,
    /repo-maintain\/automated/,
    /2 bounded repair attempts/,
    /git reset --hard <pre-phase-sha> && git clean -fd/,
    /RequiredAzdVersion/,
    /govulncheck/,
    /codeql-action\/\*/,
  ]],
  ["health score rubric defines deterministic deductions across all 7 dimensions", "references/health-score-rubric.md", [
    /CI & Workflow Hygiene/,
    /Test & Branch Coverage/,
    /Dependency & License Health/,
    /Security Posture/,
    /Documentation Accuracy/,
    /Skill & Eval Quality/,
    /Backlog SLA/,
    /97-100/,
    /Before/,
    /After/,
  ]],
  ["stealth and fleet reference enforces fail-closed redaction and context partitioning", "references/stealth-and-fleet.md", [
    /fail-closed/i,
    /CWE-\\d\+/,
    /CVE-\\d\{4\}-\\d\+/,
    /GHSA-/,
    /Zero Cross-Repo Leakage/,
    /github\.event\.repository\.fork == false/,
  ]],
];

for (const [name, file, clauses] of referenceContracts) {
  test(`reference contract: ${name}`, async () => {
    const content = (await read(file)).replace(/\s+/g, " ");
    for (const clause of clauses) {
      assert.match(content, clause, `${file}: ${clause}`);
    }
  });
}
