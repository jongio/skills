#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { MessageChannel, Worker, receiveMessageOnPort } from "node:worker_threads";

const ERRORED_COPILOT_REVIEW_RE = /Copilot encountered an error and was unable to review this pull request/i;
const ACTIONABLE_BODY_RE =
  /(?:###\s*(?:🟡\s*Changes recommended|🔵\s*Needs a closer look)|\b[1-9]\d*\s+(?:open|previously missed)\s+issues?\b)/i;
const CLEAN_COPILOT_BODY_RE = /###\s*🟢\s*Approval recommended[\s\S]*?\*\*No open issues\*\*/i;

export function isCopilotBotLogin(login) {
  return /^(?:copilot|copilot-pull-request-reviewer(?:\[bot\])?|github-copilot(?:\[bot\])?)$/i.test(
    String(login || "").trim()
  );
}

function normalizeReviewerLogin(login) {
  const normalized = String(login || "").trim().toLowerCase();
  return isCopilotBotLogin(normalized) ? "copilot-pull-request-reviewer" : normalized;
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

export function defaultPrMaxWaitSec(env = process.env) {
  const raw = Number.parseInt(String(env?.COPILOT_TASK_WAIT_TIMEOUT_SECONDS ?? ""), 10);
  const hostWaitSec = Number.isFinite(raw) && raw > 0 ? Math.min(raw, 600) : 600;
  return hostWaitSec > 60 ? hostWaitSec - 60 : Math.max(5, Math.floor(hostWaitSec / 2));
}

export function parsePrWatchArgs(argv, env = process.env) {
  const args = {
    mode: "watch",
    repo: "",
    pr: 0,
    prs: [],
    prHeads: {},
    head: "",
    intervalSec: 15,
    maxPolls: 0,
    maxWaitSec: defaultPrMaxWaitSec(env),
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
    } else if (token === "--max-wait-sec" && argv[i + 1]) {
      const parsedWait = Number.parseInt(argv[++i], 10);
      if (!Number.isSafeInteger(parsedWait) || parsedWait < 0) {
        throw new Error(`Invalid --max-wait-sec "${parsedWait}". Expected a non-negative integer.`);
      }
      args.maxWaitSec = parsedWait;
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
    cooldownUntilMs: null,
    metrics: {
      apiCalls: 0,
      cacheHits304: 0,
      rateLimitRemaining: null,
      rateLimitReset: null,
      retryAfterSec: null,
    },
  };
}

const PR_COOLDOWN_FILE = join(homedir(), ".copilot", "pr-watch", "cooldown.json");

function loadPrCooldownMs(repo) {
  if (!repo || !existsSync(PR_COOLDOWN_FILE)) return null;
  try {
    const parsed = JSON.parse(readFileSync(PR_COOLDOWN_FILE, "utf8"));
    const val = parsed?.[String(repo).toLowerCase()];
    return Number.isFinite(val) && val > Date.now() ? val : null;
  } catch {
    return null;
  }
}

function savePrCooldownMs(repo, cooldownUntilMs) {
  if (!repo) return;
  try {
    mkdirSync(dirname(PR_COOLDOWN_FILE), { recursive: true });
    let existing = {};
    if (existsSync(PR_COOLDOWN_FILE)) {
      try {
        existing = JSON.parse(readFileSync(PR_COOLDOWN_FILE, "utf8")) || {};
      } catch {
        existing = {};
      }
    }
    const key = String(repo).toLowerCase();
    if (Number.isFinite(cooldownUntilMs) && cooldownUntilMs > Date.now()) {
      existing[key] = cooldownUntilMs;
    } else {
      delete existing[key];
    }
    writeFileSync(PR_COOLDOWN_FILE, `${JSON.stringify(existing, null, 2)}\n`, "utf8");
  } catch {
    // Best-effort persistence across chunk restarts
  }
}

function parseRetryAfterHeader(rawVal) {
  if (!rawVal) return null;
  const trimmed = String(rawVal).trim();
  if (/^\d+$/.test(trimmed)) {
    return Number.parseInt(trimmed, 10);
  }
  const dateMs = Date.parse(trimmed);
  if (Number.isFinite(dateMs)) {
    return Math.max(1, Math.ceil((dateMs - Date.now()) / 1000));
  }
  return null;
}

function computeResetDelaySec(rateLimitReset) {
  if (!Number.isFinite(rateLimitReset) || rateLimitReset <= 0) return null;
  return Math.max(1, Math.ceil(rateLimitReset - Date.now() / 1000));
}

export function parsePrHttpResponse(raw, httpMeta = null) {
  let remaining = String(raw || "").replace(/\r\n/g, "\n");
  let lastHeaderBlock = "";
  while (/^HTTP\/[\d.]+\s+\d{3}\b/.test(remaining)) {
    const splitIndex = remaining.indexOf("\n\n");
    if (splitIndex === -1) {
      lastHeaderBlock = remaining;
      remaining = "";
      break;
    }
    lastHeaderBlock = remaining.slice(0, splitIndex);
    remaining = remaining.slice(splitIndex + 2).trimStart();
  }
  const metaStatus = Number.isInteger(httpMeta?.status) ? httpMeta.status : null;
  const metaRem =
    httpMeta?.rateLimitRemaining !== null &&
    httpMeta?.rateLimitRemaining !== undefined &&
    /^\d+$/.test(String(httpMeta.rateLimitRemaining).trim())
      ? Number.parseInt(String(httpMeta.rateLimitRemaining).trim(), 10)
      : null;
  const metaReset =
    httpMeta?.rateLimitReset !== null &&
    httpMeta?.rateLimitReset !== undefined &&
    /^\d+$/.test(String(httpMeta.rateLimitReset).trim())
      ? Number.parseInt(String(httpMeta.rateLimitReset).trim(), 10)
      : null;
  const metaRetry = httpMeta?.retryAfter ? parseRetryAfterHeader(httpMeta.retryAfter) : null;

  if (!lastHeaderBlock) {
    return {
      status: metaStatus ?? 200,
      etag: httpMeta?.etag ? String(httpMeta.etag).trim() : "",
      rateLimitRemaining: metaRem,
      rateLimitReset: metaReset,
      retryAfterSec: metaRetry,
      bodyText: remaining,
    };
  }
  const bodyText = remaining.trim();
  const statusMatch = lastHeaderBlock.match(/^HTTP\/[\d.]+\s+(\d{3})/m);
  const status = statusMatch ? Number.parseInt(statusMatch[1], 10) : (metaStatus ?? 200);
  const etagMatch = lastHeaderBlock.match(/^etag:\s*(.+)$/im);
  const etag = etagMatch ? etagMatch[1].trim() : (httpMeta?.etag ? String(httpMeta.etag).trim() : "");
  const remMatch = lastHeaderBlock.match(/^x-ratelimit-remaining:\s*(\d+)\s*$/im);
  const rateLimitRemaining = remMatch ? Number.parseInt(remMatch[1], 10) : metaRem;
  const resetMatch = lastHeaderBlock.match(/^x-ratelimit-reset:\s*(\d+)\s*$/im);
  const rateLimitReset = resetMatch ? Number.parseInt(resetMatch[1], 10) : metaReset;
  const retryMatch = lastHeaderBlock.match(/^retry-after:\s*(.+)$/im);
  const retryAfterSec = retryMatch ? parseRetryAfterHeader(retryMatch[1]) : metaRetry;
  return { status, etag, rateLimitRemaining, rateLimitReset, retryAfterSec, bodyText };
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

export function parseGhApiArgs(ghArgs) {
  if (!Array.isArray(ghArgs) || ghArgs[0] !== "api") {
    return null;
  }
  let includeHeaders = false;
  let method = "";
  const headers = {};
  let endpoint = "";
  const rawFields = {};
  const typedFields = {};

  for (let i = 1; i < ghArgs.length; i += 1) {
    const token = ghArgs[i];
    if (token === "-i" || token === "--include") {
      includeHeaders = true;
    } else if ((token === "-X" || token === "--method") && ghArgs[i + 1]) {
      method = String(ghArgs[++i]).toUpperCase();
    } else if ((token === "-H" || token === "--header") && ghArgs[i + 1]) {
      const rawHeader = String(ghArgs[++i]);
      const colonIdx = rawHeader.indexOf(":");
      if (colonIdx <= 0) return null;
      headers[rawHeader.slice(0, colonIdx).trim()] = rawHeader.slice(colonIdx + 1).trim();
    } else if ((token === "-f" || token === "--raw-field") && ghArgs[i + 1]) {
      const pair = String(ghArgs[++i]);
      const eqIdx = pair.indexOf("=");
      if (eqIdx <= 0) return null;
      rawFields[pair.slice(0, eqIdx)] = pair.slice(eqIdx + 1);
    } else if ((token === "-F" || token === "--field") && ghArgs[i + 1]) {
      const pair = String(ghArgs[++i]);
      const eqIdx = pair.indexOf("=");
      if (eqIdx <= 0) return null;
      const key = pair.slice(0, eqIdx);
      const val = pair.slice(eqIdx + 1);
      if (val.startsWith("@")) return null;
      if (/^-?\d+$/.test(val)) {
        typedFields[key] = Number.parseInt(val, 10);
      } else if (val === "true" || val === "false") {
        typedFields[key] = val === "true";
      } else if (val === "null") {
        typedFields[key] = null;
      } else {
        typedFields[key] = val;
      }
    } else if (token.startsWith("-")) {
      return null;
    } else if (!endpoint) {
      endpoint = token;
    } else {
      return null;
    }
  }

  if (!endpoint) {
    return null;
  }

  if (endpoint === "graphql") {
    const query = rawFields.query ?? typedFields.query;
    if (typeof query !== "string" || !query) {
      return null;
    }
    const variables = { ...rawFields, ...typedFields };
    delete variables.query;
    return {
      url: "https://api.github.com/graphql",
      method: method || "POST",
      includeHeaders,
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ query, variables }),
    };
  }

  if (Object.keys(rawFields).length > 0 || Object.keys(typedFields).length > 0) {
    return null;
  }

  const normalizedEndpoint = endpoint.replace(/^\/+/, "");
  const url = /^https?:\/\//i.test(endpoint)
    ? endpoint
    : `https://api.github.com/${normalizedEndpoint}`;
  return {
    url,
    method: method || "GET",
    includeHeaders,
    headers,
    body: undefined,
  };
}

let keepAliveWorkerState = null;
let nextWorkerReqId = 0;

function resolveGhTokenOnce() {
  const envToken = (process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "").trim();
  if (envToken) {
    return envToken;
  }
  try {
    return execFileSync("gh", ["auth", "token"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    }).trim();
  } catch {
    return "";
  }
}

function getKeepAliveWorker() {
  if (process.env.GH_HOST || process.env.PR_WATCH_DISABLE_KEEPALIVE === "1") {
    return null;
  }
  if (keepAliveWorkerState !== null) {
    return keepAliveWorkerState;
  }
  const token = resolveGhTokenOnce();
  if (!token) {
    keepAliveWorkerState = false;
    return false;
  }
  try {
    const { port1, port2 } = new MessageChannel();
    const workerCode = `
      const { parentPort } = require("node:worker_threads");
      let replyPort = null;
      parentPort.on("message", async (msg) => {
        if (msg.initPort) {
          replyPort = msg.initPort;
          return;
        }
        const { reqId, token, req, signalBuf } = msg;
        const signal = new Int32Array(signalBuf);
        try {
          const res = await fetch(req.url, {
            method: req.method,
            headers: {
              Accept: "application/vnd.github+json",
              Authorization: "Bearer " + token,
              "X-GitHub-Api-Version": "2022-11-28",
              "User-Agent": "jongio-skills-daemon",
              ...req.headers,
            },
            body: req.body,
            signal: AbortSignal.timeout(28000),
          });
          const bodyText = await res.text();
          const httpMeta = {
            status: res.status,
            etag: res.headers.get("etag"),
            rateLimitRemaining: res.headers.get("x-ratelimit-remaining"),
            rateLimitReset: res.headers.get("x-ratelimit-reset"),
            retryAfter: res.headers.get("retry-after"),
          };
          let stdout = bodyText;
          if (req.includeHeaders) {
            const hdrLines = ["HTTP/2.0 " + res.status];
            for (const h of ["etag", "x-ratelimit-remaining", "x-ratelimit-reset", "retry-after"]) {
              const v = res.headers.get(h);
              if (v !== null && v !== undefined && v !== "") hdrLines.push(h + ": " + v);
            }
            stdout = hdrLines.join("\\r\\n") + "\\r\\n\\r\\n" + bodyText;
          }
          replyPort.postMessage({
            reqId,
            ok: res.ok || (req.includeHeaders && res.status === 304),
            stdout,
            stderr: res.ok || res.status === 304 ? "" : (bodyText || ("HTTP " + res.status)),
            httpMeta,
          });
        } catch (err) {
          replyPort.postMessage({
            reqId,
            ok: false,
            transportError: true,
            stdout: "",
            stderr: err && err.message ? err.message : String(err),
          });
        } finally {
          Atomics.store(signal, 0, 1);
          Atomics.notify(signal, 0, 1);
        }
      });
    `;
    const worker = new Worker(workerCode, { eval: true });
    worker.unref();
    worker.postMessage({ initPort: port2 }, [port2]);
    keepAliveWorkerState = { worker, port1, token };
    return keepAliveWorkerState;
  } catch {
    keepAliveWorkerState = false;
    return false;
  }
}

function defaultExecGh(ghArgs) {
  const parsedReq = parseGhApiArgs(ghArgs);
  if (parsedReq) {
    const ka = getKeepAliveWorker();
    if (ka) {
      const reqId = (nextWorkerReqId += 1);
      const signalBuf = new SharedArrayBuffer(4);
      const signal = new Int32Array(signalBuf);
      ka.worker.postMessage({
        reqId,
        token: ka.token,
        req: parsedReq,
        signalBuf,
      });
      const waitRes = Atomics.wait(signal, 0, 0, 30000);
      while (true) {
        const msg = receiveMessageOnPort(ka.port1);
        if (!msg) break;
        if ((waitRes === "ok" || waitRes === "not-equal") && msg.message?.reqId === reqId) {
          const isReadOnlyRequest =
            parsedReq.method === "GET" || parsedReq.url.endsWith("/graphql");
          if (msg.message.transportError && isReadOnlyRequest) {
            break;
          }
          return {
            ok: msg.message.ok,
            stdout: msg.message.stdout,
            stderr: msg.message.stderr,
            httpMeta: msg.message.httpMeta,
          };
        }
      }
    }
  }
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
  let lastTruncationError = "";

  for (let pass = 1; pass <= maxInventoryPasses; pass += 1) {
    const passRuns = [];
    const seenPassRunIds = new Set();
    let passTruncated = false;

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
          passTruncated = true;
          lastTruncationError = `Workflow runs inventory for status=${runStatus} truncated at ${statusRuns.length}/${totalCount}`;
          break;
        }
        page += 1;
      }
      if (passTruncated) {
        break;
      }
    }

    if (passTruncated) {
      previousPassSignature = null;
      continue;
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
    if (lastTruncationError) {
      return {
        ok: false,
        status: "collection_truncated",
        collections: ["workflow_runs"],
        error: lastTruncationError,
      };
    }
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

export function evaluatePrPollTick(args, execFn = defaultExecGh, state = null) {
  const nowMs = Date.now();
  if (Number.isFinite(state?.cooldownUntilMs) && state.cooldownUntilMs > nowMs) {
    const remainingSec = Math.max(1, Math.ceil((state.cooldownUntilMs - nowMs) / 1000));
    if (state?.metrics) {
      state.metrics.retryAfterSec = remainingSec;
    }
    return {
      events: [
        {
          type: "RATE_LIMITED",
          headRefOid: args.head || "",
          retryAfterSec: remainingSec,
          rateLimitRemaining: state?.metrics?.rateLimitRemaining ?? null,
        },
      ],
      rateLimited: true,
      nextIntervalSec: remainingSec,
    };
  }
  if (state) {
    state.cooldownUntilMs = null;
  }
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
  const parsedGqlHttp = parsePrHttpResponse(
    gqlRes?.stdout || gqlRes?.stderr || "",
    gqlRes?.httpMeta
  );
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
    const errMsg = gqlRes?.stderr || "GraphQL query failed";
    const isHttpRateLimited =
      parsedGqlHttp.status === 429 ||
      (parsedGqlHttp.status === 403 &&
        (parsedGqlHttp.rateLimitRemaining === 0 ||
          parsedGqlHttp.retryAfterSec !== null ||
          /rate limit/i.test(`${errMsg} ${parsedGqlHttp.bodyText}`))) ||
      /rate limit|secondary rate limit|HTTP 429/i.test(`${errMsg} ${gqlRes?.stdout || ""}`);
    if (isHttpRateLimited) {
      const retryAfterSec = computeGqlRetrySec();
      const nextIntervalSec = computeAdaptivePrIntervalSec({
        baseIntervalSec: args.intervalSec,
        consecutiveUnchangedPolls: state?.consecutiveUnchangedPolls || 0,
        rateLimitRemaining: parsedGqlHttp.rateLimitRemaining,
        rateLimitReset: parsedGqlHttp.rateLimitReset,
        retryAfterSec,
      });
      if (state) {
        state.cooldownUntilMs = Date.now() + nextIntervalSec * 1000;
        if (state.metrics) {
          state.metrics.retryAfterSec = Math.max(state.metrics.retryAfterSec || 0, retryAfterSec);
        }
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
        nextIntervalSec,
      };
    }
    return { events: [{ type: "POLL_ERROR", error: errMsg }], error: errMsg };
  }

  let parsed;
  try {
    parsed = JSON.parse(parsedGqlHttp.bodyText || gqlRes.stdout);
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
      const nextIntervalSec = computeAdaptivePrIntervalSec({
        baseIntervalSec: args.intervalSec,
        consecutiveUnchangedPolls: state?.consecutiveUnchangedPolls || 0,
        rateLimitRemaining: parsedGqlHttp.rateLimitRemaining,
        rateLimitReset: parsedGqlHttp.rateLimitReset,
        retryAfterSec,
      });
      if (state) {
        state.cooldownUntilMs = Date.now() + nextIntervalSec * 1000;
        if (state.metrics) {
          state.metrics.retryAfterSec = Math.max(state.metrics.retryAfterSec || 0, retryAfterSec);
        }
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
        nextIntervalSec,
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
  const runsGhArgs = state
    ? [
        "api",
        "-i",
        runsEndpoint,
        ...(cachedRunsEntry?.etag ? ["-H", `If-None-Match: ${cachedRunsEntry.etag}`] : []),
      ]
    : ["api", runsEndpoint];
  if (state?.metrics) {
    state.metrics.apiCalls = (state.metrics.apiCalls || 0) + 1;
  }
  const runsRes = execFn(runsGhArgs);
  const parsedRunsHttp = parsePrHttpResponse(runsRes?.stdout || "", runsRes?.httpMeta);
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
  if (state && parsedRunsHttp.status === 304 && cachedRunsEntry?.data !== undefined) {
    state.metrics.cacheHits304 = (state.metrics.cacheHits304 || 0) + 1;
    runsData = cachedRunsEntry.data;
  } else {
    const isRateLimited =
      parsedRunsHttp.status === 429 ||
      (parsedRunsHttp.status === 403 &&
        (parsedRunsHttp.rateLimitRemaining === 0 ||
          parsedRunsHttp.retryAfterSec !== null ||
          /rate limit/i.test(parsedRunsHttp.bodyText || runsRes?.stderr || "")));
    if (isRateLimited) {
      const resetDelaySec =
        parsedRunsHttp.rateLimitRemaining === 0
          ? computeResetDelaySec(parsedRunsHttp.rateLimitReset)
          : null;
      const retryAfterSec = Math.max(parsedRunsHttp.retryAfterSec || 0, resetDelaySec || 0, 60);
      const nextIntervalSec = computeAdaptivePrIntervalSec({
        baseIntervalSec: args.intervalSec,
        consecutiveUnchangedPolls: state?.consecutiveUnchangedPolls || 0,
        rateLimitRemaining: parsedRunsHttp.rateLimitRemaining,
        rateLimitReset: parsedRunsHttp.rateLimitReset,
        retryAfterSec,
      });
      if (state) {
        state.cooldownUntilMs = Date.now() + nextIntervalSec * 1000;
        if (state.metrics) {
          state.metrics.retryAfterSec = Math.max(state.metrics.retryAfterSec || 0, retryAfterSec);
        }
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
        nextIntervalSec,
      };
    }
    if (!runsRes || !runsRes.ok || !parsedRunsHttp.bodyText) {
      const errMsg = runsRes?.stderr || "Workflow runs inventory unavailable";
      return { events: [{ type: "POLL_ERROR", error: errMsg }], error: errMsg };
    }
    try {
      runsData = JSON.parse(parsedRunsHttp.bodyText);
    } catch (error) {
      const errMsg = `Invalid workflow runs JSON: ${error.message}`;
      return { events: [{ type: "POLL_ERROR", error: errMsg }], error: errMsg };
    }
    if (state && parsedRunsHttp.etag && Array.isArray(runsData?.workflow_runs)) {
      const slimRunsData = {
        ...(typeof runsData.total_count === "number" ? { total_count: runsData.total_count } : {}),
        workflow_runs: runsData.workflow_runs.map((r) => ({
          id: r?.id,
          workflow_id: r?.workflow_id,
          path: r?.path,
          name: r?.name,
          event: r?.event,
          head_branch: r?.head_branch,
          head_sha: r?.head_sha,
          status: r?.status,
          conclusion: r?.conclusion,
          html_url: r?.html_url,
        })),
      };
      state.etags[runsEndpoint] = {
        etag: parsedRunsHttp.etag,
        data: slimRunsData,
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

  const actionRequiredRuns = [];
  for (const run of latestByWorkflowKey.values()) {
    if (run.status !== "completed") {
      activeWorkflowRuns.push(run.name || "workflow");
    } else if (
      run.conclusion &&
      !["success", "skipped", "neutral"].includes(run.conclusion.toLowerCase())
    ) {
      if (run.conclusion.toLowerCase() === "action_required" && run.id) {
        actionRequiredRuns.push({
          runId: run.id,
          name: run.name || "workflow",
          url: run.html_url,
        });
      }
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
    const actionReqCommands = actionRequiredRuns
      .map(
        (r) =>
          `gh api -X POST repos/${args.repo}/actions/runs/${r.runId}/approve && gh run rerun ${r.runId} -R ${args.repo}`
      )
      .join("; ");
    const hasNonActionRequiredFailures = failedChecks.some(
      (fc) => String(fc?.conclusion || "").toUpperCase() !== "ACTION_REQUIRED"
    );
    const defaultFailureRemediation =
      "Inspect the failed job logs via `gh api repos/<owner>/<repo>/actions/jobs/<jobId>/logs`, fix the root cause (or rebase if base SHA drifted during push), commit, push, and restart pr-watch-daemon.mjs.";
    return {
      events: [
        {
          type: "CI_FAILED",
          timestamp: new Date().toISOString(),
          headRefOid: headOid,
          failedChecks,
          ...(actionRequiredRuns.length > 0 ? { actionRequiredRuns } : {}),
          remediation:
            actionRequiredRuns.length > 0 && hasNonActionRequiredFailures
              ? `Approve and rerun action_required workflow runs (${actionReqCommands}); also inspect the other failed job logs and fix the root cause, then restart pr-watch-daemon.mjs.`
              : actionRequiredRuns.length > 0
                ? `Approve and rerun action_required workflow runs (${actionReqCommands}), then restart pr-watch-daemon.mjs.`
                : defaultFailureRemediation,
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
      const retryRes = requestCopilotReview({ ...args, pr: args.pr, head: headOid }, execFn);
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
    headReviews.map((r) => normalizeReviewerLogin(r.author?.login)).filter(Boolean)
  );
  const nonExemptExpectedReviewers = (args.expectedReviewers || []).filter(
    (login) => args.expectCopilot || !isCopilotBotLogin(login)
  );
  const missingExpectedReviewers = nonExemptExpectedReviewers.filter(
    (login) => !headReviewerLogins.has(normalizeReviewerLogin(login))
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

export function evaluateMultiPrPollTick(args, execFn = defaultExecGh, multiState = {}) {
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
    const tick = evaluatePrPollTick(prArgs, execFn, entry.watchState);
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

export function shouldEmitPrWatchStatus({
  polls = 1,
  eventsCount = 0,
  summaryChanged = false,
  nowMs = Date.now(),
  lastEmitMs = 0,
  heartbeatSec = 60,
} = {}) {
  if (polls <= 1 || eventsCount > 0 || summaryChanged) return true;
  return nowMs - lastEmitMs >= heartbeatSec * 1000;
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
    if (args.prs.length > 1) {
      const multi = evaluateMultiPrPollTick(args);
      console.log(JSON.stringify(multi, null, 2));
      if (multi.error) {
        process.exit(1);
      }
      return;
    }
    const tick = evaluatePrPollTick(args);
    console.log(JSON.stringify(tick, null, 2));
    if (tick.error) {
      process.exit(1);
    }
    return;
  }

  if (args.prs.length > 1) {
    const multiState = {};
    const initialCooldownMs = loadPrCooldownMs(args.repo);
    if (initialCooldownMs) {
      for (const prNum of args.prs) {
        multiState[prNum] = { state: { ...createPrWatchState(), cooldownUntilMs: initialCooldownMs } };
      }
    }
    const watchStartedAtMs = Date.now();
    const lastSummaryByPr = new Map();
    let lastEmitMs = 0;
    let polls = 0;
    while (true) {
      polls += 1;
      const multi = evaluateMultiPrPollTick(args, defaultExecGh, multiState);
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
        const rateSleepSec = multi.nextIntervalSec || 60;
        savePrCooldownMs(args.repo, Date.now() + rateSleepSec * 1000);
        console.log(JSON.stringify(multi, null, 2));
        if (args.maxPolls > 0 && polls >= args.maxPolls) {
          console.log(JSON.stringify({ prs: args.prs, events: [{ type: "MAX_POLLS_REACHED" }] }, null, 2));
          return;
        }
        if (args.maxWaitSec > 0) {
          const elapsedSec = Math.floor((Date.now() - watchStartedAtMs) / 1000);
          if (elapsedSec + rateSleepSec >= args.maxWaitSec) {
            const remainingWaitSec = Math.max(0, args.maxWaitSec - elapsedSec);
            if (remainingWaitSec > 0) {
              await sleepSeconds(remainingWaitSec);
            }
            console.log(
              JSON.stringify(
                {
                  prs: args.prs,
                  events: [
                    {
                      type: "WATCH_CHUNK_TIMEOUT",
                      elapsedSec: Math.floor((Date.now() - watchStartedAtMs) / 1000),
                      maxWaitSec: args.maxWaitSec,
                    },
                  ],
                  statuses: multi.statuses,
                },
                null,
                2
              )
            );
            return;
          }
        }
        await sleepSeconds(rateSleepSec);
        continue;
      }
      savePrCooldownMs(args.repo, null);
      let summaryChanged = false;
      for (const st of multi.statuses || []) {
        const prevSummary = lastSummaryByPr.get(st.pr);
        if (prevSummary && prevSummary !== st.summary) {
          summaryChanged = true;
        }
        lastSummaryByPr.set(st.pr, st.summary);
      }
      const nowMs = Date.now();
      if (
        shouldEmitPrWatchStatus({
          polls,
          eventsCount: multi.events.length,
          summaryChanged,
          nowMs,
          lastEmitMs,
        })
      ) {
        lastEmitMs = nowMs;
        console.log(JSON.stringify({ prs: multi.prs, events: multi.events, statuses: multi.statuses }, null, 2));
      }
      if (args.maxPolls > 0 && polls >= args.maxPolls) {
        console.log(JSON.stringify({ prs: args.prs, events: [{ type: "MAX_POLLS_REACHED" }], statuses: multi.statuses }, null, 2));
        return;
      }
      const nextSleepSec = multi.nextIntervalSec || args.intervalSec;
      if (args.maxWaitSec > 0) {
        const elapsedSec = Math.floor((Date.now() - watchStartedAtMs) / 1000);
        if (elapsedSec + nextSleepSec >= args.maxWaitSec) {
          console.log(
            JSON.stringify(
              {
                prs: args.prs,
                events: [{ type: "WATCH_CHUNK_TIMEOUT", elapsedSec, maxWaitSec: args.maxWaitSec }],
                statuses: multi.statuses,
              },
              null,
              2
            )
          );
          return;
        }
      }
      await sleepSeconds(nextSleepSec);
    }
  }

  const watchState = createPrWatchState();
  watchState.cooldownUntilMs = loadPrCooldownMs(args.repo);
  const watchStartedAtMs = Date.now();
  let baselinePhase = args.lastPhase;
  let lastSummary = "";
  let lastEmitMs = 0;
  let hasCommentBaseline = args.hasExplicitSinceCommentId;
  let baselineCommentId = args.sinceCommentId;
  let polls = 0;
  while (true) {
    polls += 1;
    const tick = evaluatePrPollTick(
      {
        ...args,
        lastPhase: baselinePhase,
        hasExplicitSinceCommentId: hasCommentBaseline,
        sinceCommentId: baselineCommentId,
      },
      defaultExecGh,
      watchState
    );
    if (tick.rateLimited) {
      savePrCooldownMs(args.repo, watchState.cooldownUntilMs);
      console.log(JSON.stringify(tick, null, 2));
      if (args.maxPolls > 0 && polls >= args.maxPolls) {
        console.log(JSON.stringify({ events: [{ type: "MAX_POLLS_REACHED" }] }, null, 2));
        return;
      }
      const rateSleepSec = tick.nextIntervalSec || 60;
      if (args.maxWaitSec > 0) {
        const elapsedSec = Math.floor((Date.now() - watchStartedAtMs) / 1000);
        if (elapsedSec + rateSleepSec >= args.maxWaitSec) {
          const remainingWaitSec = Math.max(0, args.maxWaitSec - elapsedSec);
          if (remainingWaitSec > 0) {
            await sleepSeconds(remainingWaitSec);
          }
          console.log(
            JSON.stringify(
              {
                events: [
                  {
                    type: "WATCH_CHUNK_TIMEOUT",
                    headRefOid: tick.status?.headRefOid || args.head || "",
                    latestCommentId: baselineCommentId,
                    lastPhase: baselinePhase || "",
                    elapsedSec: Math.floor((Date.now() - watchStartedAtMs) / 1000),
                    maxWaitSec: args.maxWaitSec,
                  },
                ],
                ...(tick.status ? { status: tick.status } : {}),
              },
              null,
              2
            )
          );
          return;
        }
      }
      await sleepSeconds(rateSleepSec);
      continue;
    }
    savePrCooldownMs(args.repo, null);
    if (tick.error) {
      console.error(JSON.stringify(tick, null, 2));
      process.exit(1);
    }
    const terminalEvents = tick.events.filter((e) => !NON_TERMINAL_PR_EVENTS.has(e.type));
    if (terminalEvents.length > 0) {
      console.log(JSON.stringify(tick, null, 2));
      return;
    }
    const currentSummary = tick.status?.summary || "";
    const summaryChanged = Boolean(lastSummary && currentSummary && currentSummary !== lastSummary);
    lastSummary = currentSummary || lastSummary;
    const nowMs = Date.now();
    // Emit live status on initial poll, phase/summary transitions, auto-retries, or 60s heartbeats
    if (
      shouldEmitPrWatchStatus({
        polls,
        eventsCount: tick.events.length,
        summaryChanged,
        nowMs,
        lastEmitMs,
      })
    ) {
      lastEmitMs = nowMs;
      console.log(JSON.stringify({ events: tick.events, status: tick.status }, null, 2));
    }
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
    const nextSleepSec = tick.nextIntervalSec || args.intervalSec;
    if (args.maxWaitSec > 0) {
      const elapsedSec = Math.floor((Date.now() - watchStartedAtMs) / 1000);
      if (elapsedSec + nextSleepSec >= args.maxWaitSec) {
        console.log(
          JSON.stringify(
            {
              events: [
                {
                  type: "WATCH_CHUNK_TIMEOUT",
                  headRefOid: tick.status?.headRefOid || args.head || "",
                  latestCommentId: baselineCommentId,
                  lastPhase: baselinePhase || "",
                  elapsedSec,
                  maxWaitSec: args.maxWaitSec,
                },
              ],
              status: tick.status,
            },
            null,
            2
          )
        );
        return;
      }
    }
    await sleepSeconds(nextSleepSec);
  }
}

if (
  import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}` ||
  process.argv[1]?.endsWith("pr-watch-daemon.mjs")
) {
  runCli();
}
