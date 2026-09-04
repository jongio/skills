import path from "node:path";

import { stableId } from "./mechanical-core.mjs";
import { findUntrustedRepositoryRoot } from "./git-process.mjs";
import { createGitHubEnvironment } from "./github-environment.mjs";
import {
  resolveExecutablePath,
  runBoundedProcess,
} from "./git.mjs";
import {
  collectGitHubBranches,
  validateNameWithOwner,
} from "./github-branches.mjs";

const MAX_GH_LIMIT = 10_000;
const MAX_CHECKS_PER_PULL_REQUEST = 100;
const REPO_ARGS = Object.freeze([
  "repo",
  "view",
  "--json",
  "id,nameWithOwner,url",
]);
export const PR_FIELDS = Object.freeze([
  "number",
  "state",
  "isDraft",
  "mergedAt",
  "headRefOid",
  "headRefName",
  "headRepository",
  "baseRefOid",
  "baseRefName",
  "url",
  "mergeStateStatus",
  "reviewDecision",
  "statusCheckRollup",
]).join(",");

const CHECK_RUN_KEYS = Object.freeze([
  "__typename",
  "completedAt",
  "conclusion",
  "detailsUrl",
  "name",
  "startedAt",
  "status",
  "workflowName",
]);
const CHECK_STATUSES = new Set([
  "COMPLETED",
  "EXPECTED",
  "IN_PROGRESS",
  "PENDING",
  "QUEUED",
  "REQUESTED",
  "WAITING",
]);
const CHECK_CONCLUSIONS = new Set([
  "ACTION_REQUIRED",
  "CANCELLED",
  "FAILURE",
  "NEUTRAL",
  "SKIPPED",
  "STALE",
  "STARTUP_FAILURE",
  "SUCCESS",
  "TIMED_OUT",
]);
const FAILURE_CONCLUSIONS = new Set([
  "ACTION_REQUIRED",
  "CANCELLED",
  "FAILURE",
  "STALE",
  "STARTUP_FAILURE",
  "TIMED_OUT",
]);
const MERGE_STATES = new Set([
  "BEHIND",
  "BLOCKED",
  "CLEAN",
  "DIRTY",
  "DRAFT",
  "HAS_HOOKS",
  "UNKNOWN",
  "UNSTABLE",
]);
const REVIEW_DECISIONS = new Set([
  "APPROVED",
  "CHANGES_REQUESTED",
  "REVIEW_REQUIRED",
]);

function clean(value, maxLength = 300) {
  return String(value)
    .replace(
      /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu,
      "\uFFFD",
    )
    .replace(/\s+/gu, " ")
    .slice(0, maxLength)
    .trim();
}

function exactKeys(value, keys) {
  return value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

export { createGitHubEnvironment } from "./github-environment.mjs";

function parseJson(buffer, label) {
  if (!Buffer.isBuffer(buffer)) {
    throw new TypeError(`${label} stdout must be a Buffer`);
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    return JSON.parse(text);
  } catch {
    throw new TypeError(`${label} returned invalid UTF-8 JSON`);
  }
}

function safeHttpsUrl(value, label, nullable = false) {
  if (nullable && (value === null || value === "")) {
    return null;
  }
  if (typeof value !== "string") {
    throw new TypeError(`${label} is not a URL`);
  }
  const parsed = new URL(value);
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password
  ) {
    throw new TypeError(`${label} is not a safe HTTPS URL`);
  }
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/u, "");
}

function optionalTimestamp(value, label) {
  if (value === null || value === "") {
    return null;
  }
  if (
    typeof value !== "string" ||
    value.length > 64 ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new TypeError(`${label} is not a valid timestamp`);
  }
  return value;
}

function parseRepository(value) {
  if (
    !exactKeys(value, ["id", "nameWithOwner", "url"]) ||
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    value.id.length > 200 ||
    typeof value.nameWithOwner !== "string" ||
    value.nameWithOwner.length === 0
  ) {
    throw new TypeError("GitHub repository response has an invalid schema");
  }
  const displayUrl = safeHttpsUrl(
    value.url,
    "GitHub repository URL",
  );
  const nameWithOwner = validateNameWithOwner(value.nameWithOwner);
  return {
    id: value.id,
    nameWithOwner,
    host: new URL(displayUrl).hostname.toLowerCase(),
    displayUrl,
  };
}

