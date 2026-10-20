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

test("evals distinguish matching preflight evidence from evidence invalidated by edits", () => {
  assert.match(evalSpec, /^  - name: reuse-valid-work$/m);
  assert.match(evalSpec, /^  - name: invalidate-stale-work[\s\S]*base and changeset have changed[\s\S]*Reruns affected checks/m);
});

test("catalog body makes both required skills visible beyond the generic install widget", async () => {
  const catalog = await readFile(new URL("../../../site/src/content/skills/go.md", import.meta.url), "utf8");
  const body = catalog.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "");
  assert.match(body, /Requires `test-doctor` and `pr`/);
});
