import {
  addGap,
  compare,
  markLimit,
} from "./evidence-shared.mjs";
import { validateOid } from "./git.mjs";
import { collectGitHubEvidence } from "./github.mjs";
import {
  integrateGitHubBranches,
  matchingPullRequests,
} from "./github-carriers.mjs";

const WORK_BEARING_SCOPES = new Set([
  "all",
  "branches",
  "remote",
  "stashes",
  "worktrees",
]);

function addObservation(carrier, code, pullRequest, description) {
  carrier.observations.push({
    code,
    source: "github",
    subjectId: carrier.id,
    summary: `Pull request #${pullRequest.number} ${description}.`,
  });
}

function attachPullRequestState(carrier, pullRequest) {
  if (pullRequest.state === "OPEN") {
    if (!carrier.blockerCodes.includes("pr-open")) {
      carrier.blockerCodes.push("pr-open");
    }
    addObservation(carrier, "pr-open", pullRequest, "is open");
  }
  if (pullRequest.isDraft) {
    if (!carrier.blockerCodes.includes("pr-draft")) {
      carrier.blockerCodes.push("pr-draft");
    }
    addObservation(carrier, "pr-draft", pullRequest, "is a draft");
  }
  if (pullRequest.state === "CLOSED" && pullRequest.mergedAt === null) {
    addObservation(
      carrier,
      "pr-closed-unmerged",
      pullRequest,
      "was closed without merge",
    );
  }
  if (pullRequest.state === "MERGED" || pullRequest.mergedAt !== null) {
    addObservation(
      carrier,
      "pr-merged-exact-head",
      pullRequest,
      "was merged at this exact head",
    );
  }
  if (pullRequest.hasFailingChecks) {
    addObservation(
      carrier,
      "pr-check-failure",
      pullRequest,
      "has failing checks",
    );
  }
  if (pullRequest.hasPendingChecks) {
    addObservation(
      carrier,
      "pr-check-pending",
      pullRequest,
      "has pending checks",
    );
  }
  if (pullRequest.reviewDecision) {
    const decision = pullRequest.reviewDecision.toLowerCase()
      .replaceAll("_", "-");
    addObservation(
      carrier,
      `pr-review-${decision}`,
      pullRequest,
      `has review decision ${pullRequest.reviewDecision}`,
    );
  }
  addObservation(
    carrier,
    `pr-merge-state-${pullRequest.mergeStateStatus.toLowerCase()}`,
    pullRequest,
    `has merge state ${pullRequest.mergeStateStatus}`,
  );
}

function branchBelongsToRepository(carrier, repositoryId) {
  return carrier.type === "local-branch" ||
    carrier.observed?.repositoryId === repositoryId;
}

function retainGapForIds(context, code, affectedIds) {
  context.gaps = context.gaps.flatMap((gap) => {
    if (gap.code !== code) return [gap];
    return affectedIds.length > 0 ? [{ ...gap, affectedIds }] : [];
  });
}

function retainRemoteGaps(context, branchCarriers, repositoryId) {
  const localRemoteCarriers = branchCarriers.filter(
    (carrier) =>
      carrier.type === "remote-branch" &&
      typeof carrier.identity?.refRawBase64 === "string",
  );
  retainGapForIds(
    context,
    "remote-identity-unavailable",
    localRemoteCarriers
      .filter((carrier) => carrier.observed?.repositoryId !== repositoryId)
      .map(({ id }) => id),
  );
  retainGapForIds(
    context,
    "remote-state-not-refreshed",
    localRemoteCarriers
      .filter(({ blockerCodes }) =>
        blockerCodes.includes("remote-state-not-refreshed"))
      .map(({ id }) => id),
  );
}

function validPullRequests(github, objectFormat, context) {
  return github.records.filter((record) => {
    try {
      validateOid(record.headOid, objectFormat);
      validateOid(record.baseOid, objectFormat);
      return true;
    } catch {
      context.skipped.pullRequests += 1;
      addGap(
        context,
        "github-pr-oid-invalid",
        [record.id],
        "pull request OID does not match the repository object format",
      );
      return false;
    }
  });
}

export async function collectPullRequests(
  repoPath,
  options,
  request,
  branchCarriers,
  boundary,
  primary,
  context,
) {
  const enabled =
    options.githubReader !== undefined || options.githubEnabled !== false;
  if (!enabled || !WORK_BEARING_SCOPES.has(request.scope)) return null;

  const github = await collectGitHubEvidence({
    cwd: repoPath,
    limit: request.limits.maxPullRequests,
    branchLimit: request.limits.maxRefs,
    timeoutMs: request.limits.commandTimeoutMs,
    maxStdoutBytes: request.limits.maxStdoutBytes,
    maxStderrBytes: request.limits.maxStderrBytes,
    signal: context.signal,
    reader: options.githubReader,
  });
  context.counts.pullRequests = github.observed;
  context.skipped.pullRequests = github.skipped;
  context.skipped.remoteBranches += github.branchSkipped;
  for (const gap of github.gaps) {
    if (gap.code === "maxRefs-limit") {
      markLimit(context, "maxRefs", gap.affectedIds);
    } else {
      addGap(context, gap.code, gap.affectedIds, gap.reason);
    }
  }
  if (!github.repository) return null;

  await integrateGitHubBranches({
    github,
    repository: github.repository,
    boundary,
    primary,
    branchCarriers,
    context,
  });
  retainRemoteGaps(context, branchCarriers, github.repository.id);
  context.counts.remoteBranches = branchCarriers.filter(
    ({ type }) => type === "remote-branch",
  ).length;
  const records = validPullRequests(
    github,
    boundary.objectFormat,
    context,
  );
  context.counts.pullRequests = records.length;
  for (const carrier of branchCarriers) {
    if (!branchBelongsToRepository(carrier, github.repository.id)) continue;
    carrier.observed.repositoryId = github.repository.id;
    const matches = matchingPullRequests(
      records,
      github.repository.id,
      carrier,
    );
    carrier.observed.pullRequests = matches;
    for (const match of matches) {
      addObservation(
        carrier,
        "github-pr-exact-head",
        match,
        "exactly matches the observed head",
      );
      attachPullRequestState(carrier, match);
    }
    carrier.blockerCodes.sort(compare);
    carrier.observations.sort(
      (left, right) =>
        compare(left.code, right.code) ||
        compare(left.summary, right.summary),
    );
  }
  return github.repository;
}