function parseHeadRepository(value) {
  if (value === null) {
    return {
      id: null,
      name: null,
      nameWithOwner: null,
    };
  }
  if (
    !exactKeys(value, ["id", "name", "nameWithOwner"]) ||
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    value.id.length > 200 ||
    typeof value.name !== "string" ||
    typeof value.nameWithOwner !== "string"
  ) {
    throw new TypeError("GitHub head repository has an invalid schema");
  }
  return {
    id: value.id,
    name: clean(value.name),
    nameWithOwner: clean(value.nameWithOwner),
  };
}

function parseCheckRun(value) {
  if (
    !exactKeys(value, CHECK_RUN_KEYS) ||
    value.__typename !== "CheckRun" ||
    typeof value.name !== "string" ||
    value.name.length === 0 ||
    !CHECK_STATUSES.has(value.status) ||
    !(
      value.conclusion === null ||
      value.conclusion === "" ||
      CHECK_CONCLUSIONS.has(value.conclusion)
    ) ||
    !(
      value.workflowName === null ||
      typeof value.workflowName === "string"
    )
  ) {
    throw new TypeError("GitHub check run has an invalid schema");
  }
  return {
    type: "check-run",
    name: clean(value.name),
    workflowName: value.workflowName
      ? clean(value.workflowName)
      : null,
    status: value.status,
    conclusion: value.conclusion || null,
    startedAt: optionalTimestamp(value.startedAt, "check startedAt"),
    completedAt: optionalTimestamp(value.completedAt, "check completedAt"),
    detailsUrl: safeHttpsUrl(
      value.detailsUrl,
      "check details URL",
      true,
    ),
  };
}

function parseChecks(value) {
  if (value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new TypeError("GitHub statusCheckRollup is not an array");
  }
  if (value.length > MAX_CHECKS_PER_PULL_REQUEST) {
    throw new TypeError("GitHub statusCheckRollup exceeds the safe limit");
  }
  return value.map(parseCheckRun);
}

function parsePullRequest(value) {
  const expectedKeys = PR_FIELDS.split(",");
  if (
    !exactKeys(value, expectedKeys) ||
    !Number.isSafeInteger(value.number) ||
    value.number < 1 ||
    !["OPEN", "CLOSED", "MERGED"].includes(value.state) ||
    typeof value.isDraft !== "boolean" ||
    typeof value.headRefOid !== "string" ||
    typeof value.headRefName !== "string" ||
    typeof value.baseRefOid !== "string" ||
    typeof value.baseRefName !== "string" ||
    !MERGE_STATES.has(value.mergeStateStatus) ||
    !(
      value.reviewDecision === null ||
      value.reviewDecision === "" ||
      REVIEW_DECISIONS.has(value.reviewDecision)
    )
  ) {
    throw new TypeError("GitHub pull request response has an invalid schema");
  }

  const headRepository = parseHeadRepository(value.headRepository);
  const checks = parseChecks(value.statusCheckRollup);
  return {
    id: stableId("github-pr", {
      repositoryId: headRepository.id,
      number: value.number,
      headOid: value.headRefOid,
    }),
    number: value.number,
    exactHeadMatch: false,
    state: value.state,
    isDraft: value.isDraft,
    mergedAt: optionalTimestamp(value.mergedAt, "pull request mergedAt"),
    url: safeHttpsUrl(value.url, "pull request URL"),
    headRepositoryId: headRepository.id,
    headRepositoryName: headRepository.name,
    headRepositoryNameWithOwner: headRepository.nameWithOwner,
    headRefName: clean(value.headRefName),
    headOid: value.headRefOid,
    baseRefName: clean(value.baseRefName),
    baseOid: value.baseRefOid,
    mergeStateStatus: value.mergeStateStatus,
    reviewDecision: value.reviewDecision || null,
    checks,
    hasFailingChecks: checks.some(
      ({ conclusion }) => FAILURE_CONCLUSIONS.has(conclusion),
    ),
    hasPendingChecks: checks.some(
      ({ status, conclusion }) =>
        status !== "COMPLETED" || conclusion === null,
    ),
  };
}

function pullRequestArgs(requestLimit) {
  return [
    "pr",
    "list",
    "--state",
    "all",
    "--limit",
    String(requestLimit),
    "--json",
    PR_FIELDS,
  ];
}

function allowedArgs(args, requestLimit) {
  const prArgs = pullRequestArgs(requestLimit);
  return (
    args.length === REPO_ARGS.length &&
    args.every((arg, index) => arg === REPO_ARGS[index])
  ) || (
    args.length === prArgs.length &&
    args.every((arg, index) => arg === prArgs[index])
  );
}

