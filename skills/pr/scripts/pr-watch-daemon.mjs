#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createGitHubClient, createEventWriter, githubHost, httpDetails, runGh } from "./lib/github-client.mjs";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

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
      timeout: 5000,
      windowsHide: true,
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
  return hostWaitSec > 60 ? hostWaitSec - 60 : Math.max(0.5, hostWaitSec / 2);
}

export function parsePrWatchArgs(argv, env = process.env) {
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
    } else if (token === "--max-wait-sec" && argv[i + 1]) {
      const rawWait = argv[++i];
      const parsedWait = Number(rawWait);
      if (!/^\d+$/.test(rawWait) || !Number.isSafeInteger(parsedWait)) {
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
      const rawSince = String(argv[++i]).trim();
      if (rawSince.includes(":")) {
        args.prSinceCommentIds ??= {};
        for (const part of rawSince.split(",").map((s) => s.trim()).filter(Boolean)) {
          const [prPart, idPart] = part.split(":");
          const prNum = Number(prPart);
          const parsedId = Number(idPart);
          if (!/^[1-9]\d*:\d+$/.test(part) || !Number.isSafeInteger(prNum) || !Number.isSafeInteger(parsedId)) {
            throw new Error(`Invalid --since-comment-id "${rawSince}". Expected "<id>" or "<pr>:<id>".`);
          }
          args.prSinceCommentIds[prNum] = parsedId;
        }
      } else {
        const parsedId = Number(rawSince);
        if (!/^\d+$/.test(rawSince) || !Number.isSafeInteger(parsedId)) {
          throw new Error(`Invalid --since-comment-id "${parsedId}". Expected a non-negative integer.`);
        }
        args.sinceCommentId = parsedId;
        args.hasExplicitSinceCommentId = true;
      }
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
  if (args.prs.length === 1 && args.prSinceCommentIds?.[args.pr] !== undefined) {
    args.sinceCommentId = args.prSinceCommentIds[args.pr];
    args.hasExplicitSinceCommentId = true;
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

const PR_WATCH_DIR = join(process.env.COPILOT_HOME || join(homedir(), ".copilot"), "pr-watch");

function prSessionFileForRepo(repo, stateDir, host) {
  const safeSlug = String(repo || "default")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "__");
  const directory = host === "github.com" ? stateDir : join(stateDir, "hosts", host.replace(/:/g, "__"));
  return join(directory, `${safeSlug}.json`);
}

function readPrSession(filePath, host) {
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) ||
        !parsed.entries || typeof parsed.entries !== "object" || Array.isArray(parsed.entries) ||
        (parsed.host !== undefined && parsed.host !== host) ||
        (host !== "github.com" && parsed.host === undefined)) throw new Error("Unverified session schema or host");
    const validDeadline = (value) => value == null || Number.isFinite(value) && value >= 0;
    if (!validDeadline(parsed.cooldownUntilMs)) throw new Error("Invalid shared cooldown");
    if (parsed.nextPrByWatchlist !== undefined &&
        (!parsed.nextPrByWatchlist || typeof parsed.nextPrByWatchlist !== "object" ||
          Array.isArray(parsed.nextPrByWatchlist) ||
          Object.entries(parsed.nextPrByWatchlist).some(([key, pr]) =>
            !/^[a-f0-9]{64}$/.test(key) || !Number.isSafeInteger(pr) || pr < 1))) {
      throw new Error("Invalid watchlist continuation");
    }
    for (const entry of Object.values(parsed.entries)) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry) ||
          !entry.watchState || typeof entry.watchState !== "object" || Array.isArray(entry.watchState)) {
        throw new Error("Invalid watch state entry");
      }
      if (entry.lastStatusScope !== undefined && typeof entry.lastStatusScope !== "string") {
        throw new Error("Invalid cached status identity");
      }
      if (!validDeadline(entry.watchState.cooldownUntilMs)) throw new Error("Invalid watch cooldown");
      if (!validDeadline(entry.watchState.nextPollAtMs)) throw new Error("Invalid next poll time");
      const retries = entry?.watchState?.copilotErrorRetriesByHead;
      if (retries !== undefined && (!retries || typeof retries !== "object" || Array.isArray(retries) ||
          Object.values(retries).some((count) => !Number.isSafeInteger(count) || count < 0))) {
        throw new Error("Invalid retry counters");
      }
    }
    return parsed;
  } catch (cause) {
    throw new Error(`Invalid PR watch state: ${filePath}`, { cause });
  }
}

