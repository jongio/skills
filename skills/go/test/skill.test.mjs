import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const skill = await readFile(new URL("../SKILL.md", import.meta.url), "utf8");
const pr = await readFile(new URL("../../pr/SKILL.md", import.meta.url), "utf8");
const evalSpec = await readFile(new URL("../evals/go/eval.yaml", import.meta.url), "utf8");

test("portable skill frontmatter contains only name and description", () => {
  const frontmatter = skill.match(/^---\n([\s\S]*?)\n---/);
  assert.ok(frontmatter);
  const keys = [...frontmatter[1].matchAll(/^([a-z][a-z-]*):/gm)].map((match) => match[1]);
  assert.deepEqual(keys, ["name", "description"]);
  assert.match(frontmatter[1], /^name: go$/m);
});

test("skill includes workflow, safety, and exit criteria", () => {
  assert.match(skill, /^## Workflow$/m);
  assert.match(skill, /^## Safety$/m);
  assert.match(skill, /^## Exit Criteria$/m);
});

test("plans, tests, implements, and reviews before invoking pr without copying its delivery logic", () => {
  assert.match(skill, /^1\..*plan[\s\S]*^2\..*Invoke `test-doctor fix`[\s\S]*^3\..*Implement[\s\S]*^4\..*Review[\s\S]*^5\..*Invoke `jongio\/pr`/m);
  assert.match(skill, /passing test\/review evidence/);
  assert.doesNotMatch(skill, /git (?:commit|push|rebase)|gh pr (?:create|merge)|--auto/);
  assert.match(pr, /Reuse passing preflight evidence only for the same worktree, base, changeset, and scope; rerun checks invalidated by later edits\./);
});

test("preserves approvals, reports missing dependencies, and verifies actual completion", () => {
  assert.match(skill, /approval boundaries/);
  assert.match(skill, /required skill is unavailable.*stop and report/);
  assert.match(skill, /GitHub confirms the intended head merged, required reviews completed, and no actionable findings remain/);
});

test("defaults to approval and forwards explicit invocation-only merge choices to pr", () => {
  assert.match(skill, /Default to `--merge=approval`/);
  assert.match(skill, /`--merge=auto`/);
  assert.match(skill, /plain-language.*auto.merge.*ask.*before merging/i);
  assert.match(skill, /Conflicting or unclear.*ask.*do not merge/);
  assert.match(skill, /standing.*do not override.*default/);
  assert.match(skill, /merge mode and its user-authorization source/);
  assert.match(skill, /only to this invocation and its `pr` handoff/);
  assert.match(skill, /awaiting merge approval.*not merged/);
});

test("merge-mode evals cover default, explicit overrides, and ambiguous input", () => {
  for (const name of ["default-merge-approval", "auto-merge-handoff", "explicit-approval-override", "conflicting-merge-modes"]) {
    assert.ok(evalSpec.includes(`  - name: ${name}\n`));
  }
});

test("defaults to squash and branch cleanup in the pr handoff", () => {
  assert.match(skill, /Default to squash merging and deleting the PR branch after merge/);
  assert.match(skill, /merge strategy and branch-cleanup choice/);
});

test("published go usage documents approval, auto, squash, and cleanup defaults", async () => {
  for (const file of ["../README.md", "../../../site/src/content/skills/go.md"]) {
    const text = await readFile(new URL(file, import.meta.url), "utf8");
    assert.match(text, /\/go --merge=approval/);
    assert.match(text, /\/go --merge=auto/);
    assert.match(text, /default.*squash/i);
    assert.match(text, /delet(?:e|ing) the PR branch afterward/i);
  }
});

test("delegates the documentation pass to pr rather than running it twice", () => {
  assert.match(skill, /Leave `doc-doctor` to `pr`; do not invoke it separately/);
  assert.doesNotMatch(skill, /Invoke `doc-doctor`/i);
  assert.equal((pr.match(/Invoke `doc-doctor`/g) ?? []).length, 1);
  assert.match(pr, /this check belongs here, not in `go`/);
  assert.match(pr, /Reuse matching passing evidence.*rerun only when invalidated/);
  assert.match(evalSpec, /^  - name: documentation-single-owner$/m);
});

test("evals distinguish matching preflight evidence from evidence invalidated by edits", () => {
  assert.match(evalSpec, /^  - name: reuse-valid-work$/m);
  assert.match(evalSpec, /^  - name: invalidate-stale-work[\s\S]*base and changeset have changed[\s\S]*Reruns affected checks/m);
});

test("catalog body has a copyable install command with every required skill", async () => {
  const catalog = await readFile(new URL("../../../site/src/content/skills/go.md", import.meta.url), "utf8");
  const body = catalog.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "");
  assert.match(body, /Requires `test-doctor` and `pr`/);
  assert.match(body, /`doc-doctor`/);
  assert.match(body, /```sh\r?\nnpx skills add jongio\/skills --skill go --skill test-doctor --skill pr --skill doc-doctor -g --agent github-copilot\r?\n```/);
});
