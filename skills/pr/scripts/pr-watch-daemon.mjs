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
    expectedReviewers: [],
    sinceCommentId: 0,
    hasExplicitSinceCommentId: false,
    lastPhase: "",
    emitPhaseChanges: true,
  };

  const addExpectedReviewers = (raw) => {
    for (const item of String(raw)
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)) {
      if (!args.expectedReviewers.includes(item)) {
        args.expectedReviewers.push(item);
      }
    }
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
    } else if (
      (token === "--expected-reviewer" || token === "--expected-reviewers") &&
      argv[i + 1]
    ) {
      addExpectedReviewers(argv[++i]);
    } else if (token === "--since-comment-id" && argv[i + 1]) {
      const parsedId = Number.parseInt(argv[++i], 10);
      if (!Number.isSafeInteger(parsedId) || parsedId < 0) {
        throw new Error(`Invalid --since-comment-id "${parsedId}". Expected a non-negative integer.`);
      }
      args.sinceCommentId = parsedId;
      args.hasExplicitSinceCommentId = true;
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

export function extractBodyOnlyFindings(reviews, issueComments, _currentHeadOid) {
  const findings = [];
  const validReviews = (reviews || []).filter(
    (r) => r && r.state !== "DISMISSED" && !isErroredCopilotReview(r)
  );
  const latestByAuthor = new Map();
  for (const r of validReviews) {
    const login = (r.author?.login || "").toLowerCase();
    if (login) {
      latestByAuthor.set(login, r);
    }
  }

  for (const review of validReviews) {
    const commitOid = review.commit?.oid || "";
    const login = review.author?.login || "unknown";
    const lowerLogin = login.toLowerCase();
    const latestForAuthor = latestByAuthor.get(lowerLogin);
    const body = review.body || "";
    const hasActionableBody = ACTIONABLE_BODY_RE.test(body);
    const isActiveChangesRequested =
      review.state === "CHANGES_REQUESTED" && latestForAuthor === review;

    if (!isActiveChangesRequested && !hasActionableBody) {
      continue;
    }

    const reviewId = review.databaseId;
    const reviewSubmittedMs = review.submittedAt ? Date.parse(review.submittedAt) : NaN;
    const citedInComment =
      reviewId &&
      !isActiveChangesRequested &&
      (issueComments || []).some((c) => {
        if (typeof c?.body !== "string" || !new RegExp(`\\b${reviewId}\\b`).test(c.body)) {
          return false;
        }
        const commentCreatedMs = c.createdAt ? Date.parse(c.createdAt) : NaN;
        if (Number.isFinite(reviewSubmittedMs) && Number.isFinite(commentCreatedMs)) {
          return commentCreatedMs >= reviewSubmittedMs;
        }
        return true;
      });
    if (!citedInComment) {
      const headlineMatch = body.match(/^###\s+.+$/m);
      findings.push({
        reviewId,
        author: login,
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
              ... on Team { slug name }
              ... on Mannequin { login }
            }
          }
        }
        reviews(last: 50) {
          pageInfo { hasPreviousPage }
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
          pageInfo { hasNextPage }
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
          pageInfo { hasPreviousPage }
          nodes {
            databaseId
            createdAt
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
                  pageInfo { hasNextPage }
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
    const errMsg = gqlRes.stderr || "GraphQL query failed";
    return { events: [{ type: "POLL_ERROR", error: errMsg }], error: errMsg };
  }

  let parsed;
  try {
    parsed = JSON.parse(gqlRes.stdout);
  } catch (error) {
    const errMsg = `Invalid GraphQL JSON: ${error.message}`;
    return { events: [{ type: "POLL_ERROR", error: errMsg }], error: errMsg };
  }
  if (Array.isArray(parsed?.errors) && parsed.errors.length > 0) {
    const errMsg = parsed.errors.map((e) => e?.message || "GraphQL error").join("; ");
    return {
      events: [{ type: "POLL_ERROR", error: errMsg }],
      error: errMsg,
    };
  }
  const pr = parsed?.data?.repository?.pullRequest;
  if (!pr) {
    const errMsg = "Pull request not found";
    return { events: [{ type: "POLL_ERROR", error: errMsg }], error: errMsg };
  }

  const truncatedCollections = [];
  if (pr.reviews?.pageInfo?.hasPreviousPage) truncatedCollections.push("reviews");
  if (pr.reviewThreads?.pageInfo?.hasNextPage) truncatedCollections.push("reviewThreads");
  if (pr.comments?.pageInfo?.hasPreviousPage) truncatedCollections.push("comments");
  if (pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.pageInfo?.hasNextPage) {
    truncatedCollections.push("statusCheckRollup.contexts");
  }
  if (truncatedCollections.length > 0) {
    return {
      events: [
        {
          type: "COLLECTION_TRUNCATED",
          headRefOid: pr.headRefOid,
          collections: truncatedCollections,
        },
      ],
    };
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

  const allComments = pr.comments?.nodes || [];
  const latestCommentId = allComments.reduce(
    (maxId, c) => (Number.isSafeInteger(c?.databaseId) && c.databaseId > maxId ? c.databaseId : maxId),
    0
  );
  const newConversationComments = args.hasExplicitSinceCommentId
    ? allComments.filter(
        (c) => Number.isSafeInteger(c?.databaseId) && c.databaseId > args.sinceCommentId
      )
    : [];
  if (newConversationComments.length > 0) {
    return {
      events: [
        {
          type: "NEW_PR_COMMENTS",
          headRefOid: pr.headRefOid,
          latestCommentId,
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
    if (!runsRes.ok || !runsRes.stdout) {
      const errMsg = runsRes.stderr || "Workflow runs inventory unavailable";
      return { events: [{ type: "POLL_ERROR", error: errMsg }], error: errMsg };
    }
    let runsData;
    try {
      runsData = JSON.parse(runsRes.stdout);
    } catch (error) {
      const errMsg = `Invalid workflow runs JSON: ${error.message}`;
      return { events: [{ type: "POLL_ERROR", error: errMsg }], error: errMsg };
    }
    if (!Array.isArray(runsData?.workflow_runs)) {
      const errMsg = "Workflow runs response missing workflow_runs array";
      return { events: [{ type: "POLL_ERROR", error: errMsg }], error: errMsg };
    }
    copilotWorkflowActive = runsData.workflow_runs.some(
      (r) =>
        /Copilot Code Review/i.test(r.name || "") &&
        r.status !== "completed"
    );
  }

  const rawPendingReviewers = (pr.reviewRequests?.nodes || [])
    .map((n) => {
      const rr = n?.requestedReviewer;
      if (!rr) return "";
      return rr.login || rr.slug || rr.name || rr.__typename || "unknown-reviewer";
    })
    .filter(Boolean);
  const pendingReviewers = args.expectCopilot
    ? rawPendingReviewers
    : rawPendingReviewers.filter((id) => !/copilot/i.test(id));
  const copilotRequested = args.expectCopilot && rawPendingReviewers.some((id) => /copilot/i.test(id));

  const headReviews = (pr.reviews?.nodes || []).filter(
    (r) => r && r.commit?.oid === headOid && r.state !== "DISMISSED" && !isErroredCopilotReview(r)
  );
  const allHeadCopilotReviews = (pr.reviews?.nodes || []).filter(
    (r) =>
      r &&
      r.commit?.oid === headOid &&
      r.state !== "DISMISSED" &&
      /copilot/i.test(r.author?.login || "")
  );
  const validHeadCopilotReviews = allHeadCopilotReviews.filter((r) => !isErroredCopilotReview(r));
  const latestHeadCopilotReview = allHeadCopilotReviews.at(-1);

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

  // Verify every non-exempt expected reviewer has a non-dismissed, non-errored review on headOid
  const headReviewerLogins = new Set(
    headReviews.map((r) => (r.author?.login || "").toLowerCase()).filter(Boolean)
  );
  const nonExemptExpectedReviewers = (args.expectedReviewers || []).filter(
    (login) => args.expectCopilot || !/copilot/i.test(login)
  );
  const missingExpectedReviewers = nonExemptExpectedReviewers.filter(
    (login) => !headReviewerLogins.has(login)
  );

  const copilotReviewPending = args.expectCopilot && (copilotWorkflowActive || copilotRequested);
  const copilotReviewComplete =
    !args.expectCopilot || (!copilotReviewPending && validHeadCopilotReviews.length > 0);
  const allRequestedReviewsComplete =
    pendingReviewers.length === 0 &&
    copilotReviewComplete &&
    missingExpectedReviewers.length === 0;

  if (!copilotReviewPending && (unresolvedThreads.length > 0 || bodyFindings.length > 0)) {
    return {
      events: [
        {
          type: "FEEDBACK_ACTION_NEEDED",
          headRefOid: headOid,
          latestCommentId,
          unresolvedThreads,
          bodyFindings,
        },
      ],
    };
  }

  const mergeGatesSatisfied =
    pr.mergeable === "MERGEABLE" &&
    ["CLEAN", "HAS_HOOKS"].includes(pr.mergeStateStatus) &&
    pr.reviewDecision !== "REVIEW_REQUIRED" &&
    pr.reviewDecision !== "CHANGES_REQUESTED";

  if (
    allRequestedReviewsComplete &&
    mergeGatesSatisfied &&
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
          latestCommentId,
          mergeStateStatus: pr.mergeStateStatus,
          mergeable: pr.mergeable,
          reviewDecision: pr.reviewDecision,
        },
      ],
    };
  }

  const totalChecksCount = contexts.length;
  const passedChecksCount = totalChecksCount - pendingChecks.length - failedChecks.length;
  const nowIso = new Date().toISOString();
  const combinedPendingReviewers = [
    ...new Set([...pendingReviewers, ...missingExpectedReviewers]),
  ];
  const phaseInfo = computePrPhase({
    totalChecksCount,
    passedChecksCount,
    pendingChecks,
    expectCopilot: args.expectCopilot,
    copilotWorkflowActive,
    copilotRequested,
    validHeadCopilotReviewsCount: validHeadCopilotReviews.length,
    pendingReviewers: combinedPendingReviewers,
  });
  const statusPayload = {
    timestamp: nowIso,
    headRefOid: headOid,
    latestCommentId,
    phase: phaseInfo.phase,
    summary: phaseInfo.summary,
    totalChecksCount,
    passedChecksCount,
    pendingChecksCount: pendingChecks.length,
    pendingChecks,
    pendingReviewers: combinedPendingReviewers,
    copilotWorkflowActive,
    validHeadCopilotReviewsCount: validHeadCopilotReviews.length,
    unresolvedThreadsCount: unresolvedThreads.length,
    bodyFindingsCount: bodyFindings.length,
  };

  if (args.emitPhaseChanges && args.lastPhase && phaseInfo.phase !== args.lastPhase) {
    return {
      events: [
        {
          type: "PHASE_CHANGED",
          timestamp: nowIso,
          headRefOid: headOid,
          latestCommentId,
          previousPhase: args.lastPhase,
          phase: phaseInfo.phase,
          summary: phaseInfo.summary,
        },
      ],
      status: statusPayload,
    };
  }

  return {
    events: [],
    status: statusPayload,
  };
}

async function sleepSeconds(sec) {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, sec * 1000));
}

export async function runCli(argv = process.argv.slice(2)) {
  const args = parsePrWatchArgs(argv);
  if (args.mode === "once") {
    const tick = evaluatePrPollTick(args);
    console.log(JSON.stringify(tick, null, 2));
    if (tick.error) {
      process.exit(1);
    }
    return;
  }

  let baselinePhase = args.lastPhase;
  let hasCommentBaseline = args.hasExplicitSinceCommentId;
  let baselineCommentId = args.sinceCommentId;
  let polls = 0;
  while (true) {
    polls += 1;
    const tick = evaluatePrPollTick({
      ...args,
      lastPhase: baselinePhase,
      hasExplicitSinceCommentId: hasCommentBaseline,
      sinceCommentId: baselineCommentId,
    });
    if (tick.error) {
      console.error(JSON.stringify(tick, null, 2));
      process.exit(1);
    }
    if (tick.events.length > 0) {
      console.log(JSON.stringify(tick, null, 2));
      return;
    }
    if (!baselinePhase && tick.status?.phase) {
      baselinePhase = tick.status.phase;
    }
    if (!hasCommentBaseline && Number.isSafeInteger(tick.status?.latestCommentId)) {
      hasCommentBaseline = true;
      baselineCommentId = tick.status.latestCommentId;
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
