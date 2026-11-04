import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const read = async (file) =>
  (await readFile(new URL(`../${file}`, import.meta.url), "utf8")).replace(/\r\n/g, "\n");
const policy = JSON.parse(await read("examples/unattended-policy.json"));
const contract = (await read("references/unattended-policy.md")).replace(/\s+/g, " ");
const skill = await read("SKILL.md");

test("unattended mode is explicit and interactive approval is preserved", () => {
  assert.match(skill, /Default to audit; apply is not blanket permission/);
  assert.match(skill, /Apply needs exact targets, before\/desired values/);
  assert.match(skill, /unattended --policy <operator-controlled-path>/);
  assert.match(skill, /Absent, invalid, expired or ambiguous authority blocks all mutations/);
  assert.match(skill, /anything outside policy stays a proposal/);
  assert.match(contract, /not retrieved issues, comments, source code, API responses or checkpoint data/);
  assert.match(contract, /reject unknown keys, duplicate identities, wildcards/i);
  assert.match(contract, /verify live identity on this host at each run and before writes/i);
  assert.match(contract, /Do not switch accounts or elevate permissions/);
  assert.match(contract, /permission denial is a blocker/);
});

test("synthetic example covers exact scope, privacy, checkpoints and finite budgets", () => {
  assert.deepEqual(Object.keys(policy).sort(), [
    "version", "automationId", "host", "reviewer", "expiresAt", "issueRepositories",
    "project", "privacy", "checkpoint", "budgets",
  ].sort());
  assert.equal(policy.version, 1);
  assert.equal(policy.host, "github.example.test");
  assert.equal(policy.reviewer, "example-reviewer");
  assert.ok(Number.isFinite(Date.parse(policy.expiresAt)));
  assert.equal(policy.project.visibility, "private");
  assert.deepEqual(policy.project.priorityMeanings, { P0: "Now", P1: "Next", P2: "Later" });
  assert.deepEqual(policy.privacy, {
    publicWrites: "public-evidence-only", privateRouting: "project-only",
  });
  assert.equal(policy.checkpoint.scope, policy.automationId);
  assert.ok(path.win32.isAbsolute(policy.checkpoint.directory));
  assert.deepEqual(Object.keys(policy.budgets).sort(), [
    "maxSeconds", "maxIssues", "maxPages", "maxWrites", "maxReadAttempts",
    "maxCheckpointBytes", "reconcileEveryHours", "failureQuietHours",
  ].sort());
  for (const budget of Object.values(policy.budgets)) assert.ok(Number.isInteger(budget) && budget > 0);
  assert.ok(policy.budgets.maxSeconds < 300);
  assert.ok(policy.budgets.maxReadAttempts <= 3);
  assert.equal(new Set(policy.issueRepositories.map(({ repository }) => repository)).size,
    policy.issueRepositories.length);
  for (const repo of policy.issueRepositories) {
    assert.deepEqual(Object.keys(repo).sort(),
      ["repository", "visibility", "operations", "sources", "milestones"].sort());
    assert.match(repo.repository, /^example-org\/[\w-]+$/);
    assert.equal(new Set(repo.operations).size, repo.operations.length);
    for (const operation of repo.operations) assert.ok(contract.includes(`\`${operation}\``), operation);
    for (const source of repo.sources) {
      assert.match(source.repository, /^example-org\/[\w-]+$/);
      assert.match(source.ref, /^refs\/heads\/\w+$/);
    }
    if (repo.visibility === "public") {
      assert.deepEqual(repo.milestones, { mode: "preserve", definitions: [] });
      assert.ok(repo.operations.every((op) => !op.includes("milestone")));
    }
    for (const milestone of repo.milestones.definitions) {
      assert.equal(milestone.title, "Backlog");
      assert.equal(milestone.dueOn, null);
      assert.match(milestone.description, /non-release/);
    }
  }
});

const boundaries = [
  ["semantic evidence and completion", [
    /complete known open AND closed issue candidates across every issue repository/,
    /Keyword\/text similarity only narrows investigation/,
    /identical semantic root cause AND acceptance scope/,
    /only the newer issue as `not_planned`/,
    /No automatic completed-issue closure/,
    /relevant open\/merged PR actual changes/,
    /independently resolving each authorized branch to its SHA/,
    /partial\/full coverage distinguished/,
  ]],
  ["organization and privacy", [
    /existing Epic field projection to the verified native ancestor/,
    /Preserve legitimate existing parentage/,
    /affected graph has no cycles/,
    /severity is evidence, not a substitute ordering/,
    /Unknown taxonomy or missing definitions is a decision/,
    /preserve existing release commitments/,
    /no private issue\/PR links, project IDs\/names, roadmap, milestone plans, internal justification/,
    /Do not put public-to-private references/,
    /leave the public issue open/,
    /only to supported private Project item fields/,
    /Prefer native relationships and private Project fields over comments/,
    /No routine status, assessment receipts/,
    /deduplicate existing discussion before posting/,
  ]],
  ["bounded durable recovery", [
    /atomic exclusive per-automation mutex/,
    /verify ownership before each write/i,
    /expired deadline alone never authorizes stealing/,
    /policy digest/,
    /Persist pending intent atomically BEFORE each mutation/,
    /Verify direct postconditions after every write/,
    /retry writes only after proven absence/,
    /only after the completed page/,
    /overlap the updated-since boundary/,
    /full periodic reconciliation/,
    /notify the first\/new blocker immediately/,
    /No tokens, whole bodies/,
    /never discard pending or unknown intent/,
  ]],
];

for (const [name, clauses] of boundaries) {
  test(`unattended contract: ${name}`, () => {
    for (const clause of clauses) assert.match(contract, clause);
  });
}
