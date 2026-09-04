import path from "node:path";

import { stableId } from "./mechanical-core.mjs";
import { findUntrustedRepositoryRoot } from "./git-process.mjs";
import { createGitHubEnvironment } from "./github-environment.mjs";
import {
  resolveExecutablePath,
  runBoundedProcess,
} from "./git.mjs";

const BRANCH_KEYS = new Set([
  "name",
  "commit",
  "protected",
  "protection",
  "protection_url",
]);
const COMMIT_KEYS = new Set(["sha", "url"]);

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

function onlyKeys(value, allowed) {
  return value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === allowed.size &&
    Object.keys(value).every((key) => allowed.has(key));
}

export function validateNameWithOwner(value) {
  if (
    typeof value !== "string" ||
    value.length > 200 ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(value)
  ) {
    throw new TypeError("GitHub repository nameWithOwner is not canonical");
  }
  const [owner, repository] = value.split("/");
  if (
    owner === "." ||
    owner === ".." ||
    repository === "." ||
    repository === ".."
  ) {
    throw new TypeError("GitHub repository nameWithOwner is not canonical");
  }
  return value;
}

function validateHostname(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 253 ||
    value !== value.toLowerCase() ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/u
      .test(value)
  ) {
    throw new TypeError("GitHub repository host is not canonical");
  }
  return value;
}

function validRefName(value) {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= 1024 &&
    !value.startsWith("/") &&
    !value.endsWith("/") &&
    !value.startsWith(".") &&
    !value.endsWith(".") &&
    !value.endsWith(".lock") &&
    !value.includes("..") &&
    !value.includes("@{") &&
    !value.includes("//") &&
    !/[\u0000-\u0020\u007f~^:?*[\]\\]/u.test(value);
}

function parseBranch(value, repositoryId) {
  if (
    !onlyKeys(value, BRANCH_KEYS) ||
    !validRefName(value.name) ||
    typeof value.protected !== "boolean" ||
    !onlyKeys(value.commit, COMMIT_KEYS) ||
    typeof value.commit.url !== "string" ||
    value.protection === null ||
    typeof value.protection !== "object" ||
    Array.isArray(value.protection) ||
    typeof value.protection_url !== "string" ||
    !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(value.commit.sha)
  ) {
    throw new TypeError("GitHub branch response has an invalid schema");
  }
  return {
    id: stableId("github-branch", {
      repositoryId,
      refName: value.name,
      tipOid: value.commit.sha,
    }),
    repositoryId,
    refName: value.name,
    tipOid: value.commit.sha,
    protected: value.protected,
  };
}

function parsePages(buffer, repositoryId) {
  if (!Buffer.isBuffer(buffer)) {
    throw new TypeError("GitHub branches stdout must be a Buffer");
  }
  let value;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    value = JSON.parse(text);
  } catch {
    throw new TypeError("GitHub branches returned invalid UTF-8 JSON");
  }
  if (
    !Array.isArray(value) ||
    value.some((page) => !Array.isArray(page))
  ) {
    throw new TypeError("GitHub branches response is not nested pages");
  }
  return value.flatMap((page) =>
    page.map((branch) => parseBranch(branch, repositoryId)));
}

export function branchApiArgs(nameWithOwner, host) {
  const canonical = validateNameWithOwner(nameWithOwner);
  const canonicalHost = validateHostname(host);
  return [
    "api",
    `repos/${canonical}/branches?per_page=100`,
    "--hostname",
    canonicalHost,
    "--paginate",
    "--slurp",
  ];
}

function limitGap(reason) {
  return {
    code: "maxRefs-limit",
    affectedIds: [],
    reason,
  };
}

export async function collectGitHubBranches({
  cwd,
  repository,
  limit,
  timeoutMs,
  maxStdoutBytes,
  maxStderrBytes,
  signal,
  reader,
} = {}) {
  if (
    !repository ||
    typeof repository.id !== "string" ||
    repository.id.length === 0
  ) {
    throw new TypeError("canonical GitHub repository identity is required");
  }
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new RangeError("GitHub branch limit must be a nonnegative integer");
  }
  const args = branchApiArgs(
    repository.nameWithOwner,
    repository.host,
  );
  if (limit === 0) {
    return {
      records: [],
      observed: 0,
      skipped: 0,
      gaps: [limitGap("GitHub branch limit is zero.")],
    };
  }

  let ghPath = null;
  let ghEnvironment = null;
  const read = reader ?? ((argv, options) => {
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
    return runBoundedProcess(ghPath, argv, {
      ...options,
      env: ghEnvironment,
      rejectNonZero: true,
    });
  });
  try {
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
      throw new TypeError("GitHub branch reader returned an invalid result");
    }
    const parsed = parsePages(result.stdout, repository.id);
    const records = parsed.slice(0, limit)
      .sort((left, right) => left.id.localeCompare(right.id, "en"));
    const skipped = Math.max(0, parsed.length - limit);
    return {
      records,
      observed: records.length,
      skipped,
      gaps: skipped > 0
        ? [limitGap(
          "GitHub branch records reached the configured limit.",
        )]
        : [],
    };
  } catch (error) {
    if (signal?.aborted) {
      throw error;
    }
    return {
      records: [],
      observed: 0,
      skipped: 0,
      gaps: [{
        code: "github-branches-unavailable",
        affectedIds: [],
        reason: clean(
          error?.code ?? error?.name ?? "GitHub branch read failed",
        ),
      }],
    };
  }
}