function hydrateWatchState(raw) {
  const base = createPrWatchState();
  if (!raw || typeof raw !== "object") return base;
  if (raw.etags && typeof raw.etags === "object") base.etags = raw.etags;
  if (typeof raw.cacheScope === "string") base.cacheScope = raw.cacheScope;
  if (Number.isInteger(raw.consecutiveUnchangedPolls) && raw.consecutiveUnchangedPolls >= 0) {
    base.consecutiveUnchangedPolls = raw.consecutiveUnchangedPolls;
  }
  if (raw.copilotErrorRetriesByHead && typeof raw.copilotErrorRetriesByHead === "object") {
    base.copilotErrorRetriesByHead = raw.copilotErrorRetriesByHead;
  }
  if (Array.isArray(raw.retriedCopilotReviewIds)) {
    base.retriedCopilotReviewIds = raw.retriedCopilotReviewIds;
  }
  if (raw.pendingRetryReviewId !== undefined) {
    base.pendingRetryReviewId = raw.pendingRetryReviewId;
  }
  if (Number.isInteger(raw.pendingRetryGracePolls) && raw.pendingRetryGracePolls >= 0) {
    base.pendingRetryGracePolls = raw.pendingRetryGracePolls;
  }
  if (Number.isFinite(raw.cooldownUntilMs) && raw.cooldownUntilMs > Date.now()) {
    base.cooldownUntilMs = raw.cooldownUntilMs;
  }
  if (Number.isFinite(raw.nextPollAtMs)) base.nextPollAtMs = raw.nextPollAtMs;
  if (raw.metrics && typeof raw.metrics === "object") {
    base.metrics = { ...base.metrics, ...raw.metrics };
  }
  return base;
}

export function loadPersistedPrSession(repo, stateDir = PR_WATCH_DIR, host = githubHost()) {
  if (!repo) {
    return { cooldownUntilMs: null, entries: {} };
  }
  host = githubHost(host);
  const filePath = prSessionFileForRepo(repo, stateDir, host);
  try {
    const parsed = readPrSession(filePath, host);
    const cooldownUntilMs =
      Number.isFinite(parsed.cooldownUntilMs) && parsed.cooldownUntilMs > Date.now()
        ? parsed.cooldownUntilMs
        : null;
    const entries = {};
    if (parsed.entries && typeof parsed.entries === "object") {
      for (const [prKey, entry] of Object.entries(parsed.entries)) {
        if (!entry || typeof entry !== "object") continue;
        const ws = hydrateWatchState(entry.watchState);
        if (cooldownUntilMs && (!ws.cooldownUntilMs || ws.cooldownUntilMs < cooldownUntilMs)) {
          ws.cooldownUntilMs = cooldownUntilMs;
        }
        entries[prKey] = {
          watchState: ws,
          lastPhase: typeof entry.lastPhase === "string" ? entry.lastPhase : "",
          lastStatus: entry.lastStatus || null,
          ...(typeof entry.lastStatusScope === "string" ? { lastStatusScope: entry.lastStatusScope } : {}),
          hasExplicitSinceCommentId: Boolean(entry.hasExplicitSinceCommentId),
          sinceCommentId: Number.isSafeInteger(entry.sinceCommentId) ? entry.sinceCommentId : 0,
        };
      }
    }
    return {
      cooldownUntilMs, entries, nextPr: parsed.nextPr,
      ...(parsed.nextPrByWatchlist ? { nextPrByWatchlist: parsed.nextPrByWatchlist } : {}),
    };
  } catch (error) {
    if (error.cause?.code === "ENOENT") return { cooldownUntilMs: null, entries: {} };
    throw error;
  }
}

