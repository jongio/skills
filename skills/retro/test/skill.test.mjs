import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const [skill, safety, readme, evals, evalReadme, packageText, lockText] = await Promise.all([
  read("../SKILL.md"),
  read("../references/closeout-safety.md"),
  read("../README.md"),
  read("../evals/retro/eval.yaml"),
  read("../evals/README.md"),
  read("../package.json"),
  read("../package-lock.json"),
]);
const normalized = (text) => text.replace(/\s+/g, " ");

function includesAll(text, phrases) {
  for (const phrase of phrases) {
    assert.ok(normalized(text).includes(phrase), `Missing contract: ${phrase}`);
  }
}

test("portable skill frontmatter contains only name and description", () => {
  const frontmatter = skill.match(/^---\n([\s\S]*?)\n---/);
  assert.ok(frontmatter);
  const keys = [...frontmatter[1].matchAll(/^([a-z][a-z-]*):/gm)].map((match) => match[1]);
  assert.deepEqual(keys, ["name", "description"]);
  assert.match(frontmatter[1], /^name: retro$/m);
  assert.ok(skill.split("\n").length <= 500);
  const description = frontmatter[1].split("description: >-\n")[1].trim();
  assert.ok(normalized(description).length <= 1024);
  includesAll(description, ["USE FOR:", "DO NOT USE FOR:", "session retrospective"]);
});