function limitGap(reason) {
  return {
    code: "maxPullRequests-limit",
    affectedIds: [],
    reason,
  };
}

function githubFailure(error) {
  if (error instanceof TypeError) {
    return {
      code: "github-response-invalid",
      reason: clean(error.message || "GitHub returned an invalid response"),
    };
  }
  return {
    code: "github-evidence-unavailable",
    reason: clean(
      error?.code ?? error?.name ?? "GitHub read failed",
    ),
  };
}

export async function collectGitHubEvidence({
  cwd,
  limit,
  branchLimit = limit,
  timeoutMs,
  maxStdoutBytes,
  maxStderrBytes,
  signal,
  reader,
} = {}) {
  if (
    !Number.isSafeInteger(limit) ||
    limit < 0 ||
    limit >= MAX_GH_LIMIT
  ) {
    throw new RangeError(
      "GitHub record limit must be an integer from 0 through 9999",
    );
  }
  if (!Number.isSafeInteger(branchLimit) || branchLimit < 0) {
    throw new RangeError(
      "GitHub branch limit must be a nonnegative integer",
    );
  }

  const requestLimit = Math.min(limit + 1, MAX_GH_LIMIT);
  let ghPath = null;
  let ghEnvironment = null;
  const read = reader ?? ((args, options) => {
    if (ghPath === null) {
      const untrustedRoots = [
        findUntrustedRepositoryRoot(path.resolve(cwd ?? process.cwd())),
      ];
      ghPath = resolveExecutablePath("gh", { untrustedRoots });
      ghEnvironment = createGitHubEnvironment(
        ghPath,
        resolveExecutablePath("git", { untrustedRoots }),
      );
    }
    return runBoundedProcess(ghPath, args, {
      ...options,
      env: ghEnvironment,
      rejectNonZero: true,
    });
  });
  const invoke = async (args) => {
    if (!allowedArgs(args, requestLimit)) {
      throw new TypeError("GitHub argv is not allowlisted");
    }
    const result = await read([...args], {
      cwd,
      timeoutMs,
      maxStdoutBytes,
      maxStderrBytes,
      signal,
    });
    if (
      !result ||
      result.exitCode !== 0 ||
      !Buffer.isBuffer(result.stdout)
    ) {
      throw new TypeError("GitHub reader returned an invalid process result");
    }
    return result.stdout;
  };

  try {
    const repository = parseRepository(parseJson(
      await invoke([...REPO_ARGS]),
      "gh repo view",
    ));
    const branches = await collectGitHubBranches({
      cwd,
      repository,
      limit: branchLimit,
      timeoutMs,
      maxStdoutBytes,
      maxStderrBytes,
      signal,
      reader: read,
    });
    if (limit === 0) {
      return {
        repository,
        branches: branches.records,
        branchObserved: branches.observed,
        branchSkipped: branches.skipped,
        records: [],
        observed: 0,
        skipped: 0,
        gaps: [
          ...branches.gaps,
          limitGap("GitHub pull request limit is zero."),
        ],
      };
    }

    const values = parseJson(
      await invoke(pullRequestArgs(requestLimit)),
      "gh pr list",
    );
    if (!Array.isArray(values)) {
      throw new TypeError(
        "GitHub pull request response is not an array",
      );
    }
    if (values.length > requestLimit) {
      throw new TypeError(
        "GitHub pull request response exceeded the requested limit",
      );
    }

    const parsed = values.slice(0, limit).map(parsePullRequest)
      .sort((left, right) => left.id.localeCompare(right.id, "en"));
    const skipped = Math.max(0, values.length - limit);
    return {
      repository,
      branches: branches.records,
      branchObserved: branches.observed,
      branchSkipped: branches.skipped,
      records: parsed,
      observed: parsed.length,
      skipped,
      gaps: [
        ...branches.gaps,
        ...(skipped > 0
          ? [limitGap(
            "GitHub pull request records reached the configured limit.",
          )]
          : []),
      ],
    };
  } catch (error) {
    if (signal?.aborted) {
      throw error;
    }
    const failure = githubFailure(error);
    return {
      repository: null,
      branches: [],
      branchObserved: 0,
      branchSkipped: 0,
      records: [],
      observed: 0,
      skipped: 0,
      gaps: [{
        code: failure.code,
        affectedIds: [],
        reason: failure.reason,
      }],
    };
  }
}
