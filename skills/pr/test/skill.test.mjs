import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  evaluatePrPollTick,
  extractBodyOnlyFindings,
  isErroredCopilotReview,
  parsePrWatchArgs,
} from "../scripts/pr-watch-daemon.mjs";

const skill = (await readFile(new URL("../SKILL.md", import.meta.url), "utf8")).replace(/\r\n/g, "\n");
const evalSpec = (await readFile(new URL("../evals/pr/eval.yaml", import.meta.url), "utf8")).replace(/\r\n/g, "\n");

test("portable skill frontmatter contains name, description, and version metadata", () => {
  const frontmatter = skill.match(/^---\n([\s\S]*?)\n---/);
  assert.ok(frontmatter);
  const keys = [...frontmatter[1].matchAll(/^([a-z][a-z-]*):/gm)].map((match) => match[1]);
  assert.deepEqual(keys, ["name", "description", "metadata"]);
  assert.match(frontmatter[1], /^  version: "[^"\r\n]+"$/m);
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
  assert.match(skill, /including Copilot by default/);
  assert.match(skill, /gh repo view --json owner,isPrivate/);
  assert.match(skill, /explicit user-authorized private-owner exception/);
  assert.match(skill, /both private visibility and the exact allowed owner login/);
  assert.match(skill, /already-pending Copilot requests/);
  assert.match(skill, /never waives posted feedback or other required reviews/);
  assert.match(skill, /Private visibility alone is not an exception/);
  assert.match(skill, /resolve automated\/bot threads/i);
  assert.match(skill, /keep human threads with open questions open/i);
  assert.match(skill, /rebase/i);
  assert.match(skill, /review threads \(including outdated ones\)/);
  assert.match(skill, /submitted, non-dismissed review from every expected reviewer on the full current head OID/);
  assert.match(skill, /COMMENTED is completion, not approval/);
  assert.match(skill, /Green CI, mergeability, empty review requests, and reviewDecision do not prove completion/);
  assert.match(skill, /Every new push invalidates/);
  assert.match(skill, /exact validation commands plus results/);
  assert.match(skill, /preserve its headings, comments, checklist items, and ordering/);
  assert.match(skill, /explicit merge authorization/);
  assert.match(skill, /gh pr merge <number> -R <owner\/repo> --squash --match-head-commit <full-head-OID>/);
  assert.doesNotMatch(skill, /`gh pr merge [^`]*--delete-branch/);
  assert.match(skill, /Never use GitHub auto-merge.*`--admin`, raw API calls, or wrappers/);
  assert.match(skill, /Verify actual merged state afterward/);
  assert.doesNotMatch(skill, /gh pr merge --auto|Copilot never auto-requested on private repos/);
});

test("defaults to squash and branch deletion without destructive worktree cleanup", () => {
  assert.match(skill, /Default to squash merging and deleting the PR branch after merge/);
  assert.match(skill, /replace `--squash` only.*explicitly requests/);
  assert.match(skill, /Verify branch deletion separately/);
  assert.match(skill, /Never force-delete.*remove worktrees.*discard local changes/);
  assert.match(skill, /cleanup is blocked.*merged with cleanup pending/);
});

