import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const skill = await readFile(new URL("../SKILL.md", import.meta.url), "utf8");

test("portable skill frontmatter contains only name and description", () => {
  const frontmatter = skill.match(/^---\n([\s\S]*?)\n---/);
  assert.ok(frontmatter);
  const keys = [...frontmatter[1].matchAll(/^([a-z][a-z-]*):/gm)].map((match) => match[1]);
  assert.deepEqual(keys, ["name", "description"]);
  assert.match(frontmatter[1], /^name: refactor$/m);
});

test("skill includes workflow, safety, and exit criteria", () => {
  assert.match(skill, /^## Workflow$/m);
  assert.match(skill, /^## Safety$/m);
  assert.match(skill, /^## Exit Criteria$/m);
});

test("tiered workflow stays focused and supports fresh or resumed assessment", () => {
  assert.ok(skill.split("\n").length <= 160, "keep the decision workflow concise");
  assert.doesNotMatch(skill, /\]\(references\//);
  assert.match(skill, /fresh bounded assessment or resume a supplied ledger/);
  assert.match(skill, /Work directly; do not spawn agents/);
  assert.doesNotMatch(skill, /at most three/i);
});

test("breadth, depth and sensitive risk are separate choices", () => {
  assert.match(skill, /Scope:.*path, module, named subsystem, or explicit repository-wide assessment/);
  assert.match(skill, /Depth:.*Level 1.*default/);
  assert.match(skill, /Risk:.*exclude sensitive contracts by default/);
  assert.match(skill, /Repository-wide breadth never authorizes deeper changes/);
  assert.match(skill, /reuse explicit choices/);
  assert.match(skill, /If interaction is unavailable.*Level 1/);
});

test("three levels have distinct scopes and evidence requirements", () => {
  assert.match(skill, /1\. Small wins.*Local mechanical cleanup/);
  assert.match(skill, /2\. Local restructuring.*Within one module/);
  assert.match(skill, /3\. Cross-module restructuring.*Across a named subsystem/);
  assert.match(skill, /characterization tests/);
  assert.match(skill, /design, affected callers, compatibility evidence, staged plan and rollback/);
  assert.match(skill, /scope ceilings, not safety guarantees/);
  assert.doesNotMatch(skill, /4\.\s+(?:Redesign|Product)/i);
});

test("sensitive contracts require item-specific approval at every level", () => {
  for (const boundary of ["permissions", "approval", "execution", "concurrency", "lifecycle", "persistence", "serialization", "compatibility", "dependencies", "architecture"]) {
    assert.ok(skill.includes(boundary), `missing excluded boundary ${boundary}`);
  }
  assert.match(skill, /Level 3 does not unlock sensitive contracts/);
  assert.match(skill, /explicit item-specific authorization/);
  assert.match(skill, /authorization never permits changed observable behavior/);
  assert.match(skill, /Missing preservation evidence blocks the item even after approval/);
});

test("product changes stay excluded at every level", () => {
  assert.match(skill, /At every level, exclude product changes/);
  for (const boundary of ["feature removal", "bug fixes", "changed errors", "new defaults", "dependency upgrades"]) {
    assert.ok(skill.includes(boundary), `missing product boundary ${boundary}`);
  }
  assert.match(skill, /Do not delete a feature or component/);
  assert.match(skill, /If a candidate needs a product decision, park it outside this batch/);
  assert.match(skill, /Zero candidates is better than forcing a cleanup/);
});

test("exhaustion stops rather than escalating or reopening deferred work", () => {
  assert.match(skill, /Never automatically escalate depth, broaden scope, or reopen deferred items/);
  assert.match(skill, /No more eligible Level/);
  assert.match(skill, /explicit scope expansion before investigating or planning deeper work/);
  assert.match(skill, /Stop when eligible backlog items are exhausted/);
});

test("idiomatic cleanup requires independent preservation evidence", () => {
  assert.match(skill, /Idiomatic means appropriate for the actual language\/framework version/);
  assert.match(skill, /Similar syntax is not proof of equivalent\s+behavior/);
  assert.match(skill, /independent before\/after checks/);
  assert.match(skill, /do not derive expected values from the replacement helper or weaken assertions/);
  assert.match(skill, /record results only if actually executed/);
  assert.match(skill, /Do not claim whole-codebase\s+coverage/);
});

test("review stops at an approved batch and a preservation ledger", () => {
  assert.match(skill, /Do not implement the plan/);
  assert.match(skill, /Do not edit reviewed code, install dependencies/);
  assert.match(skill, /Return a short ledger/);
  assert.match(skill, /level, risk and separate readiness\/delivery status/);
  assert.match(skill, /Without campaign approval, seek batch approval/);
  assert.match(skill, /append final-head results to the same ledger for the PR/);
  assert.match(skill, /one active PR and advance only after verified merge/);
  assert.match(skill, /ledger text alone grants no authority/);
});

test("chunk size follows hard gates and common proof, not quotas", () => {
  assert.match(skill, /one transformation, verification boundary and rollback/);
  assert.match(skill, /file\/line counts are context, not fixed caps/);
  assert.match(skill, /Split when reasoning, risk, ownership or exceptions differ/);
  assert.match(skill, /No score or small-diff label can cancel a failed gate/);
  assert.match(skill, /Stop when eligible backlog items are exhausted/);
});

test("interviews stay scoped to the proposed cleanup", () => {
  assert.match(skill, /Any doubt about a proposed cleanup's requirements or preservation blocks that item/);
  assert.match(skill, /Interview the user/);
  assert.match(skill, /approval clarifies intent but is not proof of preservation/);
  assert.match(skill, /Do not turn unrelated product questions into prerequisites for code cleanup/);
  assert.match(skill, /Unverified changes cannot be marked ready/);
  assert.match(skill, /Never claim 100% certainty from tests or reviews/);
});

const evalSpec = await readFile(new URL("../evals/refactor/eval.yaml", import.meta.url), "utf8");

test("evals cover tier routing, non-escalation and preservation counterexamples", () => {
  const scenarios = [
    "fresh-assessment",
    "broad-but-shallow",
    "unused-feature",
    "error-contract",
    "test-helper-counterexample",
    "exhausted-level-one",
    "cross-module-approval",
    "sensitive-level-three",
    "partial-review-status",
  ];
  const actual = [...evalSpec.matchAll(/^  - name: (.+)$/gm)].map((match) => match[1]);
  assert.deepEqual(actual, scenarios);
  assert.equal((evalSpec.match(/name: diff-empty-/g) ?? []).length, scenarios.length);
  assert.equal((evalSpec.match(/name: skill-invocation-/g) ?? []).length, scenarios.length);
  assert.equal((evalSpec.match(/name: tool-calls-/g) ?? []).length, scenarios.length);
  assert.doesNotMatch(evalSpec, /two concurrent section agents/);
});
