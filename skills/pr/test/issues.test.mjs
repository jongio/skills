import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = async (file) => (await readFile(new URL(file, import.meta.url), "utf8")).replace(/\r\n/g, "\n");
const skill = await read("../SKILL.md");
const contract = (await read("../references/issue-reconciliation.md").catch((error) => {
  if (error.code === "ENOENT") return "";
  throw error;
})).replace(/\s+/g, " ");
const evalSpec = await read("../evals/pr/eval.yaml");

test("direct PR delivery and go handoffs share pre-merge discovery and post-merge reconciliation", () => {
  assert.match(skill, /\*\*Related issues\*\*:[^\n]*\[.*\]\(references\/issue-reconciliation\.md\)/);
  const discover = skill.indexOf("**Related issues**:");
  const merge = skill.indexOf("7. **Merge**:");
  const reconcile = skill.indexOf("**Issue reconciliation**:");
  const cleanup = skill.indexOf("**Cleanup**:");
  assert.ok(discover > 0 && discover < merge, "discover issues before merging");
  assert.ok(reconcile > merge && reconcile < cleanup, "reconcile after confirmed merge, before cleanup");
  assert.match(skill, /\*\*Issue reconciliation\*\*:[^\n]*GitHub confirms[^\n]*intended head[^\n]*already-merged/);
  assert.match(skill, /Related issues[^\n]*verified closed[^\n]*remaining work[^\n]*issue reconciliation pending/);
  assert.match(contract, /direct `pr`, a `go` handoff, and resuming an already-merged PR/);
});

test("issue inventory is paginated, repository-qualified, and distinguishes references from delivery scope", () => {
  assert.match(contract, /closing links.*PR body.*handoff.*conversation/);
  assert.match(contract, /Paginate.*linked issues.*comments/);
  assert.match(contract, /`owner\/repo#number`/);
  assert.match(contract, /cross-repository/);
  assert.match(contract, /acceptance criteria.*merged changes.*validation evidence/);
  assert.match(contract, /mere mention.*not.*permission to close/);
  assert.match(contract, /non-default base/);
  assert.match(contract, /Remove.*closing keywords.*partially resolved/);
  assert.match(contract, /Remove.*closing keywords.*reference-only/);
  assert.match(contract, /unavailable or incomplete.*not.*no related issues/);
});

test("task and handoff associations survive interruption through a verified GitHub inventory", () => {
  assert.match(contract, /Before merge, persist.*repository-qualified inventory.*scope rationale.*PR body.*PR comment/);
  assert.match(contract, /task-only.*handoff-only/);
  assert.match(contract, /read back.*persisted inventory.*pause merge/);
  assert.match(contract, /Reuse or update.*inventory.*rather than posting duplicates/);
});

test("complete issues are closed only after confirmed delivery and persisted state verification", () => {
  assert.match(contract, /Do not mutate issues before GitHub confirms.*intended head.*merged/);
  assert.match(contract, /Fully resolved.*all acceptance criteria.*evidence/);
  assert.match(contract, /already closed.*verify.*do not.*duplicate/);
  assert.match(contract, /still open.*close.*completed/);
  assert.match(contract, /`gh issue close <number> -R <owner\/repo> --reason completed/);
  assert.match(contract, /Re-read.*state.*comments.*verify.*persisted/);
});

test("partial and uncertain issues preserve outstanding work without guessing or reopening unrelated closures", () => {
  assert.match(contract, /Partially resolved.*keep.*open/);
  assert.match(contract, /merged PR link.*completed work.*remaining acceptance criteria.*next steps/);
  assert.match(contract, /Unknown.*do not close.*blocker/);
  assert.match(contract, /partially resolved issue.*automatically closed.*reopen.*evidence/);
  assert.match(contract, /unrelated.*closure.*do not reopen/);
  assert.match(contract, /user decision.*before.*reopening/);
});

test("retries avoid duplicate updates and failures remain visibly pending independently of cleanup", () => {
  assert.match(contract, /Before.*write.*re-read.*state.*comments/);
  assert.match(contract, /same merged PR.*remaining work.*reuse.*existing update/);
  assert.match(contract, /timeout.*re-read.*before retrying/);
  assert.match(contract, /permission.*API.*verification.*merged with issue reconciliation pending/);
  assert.match(contract, /Do not retry.*merge.*failed issue update/);
  assert.match(contract, /cleanup.*independent.*issue reconciliation/);
  assert.match(contract, /no related issues.*only.*complete inventory/);
});

test("README and catalog document verified closure, partial progress, recovery, and pending failures", async () => {
  for (const file of ["../README.md", "../../../site/src/content/skills/pr.md"]) {
    const text = (await read(file)).replace(/\s+/g, " ");
    assert.match(text, /related issues/i);
    assert.match(text, /persist.*inventory.*PR body.*PR comment/i);
    assert.match(text, /fully resolved.*closed/);
    assert.match(text, /partial.*open.*remaining work/);
    assert.match(text, /already-merged.*duplicate/);
    assert.match(text, /merged with issue reconciliation pending/);
  }
});

test("capability evals cover complete, partial, unknown, recovery, and unavailable inventory paths", () => {
  for (const name of [
    "post-merge-complete-and-partial-issues",
    "post-merge-issue-retry-and-permission-failure",
    "post-merge-unknown-and-cross-repository-issues",
    "pre-merge-partial-closing-link",
  ]) {
    const scenario = evalSpec.split(`  - name: ${name}\n`)[1]?.split("\n  - name: ")[0];
    assert.ok(scenario, `missing capability scenario: ${name}`);
    assert.match(scenario, /type: diff-empty/);
    assert.match(scenario, /type: skill-invocation/);
    assert.match(scenario, /required: \[pr\]/);
    assert.match(scenario, /Score 1/);
  }
});