test("base updates require a verified blocker rather than divergence alone", () => {
  const inspect = skill.split("**Inspect Base**:")[1]?.split("\n")[0];
  const monitor = skill.split("**Base changes**:")[1]?.split("\n")[0];
  assert.ok(inspect);
  assert.ok(monitor);
  assert.match(inspect, /without changing the PR head/);
  assert.match(inspect, /Being behind base alone is not a reason to rebase, merge base.*update-branch/);
  assert.match(inspect, /Update only for confirmed merge conflicts or a verified enforced up-to-date requirement blocking this PR/);
  assert.match(inspect, /use rebase only when necessary to clear that blocker/);
  assert.match(inspect, /Unknown mergeability or unavailable policy evidence.*not speculative rebasing/);
  assert.match(inspect, /required merge queue is not itself a reason to update/);
  assert.match(monitor, /same Inspect Base gate.*monitoring and immediately before merge/);
  assert.match(monitor, /Preserve the head.*pending or passing/);
  assert.match(monitor, /Resolve confirmed conflicts even after submission/);
  assert.match(monitor, /record the blocker and target base OID.*recheck.*before changing the head/);
  assert.match(monitor, /batch known fixes into the same push/);
  assert.match(monitor, /Do not repeat an update unless fresh evidence/);
  assert.match(monitor, /rerun invalidated checks and obtain expected reviews on the new head/);
  assert.match(monitor, /Never bypass required freshness checks or force-push shared branches without explicit confirmation/);
  assert.match(skill, /satisfies applicable enforced base-freshness or merge-queue requirements \(being behind alone is acceptable\)/);
  assert.doesNotMatch(skill, /rebase onto the base branch if behind|rebase\/push if the branch falls behind|PR is submitted, up to date with base/);
});

test("base-update documentation preserves CI without waiving real blockers", async () => {
  for (const file of ["../README.md", "../../../site/src/content/skills/pr.md"]) {
    const text = (await readFile(new URL(file, import.meta.url), "utf8")).replace(/\s+/g, " ");
    assert.match(text, /Being behind base alone.*(?:does not|never) trigger/);
    assert.match(text, /confirmed merge conflicts or a verified enforced up-to-date requirement/);
    assert.match(text, /use rebase only when necessary/i);
    assert.match(text, /before submission, during monitoring, (?:or|and) before merge/);
    assert.match(text, /required merge queue alone/);
    assert.doesNotMatch(text, /an up-to-date base/);
  }
});

test("queue admission waits for confirmed merge and preserves the authorized strategy", () => {
  assert.match(skill, /merge queue.*configured strategy.*authorized strategy/);
  assert.match(skill, /Queue admission is not a merge/);
  assert.match(skill, /wait for GitHub to confirm.*intended head.*before cleanup/);
  assert.match(skill, /Never bundle.*`--delete-branch`/);
});

test("cleanup requires atomic expected-OID deletion rather than check-then-delete", () => {
  assert.match(skill, /Verify the PR head repository, remote, and branch/);
  assert.match(skill, /git push --force-with-lease=refs\/heads\/<branch>:<merged-head-OID> <verified-head-remote> :refs\/heads\/<branch>/);
  assert.match(skill, /git update-ref --no-deref -d refs\/heads\/<branch> <merged-head-OID>/);
  assert.match(skill, /original PR head OID, not the squash\/merge commit/);
  assert.match(skill, /do not refresh the expected OID or retry.*unconditional deletion/);
});

test("merge consent defaults to a fresh head-bound approval, with an invocation-only auto override", () => {
  assert.match(skill, /Default to `--merge=approval`/);
  assert.match(skill, /`--merge=auto`/);
  assert.match(skill, /plain-language.*auto.merge.*ask.*before merging/i);
  assert.match(skill, /Conflicting or unclear.*ask.*do not merge/);
  assert.match(skill, /standing.*do not override.*default/);
  assert.match(skill, /validated `go` handoff.*user-authorization source/);
  assert.match(skill, /only to this invocation/);
  assert.match(skill, /PR, repository, full head OID, and merge strategy/);
  assert.match(skill, /new head or changed strategy invalidates.*confirmation/);
  assert.match(skill, /Auto mode.*without another merge prompt.*all.*gates/);
  assert.match(skill, /declined or unavailable.*awaiting merge approval.*not merged/);
});

