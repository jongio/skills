#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";

const ERRORED_COPILOT_REVIEW_RE = /Copilot encountered an error and was unable to review this pull request/i;
const ACTIONABLE_BODY_RE =
  /(?:###\s*(?:🟡\s*Changes recommended|🔵\s*Needs a closer look)|\b[1-9]\d*\s+(?:open|previously missed)\s+issues?\b)/i;

export function detectRepoFromGit(cwd = process.cwd()) {
  try {
    const remote = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const match = remote.match(/github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?$/i);
    return match ? match[1] : "";
  } catch {
    return "";
  }
}

export function parsePrWatchArgs(argv) {
  const args = {
    mode: "watch",
    repo: "",
    pr: 0,
    head: "",
    intervalSec: 15,
    maxPolls: 0,
    expectCopilot: true,
    sinceCommentId: 0,
    lastPhase: "",
    emitPhaseChanges: true,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "watch" || token === "once") {
      args.mode = token;
    } else if (token === "--mode" && argv[i + 1]) {
      args.mode = argv[++i];
    } else if (token === "--repo" && argv[i + 1]) {
      args.repo = argv[++i].trim();
    } else if (token === "--pr" && argv[i + 1]) {
      args.pr = Number.parseInt(argv[++i], 10) || 0;
    } else if (token === "--head" && argv[i + 1]) {
      args.head = argv[++i].trim();
    } else if (token === "--interval" && argv[i + 1]) {
      args.intervalSec = Math.max(5, Number.parseInt(argv[++i], 10) || 15);
    } else if (token === "--max-polls" && argv[i + 1]) {
      args.maxPolls = Math.max(1, Number.parseInt(argv[++i], 10) || 1);
    } else if (token === "--no-copilot") {
      args.expectCopilot = false;
    } else if (token === "--since-comment-id" && argv[i + 1]) {
      args.sinceCommentId = Math.max(0, Number.parseInt(argv[++i], 10) || 0);
    } else if (token === "--last-phase" && argv[i + 1]) {
      args.lastPhase = argv[++i].trim();
    } else if (token === "--no-phase-events") {
      args.emitPhaseChanges = false;
    }
  }

  if (!args.repo) {
    args.repo = detectRepoFromGit();
  }
  if (!args.repo || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(args.repo)) {
    throw new Error(`Invalid or missing --repo "${args.repo}". Expected "<owner>/<repo>".`);
  }
  if (!Number.isSafeInteger(args.pr) || args.pr <= 0) {
    throw new Error(`Invalid or missing --pr "${args.pr}". Expected a positive pull request number.`);
  }
  return args;
}

export function computePrPhase({
  totalChecksCount = 0,
  passedChecksCount = 0,
  pendingChecks = [],
  expectCopilot = true,
  copilotWorkflowActive = false,
  copilotRequested = false,
  validHeadCopilotReviewsCount = 0,
  pendingReviewers = [],
} = {}) {
  let ciPhase = "ci:none";
  let ciLabel = "CI not started";
  if (totalChecksCount > 0) {
    if (pendingChecks.length > 0) {
      ciPhase = "ci:running";
      const sampleActive = pendingChecks.slice(0, 3).join(", ");
      ciLabel = `CI running (${passedChecksCount}/${totalChecksCount} passed; active: ${sampleActive})`;
    } else {
      ciPhase = "ci:passed";
      ciLabel = `CI passed (${passedChecksCount}/${totalChecksCount})`;
    }
  }

  let reviewPhase = "review:none";
  let reviewLabel = "No review pending";
  if (expectCopilot) {
    if (copilotWorkflowActive) {
      reviewPhase = "review:copilot-reviewing";
      reviewLabel = "Copilot is reviewing";
    } else if (copilotRequested) {
      reviewPhase = "review:copilot-queued";
      reviewLabel = "Copilot review queued";
    } else if (validHeadCopilotReviewsCount > 0) {
      reviewPhase = "review:copilot-done";
      reviewLabel = "Copilot review completed";
    } else {
      reviewPhase = "review:copilot-waiting";
      reviewLabel = "Waiting for Copilot review";
    }
  } else if (pendingReviewers.length > 0) {
    reviewPhase = "review:waiting";
    reviewLabel = `Waiting for reviewers (${pendingReviewers.join(", ")})`;
  }

  return {
    phase: `${ciPhase}|${reviewPhase}`,
    summary: `${ciLabel} | ${reviewLabel}`,
  };
}
export function isErroredCopilotReview(review) {
  return Boolean(review && typeof review.body === "string" && ERRORED_COPILOT_REVIEW_RE.test(review.body));
}

