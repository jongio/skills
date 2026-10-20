import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const skill = (await readFile(new URL("../SKILL.md", import.meta.url), "utf8")).replace(/\r\n/g, "\n");
const evalSpec = await readFile(new URL("../evals/pr/eval.yaml", import.meta.url), "utf8");

test("portable skill frontmatter contains only name and description", () => {
  const frontmatter = skill.match(/^---\n([\s\S]*?)\n---/);
  assert.ok(frontmatter);
  const keys = [...frontmatter[1].matchAll(/^([a-z][a-z-]*):/gm)].map((match) => match[1]);
  assert.deepEqual(keys, ["name", "description"]);
  assert.match(frontmatter[1], /^name: pr$/m);
});

test("skill includes workflow, safety, and exit criteria", () => {
  assert.match(skill, /^## Workflow$/m);
  assert.match(skill, /^## Safety$/m);
  assert.match(skill, /^## Exit Criteria$/m);
});

test("workflow remains concise and covers preflight, review routing, monitoring, and merge", () => {
  assert.ok(skill.split("\n").length <= 60, "keep SKILL.md short and sweet");
  assert.doesNotMatch(skill, /devx|devy/i);
  assert.match(skill, /create a dedicated PR branch first/i);
  assert.match(skill, /commit intended uncommitted changes first/i);
  assert.match(skill, /npx skills add jongio\/skills --skill test-doctor/);
  assert.match(skill, /light security review/i);
  assert.match(skill, /linter and build/i);
  assert.match(skill, /Never automatically add Copilot as a reviewer on \*\*private\*\* repositories/);
  assert.match(skill, /resolve automated\/bot threads/i);
  assert.match(skill, /keep human threads with open questions open/i);
  assert.match(skill, /rebase/i);
  assert.match(skill, /auto-merge/i);
});

test("review inventory includes full bodies rather than trusting clean summary counts", () => {
  const text = skill.replace(/\s+/g, " ");
  assert.match(text, /all submitted review bodies, PR conversation comments, inline review comments, and review threads/i);
  assert.match(text, /Paginate every collection/i);
  assert.match(text, /nested `<details>`\/`<summary>`/);
  assert.match(text, /previously missed/i);
  assert.match(text, /unchanged code/i);
  assert.match(text, /"No open issues".*not proof that feedback is clear/i);
});

test("owns documentation preflight with identity-bound reuse and missing-skill blocking", () => {
  assert.equal((skill.match(/Invoke `doc-doctor`/g) ?? []).length, 1);
  assert.match(skill, /on the diff and affected docs/);
  assert.match(skill, /this check belongs here, not in `go`/);
  assert.match(skill, /same worktree, base, changeset, and scope; rerun checks invalidated by later edits/);
  assert.match(skill, /Reuse matching passing evidence.*rerun only when invalidated/);
  assert.match(skill, /If unavailable, stop and prompt to install.*--skill doc-doctor/);
});

test("catalog body has a copyable install command with every required skill", async () => {
  const catalog = await readFile(new URL("../../../site/src/content/skills/pr.md", import.meta.url), "utf8");
  const body = catalog.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "");
  assert.match(body, /```sh\r?\nnpx skills add jongio\/skills --skill pr --skill test-doctor --skill doc-doctor -g --agent github-copilot\r?\n```/);
});

test("body-only findings get evidence-backed disposition without fake thread resolution", () => {
  const text = skill.replace(/\s+/g, " ");
  assert.match(text, /Deduplicate.*review ID.*heading.*file\/line/i);
  assert.match(text, /revalidate older findings against the current head/i);
  assert.match(text, /body-only finding.*PR comment citing its review ID and heading/i);
  assert.match(text, /no thread to resolve/i);
  assert.match(text, /body-only findings.*addressed.*merge/i);
});

test("eval spec covers private repo reviewer rules, comment resolution, and balanced grader weights", () => {
  assert.doesNotMatch(evalSpec, /devx|devy/i);
  const cases = [...evalSpec.matchAll(/^  - name: (.+)$/gm)].map(([, name]) => name);
  assert.deepEqual(cases, [
    "private-repo-skips-auto-copilot-review",
    "clean-headline-hides-body-only-finding",
    "deduplicate-and-revalidate-review-body-findings",
    "bot-vs-human-comment-resolution",
    "documentation-preflight-reuse",
  ]);
  assert.equal((evalSpec.match(/type: diff-empty/g) ?? []).length, cases.length);
  assert.equal((evalSpec.match(/type: skill-invocation/g) ?? []).length, cases.length);
  assert.match(evalSpec, /\*\*No open issues\*\*[\s\S]*<details>[\s\S]*previously missed[\s\S]*<details>/);
  assert.match(evalSpec, /finding exists only in review R17/);
  const weights = Object.fromEntries(
    [...evalSpec.matchAll(/^    (prompt|diff-empty|skill-invocation): ([\d.]+)$/gm)]
      .map(([, type, weight]) => [type, Number(weight)]),
  );
  assert.equal(Object.keys(weights).length, 3);
  assert.ok(Math.abs(Object.values(weights).reduce((a, b) => a + b, 0) - 1) < 0.000001);
  const threshold = Number(evalSpec.match(/^  threshold: ([\d.]+)$/m)[1]);
  for (const requiredGrader of ["diff-empty", "skill-invocation"]) {
    const scoreWithoutRequired = 1 - weights[requiredGrader];
    assert.ok(
      scoreWithoutRequired < threshold,
      `${requiredGrader} failure must prevent passing threshold`,
    );
  }
});