test("skill includes workflow, safety, and exit criteria", () => {
  assert.match(skill, /^## Workflow$/m);
  assert.match(skill, /^## Safety$/m);
  assert.match(skill, /^## Exit Criteria$/m);
});

test("ledger covers feedback, evidence gaps, and explicit dispositions", () => {
  includesAll(skill, [
    "user turns, corrections, and relevant results, not merely an assistant summary",
    "Paginate within the selected session",
    "follow-up tasks, negative constraints",
    "wording and UX corrections",
    "Split compound requests",
    "**verified**",
    "**open**",
    "**blocked**",
    "**deferred**",
    "**superseded**",
    "Only explicit user direction can defer or cancel work",
    "Do not mark blocked or deferred obligations done",
    "**Complete with explicit deferrals**",
    "**Incomplete**",
  ]);
});

test("bare retro audits and fix mode explicitly opts into authorized changes", () => {
  includesAll(skill, [
    "`/retro`: inspect and report; no project or skill edits, task status writes, Git mutations",
    "`/retro fix`: audit, complete outstanding authorized work",
    "An explicit current natural-language request to fix outstanding work or update used skills also selects fix mode",
    "A question about whether the session is done selects audit mode",
    "In audit mode, keep the ledger in the response without persisting it",
    "In fix mode, finish open work already authorized",
    "Do not run commands that write generated artifacts",
    "A subsequent edit invalidates checks",
    "Read known background-agent results",
    "Audit mode is read-only even if an earlier message approved edits",
    "An invocation of `/retro fix` is not blanket deletion or merge approval",
  ]);
  for (const text of [skill, readme, evals, evalReadme]) {
    assert.doesNotMatch(text, /audit-only|normal.mode/i);
    assert.match(text, /\/retro fix/);
  }
});

test("skill changes require real usage and verified authoritative source", () => {
  includesAll(skill, [
    "invocation records and conversation evidence",
    "Keep correct instructions unchanged",
    "installed plugin bundles, package caches, generated copies",
    "**ask the user where the skill's source lives**",
    "Do not guess, search the whole disk",
    "never edit every same-name copy",
    "Preserve unrelated edits and stop on conflicts",
    "synthetic examples",
    "Do not turn a one-session preference into a global rule",
    "Source edits are not automatically installed",
  ]);
});

test("PR gates preserve expected reviewers, current-head completion, and exact exception", () => {
  includesAll(safety, [
    "Devy supplements the built-in `/pr` command",
    '{"copilot":true,"expectedReviewers":[]}',
    "Verify GitHub repository owner and visibility",
    "**Only for PRIVATE repositories owned by jongio**",
    "including already-pending Copilot requests",
    "Configure other expected reviewers by login",
    "before requesting them",
    "Wait for every expected review to complete on that current head",
    "**COMMENTED** review counts as completion, not approval",
    "empty **reviewDecision** are not review-completion evidence",
    "including outdated ones",
    "Any new commit restarts current-head review",
    "gh pr merge NUMBER -R OWNER/REPO --match-head-commit FULL_SHA",
    "structured `merge_pull_request` with `sha`",
    "Do not bypass a denial with wrappers, scripts, raw APIs, admin, or deferred auto-merge",
    "read GitHub state to verify",
  ]);
});

test("cleanup uses existing proof with independent approval and fresh identities", () => {
  includesAll(skill, ["installed `git-tidy` skill's proof", "no candidates", "successful scoped inventory"]);
  includesAll(safety, [
    "isolated remote verification",
    "Tracked, staged, untracked, and ignored content",
    "A clean tracked diff alone is insufficient",
    "content proof",
    "Unknown ownership/use means retain",
    "Keep the current worktree and primary worktree",
    "Do not unlock, force-delete, discard, stash, or move work",
    "Approval of local cleanup does not approve remote branch deletion",
    "revalidate those same identities and preconditions",
    "obtain a new preview/approval",
    "report the partial result",
  ]);
});

test("non-interactive merge example pins the head and selects exactly one method", () => {
  const commands = safety.match(/^gh pr merge .+$/gm) ?? [];
  assert.equal(commands.length, 1);
  const args = commands[0].split(/\s+/);
  assert.equal(args.filter((arg) => ["--merge", "--squash", "--rebase"].includes(arg)).length, 1);
  assert.equal(args[args.indexOf("--match-head-commit") + 1], "FULL_SHA");
  assert.equal(args[args.indexOf("-R") + 1], "OWNER/REPO");
  assert.equal(args[3], "NUMBER");
  assert.doesNotMatch(commands[0], /--auto|--admin|[;&|]/);
  includesAll(safety, [
    "repository-allowed and user-authorized merge method",
    "`--match-head-commit` pins the head; it does not select a merge method",
    "ask before choosing one",
  ]);
});

test("local documentation links resolve inside the skill package", async () => {
  const documents = [
    ["../SKILL.md", skill],
    ["../README.md", readme],
    ["../references/closeout-safety.md", safety],
    ["../evals/README.md", evalReadme],
  ];
  const root = new URL("../", import.meta.url);
  for (const [path, text] of documents) {
    for (const [, target] of text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      if (/^(?:https?:|#)/.test(target)) continue;
      const url = new URL(target.split("#")[0], new URL(path, import.meta.url));
      assert.ok(url.href.startsWith(root.href), `Link escapes skill: ${target}`);
      await readFile(url);
    }
  }
});

test("eval roster covers each distinct closeout failure mode", () => {
  const names = [...evals.matchAll(/^  - name: (.+)$/gm)].map((match) => match[1]);
  assert.deepEqual(names, [
    "reconcile-missed-correction",
    "missing-history-and-running-agent",
    "unknown-skill-source",
    "source-improvement-not-global-preference",
    "public-pr-current-head-review",
    "private-owner-copilot-exception",
    "other-private-owner-and-commented-review",
    "merged-branch-with-new-work",
    "cleanup-revalidation-and-partial-failure",
    "deferral-supersession-and-no-gratuitous-edit",
    "denial-is-not-a-merge-bypass",
    "authorized-gap-is-work-not-just-advice",
    "bare-retro-is-read-only-despite-prior-approval",
  ]);
  assert.equal((evals.match(/^    rubric:/gm) ?? []).length, names.length);
  assert.equal((evals.match(/^      - type: prompt$/gm) ?? []).length, names.length);
  assert.equal((evals.match(/^          threshold: 0\.9$/gm) ?? []).length, names.length);
  includesAll(evalReadme, ["Neither is an agent behavior result", "Only after approval for agent usage"]);
});

test("package scripts and lock agree on the existing Vally toolchain", () => {
  const pkg = JSON.parse(packageText);
  const lock = JSON.parse(lockText);
  assert.equal(pkg.name, "retro");
  assert.equal(lock.name, pkg.name);
  assert.equal(lock.packages[""].name, pkg.name);
  assert.deepEqual(lock.packages[""].devDependencies, pkg.devDependencies);
  assert.equal(pkg.scripts.test, "node --test test/*.test.mjs");
  assert.equal(pkg.scripts["eval:lint"], "vally lint --eval-spec evals/retro/eval.yaml --strict");
  assert.equal(
    lock.packages["node_modules/@microsoft/vally-cli"].version,
    pkg.devDependencies["@microsoft/vally-cli"],
  );
});