export function extractBodyOnlyFindings(reviews, issueComments, currentHeadOid) {
  const findings = [];
  for (const review of reviews || []) {
    if (!review || review.state === "DISMISSED" || isErroredCopilotReview(review)) {
      continue;
    }
    const commitOid = review.commit?.oid || "";
    if (currentHeadOid && commitOid !== currentHeadOid) {
      continue;
    }
    const body = review.body || "";
    const isActionable = review.state === "CHANGES_REQUESTED" || ACTIONABLE_BODY_RE.test(body);
    if (!isActionable) {
      continue;
    }
    const reviewId = review.databaseId;
    const citedInComment =
      reviewId &&
      (issueComments || []).some(
        (c) => typeof c?.body === "string" && new RegExp(`\\b${reviewId}\\b`).test(c.body)
      );
    if (!citedInComment) {
      const headlineMatch = body.match(/^###\s+.+$/m);
      findings.push({
        reviewId,
        author: review.author?.login || "unknown",
        state: review.state,
        commitOid,
        headline: headlineMatch ? headlineMatch[0].trim() : review.state,
        body,
      });
    }
  }
  return findings;
}

function defaultExecGh(ghArgs) {
  const res = spawnSync("gh", ghArgs, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return {
    ok: res.status === 0,
    stdout: res.stdout || "",
    stderr: res.stderr || "",
  };
}

export function evaluatePrPollTick(args, execFn = defaultExecGh) {
  const [owner, name] = args.repo.split("/");
  const query = `query($owner: String!, $name: String!, $pr: Int!) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $pr) {
        state
        headRefOid
        mergeable
        mergeStateStatus
        reviewDecision
        reviewRequests(first: 20) {
          nodes {
            requestedReviewer {
              __typename
              ... on Bot { login }
              ... on User { login }
            }
          }
        }
        reviews(last: 50) {
          nodes {
            databaseId
            state
            submittedAt
            commit { oid }
            author { login }
            body
          }
        }
        reviewThreads(first: 100) {
          nodes {
            id
            isResolved
            isOutdated
            path
            line
            comments(first: 20) {
              nodes {
                databaseId
                author { login }
                body
              }
            }
          }
        }
        comments(last: 50) {
          nodes {
            databaseId
            author { login }
            body
          }
        }
        commits(last: 1) {
          nodes {
            commit {
              statusCheckRollup {
                state
                contexts(first: 100) {
                  nodes {
                    __typename
                    ... on CheckRun {
                      name
                      status
                      conclusion
                      detailsUrl
                    }
                    ... on StatusContext {
                      context
                      state
                      targetUrl
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }`;

  const gqlRes = execFn([
    "api",
    "graphql",
    "-F",
    `owner=${owner}`,
    "-F",
    `name=${name}`,
    "-F",
    `pr=${args.pr}`,
    "-f",
    `query=${query}`,
  ]);
  if (!gqlRes.ok) {
    return { events: [], error: gqlRes.stderr || "GraphQL query failed" };
  }

  const parsed = JSON.parse(gqlRes.stdout);
  const pr = parsed?.data?.repository?.pullRequest;
  if (!pr) {
    return { events: [], error: "Pull request not found" };
  }

  if (pr.state !== "OPEN") {
    return {
      events: [{ type: "PR_CLOSED_OR_MERGED", state: pr.state, headRefOid: pr.headRefOid }],
    };
  }

  if (args.head && pr.headRefOid !== args.head) {
    return {
      events: [{ type: "HEAD_CHANGED", expectedHead: args.head, currentHead: pr.headRefOid }],
    };
  }

  if (pr.mergeable === "CONFLICTING" || pr.mergeStateStatus === "DIRTY") {
    return {
      events: [
        {
          type: "MERGE_CONFLICT",
          headRefOid: pr.headRefOid,
          mergeable: pr.mergeable,
          mergeStateStatus: pr.mergeStateStatus,
        },
      ],
    };
  }

  if (pr.mergeStateStatus === "BEHIND") {
    return {
      events: [
        {
          type: "BASE_UPDATE_BLOCKED",
          headRefOid: pr.headRefOid,
          mergeStateStatus: pr.mergeStateStatus,
        },
      ],
    };
  }

  const newConversationComments =
    args.sinceCommentId > 0
      ? (pr.comments?.nodes || []).filter(
          (c) => Number.isSafeInteger(c?.databaseId) && c.databaseId > args.sinceCommentId
        )
      : [];
  if (newConversationComments.length > 0) {
    return {
      events: [
        {
          type: "NEW_PR_COMMENTS",
          headRefOid: pr.headRefOid,
          comments: newConversationComments,
        },
      ],
    };
  }

  const headOid = pr.headRefOid;
  const contexts = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes || [];
  const failedChecks = [];
  const pendingChecks = [];

  for (const ctx of contexts) {
    if (ctx.__typename === "CheckRun") {
      if (ctx.status !== "COMPLETED") {
        pendingChecks.push(ctx.name);
      } else if (
        ctx.conclusion &&
        !["SUCCESS", "SKIPPED", "NEUTRAL"].includes(ctx.conclusion)
      ) {
        failedChecks.push({ name: ctx.name, conclusion: ctx.conclusion, url: ctx.detailsUrl });
      }
    } else if (ctx.__typename === "StatusContext") {
      if (ctx.state === "PENDING" || ctx.state === "EXPECTED") {
        pendingChecks.push(ctx.context);
      } else if (ctx.state === "FAILURE" || ctx.state === "ERROR") {
        failedChecks.push({ name: ctx.context, conclusion: ctx.state, url: ctx.targetUrl });
      }
    }
  }

  if (failedChecks.length > 0) {
    return {
      events: [{ type: "CI_FAILED", headRefOid: headOid, failedChecks }],
    };
  }

  // Check if Running Copilot Code Review workflow run is active on headOid
  let copilotWorkflowActive = false;
  if (args.expectCopilot) {
    const runsRes = execFn(["api", `repos/${args.repo}/actions/runs?head_sha=${headOid}&per_page=20`]);
    if (runsRes.ok && runsRes.stdout) {
      try {
        const runsData = JSON.parse(runsRes.stdout);
        copilotWorkflowActive = (runsData.workflow_runs || []).some(
          (r) =>
            /Copilot Code Review/i.test(r.name || "") &&
            r.status !== "completed"
        );
      } catch {
        // Ignore parse errors
      }
    }
  }

  const pendingReviewers = (pr.reviewRequests?.nodes || [])
    .map((n) => n?.requestedReviewer?.login)
    .filter(Boolean);
  const copilotRequested = pendingReviewers.some((login) => /copilot/i.test(login));

  const headReviews = (pr.reviews?.nodes || []).filter(
    (r) => r && r.commit?.oid === headOid && r.state !== "DISMISSED"
  );
  const headCopilotReviews = headReviews.filter((r) => /copilot/i.test(r.author?.login || ""));
  const validHeadCopilotReviews = headCopilotReviews.filter((r) => !isErroredCopilotReview(r));
  const latestHeadCopilotReview = headCopilotReviews.at(-1);

  if (
    args.expectCopilot &&
    !copilotWorkflowActive &&
    !copilotRequested &&
    validHeadCopilotReviews.length === 0 &&
    isErroredCopilotReview(latestHeadCopilotReview)
  ) {
    return {
      events: [
        {
          type: "COPILOT_REVIEW_ERROR",
          headRefOid: headOid,
          reviewId: latestHeadCopilotReview.databaseId,
          message: latestHeadCopilotReview.body,
        },
      ],
    };
  }

  const unresolvedThreads = (pr.reviewThreads?.nodes || [])
    .filter((t) => t && t.isResolved === false)
    .map((t) => ({
      threadId: t.id,
      path: t.path,
      line: t.line,
      isOutdated: t.isOutdated,
      comments: (t.comments?.nodes || []).map((c) => ({
        commentId: c.databaseId,
        author: c.author?.login,
        body: c.body,
      })),
    }));

  const bodyFindings = extractBodyOnlyFindings(pr.reviews?.nodes || [], pr.comments?.nodes || [], headOid);

  // Wait for active Copilot review before waking on feedback or readiness
  const copilotReviewComplete =
    !args.expectCopilot ||
    (!copilotWorkflowActive && !copilotRequested && validHeadCopilotReviews.length > 0);
  const allRequestedReviewsComplete = pendingReviewers.length === 0 && copilotReviewComplete;

  if (allRequestedReviewsComplete && (unresolvedThreads.length > 0 || bodyFindings.length > 0)) {
    return {
      events: [
        {
          type: "FEEDBACK_ACTION_NEEDED",
          headRefOid: headOid,
          unresolvedThreads,
          bodyFindings,
        },
      ],
    };
  }

  if (
    allRequestedReviewsComplete &&
    contexts.length > 0 &&
    pendingChecks.length === 0 &&
    unresolvedThreads.length === 0 &&
    bodyFindings.length === 0
  ) {
    return {
      events: [
        {
          type: "PR_READY_TO_MERGE",
          headRefOid: headOid,
          mergeStateStatus: pr.mergeStateStatus,
          mergeable: pr.mergeable,
          reviewDecision: pr.reviewDecision,
        },
      ],
    };
  }

  const totalChecksCount = contexts.length;
  const passedChecksCount = totalChecksCount - pendingChecks.length - failedChecks.length;
  const phaseInfo = computePrPhase({
    totalChecksCount,
    passedChecksCount,
    pendingChecks,
    expectCopilot: args.expectCopilot,
    copilotWorkflowActive,
    copilotRequested,
    validHeadCopilotReviewsCount: validHeadCopilotReviews.length,
    pendingReviewers,
  });

  if (args.emitPhaseChanges && args.lastPhase && phaseInfo.phase !== args.lastPhase) {
    return {
      events: [
        {
          type: "PHASE_CHANGED",
          headRefOid: headOid,
          previousPhase: args.lastPhase,
          phase: phaseInfo.phase,
          summary: phaseInfo.summary,
        },
      ],
      status: {
        headRefOid: headOid,
        phase: phaseInfo.phase,
        summary: phaseInfo.summary,
        totalChecksCount,
        passedChecksCount,
        pendingChecksCount: pendingChecks.length,
        pendingChecks,
        pendingReviewers,
        copilotWorkflowActive,
        validHeadCopilotReviewsCount: validHeadCopilotReviews.length,
        unresolvedThreadsCount: unresolvedThreads.length,
        bodyFindingsCount: bodyFindings.length,
      },
    };
  }

  return {
    events: [],
    status: {
      headRefOid: headOid,
      phase: phaseInfo.phase,
      summary: phaseInfo.summary,
      totalChecksCount,
      passedChecksCount,
      pendingChecksCount: pendingChecks.length,
      pendingChecks,
      pendingReviewers,
      copilotWorkflowActive,
      validHeadCopilotReviewsCount: validHeadCopilotReviews.length,
      unresolvedThreadsCount: unresolvedThreads.length,
      bodyFindingsCount: bodyFindings.length,
    },
  };
}

async function sleepSeconds(sec) {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, sec * 1000));
}

export async function runCli(argv = process.argv.slice(2)) {
  const args = parsePrWatchArgs(argv);
  if (args.mode === "once") {
    console.log(JSON.stringify(evaluatePrPollTick(args), null, 2));
    return;
  }

  let baselinePhase = args.lastPhase;
  let polls = 0;
  while (true) {
    polls += 1;
    const tick = evaluatePrPollTick({ ...args, lastPhase: baselinePhase });
    if (tick.events.length > 0) {
      console.log(JSON.stringify(tick, null, 2));
      return;
    }
    if (!baselinePhase && tick.status?.phase) {
      baselinePhase = tick.status.phase;
    }
    if (args.maxPolls > 0 && polls >= args.maxPolls) {
      console.log(JSON.stringify({ events: [{ type: "MAX_POLLS_REACHED" }], status: tick.status }, null, 2));
      return;
    }
    await sleepSeconds(args.intervalSec);
  }
}

if (
  import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}` ||
  process.argv[1]?.endsWith("pr-watch-daemon.mjs")
) {
  runCli();
}