export function savePersistedPrSession(repo, { cooldownUntilMs = null, entries = {}, nextPr, watchlistKey, deadlineMs = Infinity } = {}, stateDir = PR_WATCH_DIR, host = githubHost()) {
  if (!repo) return;
  host = githubHost(host);
  const filePath = prSessionFileForRepo(repo, stateDir, host);
  const lockPath = `${filePath}.lock`;
  const tempPath = `${filePath}.${process.pid}.pending`;
  let lock;
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    const lockDeadline = Math.min(Date.now() + 1000, deadlineMs);
    while (lock === undefined) {
      try {
        lock = openSync(lockPath, "wx");
        writeFileSync(lock, String(process.pid), "utf8");
      } catch (error) {
        if (!["EEXIST", "EPERM"].includes(error.code)) throw error;
        if (Date.now() >= lockDeadline) throw new Error("PR watch state lock unavailable", { cause: error });
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
    let existing = { cooldownUntilMs: null, entries: {} };
    if (existsSync(filePath)) {
      existing = readPrSession(filePath, host);
    }
    const mergedEntries = { ...(existing.entries || {}), ...entries };
    const validCooldown = Math.max(
      Number.isFinite(existing.cooldownUntilMs) ? existing.cooldownUntilMs : 0,
      Number.isFinite(cooldownUntilMs) ? cooldownUntilMs : 0,
      ...Object.values(mergedEntries).map((entry) => entry?.watchState?.cooldownUntilMs || 0)
    );
    const nextPrByWatchlist = { ...existing.nextPrByWatchlist };
    if (watchlistKey !== undefined) {
      if (!/^[a-f0-9]{64}$/.test(watchlistKey) ||
          (nextPr !== undefined && (!Number.isSafeInteger(nextPr) || nextPr < 1))) {
        throw new Error("Invalid watchlist continuation");
      }
      if (nextPr !== undefined) nextPrByWatchlist[watchlistKey] = nextPr;
    }
    writeFileSync(
      tempPath,
      `${JSON.stringify({
        host, cooldownUntilMs: validCooldown > Date.now() ? validCooldown : null,
        entries: mergedEntries, nextPr: nextPr ?? existing.nextPr,
        ...(Object.keys(nextPrByWatchlist).length ? { nextPrByWatchlist } : {}),
      }, null, 2)}\n`,
      "utf8"
    );
    renameSync(tempPath, filePath);
  } finally {
    if (lock !== undefined) {
      closeSync(lock);
      rmSync(lockPath, { force: true });
      rmSync(tempPath, { force: true });
    }
  }
}

class WatchChunkDeadline extends Error {}

function chunkExec(execFn, deadlineMs) {
  const invoke = async (fn, input, options = {}) => {
    const remaining = deadlineMs - Date.now();
    if (remaining <= 0) throw new WatchChunkDeadline();
    const control = new AbortController();
    const timer = Number.isFinite(remaining)
      ? setTimeout(() => control.abort(), Math.min(2147483647, Math.ceil(remaining)))
      : null;
    try {
      const signal = options.signal ? AbortSignal.any([control.signal, options.signal]) : control.signal;
      const result = await fn(input, { ...options, signal });
      if (control.signal.aborted || result?.chunkTimedOut) throw new WatchChunkDeadline();
      return result;
    } catch (error) {
      if (control.signal.aborted) throw new WatchChunkDeadline();
      throw error;
    } finally {
      clearTimeout(timer);
    }
  };
  const request = (input, options) => invoke(execFn, input, options);
  if (execFn.cacheScope) request.cacheScope = (options) =>
    invoke((_, requestOptions) => execFn.cacheScope(requestOptions), undefined, options);
  return request;
}

function resetPrObservations(state, scope) {
  state.etags = {};
  state.cacheScope = scope;
  state.nextPollAtMs = null;
  state.consecutiveUnchangedPolls = 0;
  state.metrics = createPrWatchState().metrics;
}

async function verifyCachedPrStatuses(entries, execFn, args) {
  const cached = entries.filter(Boolean);
  if (!cached.some((entry) => entry.lastStatus || entry.lastPhase ||
      entry.watchState.cacheScope || entry.watchState.nextPollAtMs ||
      Object.keys(entry.watchState.etags || {}).length)) return;
  let scope;
  try {
    scope = await chunkExec(execFn, args.chunkDeadlineMs ?? Infinity).cacheScope?.({ target: args.repo });
  } catch {
    scope = "";
  }
  if (typeof scope !== "string") scope = "";
  for (const entry of cached) {
    if (scope && entry.watchState.cacheScope === scope &&
        (!(entry.lastStatus || entry.lastPhase) || entry.lastStatusScope === scope)) continue;
    resetPrObservations(entry.watchState, scope);
    entry.lastStatus = null;
    entry.lastStatusScope = "";
    entry.lastPhase = "";
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
async function defaultRequest(request, options) {
  if (request.kind === "reviewer") {
    const result = await runGh(["pr", "edit", String(request.pr), "-R", request.repo,
      request.remove ? "--remove-reviewer" : "--add-reviewer", "@copilot"], { timeout: 30000, signal: options?.signal });
    return { ok: result.ok, error: result.stderr };
  }
  githubClient ??= createGitHubClient();
  return githubClient.request(request, options);
}
defaultRequest.cacheScope = async (options) => {
  githubClient ??= createGitHubClient();
  return githubClient.cacheScope(options);
};
export async function requestCopilotReview(args, execFn = defaultRequest) {
  if (!args?.head || typeof args.head !== "string" || !args.head.trim()) {
    return {
      ok: false,
      status: "missing_head",
      error: 'Missing or invalid --head "<oid>" for request-copilot.',
    };
  }
  let credentialScope;
  const scopedRequest = async (input) => {
    try {
      const currentScope = await execFn.cacheScope?.();
      if (credentialScope && currentScope && currentScope !== credentialScope) {
        return { ok: false, error: "GitHub credential scope changed during Copilot request" };
      }
      credentialScope ||= currentScope;
      if (input.kind === "reviewer" && !input.remove) args.onReviewRequest?.();
      const result = await execFn(input);
      if (credentialScope && result?.cacheScope && result.cacheScope !== credentialScope) {
        return { ok: false, error: "GitHub credential scope changed during Copilot request" };
      }
      credentialScope ||= result?.cacheScope;
      return result;
    } catch (error) {
      if (error instanceof WatchChunkDeadline) throw error;
      return { ok: false, error: error.message };
    }
  };
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
    const gqlRes = await scopedRequest({ kind: "graphql", query, variables: { owner, name, pr: args.pr } });
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
        const runsRes = await scopedRequest({ endpoint });
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
      const cancelRes = await scopedRequest({ method: "POST", endpoint: `repos/${args.repo}/actions/runs/${run.id}/cancel` });
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
    const removeRes = await scopedRequest({ kind: "reviewer", repo: args.repo, pr: args.pr, remove: true });
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

  const addRes = await scopedRequest({ kind: "reviewer", repo: args.repo, pr: args.pr, remove: false });
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
  const nowMs = Date.now();
  if (args.respectPollInterval && state?.nextPollAtMs > nowMs && !(state.cooldownUntilMs > nowMs) &&
      (!args.head || (state.metrics.nextPollHeadOid || args.lastStatus?.headRefOid) === args.head)) {
    return {
      events: [], pollDeferred: true, nextIntervalSec: (state.nextPollAtMs - nowMs) / 1000,
      ...(args.lastStatus ? { status: args.lastStatus } : {}),
    };
  }
  if (args.respectPollInterval && state) state.nextPollAtMs = null;
  try {
    const tick = await evaluatePrPollTickInner(args, chunkExec(execFn, args.chunkDeadlineMs ?? Infinity), state);
    const polledHead = tick.status?.headRefOid || tick.events?.find((event) => event.type === "PR_READY_TO_MERGE")?.headRefOid;
    if (args.respectPollInterval && state && polledHead && !tick.error && !tick.rateLimited && !tick.chunkTimedOut) {
      state.nextPollAtMs = Date.now() + (tick.nextIntervalSec || args.intervalSec) * 1000;
      state.metrics.nextPollHeadOid = polledHead;
    }
    return tick;
  } catch (error) {
    if (!(error instanceof WatchChunkDeadline)) throw error;
    return { events: [], chunkTimedOut: true, nextIntervalSec: args.intervalSec };
  }
}

async function evaluatePrPollTickInner(args, execFn, state) {
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

  const gqlRes = await execFn({ kind: "graphql", query, variables: { owner, name, pr: args.pr } });
  const parsedGqlHttp = httpDetails(gqlRes);
  if (state && typeof gqlRes?.cacheScope === "string" && state.cacheScope !== gqlRes.cacheScope) {
    if (state.cacheScope) {
      resetPrObservations(state, gqlRes.cacheScope);
      state.metrics.apiCalls = 1;
    } else {
      state.etags = {};
      state.cacheScope = gqlRes.cacheScope;
    }
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
  const runsRequest = { endpoint: runsEndpoint, conditional: Boolean(state),
    headers: cachedRunsEntry?.etag ? { "If-None-Match": cachedRunsEntry.etag } : {} };
  if (state?.metrics) {
    state.metrics.apiCalls = (state.metrics.apiCalls || 0) + 1;
  }
  const runsRes = await execFn(runsRequest);
  const parsedRunsHttp = httpDetails(runsRes);
  const credentialChanged = typeof gqlRes?.cacheScope === "string" &&
    typeof runsRes?.cacheScope === "string" && runsRes.cacheScope !== gqlRes.cacheScope;
  if (credentialChanged && state) {
    resetPrObservations(state, runsRes.cacheScope);
    state.metrics.apiCalls = 1;
  }
  if (credentialChanged && (runsRes.ok || parsedRunsHttp.status === 304)) {
    const error = "GitHub credentials changed during the poll; retry the pinned head";
    return { events: [{ type: "POLL_ERROR", error }], error };
  }
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
      const retryRes = await requestCopilotReview({
        ...args,
        pr: args.pr,
        head: headOid,
        onReviewRequest: () => { state.copilotErrorRetriesByHead[headOid] = prevRetries + 1; },
      }, execFn);
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

export async function evaluateMultiPrPollTick(args, execFn = defaultRequest, multiState = {}) {
  const targetPrs = Array.isArray(args.prs) && args.prs.length > 0 ? args.prs : [args.pr];
  const startIndex = Math.max(0, targetPrs.indexOf(args.nextPr));
  const orderedPrs = [...targetPrs.slice(startIndex), ...targetPrs.slice(0, startIndex)];
  const allEvents = [];
  const statuses = [];
  let anyRateLimited = false;
  let maxRateLimitIntervalSec = 0;
  let minActiveIntervalSec = Infinity;
  let firstError = null;
  let chunkTimedOut = false;
  let nextPr = orderedPrs[0];
  let completedThisTick = 0;

  for (const prNumber of orderedPrs) {
    if (Date.now() >= (args.chunkDeadlineMs ?? Infinity)) {
      chunkTimedOut = true;
      nextPr = prNumber;
      break;
    }
    if (!multiState[prNumber]) {
      const explicitPrCommentId = args.prSinceCommentIds?.[prNumber];
      const useSinglePrBaseline = targetPrs.length === 1 || prNumber === args.pr;
      const ws = createPrWatchState();
      if (Number.isFinite(args.initialCooldownMs) && args.initialCooldownMs > Date.now()) {
        ws.cooldownUntilMs = args.initialCooldownMs;
      }
      multiState[prNumber] = {
        watchState: ws,
        lastPhase: targetPrs.length === 1 ? args.lastPhase || "" : "",
        hasExplicitSinceCommentId:
          explicitPrCommentId !== undefined
            ? true
            : useSinglePrBaseline
              ? Boolean(args.hasExplicitSinceCommentId)
              : false,
        sinceCommentId:
          explicitPrCommentId !== undefined
            ? explicitPrCommentId
            : useSinglePrBaseline
              ? args.sinceCommentId || 0
              : 0,
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
      lastStatus: entry.lastStatus,
      hasExplicitSinceCommentId: entry.hasExplicitSinceCommentId,
      sinceCommentId: entry.sinceCommentId,
    };
    const previousScope = entry.watchState.cacheScope;
    const tick = await evaluatePrPollTick(prArgs, execFn, entry.watchState);
    const currentScope = entry.watchState.cacheScope;
    if (previousScope !== currentScope) {
      entry.lastStatus = null;
      entry.lastStatusScope = "";
      entry.lastPhase = "";
      const invalidated = new Set([prNumber]);
      for (const [otherPr, otherEntry] of Object.entries(multiState)) {
        if (otherEntry === entry || otherEntry.watchState.cacheScope === currentScope) continue;
        resetPrObservations(otherEntry.watchState, currentScope);
        otherEntry.lastStatus = null;
        otherEntry.lastStatusScope = "";
        otherEntry.lastPhase = "";
        invalidated.add(Number(otherPr));
      }
      for (let i = statuses.length - 1; i >= 0; i--) {
        if (invalidated.has(statuses[i].pr)) statuses.splice(i, 1);
      }
      for (let i = allEvents.length - 1; i >= 0; i--) {
        if (invalidated.has(allEvents[i].pr)) allEvents.splice(i, 1);
      }
    }
    nextPr = targetPrs[(targetPrs.indexOf(prNumber) + 1) % targetPrs.length];
    if (tick.chunkTimedOut) {
      if (completedThisTick > 0) nextPr = prNumber;
      chunkTimedOut = true;
      break;
    }
    if (tick.error && !firstError) {
      firstError = tick.error;
    }
    for (const ev of tick.events || []) {
      allEvents.push({ pr: prNumber, ...ev });
    }
    if (tick.status) {
      entry.lastStatus = tick.status;
      if (!tick.pollDeferred) entry.lastStatusScope = entry.watchState.cacheScope || "";
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
    completedThisTick += 1;
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
    nextPr,
    ...(chunkTimedOut ? { chunkTimedOut: true } : {}),
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

export async function runCli(argv = process.argv.slice(2), services = {}) {
  const args = parsePrWatchArgs(argv);
  args.respectPollInterval = args.mode === "watch";
  const execFn = services.execFn || defaultRequest;
  const sleep = services.sleep || sleepSeconds;
  const stateDir = services.stateDir || PR_WATCH_DIR;
  const sessionHost = githubHost();
  const watchlistKey = args.prs.length > 1
    ? createHash("sha256").update(JSON.stringify({
        host: sessionHost, repo: args.repo.toLowerCase(),
        prs: args.prs.map((pr) => [pr, args.prHeads?.[pr] ?? (pr === args.pr ? args.head : "")]),
      })).digest("hex")
    : undefined;
  const loadSession = () => loadPersistedPrSession(args.repo, stateDir, sessionHost);
  const refreshSharedCooldown = (states) => {
    const until = loadSession().cooldownUntilMs;
    if (until) for (const state of states) state.cooldownUntilMs = Math.max(state.cooldownUntilMs || 0, until);
    return until;
  };
  const watchStartedAtMs = Date.now();
  if (args.mode === "watch" && args.maxWaitSec > 0) {
    args.chunkDeadlineMs = watchStartedAtMs + args.maxWaitSec * 1000;
  }
  const saveSession = (session) => savePersistedPrSession(args.repo, {
    ...session, nextPr: args.nextPr, watchlistKey, deadlineMs: args.chunkDeadlineMs,
  }, stateDir, sessionHost);
  const emit = createEventWriter(args.eventsFile, "pr-watch", { repo: args.repo, pr: args.pr });
  const heartbeat = args.eventsFile ? setInterval(() => emit({
    status: { repo: args.repo, phase: "polling", summary: "Watcher active; awaiting GitHub observations" },
  }), 60000) : null;
  heartbeat?.unref();
  try {
  if (args.mode === "request-copilot") {
    const res = await requestCopilotReview(args, execFn);
    console.log(JSON.stringify(res, null, 2));
    if (!res.ok) {
      process.exit(1);
    }
    return;
  }
  if (args.mode === "once") {
    if (args.prs.length > 1) {
      const multi = await evaluateMultiPrPollTick(args, execFn);
      emit(multi);
      console.log(JSON.stringify(multi, null, 2));
      if (multi.error) {
        process.exit(1);
      }
      return;
    }
    const tick = await evaluatePrPollTick(args, execFn);
    emit(tick);
    console.log(JSON.stringify(tick, null, 2));
    if (tick.error) {
      process.exit(1);
    }
    return;
  }

  if (args.prs.length > 1) {
    const persistedSession = loadSession();
    const savedNextPr = persistedSession.nextPrByWatchlist?.[watchlistKey];
    if (savedNextPr !== undefined && !args.prs.includes(savedNextPr)) {
      throw new Error("Invalid continuation for the current PR watchlist");
    }
    args.nextPr = savedNextPr ??
      (persistedSession.nextPrByWatchlist ? undefined : persistedSession.nextPr);
    await verifyCachedPrStatuses(args.prs.map((pr) => persistedSession.entries[String(pr)]), execFn, args);
    const multiState = {};
    for (const prNum of args.prs) {
      const savedEntry = persistedSession.entries[String(prNum)];
      const explicitPrCommentId = args.prSinceCommentIds?.[prNum];
      if (savedEntry) {
        const useSinglePrBaseline = prNum === args.pr;
        const hasOverride =
          explicitPrCommentId !== undefined ||
          (useSinglePrBaseline && Boolean(args.hasExplicitSinceCommentId));
        const overrideId =
          explicitPrCommentId !== undefined ? explicitPrCommentId : args.sinceCommentId || 0;
        multiState[prNum] = {
          watchState: savedEntry.watchState,
          lastPhase: savedEntry.lastPhase || "",
          lastStatus: savedEntry.lastStatus || null,
          lastStatusScope: savedEntry.lastStatusScope || "",
          hasExplicitSinceCommentId: hasOverride ? true : savedEntry.hasExplicitSinceCommentId,
          sinceCommentId: hasOverride ? overrideId : savedEntry.sinceCommentId,
        };
      }
    }
    const lastSummaryByPr = new Map();
    const statusByPr = new Map(Object.entries(multiState)
      .filter(([, entry]) => entry.lastStatus)
      .map(([pr, entry]) => [Number(pr), { pr: Number(pr), ...entry.lastStatus }]));
    let lastStatuses = [...statusByPr.values()];
    let lastEmitMs = 0;
    let polls = 0;
    while (true) {
      polls += 1;
      await verifyCachedPrStatuses(Object.values(multiState), execFn, args);
      const sharedCooldown = refreshSharedCooldown(Object.values(multiState).map((entry) => entry.watchState));
      if (sharedCooldown) persistedSession.cooldownUntilMs = Math.max(persistedSession.cooldownUntilMs || 0, sharedCooldown);
      const multi = await evaluateMultiPrPollTick(
        {
          ...args,
          ...(persistedSession.cooldownUntilMs
            ? { initialCooldownMs: persistedSession.cooldownUntilMs }
            : {}),
        },
        execFn,
        multiState
      );
      for (const [pr, entry] of Object.entries(multiState)) {
        if (!entry.lastStatus) {
          statusByPr.delete(Number(pr));
          lastSummaryByPr.delete(Number(pr));
        }
      }
      lastStatuses = [...statusByPr.values()];
      emit(multi);
      args.nextPr = multi.nextPr;
      if (multi.statuses && multi.statuses.length > 0) {
        for (const status of multi.statuses) statusByPr.set(status.pr, status);
        lastStatuses = [...statusByPr.values()];
      }
      const entriesToSave = {};
      for (const [k, v] of Object.entries(multiState)) {
        entriesToSave[String(k)] = v;
      }
      const observedCooldownMs = Math.max(persistedSession.cooldownUntilMs || 0,
        ...Object.values(multiState).map((entry) => entry.watchState?.cooldownUntilMs || 0));
      const rateCooldownMs = multi.rateLimited
        ? observedCooldownMs || Date.now() + (multi.nextIntervalSec || 60) * 1000 : null;
      if (multi.error) {
        saveSession({
          cooldownUntilMs: rateCooldownMs,
          entries: entriesToSave,
        });
        console.error(JSON.stringify(multi, null, 2));
        process.exit(1);
      }
      const terminalEvents = multi.events.filter((e) => !NON_TERMINAL_PR_EVENTS.has(e.type));
      if (terminalEvents.length > 0) {
        for (const ev of terminalEvents) {
          if (ev.pr && Number.isSafeInteger(ev.latestCommentId) && entriesToSave[String(ev.pr)]) {
            entriesToSave[String(ev.pr)].hasExplicitSinceCommentId = true;
            entriesToSave[String(ev.pr)].sinceCommentId = Math.max(
              entriesToSave[String(ev.pr)].sinceCommentId || 0,
              ev.latestCommentId
            );
          }
        }
        saveSession({
          cooldownUntilMs: rateCooldownMs,
          entries: entriesToSave,
        });
        console.log(JSON.stringify(multi, null, 2));
        return;
      }
      if (multi.rateLimited) {
        const rateSleepSec = multi.nextIntervalSec || 60;
        const nextCooldownMs = rateCooldownMs;
        persistedSession.cooldownUntilMs = nextCooldownMs;
        saveSession({
          cooldownUntilMs: nextCooldownMs,
          entries: entriesToSave,
        });
        console.log(JSON.stringify(multi, null, 2));
        if (args.maxPolls > 0 && polls >= args.maxPolls) {
          console.log(JSON.stringify({ prs: args.prs, events: [{ type: "MAX_POLLS_REACHED" }] }, null, 2));
          return;
        }
        if (args.maxWaitSec > 0) {
          const elapsedSec = Math.floor((Date.now() - watchStartedAtMs) / 1000);
          if (elapsedSec + rateSleepSec >= args.maxWaitSec) {
            const remainingWaitSec = Math.max(0, (args.chunkDeadlineMs - Date.now()) / 1000);
            if (remainingWaitSec > 0) {
              await sleep(remainingWaitSec);
            }
            emit({ events: [{ type: "WATCH_CHUNK_TIMEOUT" }], statuses: lastStatuses });
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
                  statuses: lastStatuses,
                },
                null,
                2
              )
            );
            return;
          }
        }
        await sleep(rateSleepSec);
        continue;
      }
      persistedSession.cooldownUntilMs = null;
      saveSession({ cooldownUntilMs: null, entries: entriesToSave });
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
        if (multi.chunkTimedOut || elapsedSec + nextSleepSec >= args.maxWaitSec) {
          const remainingWaitSec = Math.max(0, (args.chunkDeadlineMs - Date.now()) / 1000);
          if (remainingWaitSec > 0) {
            await sleep(remainingWaitSec);
          }
          emit({ events: [{ type: "WATCH_CHUNK_TIMEOUT" }], statuses: lastStatuses });
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
                statuses: lastStatuses,
              },
              null,
              2
            )
          );
          return;
        }
      }
      await sleep(nextSleepSec);
    }
  }

  const persistedSession = loadSession();
  const savedPrEntry = persistedSession.entries[String(args.pr)];
  await verifyCachedPrStatuses([savedPrEntry], execFn, args);
  const watchState = savedPrEntry?.watchState || createPrWatchState();
  if (persistedSession.cooldownUntilMs && (!watchState.cooldownUntilMs || watchState.cooldownUntilMs < persistedSession.cooldownUntilMs)) {
    watchState.cooldownUntilMs = persistedSession.cooldownUntilMs;
  }
  let baselinePhase = args.lastPhase || savedPrEntry?.lastPhase || "";
  let lastSummary = "";
  let lastStatus = savedPrEntry?.lastStatus || null;
  let lastStatusScope = savedPrEntry?.lastStatusScope || "";
  let lastEmitMs = 0;
  const explicitSinglePrCommentId = args.prSinceCommentIds?.[args.pr];
  let hasCommentBaseline =
    explicitSinglePrCommentId !== undefined ||
    args.hasExplicitSinceCommentId ||
    Boolean(savedPrEntry?.hasExplicitSinceCommentId);
  let baselineCommentId =
    explicitSinglePrCommentId !== undefined
      ? explicitSinglePrCommentId
      : args.hasExplicitSinceCommentId
        ? args.sinceCommentId
        : (savedPrEntry?.sinceCommentId || 0);
  let polls = 0;
  while (true) {
    polls += 1;
    const cachedEntry = { watchState, lastStatus, lastStatusScope, lastPhase: baselinePhase };
    await verifyCachedPrStatuses([cachedEntry], execFn, args);
    lastStatus = cachedEntry.lastStatus;
    lastStatusScope = cachedEntry.lastStatusScope;
    baselinePhase = cachedEntry.lastPhase;
    refreshSharedCooldown([watchState]);
    const previousScope = watchState.cacheScope;
    const tick = await evaluatePrPollTick(
      {
        ...args,
        lastPhase: baselinePhase,
        lastStatus,
        hasExplicitSinceCommentId: hasCommentBaseline,
        sinceCommentId: baselineCommentId,
      },
      execFn,
      watchState
    );
    if (previousScope !== watchState.cacheScope) {
      lastStatus = null;
      lastStatusScope = "";
      baselinePhase = "";
      lastSummary = "";
    }
    emit(tick);
    if (tick.status) {
      lastStatus = tick.status;
      if (!tick.pollDeferred) lastStatusScope = watchState.cacheScope || "";
    }
    if (tick.rateLimited) {
      saveSession({
        cooldownUntilMs: watchState.cooldownUntilMs,
        entries: {
          [String(args.pr)]: {
            watchState,
            lastPhase: baselinePhase,
            lastStatus,
            lastStatusScope,
            hasExplicitSinceCommentId: hasCommentBaseline,
            sinceCommentId: baselineCommentId,
          },
        },
      });
      console.log(JSON.stringify(tick, null, 2));
      if (args.maxPolls > 0 && polls >= args.maxPolls) {
        console.log(JSON.stringify({ events: [{ type: "MAX_POLLS_REACHED" }] }, null, 2));
        return;
      }
      const rateSleepSec = tick.nextIntervalSec || 60;
      if (args.maxWaitSec > 0) {
        const elapsedSec = Math.floor((Date.now() - watchStartedAtMs) / 1000);
        if (elapsedSec + rateSleepSec >= args.maxWaitSec) {
          const remainingWaitSec = Math.max(0, (args.chunkDeadlineMs - Date.now()) / 1000);
          if (remainingWaitSec > 0) {
            await sleep(remainingWaitSec);
          }
          emit({ events: [{ type: "WATCH_CHUNK_TIMEOUT", headRefOid: args.head }], status: lastStatus });
          console.log(
            JSON.stringify(
              {
                events: [
                  {
                    type: "WATCH_CHUNK_TIMEOUT",
                    headRefOid: lastStatus?.headRefOid || args.head || "",
                    latestCommentId: baselineCommentId,
                    lastPhase: baselinePhase || "",
                    elapsedSec: Math.floor((Date.now() - watchStartedAtMs) / 1000),
                    maxWaitSec: args.maxWaitSec,
                  },
                ],
                ...(lastStatus ? { status: lastStatus } : {}),
              },
              null,
              2
            )
          );
          return;
        }
      }
      await sleep(rateSleepSec);
      continue;
    }
    if (tick.error) {
      console.error(JSON.stringify(tick, null, 2));
      process.exit(1);
    }
    if (tick.status?.phase) {
      baselinePhase = tick.status.phase;
    }
    if (!hasCommentBaseline && Number.isSafeInteger(tick.status?.latestCommentId)) {
      hasCommentBaseline = true;
      baselineCommentId = tick.status.latestCommentId;
    }
    const terminalEvents = tick.events.filter((e) => !NON_TERMINAL_PR_EVENTS.has(e.type));
    if (terminalEvents.length > 0) {
      for (const ev of terminalEvents) {
        if (Number.isSafeInteger(ev.latestCommentId)) {
          hasCommentBaseline = true;
          baselineCommentId = Math.max(baselineCommentId || 0, ev.latestCommentId);
        }
      }
      saveSession({
        cooldownUntilMs: null,
        entries: {
          [String(args.pr)]: {
            watchState,
            lastPhase: baselinePhase,
            lastStatus,
            lastStatusScope,
            hasExplicitSinceCommentId: hasCommentBaseline,
            sinceCommentId: baselineCommentId,
          },
        },
      });
      console.log(JSON.stringify(tick, null, 2));
      return;
    }
    saveSession({
      cooldownUntilMs: null,
      entries: {
        [String(args.pr)]: {
          watchState,
          lastPhase: baselinePhase,
          lastStatus,
          lastStatusScope,
          hasExplicitSinceCommentId: hasCommentBaseline,
          sinceCommentId: baselineCommentId,
        },
      },
    });
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
    if (args.maxPolls > 0 && polls >= args.maxPolls) {
      console.log(JSON.stringify({ events: [{ type: "MAX_POLLS_REACHED" }], status: tick.status }, null, 2));
      return;
    }
    const nextSleepSec = tick.nextIntervalSec || args.intervalSec;
    if (args.maxWaitSec > 0) {
      const elapsedSec = Math.floor((Date.now() - watchStartedAtMs) / 1000);
      if (tick.chunkTimedOut || elapsedSec + nextSleepSec >= args.maxWaitSec) {
        const remainingWaitSec = Math.max(0, (args.chunkDeadlineMs - Date.now()) / 1000);
        if (remainingWaitSec > 0) {
          await sleep(remainingWaitSec);
        }
        emit({ events: [{ type: "WATCH_CHUNK_TIMEOUT", headRefOid: args.head }], status: lastStatus });
        console.log(
          JSON.stringify(
            {
              events: [
                {
                  type: "WATCH_CHUNK_TIMEOUT",
                  headRefOid: lastStatus?.headRefOid || args.head || "",
                  latestCommentId: baselineCommentId,
                  lastPhase: baselinePhase || "",
                  elapsedSec: Math.floor((Date.now() - watchStartedAtMs) / 1000),
                  maxWaitSec: args.maxWaitSec,
                },
              ],
              status: lastStatus,
            },
            null,
            2
          )
        );
        return;
      }
    }
    await sleep(nextSleepSec);
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
