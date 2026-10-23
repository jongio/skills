#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";

const ERRORED_COPILOT_REVIEW_RE = /Copilot encountered an error and was unable to review this pull request/i;
const ACTIONABLE_BODY_RE =
  /(?:###\s*(?:🟡\s*Changes recommended|🔵\s*Needs a closer look)|\b[1-9]\d*\s+(?:open|previously missed)\s+issues?\b)/i;
const CLEAN_COPILOT_BODY_RE = /###\s*🟢\s*Approval recommended[\s\S]*?\*\*No open issues\*\*/i;

export function isCopilotBotLogin(login) {
  return /^(?:copilot|copilot-pull-request-reviewer(?:\[bot\])?|github-copilot(?:\[bot\])?)$/i.test(
    String(login || "").trim()
  );
}

export function detectRepoFromGit(cwd = process.cwd()) {
  try {
    const remote = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const match = remote.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/i);
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
    if (token === "watch" || token === "once" || token === "request-copilot") {
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
  if (args.mode === "request-copilot" && !args.head) {
    throw new Error('Missing or invalid --head "<oid>" for request-copilot.');
  }
  return args;
}

export function computePrPhase({
  totalChecksCount = 0,
  passedChecksCount = 0,
  pendingChecks = [],
  activeWorkflowRuns = [],
  expectCopilot = true,
  copilotWorkflowActive = false,
  copilotRequested = false,
  validHeadCopilotReviewsCount = 0,
  pendingReviewers = [],
} = {}) {
  let ciPhase = "ci:none";
  let ciLabel = "CI not started";
  if (totalChecksCount > 0 || activeWorkflowRuns.length > 0) {
    if (pendingChecks.length > 0 || activeWorkflowRuns.length > 0) {
      ciPhase = "ci:running";
      const activeNames = pendingChecks.length > 0 ? pendingChecks : activeWorkflowRuns;
      const sampleActive = activeNames.slice(0, 3).join(", ");
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

function extractBodyConcerns(body, fallbackHeadline, resolvedCommentIds = new Set()) {
  const bodyWithoutResolvedDetails = body.replace(
    /<details[^>]*>\s*<summary>\s*<strong>\s*\d+\s+resolved since last review\s*<\/strong>\s*<\/summary>[\s\S]*?<\/details>/gi,
    ""
  );
  const concerns = [];
  let hadInlineLinks = false;
  for (const match of bodyWithoutResolvedDetails.matchAll(
    /\[([^\]]+)\]\(https:\/\/github\.com\/[^)]+#discussion_r(\d+)\)/g
  )) {
    hadInlineLinks = true;
    const title = match[1].trim();
    const commentId = Number.parseInt(match[2], 10);
    if (resolvedCommentIds.has(commentId)) {
      continue;
    }
    if (title && !concerns.includes(title)) {
      concerns.push(title);
    }
  }
  for (const match of bodyWithoutResolvedDetails.matchAll(
    /<summary>[\s\S]*?<\/picture>\s*([^<\n]+)<\/summary>/gi
  )) {
    const title = match[1].trim();
    if (title && !concerns.includes(title)) {
      concerns.push(title);
    }
  }
  const residualProse = bodyWithoutResolvedDetails
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<details[^>]*>\s*<summary>\s*<strong>\s*\d+\s+open issues?\s*<\/strong>\s*<\/summary>[\s\S]*?<\/details>/gi, "")
    .replace(/^\s*-\s*(?:<picture>[\s\S]*?<\/picture>\s*)?\[[^\]]+\]\(https:\/\/github\.com\/[^)]+#discussion_r\d+\).*$/gm, "")
    .replace(/^###\s+.+$/gm, "")
    .replace(/\*\*No open issues\*\*\s*(?:🎉)?/gi, "")
    .replace(/<sub>[\s\S]*?<\/sub>/gi, "")
    .trim();

  if (
    (residualProse.length > 0 || (concerns.length === 0 && !hadInlineLinks)) &&
    !concerns.includes(fallbackHeadline)
  ) {
    concerns.push(fallbackHeadline);
  }
  return concerns;
}

export function extractBodyOnlyFindings(
  reviews,
  issueComments,
  _currentHeadOid,
  resolvedCommentIds = new Set()
) {
  const findings = [];
  const validReviews = (reviews || []).filter(
    (r) =>
      r &&
      r.state !== "DISMISSED" &&
      r.state !== "PENDING" &&
      Boolean(r.submittedAt !== null) &&
      !isErroredCopilotReview(r)
  );
  const latestDecisionByAuthor = new Map();
  for (const r of validReviews) {
    const login = (r.author?.login || "").toLowerCase();
    if (login && (r.state === "APPROVED" || r.state === "CHANGES_REQUESTED")) {
      latestDecisionByAuthor.set(login, r);
    }
  }

  for (const review of validReviews) {
    const commitOid = review.commit?.oid || "";
    const login = review.author?.login || "unknown";
    const lowerLogin = login.toLowerCase();
    const latestDecision = latestDecisionByAuthor.get(lowerLogin);
    const body = (review.body || "").trim();
    const isCleanApprovalBody = CLEAN_COPILOT_BODY_RE.test(body) && !ACTIONABLE_BODY_RE.test(body);
    const hasActionableBody =
      ACTIONABLE_BODY_RE.test(body) ||
      (review.state === "COMMENTED" && body.length > 0 && !isCleanApprovalBody);
    const isActiveChangesRequested =
      review.state === "CHANGES_REQUESTED" && latestDecision === review;

    if (!isActiveChangesRequested && !hasActionableBody) {
      continue;
    }

    const reviewId = review.databaseId;
    const reviewSubmittedMs = review.submittedAt ? Date.parse(review.submittedAt) : NaN;
    const headlineMatch = body.match(/^###\s+.+$/m);
    const headline = headlineMatch ? headlineMatch[0].trim() : review.state;
    const concerns = extractBodyConcerns(body, headline, resolvedCommentIds);
    if (concerns.length === 0 && !isActiveChangesRequested) {
      continue;
    }

    const eligibleComments = (issueComments || []).filter((c) => {
      if (typeof c?.body !== "string" || !new RegExp(`\\b${reviewId}\\b`).test(c.body)) {
        return false;
      }
      const commentCreatedMs = c.createdAt ? Date.parse(c.createdAt) : NaN;
      if (Number.isFinite(reviewSubmittedMs) && Number.isFinite(commentCreatedMs)) {
        return commentCreatedMs >= reviewSubmittedMs;
      }
      return true;
    });

    const unsettledConcerns = isActiveChangesRequested
      ? concerns
      : concerns.filter((concern) => {
          if (eligibleComments.length === 0) {
            return true;
          }
          if (concerns.length === 1) {
            return false;
          }
          const lowerConcern = concern.toLowerCase();
          return !eligibleComments.some((c) => c.body.toLowerCase().includes(lowerConcern));
        });

    if (unsettledConcerns.length > 0) {
      findings.push({
        reviewId,
        author: login,
        state: review.state,
        commitOid,
        headline,
        unsettledConcerns,
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

export function requestCopilotReview(args, execFn = defaultExecGh) {
  if (!args?.head || typeof args.head !== "string" || !args.head.trim()) {
    return {
      ok: false,
      status: "missing_head",
      error: 'Missing or invalid --head "<oid>" for request-copilot.',
    };
  }
  const [owner, name] = args.repo.split("/");
  const query = `query($owner: String!, $name: String!, $pr: Int!) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $pr) {
        state
        headRefOid
        headRefName
        headRepository {
          nameWithOwner
        }
        reviewRequests(first: 100) {
          pageInfo { hasNextPage }
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
      }
    }
  }`;

  const fetchValidatedPr = () => {
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
    if (!gqlRes || !gqlRes.ok) {
      return {
        ok: false,
        result: {
          ok: false,
          status: "poll_error",
          error: gqlRes?.stderr || "GraphQL query failed",
        },
      };
    }

    let parsed;
    try {
      parsed = JSON.parse(gqlRes.stdout);
    } catch (error) {
      return {
        ok: false,
        result: {
          ok: false,
          status: "poll_error",
          error: `Invalid GraphQL JSON: ${error.message}`,
        },
      };
    }
    if (Array.isArray(parsed?.errors) && parsed.errors.length > 0) {
      return {
        ok: false,
        result: {
          ok: false,
          status: "poll_error",
          error: parsed.errors.map((e) => e?.message || "GraphQL error").join("; "),
        },
      };
    }
    const prNode = parsed?.data?.repository?.pullRequest;
    if (!prNode) {
      return {
        ok: false,
        result: {
          ok: false,
          status: "poll_error",
          error: "Pull request not found",
        },
      };
    }

    if (prNode.state !== "OPEN") {
      return {
        ok: false,
        result: {
          ok: false,
          status: "pr_not_open",
          state: prNode.state,
        },
      };
    }

    if (prNode.headRefOid !== args.head) {
      return {
        ok: false,
        result: {
          ok: false,
          status: "head_mismatch",
          expectedHead: args.head,
          actualHead: prNode.headRefOid,
        },
      };
    }

    if (prNode.reviewRequests?.pageInfo?.hasNextPage) {
      return {
        ok: false,
        result: {
          ok: false,
          status: "collection_truncated",
          collections: ["reviewRequests"],
          error: "PR reviewRequests exceeded 100 entries",
        },
      };
    }

    return { ok: true, pr: prNode };
  };

  const initialPrCheck = fetchValidatedPr();
  if (!initialPrCheck.ok) {
    return initialPrCheck.result;
  }
  let pr = initialPrCheck.pr;

  const isMatchingActivePrRun = (run, targetPr) => {
    if (!run || run.status === "completed" || !/Copilot Code Review/i.test(run.name || "")) {
      return false;
    }
    const hasExplicitPrs = Array.isArray(run.pull_requests) && run.pull_requests.length > 0;
    if (hasExplicitPrs) {
      return run.pull_requests.some((p) => p?.number === args.pr);
    }
    const sameBranch = Boolean(targetPr.headRefName && run.head_branch === targetPr.headRefName);
    if (!sameBranch) {
      return false;
    }
    const baseRepoLower = (args.repo || "").toLowerCase();
    const expectedHeadRepoLower = (
      targetPr.headRepository?.nameWithOwner ||
      args.repo ||
      ""
    ).toLowerCase();
    const runHeadRepoLower = (run.head_repository?.full_name || "").toLowerCase();
    if (expectedHeadRepoLower !== baseRepoLower) {
      return runHeadRepoLower === expectedHeadRepoLower;
    }
    return !runHeadRepoLower || runHeadRepoLower === expectedHeadRepoLower;
  };

  // Order statuses from pre-execution to running, and perform a bounded multi-pass
  // stabilization recheck so runs transitioning (e.g., queued -> in_progress) between
  // per-status queries cannot slip between buckets undetected.
  const activeRunStatuses = ["pending", "requested", "waiting", "queued", "in_progress"];
  const maxInventoryPasses = 3;
  let allWorkflowRuns = [];
  let previousPassSignature = null;
  let inventoryStabilized = false;

  for (let pass = 1; pass <= maxInventoryPasses; pass += 1) {
    const passRuns = [];
    const seenPassRunIds = new Set();

    for (const runStatus of activeRunStatuses) {
      const statusRuns = [];
      let page = 1;
      while (true) {
        const endpoint =
          page === 1
            ? `repos/${args.repo}/actions/runs?status=${runStatus}&per_page=100`
            : `repos/${args.repo}/actions/runs?status=${runStatus}&per_page=100&page=${page}`;
        const runsRes = execFn(["api", endpoint]);
        if (!runsRes || !runsRes.ok || !runsRes.stdout) {
          return {
            ok: false,
            status: "poll_error",
            error: runsRes?.stderr || "Workflow runs inventory unavailable",
          };
        }

        let runsData;
        try {
          runsData = JSON.parse(runsRes.stdout);
        } catch (error) {
          return {
            ok: false,
            status: "poll_error",
            error: `Invalid workflow runs JSON: ${error.message}`,
          };
        }
        if (!Array.isArray(runsData?.workflow_runs)) {
          return {
            ok: false,
            status: "poll_error",
            error: "Workflow runs response missing workflow_runs array",
          };
        }

        const pageRuns = runsData.workflow_runs;
        statusRuns.push(...pageRuns);
        for (const run of pageRuns) {
          const key = run?.id ?? Symbol("run");
          if (!seenPassRunIds.has(key)) {
            seenPassRunIds.add(key);
            passRuns.push(run);
          }
        }
        const totalCount =
          typeof runsData.total_count === "number" ? runsData.total_count : statusRuns.length;

        if (statusRuns.length >= totalCount) {
          break;
        }
        if (pageRuns.length === 0) {
          return {
            ok: false,
            status: "collection_truncated",
            collections: ["workflow_runs"],
            error: `Workflow runs inventory for status=${runStatus} truncated at ${statusRuns.length}/${totalCount}`,
          };
        }
        page += 1;
      }
    }

    const passSignature = passRuns
      .filter((r) => isMatchingActivePrRun(r, pr))
      .map((r) => `${r.id ?? ""}:${r.head_sha ?? ""}`)
      .sort()
      .join("|");

    allWorkflowRuns = passRuns;
    if (previousPassSignature !== null && passSignature === previousPassSignature) {
      inventoryStabilized = true;
      break;
    }
    previousPassSignature = passSignature;
  }

  if (!inventoryStabilized) {
    return {
      ok: false,
      status: "inventory_unstable",
      error: "Active Copilot workflow run inventory did not stabilize across recheck passes",
    };
  }

  // Revalidate PR open state and pinned head after inventory before cancelling runs or editing reviewers
  const refreshedPrCheck = fetchValidatedPr();
  if (!refreshedPrCheck.ok) {
    return refreshedPrCheck.result;
  }
  pr = refreshedPrCheck.pr;

  const matchingActiveRuns = allWorkflowRuns.filter((run) => isMatchingActivePrRun(run, pr));

  const currentHeadRun = matchingActiveRuns.find((run) => run.head_sha === pr.headRefOid);

  const cancelledRunIds = [];
  for (const run of matchingActiveRuns) {
    if (run.head_sha !== pr.headRefOid && run.id) {
      const cancelRes = execFn([
        "api",
        "-X",
        "POST",
        `repos/${args.repo}/actions/runs/${run.id}/cancel`,
      ]);
      if (!cancelRes || !cancelRes.ok) {
        return {
          ok: false,
          status: "cancel_failed",
          headRefOid: pr.headRefOid,
          runId: run.id,
          cancelledRunIds,
          error: cancelRes?.stderr || `Failed to cancel superseded Copilot review run ${run.id}`,
        };
      }
      cancelledRunIds.push(run.id);
    }
  }

  if (currentHeadRun) {
    return {
      ok: true,
      status: "already_running",
      headRefOid: pr.headRefOid,
      activeRunId: currentHeadRun.id,
      cancelledRunIds,
    };
  }

  const copilotCurrentlyRequested = (pr.reviewRequests?.nodes || []).some((n) =>
    isCopilotBotLogin(n?.requestedReviewer?.login)
  );
  const toggledExistingRequest = Boolean(copilotCurrentlyRequested || cancelledRunIds.length > 0);
  if (toggledExistingRequest) {
    const removeRes = execFn([
      "pr",
      "edit",
      String(args.pr),
      "-R",
      args.repo,
      "--remove-reviewer",
      "@copilot",
    ]);
    if (!removeRes || !removeRes.ok) {
      return {
        ok: false,
        status: "remove_reviewer_failed",
        headRefOid: pr.headRefOid,
        cancelledRunIds,
        error: removeRes?.stderr || "Failed to remove existing @copilot reviewer request",
      };
    }
  }

  const addRes = execFn([
    "pr",
    "edit",
    String(args.pr),
    "-R",
    args.repo,
    "--add-reviewer",
    "@copilot",
  ]);
  if (!addRes.ok) {
    return {
      ok: false,
      status: "request_failed",
      headRefOid: pr.headRefOid,
      cancelledRunIds,
      error: addRes.stderr || "Failed to request @copilot review",
    };
  }

  return {
    ok: true,
    status: "requested",
    headRefOid: pr.headRefOid,
    cancelledRunIds,
    toggledExistingRequest,
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
          lastPhase: args.lastPhase || "",
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

  // Check Actions workflow runs on headOid for both active Copilot reviews and latest workflow-level state
  let copilotWorkflowActive = false;
  const activeWorkflowRuns = [];
  const runsRes = execFn(["api", `repos/${args.repo}/actions/runs?head_sha=${headOid}&per_page=100`]);
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
  if (
    typeof runsData?.total_count === "number" &&
    runsData.total_count > runsData.workflow_runs.length
  ) {
    return {
      events: [
        {
          type: "COLLECTION_TRUNCATED",
          headRefOid: headOid,
          collections: ["workflow_runs"],
        },
      ],
    };
  }

  const latestByWorkflowKey = new Map();
  for (const run of runsData.workflow_runs) {
    if (/Copilot Code Review/i.test(run.name || "")) {
      if (run.status !== "completed") {
        copilotWorkflowActive = true;
      }
      continue;
    }
    const wfKey = `${run.workflow_id ?? run.path ?? run.name ?? "wf"}::${run.event ?? ""}::${run.head_branch ?? ""}`;
    const prev = latestByWorkflowKey.get(wfKey);
    if (!prev || (run.id ?? 0) > (prev.id ?? 0)) {
      latestByWorkflowKey.set(wfKey, run);
    }
  }

  for (const run of latestByWorkflowKey.values()) {
    if (run.status !== "completed") {
      activeWorkflowRuns.push(run.name || "workflow");
    } else if (
      run.conclusion &&
      !["success", "skipped", "neutral"].includes(run.conclusion.toLowerCase())
    ) {
      const runIdMarker = run.id ? `/runs/${run.id}` : "";
      const alreadyRecorded = failedChecks.some(
        (fc) =>
          (runIdMarker && typeof fc.url === "string" && fc.url.includes(runIdMarker)) ||
          (fc.url && fc.url === run.html_url) ||
          fc.name === run.name
      );
      if (!alreadyRecorded) {
        failedChecks.push({
          name: run.name || "workflow",
          conclusion: run.conclusion.toUpperCase(),
          url: run.html_url,
        });
      }
    }
  }

  if (failedChecks.length > 0) {
    return {
      events: [
        {
          type: "CI_FAILED",
          timestamp: new Date().toISOString(),
          headRefOid: headOid,
          failedChecks,
          remediation:
            "Inspect the failed job logs via `gh api repos/<owner>/<repo>/actions/jobs/<jobId>/logs`, fix the root cause (or rebase if base SHA drifted during push), commit, push, and restart pr-watch-daemon.mjs.",
        },
      ],
    };
  }

  const rawPendingReviewerEntries = (pr.reviewRequests?.nodes || [])
    .map((n) => {
      const rr = n?.requestedReviewer;
      if (!rr) return null;
      const id = rr.login || rr.slug || rr.name || rr.__typename || "unknown-reviewer";
      const isCopilotBot = rr.__typename === "Bot" && isCopilotBotLogin(rr.login);
      return { id, isCopilotBot };
    })
    .filter(Boolean);
  const pendingReviewers = (
    args.expectCopilot
      ? rawPendingReviewerEntries
      : rawPendingReviewerEntries.filter((entry) => !entry.isCopilotBot)
  ).map((entry) => entry.id);
  const copilotRequested =
    args.expectCopilot && rawPendingReviewerEntries.some((entry) => entry.isCopilotBot);

  const isSubmittedReview = (r) =>
    Boolean(r && r.state !== "DISMISSED" && r.state !== "PENDING" && r.submittedAt);

  const headReviews = (pr.reviews?.nodes || []).filter(
    (r) => isSubmittedReview(r) && r.commit?.oid === headOid && !isErroredCopilotReview(r)
  );
  const allHeadCopilotReviews = (pr.reviews?.nodes || []).filter(
    (r) =>
      isSubmittedReview(r) &&
      r.commit?.oid === headOid &&
      isCopilotBotLogin(r.author?.login)
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
          latestCommentId,
          lastPhase: args.lastPhase || "",
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

  const resolvedCommentIds = new Set();
  for (const t of pr.reviewThreads?.nodes || []) {
    if (t && t.isResolved === true) {
      for (const c of t.comments?.nodes || []) {
        if (Number.isSafeInteger(c?.databaseId)) {
          resolvedCommentIds.add(c.databaseId);
        }
      }
    }
  }

  const bodyFindings = extractBodyOnlyFindings(
    pr.reviews?.nodes || [],
    pr.comments?.nodes || [],
    headOid,
    resolvedCommentIds
  );

  // Verify every non-exempt expected reviewer has a non-dismissed, non-errored submitted review on headOid
  const headReviewerLogins = new Set(
    headReviews.map((r) => (r.author?.login || "").toLowerCase()).filter(Boolean)
  );
  const nonExemptExpectedReviewers = (args.expectedReviewers || []).filter(
    (login) => args.expectCopilot || !isCopilotBotLogin(login)
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
    activeWorkflowRuns.length === 0 &&
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
    activeWorkflowRuns,
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
    activeWorkflowRuns,
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
  if (args.mode === "request-copilot") {
    const res = requestCopilotReview(args);
    console.log(JSON.stringify(res, null, 2));
    if (!res.ok) {
      process.exit(1);
    }
    return;
  }
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
    const terminalEvents = tick.events.filter((e) => e.type !== "PHASE_CHANGED");
    if (terminalEvents.length > 0) {
      console.log(JSON.stringify(tick, null, 2));
      return;
    }
    // Emit live status and nonterminal phase changes to stdout while continuing to watch
    console.log(JSON.stringify({ events: tick.events, status: tick.status }, null, 2));
    if (tick.status?.phase) {
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
