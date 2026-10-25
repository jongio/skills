import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  computeAdaptivePrIntervalSec,
  computePrPhase,
  createPrWatchState,
  evaluateMultiPrPollTick,
  evaluatePrPollTick,
  extractBodyOnlyFindings,
  isErroredCopilotReview,
  parseGhApiArgs,
  parsePrWatchArgs,
  requestCopilotReview,
  shouldEmitPrWatchStatus,
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
    "post-merge-complete-and-partial-issues",
    "post-merge-issue-retry-and-permission-failure",
    "post-merge-unknown-and-cross-repository-issues",
    "pre-merge-partial-closing-link",
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
                      submittedAt: "2026-10-22T20:00:00Z",
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
                      submittedAt: "2026-10-22T20:00:00Z",
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

  // Once a PR comment cites reviewId 902 after submittedAt, extractBodyOnlyFindings clears it;
  // an older comment created before review.submittedAt does NOT clear it, and an unaddressed
  // CHANGES_REQUESTED review on an older commit remains blocking.
  assert.equal(
    extractBodyOnlyFindings(
      [
        {
          databaseId: 902,
          state: "COMMENTED",
          submittedAt: "2026-10-22T20:00:00Z",
          commit: { oid: "head123" },
          body: "### 🔵 Needs a closer look",
        },
      ],
      [{ databaseId: 501, createdAt: "2026-10-22T19:00:00Z", body: "Addressed review 902 early." }],
      "head123"
    ).length,
    1
  );
  assert.equal(
    extractBodyOnlyFindings(
      [
        {
          databaseId: 902,
          state: "COMMENTED",
          submittedAt: "2026-10-22T20:00:00Z",
          commit: { oid: "head123" },
          body: "### 🔵 Needs a closer look",
        },
      ],
      [{ databaseId: 501, createdAt: "2026-10-22T20:05:00Z", body: "Addressed review 902 in commit abc." }],
      "head123"
    ).length,
    0
  );
  assert.equal(
    extractBodyOnlyFindings(
      [
        {
          databaseId: 888,
          state: "CHANGES_REQUESTED",
          submittedAt: "2026-10-22T20:00:00Z",
          author: { login: "alice" },
          commit: { oid: "olderhead" },
          body: "",
        },
        {
          databaseId: 889,
          state: "COMMENTED",
          submittedAt: "2026-10-22T20:05:00Z",
          author: { login: "alice" },
          commit: { oid: "head123" },
          body: "Please also check the timeout before merging.",
        },
      ],
      [],
      "head123"
    ).length,
    2,
    "Later COMMENTED review must not clear earlier CHANGES_REQUESTED decision, and unclassified COMMENTED body must surface"
  );

  // Partial disposition of a multi-concern body leaves unsettled concerns active
  const multiConcernBody =
    "### 🟡 Changes recommended\n- [Fix timeout](https://github.com/o/r/pull/1#discussion_r1)\n- [Fix pagination](https://github.com/o/r/pull/1#discussion_r2)";
  const partialFindings = extractBodyOnlyFindings(
    [
      {
        databaseId: 905,
        state: "COMMENTED",
        submittedAt: "2026-10-22T20:00:00Z",
        author: { login: "copilot-pull-request-reviewer" },
        commit: { oid: "head123" },
        body: multiConcernBody,
      },
    ],
    [{ databaseId: 600, createdAt: "2026-10-22T20:05:00Z", body: "Review 905: addressed Fix timeout." }],
    "head123"
  );
  assert.equal(partialFindings.length, 1);
  assert.deepEqual(partialFindings[0].unsettledConcerns, ["Fix pagination"]);

  // A review with both a resolved inline link and unlinked actionable prose still retains the prose finding
  const mixedResolvedAndProse = `### 🟡 Changes recommended\n\nAlso fix the unlinked timeout race in the worker.\n\n- [Resolved item](https://github.com/o/r/pull/1#discussion_r4354371458)`;
  const mixedFindings = extractBodyOnlyFindings(
    [
      {
        databaseId: 906,
        state: "COMMENTED",
        submittedAt: "2026-10-23T03:29:22Z",
        author: { login: "copilot-pull-request-reviewer" },
        commit: { oid: "0b6d67c7" },
        body: mixedResolvedAndProse,
      },
    ],
    [],
    "0b6d67c7",
    new Set([4354371458])
  );
  assert.equal(mixedFindings.length, 1);
  assert.equal(mixedFindings[0].reviewId, 906);

  // A review with "### 🔵 Needs a closer look" + "No open issues" + "<details>1 resolved since last review" (#discussion_r...)
  // MUST still surface as a body-only finding until cited in a PR comment!
  const needsCloserLookWithResolvedLink = `<!-- ccr-overview-v2 -->\n\n### 🔵 Needs a closer look\n\nWatched-run validation still permits silently unmonitored requests.\n\n**No open issues** 🎉\n\n<details>\n<summary><strong>1 resolved since last review</strong></summary>\n\n- [Surface uncached discovery errors](https://github.com/jongio/skills/pull/174#discussion_r4355767769)\n</details>`;
  const closerLookFindings = extractBodyOnlyFindings(
    [
      {
        databaseId: 5623556560,
        state: "COMMENTED",
        submittedAt: "2026-10-23T03:29:22Z",
        author: { login: "copilot-pull-request-reviewer" },
        commit: { oid: "0b6d67c7" },
        body: needsCloserLookWithResolvedLink,
      },
    ],
    [],
    "0b6d67c7",
    new Set([4355767769])
  );
  assert.equal(closerLookFindings.length, 1);
  assert.equal(closerLookFindings[0].reviewId, 5623556560);

  // 4. --no-copilot ignores pending Copilot requests, Team requests stay pending,
  // --expected-reviewers requires current-head review, and REVIEW_REQUIRED blocks PR_READY_TO_MERGE
  const gatedArgs = parsePrWatchArgs([
    "watch",
    "--repo",
    "jongio/skills",
    "--pr",
    "175",
    "--head",
    "head123",
    "--no-copilot",
    "--expected-reviewers",
    "alice",
    "--since-comment-id",
    "0",
  ]);
  assert.equal(gatedArgs.hasExplicitSinceCommentId, true);
  assert.deepEqual(gatedArgs.expectedReviewers, ["alice"]);

  const blockedByExpectedReviewer = evaluatePrPollTick(gatedArgs, (ghArgs) => {
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
                reviewDecision: "APPROVED",
                reviewRequests: {
                  nodes: [{ requestedReviewer: { __typename: "Bot", login: "copilot-pull-request-reviewer" } }],
                },
                reviews: {
                  nodes: [
                    {
                      databaseId: 910,
                      state: "APPROVED",
                      submittedAt: "2026-10-22T20:00:00Z",
                      commit: { oid: "olderhead" },
                      author: { login: "alice" },
                      body: "LGTM on old head",
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
                            nodes: [{ __typename: "CheckRun", name: "lint", status: "COMPLETED", conclusion: "SUCCESS" }],
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
  assert.equal(blockedByExpectedReviewer.events.length, 0);
  assert.deepEqual(blockedByExpectedReviewer.status.pendingReviewers, ["alice"]);

  // Unavailable workflow_runs inventory surfaces POLL_ERROR instead of assuming idle Copilot
  const workflowErrTick = evaluatePrPollTick(args, (ghArgs) => {
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
                reviewDecision: "APPROVED",
                reviewRequests: { nodes: [] },
                reviews: { nodes: [] },
                reviewThreads: { nodes: [] },
                comments: { nodes: [] },
                commits: { nodes: [] },
              },
            },
          },
        }),
        stderr: "",
      };
    }
    return { ok: false, stdout: "", stderr: "HTTP 503" };
  });
  assert.equal(workflowErrTick.events[0].type, "POLL_ERROR");
  assert.match(workflowErrTick.error, /503/);

  // 5. CI_FAILED is emitted when statusCheckRollup fails, and activeWorkflowRuns blocks readiness when checks haven't started
  const ciFailedTick = evaluatePrPollTick(args, (ghArgs) => {
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
                mergeStateStatus: "UNSTABLE",
                reviewDecision: null,
                reviewRequests: { nodes: [] },
                reviews: { nodes: [] },
                reviewThreads: { nodes: [] },
                comments: { nodes: [] },
                commits: {
                  nodes: [
                    {
                      commit: {
                        statusCheckRollup: {
                          state: "FAILURE",
                          contexts: {
                            nodes: [
                              {
                                __typename: "CheckRun",
                                name: "Detect statusline changes",
                                status: "COMPLETED",
                                conclusion: "FAILURE",
                                detailsUrl: "https://github.com/jongio/skills/actions/runs/1/job/2",
                              },
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
    return {
      ok: true,
      stdout: JSON.stringify({
        workflow_runs: [
          {
            id: 10,
            workflow_id: 1,
            name: "Statusline performance",
            event: "pull_request",
            head_branch: "feat/x",
            status: "completed",
            conclusion: "failure",
            html_url: "https://github.com/jongio/skills/actions/runs/1",
          },
        ],
      }),
      stderr: "",
    };
  });
  assert.equal(ciFailedTick.events[0].type, "CI_FAILED");
  assert.equal(ciFailedTick.events[0].failedChecks.length, 2);
  assert.ok(ciFailedTick.events[0].remediation);

  // 3. Phase-transition wakeup: emits PHASE_CHANGED when CI transitions from running to passed while Copilot reviews
  const phaseInfo = computePrPhase({
    totalChecksCount: 7,
    passedChecksCount: 5,
    pendingChecks: ["lint", "git-tidy-tests"],
    expectCopilot: true,
    copilotWorkflowActive: true,
  });
  assert.equal(phaseInfo.phase, "ci:running|review:copilot-reviewing");
  assert.match(phaseInfo.summary, /CI running \(5\/7 passed; active: lint, git-tidy-tests\) \| Copilot is reviewing/);

  const phaseChangeArgs = parsePrWatchArgs([
    "watch",
    "--repo",
    "jongio/skills",
    "--pr",
    "174",
    "--head",
    "head123",
    "--last-phase",
    "ci:running|review:copilot-reviewing",
  ]);
  const phaseChangedTick = evaluatePrPollTick(phaseChangeArgs, (ghArgs) => {
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
                reviewRequests: {
                  nodes: [{ requestedReviewer: { __typename: "Bot", login: "copilot-pull-request-reviewer" } }],
                },
                reviews: { nodes: [] },
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
    return {
      ok: true,
      stdout: JSON.stringify({
        workflow_runs: [{ name: "Running Copilot Code Review", status: "in_progress" }],
      }),
      stderr: "",
    };
  });
  assert.equal(phaseChangedTick.events.length, 1);
  assert.equal(phaseChangedTick.events[0].type, "PHASE_CHANGED");
  assert.equal(phaseChangedTick.events[0].previousPhase, "ci:running|review:copilot-reviewing");
  assert.equal(phaseChangedTick.events[0].phase, "ci:passed|review:copilot-reviewing");
  assert.equal(phaseChangedTick.events[0].summary, "CI passed (1/1) | Copilot is reviewing");
});

test("Copilot reviewer aliases match without weakening review gates", async (t) => {
  const head = "a".repeat(40);
  const aliases = [
    "copilot",
    "copilot-pull-request-reviewer",
    "copilot-pull-request-reviewer[bot]",
    "github-copilot",
    "github-copilot[bot]",
  ];
  function poll({
    expected = "copilot",
    author = "copilot-pull-request-reviewer",
    review = {},
    pr = {},
    workflowRuns = [],
    noCopilot = false,
  } = {}) {
    const args = parsePrWatchArgs([
      "once", "--repo", "example/skills", "--pr", "7", "--head", head,
      "--expected-reviewers", expected, "--max-copilot-retries", "0",
      ...(noCopilot ? ["--no-copilot"] : []),
    ]);
    const pullRequest = {
      state: "OPEN",
      headRefOid: head,
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      reviewDecision: "APPROVED",
      reviewRequests: { nodes: [] },
      reviews: { nodes: [{
        databaseId: 1,
        state: "APPROVED",
        submittedAt: "2026-01-01T00:00:00Z",
        commit: { oid: head },
        author: { login: author },
        body: "Looks good.",
        ...review,
      }] },
      reviewThreads: { nodes: [] },
      comments: { nodes: [] },
      commits: { nodes: [{ commit: { statusCheckRollup: {
        state: "SUCCESS",
        contexts: { nodes: [{
          __typename: "CheckRun", name: "tests", status: "COMPLETED", conclusion: "SUCCESS",
        }] },
      } } }] },
      ...pr,
    };
    return evaluatePrPollTick(args, (ghArgs) => {
      assert.equal(ghArgs[0], "api");
      if (ghArgs[1] === "graphql") {
        return {
          ok: true,
          stdout: JSON.stringify({ data: { repository: { pullRequest } } }),
          stderr: "",
        };
      }
      assert.ok(ghArgs[1].startsWith("repos/example/skills/actions/runs?"));
      return { ok: true, stdout: JSON.stringify({ workflow_runs: workflowRuns }), stderr: "" };
    });
  }

  await t.test("matches all supported expected and returned Copilot names", () => {
    for (const expected of [...aliases, " CoPiLoT "]) {
      for (const author of [...aliases, "CoPiLoT-Pull-Request-Reviewer[BoT]"]) {
        const result = poll({ expected, author });
        assert.equal(result.events[0]?.type, "PR_READY_TO_MERGE", `${expected} / ${author}`);
        assert.equal(result.events[0].headRefOid, head);
      }
    }
    assert.equal(poll({ expected: aliases.join(",") }).events[0]?.type, "PR_READY_TO_MERGE");
  });

  await t.test("COMMENTED completes review without claiming approval", () => {
    const result = poll({
      review: { state: "COMMENTED", body: "### 🟢 Approval recommended\n\n**No open issues**" },
      pr: { reviewDecision: null },
    });
    assert.equal(result.events[0]?.type, "PR_READY_TO_MERGE");
    assert.equal(result.events[0].reviewDecision, null);
  });

  await t.test("requires a submitted current-head review and separate approval gates", () => {
    for (const [name, options, count] of [
      ["missing", { pr: { reviews: { nodes: [] } } }, 0],
      ["stale", { review: { commit: { oid: "b".repeat(40) } } }, 0],
      ["dismissed", { review: { state: "DISMISSED" } }, 0],
      ["draft", { review: { state: "PENDING" } }, 0],
      ["unsubmitted", { review: { submittedAt: null } }, 0],
      ["requested", { pr: { reviewRequests: { nodes: [{
        requestedReviewer: { __typename: "Bot", login: "copilot-pull-request-reviewer" },
      }] } } }, 1],
      ["running", { workflowRuns: [{
        id: 2, name: "Running Copilot Code Review", status: "in_progress",
      }] }, 1],
      ["approval required", { pr: { reviewDecision: "REVIEW_REQUIRED" } }, 1],
      ["changes requested", { pr: { reviewDecision: "CHANGES_REQUESTED" } }, 1],
    ]) {
      const result = poll(options);
      assert.ok(!result.events.some((event) => event.type === "PR_READY_TO_MERGE"), name);
      assert.equal(result.status?.validHeadCopilotReviewsCount, count, name);
    }
    assert.equal(
      poll({ review: {
        state: "COMMENTED",
        body: "Copilot encountered an error and was unable to review this pull request.",
      } }).events[0]?.type,
      "COPILOT_REVIEW_ERROR",
    );
    assert.equal(poll({ pr: { headRefOid: "b".repeat(40) } }).events[0]?.type, "HEAD_CHANGED");
    assert.equal(poll({ review: { state: "COMMENTED" } }).events[0]?.type, "FEEDBACK_ACTION_NEEDED");
  });

  await t.test("keeps unrelated reviewers and lookalike names distinct", () => {
    const missingHuman = poll({ expected: "copilot,alice" });
    assert.deepEqual(missingHuman.status?.pendingReviewers, ["alice"]);
    const lookalike = poll({ expected: "copilot-helper" });
    assert.deepEqual(lookalike.status?.pendingReviewers, ["copilot-helper"]);
    assert.equal(
      poll({ author: "ALICE", expected: "alice", noCopilot: true }).events[0]?.type,
      "PR_READY_TO_MERGE",
    );
  });
});

test("requestCopilotReview cancels superseded branch runs, toggles existing requests, and guards head/state", () => {
  assert.match(skill, /--body-file.*@'\.\.\.'@/i);
  assert.match(skill, /pr-watch-daemon\.mjs request-copilot/);
  assert.match(skill, /cross-model `rubber-duck` sub-agent review/);

  // 0. Rejects missing --head in parsePrWatchArgs and requestCopilotReview without performing mutations
  assert.throws(
    () => parsePrWatchArgs(["request-copilot", "--repo", "jongio/skills", "--pr", "177"]),
    /Missing or invalid --head/
  );
  const unpinnedCalls = [];
  const unpinnedRes = requestCopilotReview(
    { mode: "request-copilot", repo: "jongio/skills", pr: 177, head: "" },
    (ghArgs) => {
      unpinnedCalls.push(ghArgs);
      return { ok: true, stdout: "{}", stderr: "" };
    }
  );
  assert.equal(unpinnedRes.ok, false);
  assert.equal(unpinnedRes.status, "missing_head");
  assert.equal(unpinnedCalls.length, 0);

  const reqArgs = parsePrWatchArgs([
    "request-copilot",
    "--repo",
    "jongio/skills",
    "--pr",
    "177",
    "--head",
    "head_new",
  ]);
  assert.equal(reqArgs.mode, "request-copilot");
  assert.equal(reqArgs.pr, 177);
  assert.equal(reqArgs.head, "head_new");

  // 1. Rejects head_mismatch without cancelling runs or editing reviewers
  const mismatchCalls = [];
  const mismatchRes = requestCopilotReview(reqArgs, (ghArgs) => {
    mismatchCalls.push(ghArgs);
    return {
      ok: true,
      stdout: JSON.stringify({
        data: {
          repository: {
            pullRequest: {
              state: "OPEN",
              headRefOid: "head_other",
              headRefName: "feat/x",
              reviewRequests: { nodes: [] },
            },
          },
        },
      }),
      stderr: "",
    };
  });
  assert.equal(mismatchRes.ok, false);
  assert.equal(mismatchRes.status, "head_mismatch");
  assert.equal(mismatchRes.expectedHead, "head_new");
  assert.equal(mismatchRes.actualHead, "head_other");
  assert.equal(mismatchCalls.length, 1);

  // 2. Rejects pr_not_open
  const closedRes = requestCopilotReview(reqArgs, () => ({
    ok: true,
    stdout: JSON.stringify({
      data: {
        repository: {
          pullRequest: {
            state: "MERGED",
            headRefOid: "head_new",
            headRefName: "feat/x",
            reviewRequests: { nodes: [] },
          },
        },
      },
    }),
    stderr: "",
  }));
  assert.equal(closedRes.ok, false);
  assert.equal(closedRes.status, "pr_not_open");
  assert.equal(closedRes.state, "MERGED");

  // 3. Cancels superseded runs BEFORE returning already_running when both old-head and current-head runs are active
  const activeCalls = [];
  const alreadyRunningRes = requestCopilotReview(reqArgs, (ghArgs) => {
    activeCalls.push(ghArgs);
    if (ghArgs[1] === "graphql") {
      return {
        ok: true,
        stdout: JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                state: "OPEN",
                headRefOid: "head_new",
                headRefName: "feat/x",
                reviewRequests: {
                  nodes: [{ requestedReviewer: { __typename: "Bot", login: "copilot-pull-request-reviewer" } }],
                },
              },
            },
          },
        }),
        stderr: "",
      };
    }
    if (ghArgs[1] === "repos/jongio/skills/actions/runs?status=in_progress&per_page=100") {
      return {
        ok: true,
        stdout: JSON.stringify({
          workflow_runs: [
            {
              id: 4000,
              name: "Running Copilot Code Review",
              status: "in_progress",
              head_branch: "feat/x",
              head_sha: "head_old",
            },
          ],
        }),
        stderr: "",
      };
    }
    if (ghArgs[1] === "repos/jongio/skills/actions/runs?status=queued&per_page=100") {
      return {
        ok: true,
        stdout: JSON.stringify({
          workflow_runs: [
            {
              id: 4001,
              name: "Running Copilot Code Review",
              status: "queued",
              head_branch: "feat/x",
              head_sha: "head_new",
            },
          ],
        }),
        stderr: "",
      };
    }
    if (ghArgs[0] === "api" && ghArgs[1]?.startsWith("repos/jongio/skills/actions/runs?status=")) {
      return { ok: true, stdout: JSON.stringify({ workflow_runs: [] }), stderr: "" };
    }
    return { ok: true, stdout: "{}", stderr: "" };
  });
  assert.equal(alreadyRunningRes.ok, true);
  assert.equal(alreadyRunningRes.status, "already_running");
  assert.equal(alreadyRunningRes.activeRunId, 4001);
  assert.deepEqual(alreadyRunningRes.cancelledRunIds, [4000]);
  assert.ok(!activeCalls.some((c) => c[0] === "pr" && c[1] === "edit"));

  // 4. Cancels superseded Copilot runs on the same branch/PR (leaving other branches alone)
  // and toggles --remove-reviewer / --add-reviewer when @copilot is already requested
  const toggleCalls = [];
  const toggledRes = requestCopilotReview(reqArgs, (ghArgs) => {
    toggleCalls.push(ghArgs);
    if (ghArgs[1] === "graphql") {
      return {
        ok: true,
        stdout: JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                state: "OPEN",
                headRefOid: "head_new",
                headRefName: "feat/x",
                reviewRequests: {
                  nodes: [{ requestedReviewer: { __typename: "Bot", login: "copilot-pull-request-reviewer" } }],
                },
              },
            },
          },
        }),
        stderr: "",
      };
    }
    if (ghArgs[1] === "repos/jongio/skills/actions/runs?status=in_progress&per_page=100") {
      return {
        ok: true,
        stdout: JSON.stringify({
          workflow_runs: [
            {
              id: 5001,
              name: "Running Copilot Code Review",
              status: "in_progress",
              head_branch: "feat/x",
              head_sha: "head_old",
            },
            {
              id: 5002,
              name: "Running Copilot Code Review",
              status: "in_progress",
              head_branch: "feat/other-pr",
              head_sha: "head_other_branch",
            },
            {
              id: 5003,
              name: "Skill Lint",
              status: "in_progress",
              head_branch: "feat/x",
              head_sha: "head_old",
            },
          ],
        }),
        stderr: "",
      };
    }
    if (ghArgs[0] === "api" && ghArgs[1]?.startsWith("repos/jongio/skills/actions/runs?status=")) {
      return { ok: true, stdout: JSON.stringify({ workflow_runs: [] }), stderr: "" };
    }
    return { ok: true, stdout: "{}", stderr: "" };
  });
  assert.equal(toggledRes.ok, true);
  assert.equal(toggledRes.status, "requested");
  assert.deepEqual(toggledRes.cancelledRunIds, [5001]);
  assert.equal(toggledRes.toggledExistingRequest, true);
  assert.deepEqual(
    toggleCalls.slice(-3),
    [
      ["api", "-X", "POST", "repos/jongio/skills/actions/runs/5001/cancel"],
      ["pr", "edit", "177", "-R", "jongio/skills", "--remove-reviewer", "@copilot"],
      ["pr", "edit", "177", "-R", "jongio/skills", "--add-reviewer", "@copilot"],
    ]
  );

  // 5. Does NOT match another PR's run when both PRs share the same branch name (e.g. fork PRs on patch-1)
  const forkArgs = parsePrWatchArgs([
    "request-copilot",
    "--repo",
    "jongio/skills",
    "--pr",
    "177",
    "--head",
    "head_new",
  ]);
  const forkCalls = [];
  const forkRes = requestCopilotReview(forkArgs, (ghArgs) => {
    forkCalls.push(ghArgs);
    if (ghArgs[1] === "graphql") {
      return {
        ok: true,
        stdout: JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                state: "OPEN",
                headRefOid: "head_new",
                headRefName: "patch-1",
                headRepository: { nameWithOwner: "alice/skills" },
                reviewRequests: { nodes: [] },
              },
            },
          },
        }),
        stderr: "",
      };
    }
    if (ghArgs[1] === "repos/jongio/skills/actions/runs?status=in_progress&per_page=100") {
      return {
        ok: true,
        stdout: JSON.stringify({
          workflow_runs: [
            {
              id: 6001,
              name: "Running Copilot Code Review",
              status: "in_progress",
              head_branch: "patch-1",
              head_sha: "head_other_fork",
              pull_requests: [{ number: 199 }],
            },
            {
              id: 6002,
              name: "Running Copilot Code Review",
              status: "in_progress",
              head_branch: "patch-1",
              head_sha: "head_bob_fork",
              head_repository: { full_name: "bob/skills" },
              pull_requests: [],
            },
          ],
        }),
        stderr: "",
      };
    }
    if (ghArgs[0] === "api" && ghArgs[1]?.startsWith("repos/jongio/skills/actions/runs?status=")) {
      return { ok: true, stdout: JSON.stringify({ workflow_runs: [] }), stderr: "" };
    }
    return { ok: true, stdout: "{}", stderr: "" };
  });
  assert.equal(forkRes.ok, true);
  assert.equal(forkRes.status, "requested");
  assert.deepEqual(forkRes.cancelledRunIds, []);

  // 6. Paginates status-filtered workflow_runs beyond page 1 and detects an active review on page 2
  const pagedRes = requestCopilotReview(reqArgs, (ghArgs) => {
    if (ghArgs[1] === "graphql") {
      return {
        ok: true,
        stdout: JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                state: "OPEN",
                headRefOid: "head_new",
                headRefName: "feat/x",
                reviewRequests: { nodes: [] },
              },
            },
          },
        }),
        stderr: "",
      };
    }
    if (ghArgs[1] === "repos/jongio/skills/actions/runs?status=waiting&per_page=100") {
      return {
        ok: true,
        stdout: JSON.stringify({
          total_count: 2,
          workflow_runs: [
            {
              id: 7001,
              name: "Skill Lint",
              status: "waiting",
              head_branch: "main",
              head_sha: "main_sha",
            },
          ],
        }),
        stderr: "",
      };
    }
    if (ghArgs[1] === "repos/jongio/skills/actions/runs?status=waiting&per_page=100&page=2") {
      return {
        ok: true,
        stdout: JSON.stringify({
          total_count: 2,
          workflow_runs: [
            {
              id: 7002,
              name: "Running Copilot Code Review",
              status: "waiting",
              head_branch: "feat/x",
              head_sha: "head_new",
            },
          ],
        }),
        stderr: "",
      };
    }
    if (ghArgs[0] === "api" && ghArgs[1]?.startsWith("repos/jongio/skills/actions/runs?status=")) {
      return { ok: true, stdout: JSON.stringify({ total_count: 0, workflow_runs: [] }), stderr: "" };
    }
    return { ok: false, stdout: "", stderr: "unexpected call" };
  });
  assert.equal(pagedRes.ok, true);
  assert.equal(pagedRes.status, "already_running");
  assert.equal(pagedRes.activeRunId, 7002);

  // 7. Stops and returns cancel_failed when cancelling a superseded run fails
  const cancelFailCalls = [];
  const cancelFailRes = requestCopilotReview(reqArgs, (ghArgs) => {
    cancelFailCalls.push(ghArgs);
    if (ghArgs[1] === "graphql") {
      return {
        ok: true,
        stdout: JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                state: "OPEN",
                headRefOid: "head_new",
                headRefName: "feat/x",
                reviewRequests: { nodes: [] },
              },
            },
          },
        }),
        stderr: "",
      };
    }
    if (ghArgs[1] === "repos/jongio/skills/actions/runs?status=in_progress&per_page=100") {
      return {
        ok: true,
        stdout: JSON.stringify({
          workflow_runs: [
            {
              id: 8001,
              name: "Running Copilot Code Review",
              status: "in_progress",
              head_branch: "feat/x",
              head_sha: "head_old",
            },
          ],
        }),
        stderr: "",
      };
    }
    if (ghArgs[0] === "api" && ghArgs[1]?.startsWith("repos/jongio/skills/actions/runs?status=")) {
      return { ok: true, stdout: JSON.stringify({ workflow_runs: [] }), stderr: "" };
    }
    if (ghArgs[3] === "repos/jongio/skills/actions/runs/8001/cancel") {
      return { ok: false, stdout: "", stderr: "HTTP 403 Forbidden" };
    }
    return { ok: true, stdout: "{}", stderr: "" };
  });
  assert.equal(cancelFailRes.ok, false);
  assert.equal(cancelFailRes.status, "cancel_failed");
  assert.equal(cancelFailRes.runId, 8001);
  assert.deepEqual(cancelFailRes.cancelledRunIds, []);

  // 8. Stops and returns remove_reviewer_failed when removing the existing @copilot request fails
  const removeFailCalls = [];
  const removeFailRes = requestCopilotReview(reqArgs, (ghArgs) => {
    removeFailCalls.push(ghArgs);
    if (ghArgs[1] === "graphql") {
      return {
        ok: true,
        stdout: JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                state: "OPEN",
                headRefOid: "head_new",
                headRefName: "feat/x",
                reviewRequests: {
                  nodes: [{ requestedReviewer: { __typename: "Bot", login: "copilot-pull-request-reviewer" } }],
                },
              },
            },
          },
        }),
        stderr: "",
      };
    }
    if (ghArgs[0] === "api" && ghArgs[1]?.startsWith("repos/jongio/skills/actions/runs?status=")) {
      return {
        ok: true,
        stdout: JSON.stringify({ workflow_runs: [] }),
        stderr: "",
      };
    }
    if (ghArgs.includes("--remove-reviewer")) {
      return { ok: false, stdout: "", stderr: "GraphQL: Could not remove reviewer" };
    }
    return { ok: true, stdout: "{}", stderr: "" };
  });
  assert.equal(removeFailRes.ok, false);
  assert.equal(removeFailRes.status, "remove_reviewer_failed");
  assert.ok(!removeFailCalls.some((c) => c.includes("--add-reviewer")));

  // 9. Revalidates PR head after workflow inventory and aborts before cancelling a newer head's run
  let gqlCount = 0;
  const raceCalls = [];
  const raceRes = requestCopilotReview(reqArgs, (ghArgs) => {
    raceCalls.push(ghArgs);
    if (ghArgs[1] === "graphql") {
      gqlCount += 1;
      return {
        ok: true,
        stdout: JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                state: "OPEN",
                headRefOid: gqlCount === 1 ? "head_new" : "head_pushed_during_scan",
                headRefName: "feat/x",
                reviewRequests: { nodes: [] },
              },
            },
          },
        }),
        stderr: "",
      };
    }
    if (ghArgs[1] === "repos/jongio/skills/actions/runs?status=in_progress&per_page=100") {
      return {
        ok: true,
        stdout: JSON.stringify({
          workflow_runs: [
            {
              id: 9001,
              name: "Running Copilot Code Review",
              status: "in_progress",
              head_branch: "feat/x",
              head_sha: "head_pushed_during_scan",
            },
          ],
        }),
        stderr: "",
      };
    }
    if (ghArgs[0] === "api" && ghArgs[1]?.startsWith("repos/jongio/skills/actions/runs?status=")) {
      return { ok: true, stdout: JSON.stringify({ workflow_runs: [] }), stderr: "" };
    }
    return { ok: true, stdout: "{}", stderr: "" };
  });
  assert.equal(raceRes.ok, false);
  assert.equal(raceRes.status, "head_mismatch");
  assert.equal(raceRes.expectedHead, "head_new");
  assert.equal(raceRes.actualHead, "head_pushed_during_scan");
  assert.ok(!raceCalls.some((c) => c.includes("repos/jongio/skills/actions/runs/9001/cancel")));
  assert.ok(!raceCalls.some((c) => c[0] === "pr" && c[1] === "edit"));

  // 10. Rechecks status transitions: catches a current-head run that transitions queued -> in_progress
  // after pass 1 misses it between bucket queries, returning already_running without reviewer edits
  let currentTransitionInProgressCalls = 0;
  const currentTransitionCalls = [];
  const currentTransitionRes = requestCopilotReview(reqArgs, (ghArgs) => {
    currentTransitionCalls.push(ghArgs);
    if (ghArgs[1] === "graphql") {
      return {
        ok: true,
        stdout: JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                state: "OPEN",
                headRefOid: "head_new",
                headRefName: "feat/x",
                reviewRequests: { nodes: [] },
              },
            },
          },
        }),
        stderr: "",
      };
    }
    if (ghArgs[1] === "repos/jongio/skills/actions/runs?status=in_progress&per_page=100") {
      currentTransitionInProgressCalls += 1;
      // Missed on pass 1, visible on pass 2 and pass 3 after transitioning from queued -> in_progress
      const runs =
        currentTransitionInProgressCalls >= 2
          ? [
              {
                id: 9101,
                name: "Running Copilot Code Review",
                status: "in_progress",
                head_branch: "feat/x",
                head_sha: "head_new",
              },
            ]
          : [];
      return { ok: true, stdout: JSON.stringify({ workflow_runs: runs }), stderr: "" };
    }
    if (ghArgs[0] === "api" && ghArgs[1]?.startsWith("repos/jongio/skills/actions/runs?status=")) {
      return { ok: true, stdout: JSON.stringify({ workflow_runs: [] }), stderr: "" };
    }
    return { ok: true, stdout: "{}", stderr: "" };
  });
  assert.equal(currentTransitionRes.ok, true);
  assert.equal(currentTransitionRes.status, "already_running");
  assert.equal(currentTransitionRes.activeRunId, 9101);
  assert.ok(!currentTransitionCalls.some((c) => c[0] === "pr" && c[1] === "edit"));

  // 11. Rechecks status transitions: catches a superseded-head run that transitions queued -> in_progress
  // after pass 1 misses it, cancelling it before requesting @copilot
  let supersededTransitionInProgressCalls = 0;
  const supersededTransitionCalls = [];
  const supersededTransitionRes = requestCopilotReview(reqArgs, (ghArgs) => {
    supersededTransitionCalls.push(ghArgs);
    if (ghArgs[1] === "graphql") {
      return {
        ok: true,
        stdout: JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                state: "OPEN",
                headRefOid: "head_new",
                headRefName: "feat/x",
                reviewRequests: { nodes: [] },
              },
            },
          },
        }),
        stderr: "",
      };
    }
    if (ghArgs[1] === "repos/jongio/skills/actions/runs?status=in_progress&per_page=100") {
      supersededTransitionInProgressCalls += 1;
      const runs =
        supersededTransitionInProgressCalls >= 2
          ? [
              {
                id: 9201,
                name: "Running Copilot Code Review",
                status: "in_progress",
                head_branch: "feat/x",
                head_sha: "head_old",
              },
            ]
          : [];
      return { ok: true, stdout: JSON.stringify({ workflow_runs: runs }), stderr: "" };
    }
    if (ghArgs[0] === "api" && ghArgs[1]?.startsWith("repos/jongio/skills/actions/runs?status=")) {
      return { ok: true, stdout: JSON.stringify({ workflow_runs: [] }), stderr: "" };
    }
    return { ok: true, stdout: "{}", stderr: "" };
  });
  assert.equal(supersededTransitionRes.ok, true);
  assert.equal(supersededTransitionRes.status, "requested");
  assert.deepEqual(supersededTransitionRes.cancelledRunIds, [9201]);
  assert.ok(
    supersededTransitionCalls.some(
      (c) => c[3] === "repos/jongio/skills/actions/runs/9201/cancel"
    )
  );

  // 12. Unrelated PRs starting/finishing Copilot runs between passes do NOT cause inventory_unstable
  let unrelatedPassCall = 0;
  const unrelatedNoiseRes = requestCopilotReview(reqArgs, (ghArgs) => {
    if (ghArgs[1] === "graphql") {
      return {
        ok: true,
        stdout: JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                state: "OPEN",
                headRefOid: "head_new",
                headRefName: "feat/x",
                reviewRequests: { nodes: [] },
              },
            },
          },
        }),
        stderr: "",
      };
    }
    if (ghArgs[1] === "repos/jongio/skills/actions/runs?status=in_progress&per_page=100") {
      unrelatedPassCall += 1;
      return {
        ok: true,
        stdout: JSON.stringify({
          workflow_runs: [
            {
              id: 9300 + unrelatedPassCall,
              name: "Running Copilot Code Review",
              status: "in_progress",
              head_branch: `feat/unrelated-${unrelatedPassCall}`,
              head_sha: `sha_unrelated_${unrelatedPassCall}`,
              pull_requests: [{ number: 200 + unrelatedPassCall }],
            },
          ],
        }),
        stderr: "",
      };
    }
    if (ghArgs[0] === "api" && ghArgs[1]?.startsWith("repos/jongio/skills/actions/runs?status=")) {
      return { ok: true, stdout: JSON.stringify({ workflow_runs: [] }), stderr: "" };
    }
    return { ok: true, stdout: "{}", stderr: "" };
  });
  assert.equal(unrelatedNoiseRes.ok, true);
  assert.equal(unrelatedNoiseRes.status, "requested");
  assert.deepEqual(unrelatedNoiseRes.cancelledRunIds, []);

  // 13. Transient total_count drift on pass 1 (when a run finishes mid-query) retries on pass 2 & 3 instead of failing immediately
  let driftInProgressPage1Calls = 0;
  const driftRes = requestCopilotReview(reqArgs, (ghArgs) => {
    if (ghArgs[1] === "graphql") {
      return {
        ok: true,
        stdout: JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                state: "OPEN",
                headRefOid: "head_new",
                headRefName: "feat/x",
                reviewRequests: { nodes: [] },
              },
            },
          },
        }),
        stderr: "",
      };
    }
    if (ghArgs[1] === "repos/jongio/skills/actions/runs?status=in_progress&per_page=100") {
      driftInProgressPage1Calls += 1;
      if (driftInProgressPage1Calls === 1) {
        return {
          ok: true,
          stdout: JSON.stringify({
            total_count: 2,
            workflow_runs: [{ id: 9401, name: "Skill Lint", status: "in_progress" }],
          }),
          stderr: "",
        };
      }
      return {
        ok: true,
        stdout: JSON.stringify({
          total_count: 1,
          workflow_runs: [{ id: 9401, name: "Skill Lint", status: "in_progress" }],
        }),
        stderr: "",
      };
    }
    if (ghArgs[1] === "repos/jongio/skills/actions/runs?status=in_progress&per_page=100&page=2") {
      return {
        ok: true,
        stdout: JSON.stringify({ total_count: 2, workflow_runs: [] }),
        stderr: "",
      };
    }
    if (ghArgs[0] === "api" && ghArgs[1]?.startsWith("repos/jongio/skills/actions/runs?status=")) {
      return { ok: true, stdout: JSON.stringify({ total_count: 0, workflow_runs: [] }), stderr: "" };
    }
    return { ok: true, stdout: "{}", stderr: "" };
  });
  assert.equal(driftRes.ok, true);
  assert.equal(driftRes.status, "requested");
});

