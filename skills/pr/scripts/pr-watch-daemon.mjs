#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createGitHubClient, createEventWriter, httpDetails, runGh } from "./lib/github-client.mjs";
import { resolve } from "node:path";

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
      timeout: 5000,
      windowsHide: true,
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
    eventsFile: "",
    repo: "",
    pr: 0,
    prs: [],
    prHeads: {},
    head: "",
    intervalSec: 15,
    maxPolls: 0,
    maxCopilotRetries: 2,
    expectCopilot: true,
    expectedReviewers: [],
    sinceCommentId: 0,
    hasExplicitSinceCommentId: false,
    lastPhase: "",
    emitPhaseChanges: true,
  };

  const addPrSpec = (rawSpec) => {
    for (const part of String(rawSpec)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)) {
      const colonIdx = part.indexOf(":");
      const numStr = colonIdx === -1 ? part : part.slice(0, colonIdx).trim();
      const headPin = colonIdx === -1 ? "" : part.slice(colonIdx + 1).trim();
      if (!/^[1-9]\d*$/.test(numStr)) {
        throw new Error(`Invalid PR number "${part}". Expected a positive integer (or "<pr>:<head-oid>").`);
      }
      const prNum = Number.parseInt(numStr, 10);
      if (!args.prs.includes(prNum)) {
        args.prs.push(prNum);
      }
      if (headPin) {
        args.prHeads[prNum] = headPin;
      }
    }
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
    } else if (token === "--events-file" && argv[i + 1]) {
      args.eventsFile = resolve(argv[++i]);
    } else if (token === "--repo" && argv[i + 1]) {
      args.repo = argv[++i].trim();
    } else if (token === "--pr" && argv[i + 1]) {
      const rawPr = argv[++i].trim();
      if (/^[1-9]\d*$/.test(rawPr)) {
        const prNum = Number.parseInt(rawPr, 10);
        if (!args.prs.includes(prNum)) {
          args.prs.push(prNum);
        }
      } else {
        args.pr = Number.parseInt(rawPr, 10) || 0;
      }
    } else if (token === "--prs" && argv[i + 1]) {
      addPrSpec(argv[++i]);
    } else if (token === "--head" && argv[i + 1]) {
      args.head = argv[++i].trim();
    } else if (token === "--interval" && argv[i + 1]) {
      args.intervalSec = Math.max(5, Number.parseInt(argv[++i], 10) || 15);
    } else if (token === "--max-polls" && argv[i + 1]) {
      args.maxPolls = Math.max(1, Number.parseInt(argv[++i], 10) || 1);
    } else if (token === "--max-copilot-retries" && argv[i + 1]) {
      const parsedRetries = Number.parseInt(argv[++i], 10);
      if (!Number.isSafeInteger(parsedRetries) || parsedRetries < 0) {
        throw new Error(`Invalid --max-copilot-retries "${parsedRetries}". Expected a non-negative integer.`);
      }
      args.maxCopilotRetries = parsedRetries;
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

  if (args.prs.length > 0 && !args.pr) {
    args.pr = args.prs[0];
  } else if (args.pr > 0 && args.prs.length === 0) {
    args.prs = [args.pr];
  } else if (args.pr > 0 && !args.prs.includes(args.pr)) {
    args.prs.unshift(args.pr);
  }
  if (args.pr > 0 && args.head && !args.prHeads[args.pr]) {
    args.prHeads[args.pr] = args.head;
  }
  if (args.prs.length === 1 && !args.head && args.prHeads[args.prs[0]]) {
    args.head = args.prHeads[args.prs[0]];
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
  if (args.mode === "request-copilot" && args.prs.length > 1) {
    throw new Error("request-copilot requires a single --pr <number>.");
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

export function createPrWatchState() {
  return {
    etags: {},
    consecutiveUnchangedPolls: 0,
    copilotErrorRetriesByHead: {},
    retriedCopilotReviewIds: [],
    metrics: {
      apiCalls: 0,
      cacheHits304: 0,
      rateLimitRemaining: null,
      rateLimitReset: null,
      retryAfterSec: null,
    },
  };
}

function computeResetDelaySec(rateLimitReset) {
  if (!Number.isFinite(rateLimitReset) || rateLimitReset <= 0) return null;
  return Math.max(1, Math.ceil(rateLimitReset - Date.now() / 1000));
}

export function computeAdaptivePrIntervalSec({
  baseIntervalSec = 15,
  consecutiveUnchangedPolls = 0,
  rateLimitRemaining = null,
  rateLimitReset = null,
  retryAfterSec = null,
} = {}) {
  const baseSec = Math.max(5, Number(baseIntervalSec) || 15);
  let intervalSec = baseSec;
  if (consecutiveUnchangedPolls >= 12) {
    intervalSec = Math.max(intervalSec, 45);
  } else if (consecutiveUnchangedPolls >= 4) {
    intervalSec = Math.max(intervalSec, 30);
  }
  if (Number.isFinite(rateLimitRemaining) && rateLimitRemaining < 500) {
    intervalSec = Math.max(intervalSec, baseSec * 4, 60);
  }
  const resetDelaySec =
    rateLimitRemaining === 0 ? computeResetDelaySec(rateLimitReset) : null;
  if (Number.isFinite(resetDelaySec) && resetDelaySec > 0) {
    intervalSec = Math.max(intervalSec, resetDelaySec);
  }
  if (Number.isFinite(retryAfterSec) && retryAfterSec > 0) {
    intervalSec = Math.max(intervalSec, retryAfterSec);
  }
  return intervalSec;
}


let githubClient;
async function defaultRequest(request) {
  if (request.kind === "reviewer") {
    const result = await runGh(["pr", "edit", String(request.pr), "-R", request.repo,
      request.remove ? "--remove-reviewer" : "--add-reviewer", "@copilot"], { timeout: 30000 });
    return { ok: result.ok, error: result.stderr };
  }
  githubClient ??= createGitHubClient();
  return githubClient.request(request);
}
defaultRequest.cacheScope = async () => {
  githubClient ??= createGitHubClient();
  return githubClient.cacheScope();
};
export async function requestCopilotReview(args, execFn = defaultRequest) {
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

  const fetchValidatedPr = async () => {
    const gqlRes = await execFn({ kind: "graphql", query, variables: { owner, name, pr: args.pr } });
    if (!gqlRes || !gqlRes.ok) {
      return {
        ok: false,
        result: {
          ok: false,
          status: "poll_error",
          error: gqlRes?.error || "GraphQL query failed",
        },
      };
    }

    let parsed;
    try {
      parsed = gqlRes.data;
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

  const initialPrCheck = await fetchValidatedPr();
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
        const runsRes = await execFn({ endpoint });
        if (!runsRes || !runsRes.ok || !runsRes.data) {
          return {
            ok: false,
            status: "poll_error",
            error: runsRes?.error || "Workflow runs inventory unavailable",
          };
        }

        let runsData;
        try {
          runsData = runsRes.data;
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
  const refreshedPrCheck = await fetchValidatedPr();
  if (!refreshedPrCheck.ok) {
    return refreshedPrCheck.result;
  }
  pr = refreshedPrCheck.pr;

  const matchingActiveRuns = allWorkflowRuns.filter((run) => isMatchingActivePrRun(run, pr));

  const currentHeadRun = matchingActiveRuns.find((run) => run.head_sha === pr.headRefOid);

  const cancelledRunIds = [];
  for (const run of matchingActiveRuns) {
    if (run.head_sha !== pr.headRefOid && run.id) {
      const cancelRes = await execFn({ method: "POST", endpoint: `repos/${args.repo}/actions/runs/${run.id}/cancel` });
      if (!cancelRes || !cancelRes.ok) {
        return {
          ok: false,
          status: "cancel_failed",
          headRefOid: pr.headRefOid,
          runId: run.id,
          cancelledRunIds,
          error: cancelRes?.error || `Failed to cancel superseded Copilot review run ${run.id}`,
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
    const removeRes = await execFn({ kind: "reviewer", repo: args.repo, pr: args.pr, remove: true });
    if (!removeRes || !removeRes.ok) {
      return {
        ok: false,
        status: "remove_reviewer_failed",
        headRefOid: pr.headRefOid,
        cancelledRunIds,
        error: removeRes?.error || "Failed to remove existing @copilot reviewer request",
      };
    }
  }

  const addRes = await execFn({ kind: "reviewer", repo: args.repo, pr: args.pr, remove: false });
  if (!addRes.ok) {
    return {
      ok: false,
      status: "request_failed",
      headRefOid: pr.headRefOid,
      cancelledRunIds,
      error: addRes.error || "Failed to request @copilot review",
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

export async function evaluatePrPollTick(args, execFn = defaultRequest, state = null) {
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

  if (state?.metrics) {
    state.metrics.retryAfterSec = null;
    state.metrics.apiCalls = (state.metrics.apiCalls || 0) + 1;
  }

  const gqlRes = await execFn({ kind: "graphql", query, variables: { owner, name, pr: args.pr } });
  const parsedGqlHttp = httpDetails(gqlRes);
  if (state && gqlRes?.cacheScope && state.cacheScope !== gqlRes.cacheScope) {
    state.etags = {};
    state.cacheScope = gqlRes.cacheScope;
  }
  if (state?.metrics) {
    if (parsedGqlHttp.rateLimitRemaining !== null) {
      state.metrics.rateLimitRemaining = parsedGqlHttp.rateLimitRemaining;
    }
    if (parsedGqlHttp.rateLimitReset !== null) {
      state.metrics.rateLimitReset = parsedGqlHttp.rateLimitReset;
    }
    if (parsedGqlHttp.retryAfterSec !== null) {
      state.metrics.retryAfterSec = Math.max(
        state.metrics.retryAfterSec || 0,
        parsedGqlHttp.retryAfterSec
      );
    }
  }
  const computeGqlRetrySec = () => {
    const resetDelaySec =
      parsedGqlHttp.rateLimitRemaining === 0
        ? computeResetDelaySec(parsedGqlHttp.rateLimitReset)
        : null;
    return Math.max(parsedGqlHttp.retryAfterSec || 0, resetDelaySec || 0, 60);
  };
  if (!gqlRes || !gqlRes.ok) {
    const errMsg = gqlRes?.error || "GraphQL query failed";
    const isHttpRateLimited =
      gqlRes?.rateLimited || parsedGqlHttp.status === 429 ||
      (parsedGqlHttp.status === 403 &&
        (parsedGqlHttp.rateLimitRemaining === 0 ||
          parsedGqlHttp.retryAfterSec !== null ||
          /rate limit/i.test(`${errMsg} ${""}`))) ||
      /rate limit|secondary rate limit|HTTP 429/i.test(`${errMsg} ${gqlRes?.data || ""}`);
    if (isHttpRateLimited) {
      const retryAfterSec = computeGqlRetrySec();
      if (state?.metrics) {
        state.metrics.retryAfterSec = Math.max(state.metrics.retryAfterSec || 0, retryAfterSec);
      }
      return {
        events: [
          {
            type: "RATE_LIMITED",
            headRefOid: args.head || "",
            retryAfterSec,
            rateLimitRemaining: parsedGqlHttp.rateLimitRemaining,
          },
        ],
        rateLimited: true,
        nextIntervalSec: computeAdaptivePrIntervalSec({
          baseIntervalSec: args.intervalSec,
          consecutiveUnchangedPolls: state?.consecutiveUnchangedPolls || 0,
          rateLimitRemaining: parsedGqlHttp.rateLimitRemaining,
          rateLimitReset: parsedGqlHttp.rateLimitReset,
          retryAfterSec,
        }),
      };
    }
    return { events: [{ type: "POLL_ERROR", error: errMsg }], error: errMsg };
  }

  let parsed;
  try {
    parsed = gqlRes.data;
  } catch (error) {
    const errMsg = `Invalid GraphQL JSON: ${error.message}`;
    return { events: [{ type: "POLL_ERROR", error: errMsg }], error: errMsg };
  }
  if (Array.isArray(parsed?.errors) && parsed.errors.length > 0) {
    const isGqlRateLimited = parsed.errors.some(
      (e) => e?.type === "RATE_LIMITED" || /rate limit/i.test(e?.message || "")
    );
    if (isGqlRateLimited) {
      const retryAfterSec = computeGqlRetrySec();
      if (state?.metrics) {
        state.metrics.retryAfterSec = Math.max(state.metrics.retryAfterSec || 0, retryAfterSec);
      }
      return {
        events: [
          {
            type: "RATE_LIMITED",
            headRefOid: args.head || "",
            retryAfterSec,
            rateLimitRemaining: parsedGqlHttp.rateLimitRemaining,
          },
        ],
        rateLimited: true,
        nextIntervalSec: computeAdaptivePrIntervalSec({
          baseIntervalSec: args.intervalSec,
          consecutiveUnchangedPolls: state?.consecutiveUnchangedPolls || 0,
          rateLimitRemaining: parsedGqlHttp.rateLimitRemaining,
          rateLimitReset: parsedGqlHttp.rateLimitReset,
          retryAfterSec,
        }),
      };
    }
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

  const expectedHead = args.head || args.prHeads?.[args.pr] || "";
  if (expectedHead && pr.headRefOid !== expectedHead) {
    return {
      events: [{ type: "HEAD_CHANGED", expectedHead, currentHead: pr.headRefOid }],
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
  const runsEndpoint = `repos/${args.repo}/actions/runs?head_sha=${headOid}&per_page=100`;
  const cachedRunsEntry = state?.etags?.[runsEndpoint];
  const runsRequest = { endpoint: runsEndpoint, conditional: Boolean(state),
    headers: cachedRunsEntry?.etag ? { "If-None-Match": cachedRunsEntry.etag } : {} };
  if (state?.metrics) {
    state.metrics.apiCalls = (state.metrics.apiCalls || 0) + 1;
  }
  const runsRes = await execFn(runsRequest);
  const parsedRunsHttp = httpDetails(runsRes);
  if (state?.metrics) {
    if (parsedRunsHttp.rateLimitRemaining !== null) {
      state.metrics.rateLimitRemaining = parsedRunsHttp.rateLimitRemaining;
    }
    if (parsedRunsHttp.rateLimitReset !== null) {
      state.metrics.rateLimitReset = parsedRunsHttp.rateLimitReset;
    }
    if (parsedRunsHttp.retryAfterSec !== null) {
      state.metrics.retryAfterSec = Math.max(
        state.metrics.retryAfterSec || 0,
        parsedRunsHttp.retryAfterSec
      );
    }
  }

  let runsData;
  if (state && runsRes?.ok && parsedRunsHttp.status === 304 && cachedRunsEntry?.data !== undefined) {
    state.metrics.cacheHits304 = (state.metrics.cacheHits304 || 0) + 1;
    runsData = cachedRunsEntry.data;
  } else {
    const isRateLimited =
      runsRes?.rateLimited || parsedRunsHttp.status === 429 ||
      (parsedRunsHttp.status === 403 &&
        (parsedRunsHttp.rateLimitRemaining === 0 ||
          parsedRunsHttp.retryAfterSec !== null ||
          /rate limit/i.test(runsRes?.data || runsRes?.error || "")));
    if (isRateLimited) {
      const resetDelaySec =
        parsedRunsHttp.rateLimitRemaining === 0
          ? computeResetDelaySec(parsedRunsHttp.rateLimitReset)
          : null;
      const retryAfterSec = Math.max(parsedRunsHttp.retryAfterSec || 0, resetDelaySec || 0, 60);
      if (state?.metrics) {
        state.metrics.retryAfterSec = Math.max(state.metrics.retryAfterSec || 0, retryAfterSec);
      }
      return {
        events: [
          {
            type: "RATE_LIMITED",
            headRefOid: headOid,
            retryAfterSec,
            rateLimitRemaining: parsedRunsHttp.rateLimitRemaining,
          },
        ],
        rateLimited: true,
        nextIntervalSec: computeAdaptivePrIntervalSec({
          baseIntervalSec: args.intervalSec,
          consecutiveUnchangedPolls: state?.consecutiveUnchangedPolls || 0,
          rateLimitRemaining: parsedRunsHttp.rateLimitRemaining,
          rateLimitReset: parsedRunsHttp.rateLimitReset,
          retryAfterSec,
        }),
      };
    }
    if (!runsRes || !runsRes.ok || !runsRes?.data) {
      const errMsg = runsRes?.error || "Workflow runs inventory unavailable";
      return { events: [{ type: "POLL_ERROR", error: errMsg }], error: errMsg };
    }
    try {
      runsData = runsRes.data;
    } catch (error) {
      const errMsg = `Invalid workflow runs JSON: ${error.message}`;
      return { events: [{ type: "POLL_ERROR", error: errMsg }], error: errMsg };
    }
    if (state && parsedRunsHttp.etag && Array.isArray(runsData?.workflow_runs)) {
      state.etags[runsEndpoint] = {
        etag: parsedRunsHttp.etag,
        data: runsData,
        updatedAt: new Date().toISOString(),
      };
      const etagKeys = Object.keys(state.etags);
      if (etagKeys.length > 20) {
        delete state.etags[etagKeys[0]];
      }
    }
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
    state &&
    (copilotWorkflowActive ||
      copilotRequested ||
      validHeadCopilotReviews.length > 0 ||
      !isErroredCopilotReview(latestHeadCopilotReview) ||
      latestHeadCopilotReview.databaseId !== state.pendingRetryReviewId)
  ) {
    state.pendingRetryReviewId = null;
    state.pendingRetryGracePolls = 0;
  }

  if (
    args.expectCopilot &&
    !copilotWorkflowActive &&
    !copilotRequested &&
    validHeadCopilotReviews.length === 0 &&
    isErroredCopilotReview(latestHeadCopilotReview)
  ) {
    const maxRetries = args.maxCopilotRetries ?? 2;
    const prevRetries = state?.copilotErrorRetriesByHead?.[headOid] || 0;
    const reviewId = latestHeadCopilotReview.databaseId;
    const alreadyRetriedThisReview = Boolean(
      reviewId && state?.retriedCopilotReviewIds?.includes(reviewId)
    );
    const totalChecksCount = contexts.length;
    const passedChecksCount = totalChecksCount - pendingChecks.length - failedChecks.length;
    const queuedPendingReviewers = [
      ...new Set([...pendingReviewers, "copilot-pull-request-reviewer"]),
    ];
    const retryPhaseInfo = computePrPhase({
      totalChecksCount,
      passedChecksCount,
      pendingChecks,
      activeWorkflowRuns,
      expectCopilot: args.expectCopilot,
      copilotWorkflowActive: false,
      copilotRequested: true,
      validHeadCopilotReviewsCount: 0,
      pendingReviewers: queuedPendingReviewers,
    });
    if (
      alreadyRetriedThisReview &&
      state?.pendingRetryReviewId === reviewId &&
      (state?.pendingRetryGracePolls || 0) > 0
    ) {
      state.pendingRetryGracePolls -= 1;
      const nowIso = new Date().toISOString();
      return {
        events: [],
        status: {
          timestamp: nowIso,
          headRefOid: headOid,
          latestCommentId,
          phase: retryPhaseInfo.phase,
          summary: `${retryPhaseInfo.summary} (waiting for retried Copilot review)`,
          totalChecksCount,
          passedChecksCount,
          pendingChecksCount: pendingChecks.length,
          pendingChecks,
          activeWorkflowRuns,
          pendingReviewers: queuedPendingReviewers,
          copilotWorkflowActive: false,
          validHeadCopilotReviewsCount: 0,
          unresolvedThreadsCount: 0,
          bodyFindingsCount: 0,
          nextIntervalSec: args.intervalSec,
          cacheHits304: state.metrics?.cacheHits304 || 0,
        },
        nextIntervalSec: args.intervalSec,
      };
    }
    let retryAttempted = false;
    let retryFailureStatus;
    if (state && maxRetries > 0 && prevRetries < maxRetries && !alreadyRetriedThisReview) {
      retryAttempted = true;
      const retryRes = await requestCopilotReview({ ...args, pr: args.pr, head: headOid }, execFn);
      if (retryRes.ok) {
        state.copilotErrorRetriesByHead[headOid] = prevRetries + 1;
        if (reviewId) {
          state.retriedCopilotReviewIds.push(reviewId);
          state.pendingRetryReviewId = reviewId;
          state.pendingRetryGracePolls = 2;
        }
        const nowIso = new Date().toISOString();
        const attempt = prevRetries + 1;
        return {
          events: [
            {
              type: "COPILOT_REVIEW_RETRIED",
              timestamp: nowIso,
              headRefOid: headOid,
              latestCommentId,
              lastPhase: args.lastPhase || "",
              reviewId,
              attempt,
              maxAttempts: maxRetries,
              retryStatus: retryRes.status,
            },
          ],
          status: {
            timestamp: nowIso,
            headRefOid: headOid,
            latestCommentId,
            phase: retryPhaseInfo.phase,
            summary: `Copilot review error (${reviewId}); auto-retried (${attempt}/${maxRetries}) | ${retryPhaseInfo.summary}`,
            totalChecksCount,
            passedChecksCount,
            pendingChecksCount: pendingChecks.length,
            pendingChecks,
            activeWorkflowRuns,
            pendingReviewers: queuedPendingReviewers,
            copilotWorkflowActive: false,
            validHeadCopilotReviewsCount: 0,
            unresolvedThreadsCount: 0,
            bodyFindingsCount: 0,
            nextIntervalSec: args.intervalSec,
            cacheHits304: state.metrics?.cacheHits304 || 0,
          },
          nextIntervalSec: args.intervalSec,
        };
      }
      retryFailureStatus = retryRes.status;
    }
    return {
      events: [
        {
          type: "COPILOT_REVIEW_ERROR",
          headRefOid: headOid,
          latestCommentId,
          lastPhase: args.lastPhase || "",
          reviewId,
          message: latestHeadCopilotReview.body,
          ...(retryAttempted ? { retryAttempted: true, retryFailureStatus } : {}),
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

  const phaseTransitioned = Boolean(args.lastPhase && phaseInfo.phase !== args.lastPhase);
  const phaseChanged = Boolean(args.emitPhaseChanges && phaseTransitioned);
  if (state) {
    state.consecutiveUnchangedPolls = phaseTransitioned
      ? 0
      : (state.consecutiveUnchangedPolls || 0) + 1;
  }
  const unchangedCount = state?.consecutiveUnchangedPolls || 0;
  const gqlIntervalSec = computeAdaptivePrIntervalSec({
    baseIntervalSec: args.intervalSec,
    consecutiveUnchangedPolls: unchangedCount,
    rateLimitRemaining: parsedGqlHttp.rateLimitRemaining,
    rateLimitReset: parsedGqlHttp.rateLimitReset,
    retryAfterSec: parsedGqlHttp.retryAfterSec,
  });
  const restIntervalSec = computeAdaptivePrIntervalSec({
    baseIntervalSec: args.intervalSec,
    consecutiveUnchangedPolls: unchangedCount,
    rateLimitRemaining: parsedRunsHttp.rateLimitRemaining,
    rateLimitReset: parsedRunsHttp.rateLimitReset,
    retryAfterSec: parsedRunsHttp.retryAfterSec,
  });
  const nextIntervalSec = Math.max(gqlIntervalSec, restIntervalSec);
  if (
    state?.metrics &&
    parsedGqlHttp.rateLimitRemaining !== null &&
    parsedRunsHttp.rateLimitRemaining !== null
  ) {
    state.metrics.rateLimitRemaining = Math.min(
      parsedGqlHttp.rateLimitRemaining,
      parsedRunsHttp.rateLimitRemaining
    );
  }
  statusPayload.nextIntervalSec = nextIntervalSec;
  if (state?.metrics) {
    statusPayload.cacheHits304 = state.metrics.cacheHits304 || 0;
  }

  if (phaseChanged) {
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
      nextIntervalSec,
    };
  }

  return {
    events: [],
    status: statusPayload,
    nextIntervalSec,
  };
}

export async function evaluateMultiPrPollTick(args, execFn = defaultRequest, multiState = {}) {
  const targetPrs = Array.isArray(args.prs) && args.prs.length > 0 ? args.prs : [args.pr];
  const allEvents = [];
  const statuses = [];
  let anyRateLimited = false;
  let maxRateLimitIntervalSec = 0;
  let minActiveIntervalSec = Infinity;
  let firstError = null;

  for (const prNumber of targetPrs) {
    if (!multiState[prNumber]) {
      const useSinglePrBaseline = targetPrs.length === 1 || prNumber === args.pr;
      multiState[prNumber] = {
        watchState: createPrWatchState(),
        lastPhase: targetPrs.length === 1 ? args.lastPhase || "" : "",
        hasExplicitSinceCommentId: useSinglePrBaseline
          ? Boolean(args.hasExplicitSinceCommentId)
          : false,
        sinceCommentId: useSinglePrBaseline ? args.sinceCommentId || 0 : 0,
      };
    }
    const entry = multiState[prNumber];
    const prHead =
      args.prHeads?.[prNumber] ??
      (prNumber === args.pr || targetPrs.length === 1 ? args.head : "");
    const prArgs = {
      ...args,
      pr: prNumber,
      head: prHead,
      maxCopilotRetries: args.mode === "once" ? 0 : args.maxCopilotRetries,
      lastPhase: entry.lastPhase,
      hasExplicitSinceCommentId: entry.hasExplicitSinceCommentId,
      sinceCommentId: entry.sinceCommentId,
    };
    const tick = await evaluatePrPollTick(prArgs, execFn, entry.watchState);
    if (tick.error && !firstError) {
      firstError = tick.error;
    }
    for (const ev of tick.events || []) {
      allEvents.push({ pr: prNumber, ...ev });
    }
    if (tick.status) {
      entry.lastPhase = tick.status.phase || entry.lastPhase;
      if (
        !entry.hasExplicitSinceCommentId &&
        Number.isSafeInteger(tick.status.latestCommentId)
      ) {
        entry.hasExplicitSinceCommentId = true;
        entry.sinceCommentId = tick.status.latestCommentId;
      }
      statuses.push({ pr: prNumber, ...tick.status });
    }
    if (tick.rateLimited) {
      anyRateLimited = true;
      maxRateLimitIntervalSec = Math.max(maxRateLimitIntervalSec, tick.nextIntervalSec || 60);
      break;
    }
    if (Number.isFinite(tick.nextIntervalSec) && tick.nextIntervalSec > 0) {
      minActiveIntervalSec = Math.min(minActiveIntervalSec, tick.nextIntervalSec);
    }
  }

  const nextIntervalSec = anyRateLimited
    ? maxRateLimitIntervalSec
    : Number.isFinite(minActiveIntervalSec)
      ? minActiveIntervalSec
      : args.intervalSec;

  const result = {
    prs: targetPrs,
    events: allEvents,
    statuses,
    rateLimited: anyRateLimited,
    nextIntervalSec,
  };
  if (firstError) {
    result.error = firstError;
  }
  return result;
}

async function sleepSeconds(sec) {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, sec * 1000));
}

const NON_TERMINAL_PR_EVENTS = new Set([
  "PHASE_CHANGED",
  "COPILOT_REVIEW_RETRIED",
  "RATE_LIMITED",
]);

export async function runCli(argv = process.argv.slice(2)) {
  const args = parsePrWatchArgs(argv);
  const emit = createEventWriter(args.eventsFile, "pr-watch", { repo: args.repo, pr: args.pr });
  const heartbeat = args.eventsFile ? setInterval(() => emit({
    status: { repo: args.repo, phase: "polling", summary: "Watcher active; awaiting GitHub observations" },
  }), 60000) : null;
  heartbeat?.unref();
  try {
    if (args.mode === "request-copilot") {
      const res = await requestCopilotReview(args);
      console.log(JSON.stringify(res, null, 2));
      if (!res.ok) {
        process.exit(1);
      }
      return;
    }
    if (args.mode === "once") {
      if (args.prs.length > 1) {
        const multi = await evaluateMultiPrPollTick(args);
        emit(multi);
        console.log(JSON.stringify(multi, null, 2));
        if (multi.error) {
          process.exit(1);
        }
        return;
      }
      const tick = await evaluatePrPollTick(args);
      emit(tick);
      console.log(JSON.stringify(tick, null, 2));
      if (tick.error) {
        process.exit(1);
      }
      return;
    }

    if (args.prs.length > 1) {
      const multiState = {};
      let polls = 0;
      while (true) {
        polls += 1;
        const multi = await evaluateMultiPrPollTick(args, defaultRequest, multiState);
        emit(multi);
        if (multi.error) {
          console.error(JSON.stringify(multi, null, 2));
          process.exit(1);
        }
        const terminalEvents = multi.events.filter((e) => !NON_TERMINAL_PR_EVENTS.has(e.type));
        if (terminalEvents.length > 0) {
          console.log(JSON.stringify(multi, null, 2));
          return;
        }
        if (multi.rateLimited) {
          console.log(JSON.stringify(multi, null, 2));
          if (args.maxPolls > 0 && polls >= args.maxPolls) {
            console.log(JSON.stringify({ prs: args.prs, events: [{ type: "MAX_POLLS_REACHED" }] }, null, 2));
            return;
          }
          await sleepSeconds(multi.nextIntervalSec || 60);
          continue;
        }
        console.log(JSON.stringify({ prs: multi.prs, events: multi.events, statuses: multi.statuses }, null, 2));
        if (args.maxPolls > 0 && polls >= args.maxPolls) {
          console.log(JSON.stringify({ prs: args.prs, events: [{ type: "MAX_POLLS_REACHED" }], statuses: multi.statuses }, null, 2));
          return;
        }
        await sleepSeconds(multi.nextIntervalSec || args.intervalSec);
      }
    }

    const watchState = createPrWatchState();
    let baselinePhase = args.lastPhase;
    let hasCommentBaseline = args.hasExplicitSinceCommentId;
    let baselineCommentId = args.sinceCommentId;
    let polls = 0;
    while (true) {
      polls += 1;
      const tick = await evaluatePrPollTick(
        {
          ...args,
          lastPhase: baselinePhase,
          hasExplicitSinceCommentId: hasCommentBaseline,
          sinceCommentId: baselineCommentId,
        },
        defaultRequest,
        watchState
      );
      emit(tick);
      if (tick.rateLimited) {
        console.log(JSON.stringify(tick, null, 2));
        if (args.maxPolls > 0 && polls >= args.maxPolls) {
          console.log(JSON.stringify({ events: [{ type: "MAX_POLLS_REACHED" }] }, null, 2));
          return;
        }
        await sleepSeconds(tick.nextIntervalSec || 60);
        continue;
      }
      if (tick.error) {
        console.error(JSON.stringify(tick, null, 2));
        process.exit(1);
      }
      const terminalEvents = tick.events.filter((e) => !NON_TERMINAL_PR_EVENTS.has(e.type));
      if (terminalEvents.length > 0) {
        console.log(JSON.stringify(tick, null, 2));
        return;
      }
      // Emit live status and nonterminal phase changes / auto-retries to stdout while continuing to watch
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
      await sleepSeconds(tick.nextIntervalSec || args.intervalSec);
    }
  } finally {
    clearInterval(heartbeat);
  }
}

if (
  import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}` ||
  process.argv[1]?.endsWith("pr-watch-daemon.mjs")
) {
  runCli().catch((error) => { console.error(error.message); process.exitCode = 1; })
    .finally(() => githubClient?.close());
}