test("merge-mode documentation exposes both options and preserves safety gates", async () => {
  for (const file of ["../README.md", "../../../site/src/content/skills/pr.md"]) {
    const text = await readFile(new URL(file, import.meta.url), "utf8");
    assert.match(text, /\/pr --merge=approval/);
    assert.match(text, /\/pr --merge=auto/);
    assert.match(text, /default/i);
    assert.match(text, /GitHub.*--auto/);
    assert.match(text, /default.*squash/i);
    assert.match(text, /delet(?:e|ing) the PR branch afterward/i);
    assert.doesNotMatch(text, /`--squash --delete-branch`/);
    assert.match(text, /expected-OID/);
  }
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

test("long-running delivery distinguishes execution, external waits, and blocked decisions", () => {
  assert.match(skill, /stage, elapsed time, last meaningful result, and next event at least every 60 seconds/);
  assert.match(skill, /host notifications or scheduling rather than tight polling/);
  assert.match(skill, /Distinguish running commands, external review\/CI waits, and blocked approval\/input/);
  assert.match(skill, /exact decision needed and that execution is paused; resume only after that decision/);
  assert.match(skill, /Do not describe wall-clock time as active execution or invent an ETA/);
  assert.match(skill, /exceeds its documented runtime budget or stalls without progress/);
  assert.match(skill, /do not restart expensive checks, weaken gates, or redesign the workflow without authorization/);
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
  assert.match(text, /all actionable feedback \(including review-body-only findings\) is addressed/i);
});

test("review replies identify every fix tersely with actual commit links", () => {
  const comments = skill.split("**Comments**:")[1]?.split("\n")[0];
  assert.ok(comments);
  assert.match(comments, /all actionable findings.*reply to each.*including Copilot/i);
  assert.match(comments, /each fixed finding.*clickable link to the actual fixing commit/i);
  assert.match(comments, /one short sentence or bullet per fix/i);
  assert.match(comments, /group related body-only findings.*each fix identifiable/i);
  assert.match(comments, /no long validation summaries or verbose resolution reports/i);
  assert.match(comments, /unfixed or disputed.*concise, evidence-backed disposition.*never invent a fixing commit/i);
  assert.match(comments, /replying does not replace thread resolution or review\/merge gates/i);
});

test("eval spec covers private repo reviewer rules, comment resolution, and balanced grader weights", () => {
  assert.doesNotMatch(evalSpec, /devx|devy/i);
  const cases = [...evalSpec.matchAll(/^  - name: (.+)$/gm)].map(([, name]) => name);
  assert.deepEqual(cases, [
    "verified-private-owner-exception",
    "long-running-gate-and-approval-wait",
    "other-private-owner-requires-current-head-review",
    "clean-headline-hides-body-only-finding",
    "deduplicate-and-revalidate-review-body-findings",
    "bot-vs-human-comment-resolution",
    "behind-base-preserves-head",
    "verified-base-update-blockers",
    "unknown-mergeability-and-queue",
    "terse-fix-replies-with-commit-links",
    "documentation-preflight-reuse",
    "default-merge-approval",
    "explicit-auto-merge",
    "explicit-approval-overrides-standing-policy",
    "changed-head-needs-fresh-approval",
    "conflicting-merge-modes",
    "squash-and-cleanup-defaults",
    "merge-queue-deferred-cleanup",
    "post-merge-branch-advanced",
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

test("base-update evals distinguish divergence, confirmed blockers, and unknown state", () => {
  const scenario = (name) => {
    const section = evalSpec.split(`  - name: ${name}\n`)[1]?.split("\n  - name: ")[0];
    assert.ok(section, `missing scenario ${name}`);
    assert.match(section, /No commands, edits, agents, or network calls/);
    return section.replace(/\s+/g, " ");
  };
  const behind = scenario("behind-base-preserves-head");
  assert.match(behind, /pending.*passing/);
  assert.match(behind, /before submission.*during monitoring.*before merge/);
  assert.match(behind, /rebase.*merge from base.*update-branch/);
  const blockers = scenario("verified-base-update-blockers");
  assert.match(blockers, /confirmed merge conflicts/);
  assert.match(blockers, /enforced strict up-to-date requirement/);
  assert.match(blockers, /fresh evidence.*new head/);
  const unknown = scenario("unknown-mergeability-and-queue");
  assert.match(unknown, /UNKNOWN/);
  assert.match(unknown, /unavailable/);
  assert.match(unknown, /queue admission is not a merge/i);
});

test("reply eval checks actual fix attribution, body-only grouping, and disputed findings", () => {
  const section = evalSpec.split("  - name: terse-fix-replies-with-commit-links\n")[1]
    ?.split("\n  - name: ")[0];
  assert.ok(section);
  const scenario = section.replace(/\s+/g, " ");
  assert.match(scenario, /https:\/\/github\.com\/sample-owner\/sample-repo\/commit\/a{40}/);
  assert.match(scenario, /https:\/\/github\.com\/sample-owner\/sample-repo\/commit\/b{40}/);
  assert.match(scenario, /body-only.*R30/i);
  assert.match(scenario, /disputed.*no fixing commit/i);
  assert.match(scenario, /one short sentence or bullet per fix/i);
  assert.match(scenario, /Score 1.*omits.*invent.*verbose/i);
  assert.match(scenario, /No commands, edits, agents, or network calls/);
});

test("progress eval preserves gate integrity and distinguishes approval waiting", () => {
  const section = evalSpec.split("  - name: long-running-gate-and-approval-wait\n")[1]
    ?.split("\n  - name: ")[0];
  assert.ok(section);
  const scenario = section.replace(/\s+/g, " ");
  assert.match(scenario, /runtime budget/);
  assert.match(scenario, /approval has not arrived/);
  assert.match(scenario, /at least every 60 seconds/);
  assert.match(scenario, /wall-clock.*active execution/);
  assert.match(scenario, /does not restart.*weaken.*redesign/);
  assert.match(scenario, /No commands, edits, agents, or network calls/);
});

test("review and merge evals distinguish exemptions, completion, approval, and authorization", () => {
  const exception = evalSpec.split("  - name: verified-private-owner-exception\n")[1]
    ?.split("\n  - name: ")[0];
  const nonExempt = evalSpec.split("  - name: other-private-owner-requires-current-head-review\n")[1]
    ?.split("\n  - name: ")[0];
  assert.ok(exception);
  assert.ok(nonExempt);
  assert.match(exception, /doc-doctor, test-doctor/);
  assert.match(exception, /already pending, with posted/);
  assert.match(exception, /required human review/);
  assert.match(exception, /template-preserving PR body/);
  assert.match(exception, /exact validation commands\/results/);
  assert.match(exception, /reject GitHub auto-merge/);
  assert.match(nonExempt, /Copilot approved the previous head/);
  assert.match(nonExempt, /COMMENTED on the new/);
  assert.match(nonExempt, /No merge authorization/);
  assert.match(nonExempt, /actual final-head submitted reviews from every/);
  assert.match(nonExempt, /repository, PR number, authorized strategy and full --match-head-commit/);
  assert.match(nonExempt, /merged-state verification/);
});

test("pr-watch-daemon detects unresolved threads, body-only findings, errored Copilot reviews, and merge readiness", () => {
  const args = parsePrWatchArgs([
    "watch",
    "--repo",
    "jongio/skills",
    "--pr",
    "174",
    "--head",
    "head123",
    "--interval",
    "10",
    "--since-comment-id",
    "500",
  ]);
  assert.equal(args.repo, "jongio/skills");
  assert.equal(args.pr, 174);
  assert.equal(args.head, "head123");
  assert.equal(args.intervalSec, 10);
  assert.equal(args.sinceCommentId, 500);
  assert.throws(() => parsePrWatchArgs(["watch", "--repo", "bad", "--pr", "1"]), /Invalid or missing --repo/);
  assert.throws(() => parsePrWatchArgs(["watch", "--repo", "a/b", "--pr", "0"]), /Invalid or missing --pr/);

  assert.equal(
    isErroredCopilotReview({
      body: "Copilot encountered an error and was unable to review this pull request. You can try again by re-requesting a review.",
    }),
    true
  );

  // 1. Errored Copilot review without active run emits COPILOT_REVIEW_ERROR instead of PR_READY_TO_MERGE
  const erroredTick = evaluatePrPollTick(args, (ghArgs) => {
    if (ghArgs[1] === "graphql") {
      return {
        ok: true,
        stdout: JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                state: "OPEN",
                headRefOid: "head123",
                mergeable: "MERGEABLE",
                mergeStateStatus: "CLEAN",
                reviewDecision: null,
                reviewRequests: { nodes: [] },
                reviews: {
                  nodes: [
                    {
                      databaseId: 901,
                      state: "COMMENTED",
                      commit: { oid: "head123" },
                      author: { login: "copilot-pull-request-reviewer" },
                      body: "Copilot encountered an error and was unable to review this pull request.",
                    },
                  ],
                },
                reviewThreads: { nodes: [] },
                comments: { nodes: [] },
                commits: {
                  nodes: [
                    {
                      commit: {
                        statusCheckRollup: {
                          state: "SUCCESS",
                          contexts: {
                            nodes: [
                              { __typename: "CheckRun", name: "lint", status: "COMPLETED", conclusion: "SUCCESS" },
                            ],
                          },
                        },
                      },
                    },
                  ],
                },
              },
            },
          },
        }),
        stderr: "",
      };
    }
    return { ok: true, stdout: JSON.stringify({ workflow_runs: [] }), stderr: "" };
  });
  assert.equal(erroredTick.events[0].type, "COPILOT_REVIEW_ERROR");

  // 2. Body-only finding ("1 previously missed issue") and unresolved thread emit FEEDBACK_ACTION_NEEDED
  const feedbackTick = evaluatePrPollTick(args, (ghArgs) => {
    if (ghArgs[1] === "graphql") {
      return {
        ok: true,
        stdout: JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                state: "OPEN",
                headRefOid: "head123",
                mergeable: "MERGEABLE",
                mergeStateStatus: "CLEAN",
                reviewDecision: null,
                reviewRequests: { nodes: [] },
                reviews: {
                  nodes: [
                    {
                      databaseId: 902,
                      state: "COMMENTED",
                      commit: { oid: "head123" },
                      author: { login: "copilot-pull-request-reviewer" },
                      body: "### 🔵 Needs a closer look\n**No open issues**\n<details><summary><strong>1 previously missed issue</strong></summary>Fix X</details>",
                    },
                  ],
                },
                reviewThreads: {
                  nodes: [
                    {
                      id: "PRRT_1",
                      isResolved: false,
                      isOutdated: false,
                      path: "src/index.mjs",
                      line: 10,
                      comments: { nodes: [{ databaseId: 77, author: { login: "copilot" }, body: "Fix Y" }] },
                    },
                  ],
                },
                comments: { nodes: [] },
                commits: {
                  nodes: [
                    {
                      commit: {
                        statusCheckRollup: {
                          state: "SUCCESS",
                          contexts: {
                            nodes: [
                              { __typename: "CheckRun", name: "lint", status: "COMPLETED", conclusion: "SUCCESS" },
                            ],
                          },
                        },
                      },
                    },
                  ],
                },
              },
            },
          },
        }),
        stderr: "",
      };
    }
    return { ok: true, stdout: JSON.stringify({ workflow_runs: [] }), stderr: "" };
  });
  assert.equal(feedbackTick.events[0].type, "FEEDBACK_ACTION_NEEDED");
  assert.equal(feedbackTick.events[0].unresolvedThreads.length, 1);
  assert.equal(feedbackTick.events[0].bodyFindings.length, 1);
  assert.equal(feedbackTick.events[0].bodyFindings[0].reviewId, 902);

  // Once a PR comment cites reviewId 902, extractBodyOnlyFindings clears it
  assert.equal(
    extractBodyOnlyFindings(
      [{ databaseId: 902, state: "COMMENTED", commit: { oid: "head123" }, body: "### 🔵 Needs a closer look" }],
      [{ databaseId: 501, body: "Addressed review 902 in commit abc." }],
      "head123"
    ).length,
    0
  );
});