test("evaluatePrPollTick supports ETag 304 caching, adaptive intervals, and rate-limit backoff", () => {
  const watchArgs = parsePrWatchArgs([
    "watch",
    "--repo",
    "jongio/skills",
    "--pr",
    "178",
    "--head",
    "head123",
  ]);
  const state = createPrWatchState();
  const seenRunsArgs = [];
  let runsCallCount = 0;

  const gqlRunningPayload = JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          state: "OPEN",
          headRefOid: "head123",
          mergeable: "MERGEABLE",
          mergeStateStatus: "CLEAN",
          reviewDecision: null,
          reviewRequests: {
            nodes: [{ requestedReviewer: { __typename: "Bot", login: "copilot-pull-request-reviewer" } }],
          },
          reviews: { nodes: [] },
          reviewThreads: { nodes: [] },
          comments: { nodes: [] },
          commits: {
            nodes: [
              {
                commit: {
                  statusCheckRollup: {
                    state: "PENDING",
                    contexts: {
                      nodes: [
                        { __typename: "CheckRun", name: "lint", status: "IN_PROGRESS", conclusion: null },
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
  });

  const execWithEtag = (ghArgs) => {
    if (ghArgs[1] === "graphql") {
      return { ok: true, stdout: gqlRunningPayload, stderr: "" };
    }
    seenRunsArgs.push(ghArgs);
    runsCallCount += 1;
    if (runsCallCount === 1) {
      return {
        ok: true,
        stdout: `HTTP/2.0 200 OK\r\netag: "runs-etag-1"\r\nx-ratelimit-remaining: 4500\r\n\r\n${JSON.stringify({
          total_count: 1,
          workflow_runs: [{ id: 1, name: "Running Copilot Code Review", status: "in_progress" }],
        })}`,
        stderr: "",
      };
    }
    return {
      ok: true,
      stdout: 'HTTP/2.0 304 Not Modified\r\netag: "runs-etag-1"\r\nx-ratelimit-remaining: 4500\r\n\r\n',
      stderr: "",
    };
  };

  // First tick caches ETag; second tick sends If-None-Match and reuses cached workflow_runs on 304
  const tick1 = evaluatePrPollTick(watchArgs, execWithEtag, state);
  assert.equal(tick1.status.phase, "ci:running|review:copilot-reviewing");
  assert.equal(tick1.status.cacheHits304, 0);
  assert.equal(tick1.nextIntervalSec, 15);

  const tick2 = evaluatePrPollTick(
    { ...watchArgs, lastPhase: tick1.status.phase },
    execWithEtag,
    state
  );
  assert.equal(tick2.status.phase, "ci:running|review:copilot-reviewing");
  assert.equal(tick2.status.cacheHits304, 1);
  assert.deepEqual(seenRunsArgs[1].slice(-2), ["-H", 'If-None-Match: "runs-etag-1"']);

  // Adaptive interval steps up after 4 and 12 unchanged polls, and widens on low rateLimitRemaining or retryAfterSec
  assert.equal(computeAdaptivePrIntervalSec({ baseIntervalSec: 15, consecutiveUnchangedPolls: 3 }), 15);
  assert.equal(computeAdaptivePrIntervalSec({ baseIntervalSec: 15, consecutiveUnchangedPolls: 4 }), 30);
  assert.equal(computeAdaptivePrIntervalSec({ baseIntervalSec: 15, consecutiveUnchangedPolls: 12 }), 45);
  assert.equal(
    computeAdaptivePrIntervalSec({
      baseIntervalSec: 15,
      consecutiveUnchangedPolls: 1,
      rateLimitRemaining: 250,
    }),
    60
  );
  assert.equal(
    computeAdaptivePrIntervalSec({
      baseIntervalSec: 15,
      consecutiveUnchangedPolls: 1,
      retryAfterSec: 75,
    }),
    75
  );

  // HTTP 429 rate-limit response emits RATE_LIMITED with retryAfterSec backoff instead of crashing
  const rateLimitedTick = evaluatePrPollTick(
    watchArgs,
    (ghArgs) => {
      if (ghArgs[1] === "graphql") {
        return { ok: true, stdout: gqlRunningPayload, stderr: "" };
      }
      return {
        ok: false,
        stdout: "HTTP/2.0 429 Too Many Requests\r\nretry-after: 90\r\nx-ratelimit-remaining: 0\r\n\r\n{}",
        stderr: "HTTP 429",
      };
    },
    createPrWatchState()
  );
  assert.equal(rateLimitedTick.rateLimited, true);
  assert.equal(rateLimitedTick.events[0].type, "RATE_LIMITED");
  assert.equal(rateLimitedTick.nextIntervalSec, 90);

  // GraphQL RATE_LIMITED errors also emit RATE_LIMITED instead of crashing with POLL_ERROR
  const gqlRateLimitedTick = evaluatePrPollTick(
    watchArgs,
    () => ({
      ok: true,
      stdout: JSON.stringify({
        errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }],
      }),
      stderr: "",
    }),
    createPrWatchState()
  );
  assert.equal(gqlRateLimitedTick.rateLimited, true);
  assert.equal(gqlRateLimitedTick.events[0].type, "RATE_LIMITED");
  assert.equal(gqlRateLimitedTick.nextIntervalSec, 60);

  // GraphQL HTTP 429 with httpMeta retryAfter: 300 (even without "rate limit" body text) preserves 300s delay
  const gql429MetaTick = evaluatePrPollTick(
    watchArgs,
    () => ({
      ok: false,
      stdout: "{}",
      stderr: "HTTP 429",
      httpMeta: { status: 429, retryAfter: "300", rateLimitRemaining: "10" },
    }),
    createPrWatchState()
  );
  assert.equal(gql429MetaTick.rateLimited, true);
  assert.equal(gql429MetaTick.events[0].type, "RATE_LIMITED");
  assert.equal(gql429MetaTick.nextIntervalSec, 300);

  // Primary rate-limit 403 with X-RateLimit-Remaining: 0 and X-RateLimit-Reset (no Retry-After) backs off until reset
  const futureReset = Math.floor(Date.now() / 1000) + 420;
  const resetRateLimitedTick = evaluatePrPollTick(
    watchArgs,
    (ghArgs) => {
      if (ghArgs[1] === "graphql") {
        return { ok: true, stdout: gqlRunningPayload, stderr: "" };
      }
      return {
        ok: false,
        stdout: `HTTP/2.0 403 Forbidden\r\nx-ratelimit-remaining: 0\r\nx-ratelimit-reset: ${futureReset}\r\n\r\n{"message":"API rate limit exceeded"}`,
        stderr: "HTTP 403",
      };
    },
    createPrWatchState()
  );
  assert.equal(resetRateLimitedTick.rateLimited, true);
  assert.equal(resetRateLimitedTick.events[0].type, "RATE_LIMITED");
  assert.ok(resetRateLimitedTick.nextIntervalSec >= 410);

  // Low GraphQL quota (100 remaining) is not overwritten by high REST quota (4500 remaining)
  const splitQuotaState = createPrWatchState();
  const splitQuotaTick = evaluatePrPollTick(
    watchArgs,
    (ghArgs) => {
      if (ghArgs[1] === "graphql") {
        return {
          ok: true,
          stdout: gqlRunningPayload,
          stderr: "",
          httpMeta: { status: 200, rateLimitRemaining: "100", rateLimitReset: String(futureReset) },
        };
      }
      return {
        ok: true,
        stdout: `HTTP/2.0 200 OK\r\nx-ratelimit-remaining: 4500\r\n\r\n${JSON.stringify({
          total_count: 1,
          workflow_runs: [{ id: 1, name: "Running Copilot Code Review", status: "in_progress" }],
        })}`,
        stderr: "",
      };
    },
    splitQuotaState
  );
  assert.equal(splitQuotaTick.nextIntervalSec, 60);
  assert.equal(splitQuotaState.metrics.rateLimitRemaining, 100);

  // once-mode (state === null) still classifies REST httpMeta 429 and preserves retryAfter: 300
  const onceRest429Tick = evaluatePrPollTick(watchArgs, (ghArgs) => {
    if (ghArgs[1] === "graphql") {
      return { ok: true, stdout: gqlRunningPayload, stderr: "" };
    }
    return {
      ok: false,
      stdout: "{}",
      stderr: "HTTP 429",
      httpMeta: { status: 429, retryAfter: "300", rateLimitRemaining: "5" },
    };
  });
  assert.equal(onceRest429Tick.rateLimited, true);
  assert.equal(onceRest429Tick.events[0].type, "RATE_LIMITED");
  assert.equal(onceRest429Tick.nextIntervalSec, 300);

  // --no-phase-events still resets consecutiveUnchangedPolls and nextIntervalSec on a phase transition
  state.consecutiveUnchangedPolls = 12;
  const noPhaseEventsTick = evaluatePrPollTick(
    parsePrWatchArgs([
      "watch",
      "--repo",
      "jongio/skills",
      "--pr",
      "178",
      "--head",
      "head123",
      "--last-phase",
      "ci:passed|review:copilot-queued",
      "--no-phase-events",
    ]),
    execWithEtag,
    state
  );
  assert.equal(noPhaseEventsTick.events.length, 0);
  assert.equal(state.consecutiveUnchangedPolls, 0);
  assert.equal(noPhaseEventsTick.nextIntervalSec, 15);
  assert.ok(parseGhApiArgs(["api", "-i", "repos/jongio/skills/actions/runs?head_sha=abc&per_page=100"]));

  // Auto-retries COPILOT_REVIEW_ERROR up to maxCopilotRetries when watch state is provided, then emits COPILOT_REVIEW_ERROR
  const retryState = createPrWatchState();
  const retryWatchArgs = parsePrWatchArgs([
    "watch",
    "--repo",
    "jongio/skills",
    "--pr",
    "178",
    "--head",
    "head123",
    "--max-copilot-retries",
    "1",
  ]);
  const makeErrorExec = (reviewId) => (ghArgs) => {
    if (ghArgs[1] === "graphql") {
      return {
        ok: true,
        stdout: JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                state: "OPEN",
                headRefOid: "head123",
                headRefName: "feat/x",
                mergeable: "MERGEABLE",
                mergeStateStatus: "CLEAN",
                reviewDecision: null,
                reviewRequests: { nodes: [] },
                reviews: {
                  nodes: [
                    {
                      databaseId: reviewId,
                      state: "COMMENTED",
                      submittedAt: "2026-10-23T12:00:00Z",
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
    if (
      ghArgs[0] === "api" &&
      ghArgs.some((a) => typeof a === "string" && a.startsWith("repos/jongio/skills/actions/runs"))
    ) {
      return { ok: true, stdout: JSON.stringify({ workflow_runs: [] }), stderr: "" };
    }
    return { ok: true, stdout: "{}", stderr: "" };
  };
  const retriedTick = evaluatePrPollTick(retryWatchArgs, makeErrorExec(9901), retryState);
  assert.equal(retriedTick.events[0].type, "COPILOT_REVIEW_RETRIED");
  assert.equal(retriedTick.events[0].attempt, 1);
  assert.equal(retriedTick.events[0].reviewId, 9901);

  // Subsequent poll seeing the same reviewId before the new review request is visible stays in grace period
  const graceTick = evaluatePrPollTick(retryWatchArgs, makeErrorExec(9901), retryState);
  assert.equal(graceTick.events.length, 0);
  assert.equal(graceTick.status.phase, "ci:passed|review:copilot-queued");

  // Once a new errored reviewId appears after retry budget is exhausted, emits terminal COPILOT_REVIEW_ERROR
  const exhaustedTick = evaluatePrPollTick(retryWatchArgs, makeErrorExec(9902), retryState);
  assert.equal(exhaustedTick.events[0].type, "COPILOT_REVIEW_ERROR");
  assert.equal(exhaustedTick.events[0].reviewId, 9902);

  // Single-PR --prs 178:expected normalizes args.head for single-target dispatch
  const singlePinArgs = parsePrWatchArgs(["watch", "--repo", "jongio/skills", "--prs", "178:expected123"]);
  assert.equal(singlePinArgs.pr, 178);
  assert.equal(singlePinArgs.head, "expected123");

  // Multi-PR once mode disables auto-retries so one-shot inspection stays observational
  const multiOnceArgs = parsePrWatchArgs(["once", "--repo", "jongio/skills", "--prs", "178:head123,179:head123"]);
  const multiOnceTick = evaluateMultiPrPollTick(multiOnceArgs, makeErrorExec(9903), {});
  assert.equal(multiOnceTick.events[0].type, "COPILOT_REVIEW_ERROR");

  // Multi-PR polling via --prs 178:head123,179:head123 aggregates statuses and tags events with pr number
  const multiArgs = parsePrWatchArgs([
    "watch",
    "--repo",
    "jongio/skills",
    "--prs",
    "178:head123,179:head123",
  ]);
  assert.deepEqual(multiArgs.prs, [178, 179]);
  assert.deepEqual(multiArgs.prHeads, { 178: "head123", 179: "head123" });
  const multiState = {};
  const multiExec = (ghArgs) => {
    if (ghArgs[1] === "graphql") {
      return { ok: true, stdout: gqlRunningPayload, stderr: "" };
    }
    return {
      ok: true,
      stdout: `HTTP/2.0 200 OK\r\netag: "runs-etag-multi"\r\nx-ratelimit-remaining: 4500\r\n\r\n${JSON.stringify({
        total_count: 1,
        workflow_runs: [{ id: 1, name: "Running Copilot Code Review", status: "in_progress" }],
      })}`,
      stderr: "",
    };
  };
  const multiTick = evaluateMultiPrPollTick(multiArgs, multiExec, multiState);
  assert.deepEqual(multiTick.prs, [178, 179]);
  assert.equal(multiTick.statuses.length, 2);
  assert.equal(multiTick.statuses[0].pr, 178);
  assert.equal(multiTick.statuses[1].pr, 179);

  // action_required workflow runs surface actionRequiredRuns with approval/rerun remediation,
  // and shouldEmitPrWatchStatus suppresses unchanged ticks until 60s heartbeat
  const actionReqTick = evaluatePrPollTick(watchArgs, (ghArgs) => {
    if (ghArgs[1] === "graphql") {
      return { ok: true, stdout: gqlRunningPayload, stderr: "" };
    }
    return {
      ok: true,
      stdout: JSON.stringify({
        total_count: 1,
        workflow_runs: [
          {
            id: 40110872292,
            workflow_id: 1,
            name: "CI",
            event: "pull_request",
            head_branch: "update-marketplace",
            status: "completed",
            conclusion: "action_required",
            html_url: "https://github.com/github/evals/actions/runs/40110872292",
          },
        ],
      }),
      stderr: "",
    };
  });
  assert.equal(actionReqTick.events[0].type, "CI_FAILED");
  assert.equal(actionReqTick.events[0].actionRequiredRuns.length, 1);
  assert.equal(actionReqTick.events[0].actionRequiredRuns[0].runId, 40110872292);
  assert.match(actionReqTick.events[0].remediation, /actions\/runs\/40110872292\/approve/);
  assert.match(actionReqTick.events[0].remediation, /^Approve and rerun action_required workflow runs/);

  // When both action_required and genuine failures coexist, remediation includes both instructions
  const mixedActionReqTick = evaluatePrPollTick(watchArgs, (ghArgs) => {
    if (ghArgs[1] === "graphql") {
      return { ok: true, stdout: gqlRunningPayload, stderr: "" };
    }
    return {
      ok: true,
      stdout: JSON.stringify({
        total_count: 2,
        workflow_runs: [
          {
            id: 40110872292,
            workflow_id: 1,
            name: "CI",
            event: "pull_request",
            head_branch: "update-marketplace",
            status: "completed",
            conclusion: "action_required",
            html_url: "https://github.com/github/evals/actions/runs/40110872292",
          },
          {
            id: 40110872293,
            workflow_id: 2,
            name: "Lint",
            event: "pull_request",
            head_branch: "update-marketplace",
            status: "completed",
            conclusion: "failure",
            html_url: "https://github.com/github/evals/actions/runs/40110872293",
          },
        ],
      }),
      stderr: "",
    };
  });
  assert.equal(mixedActionReqTick.events[0].type, "CI_FAILED");
  assert.match(mixedActionReqTick.events[0].remediation, /also inspect the other failed job logs/);

  assert.equal(
    shouldEmitPrWatchStatus({
      polls: 1,
      eventsCount: 0,
      summaryChanged: false,
      nowMs: 1000,
      lastEmitMs: 0,
    }),
    true
  );
  assert.equal(
    shouldEmitPrWatchStatus({
      polls: 2,
      eventsCount: 0,
      summaryChanged: false,
      nowMs: 16_000,
      lastEmitMs: 1000,
    }),
    false
  );
  assert.equal(
    shouldEmitPrWatchStatus({
      polls: 5,
      eventsCount: 0,
      summaryChanged: false,
      nowMs: 62_000,
      lastEmitMs: 1000,
    }),
    true
  );
});
