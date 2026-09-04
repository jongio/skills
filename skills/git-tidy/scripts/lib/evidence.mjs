import { stableId } from "./mechanical-core.mjs";
import { carrierState } from "./carrier-state.mjs";
import { collectBranches } from "./evidence-branches.mjs";
import {
  addGap,
  compare,
  createCollectionContext,
  DEFAULT_ANALYSIS_LIMITS,
  emptyTreeOid,
  markLimit,
  normalizeLimits,
  parseLine,
  parseRawDiff,
  parseStashList,
  parseStashParents,
  parseWorktrees,
  rawPath,
} from "./evidence-shared.mjs";
import { collectStashes } from "./evidence-stashes.mjs";
import { collectWorktrees } from "./evidence-worktrees.mjs";
import { collectPullRequests } from "./evidence-github.mjs";
import { collectLegacyInventory } from "./legacy-inventory.mjs";
import {
  createGitBoundary,
  encodeRawPath,
  GitBoundaryError,
} from "./git.mjs";

export {
  DEFAULT_ANALYSIS_LIMITS,
  emptyTreeOid,
  normalizeLimits,
  parseRawDiff,
  parseStashList,
  parseStashParents,
  parseWorktrees,
};

function capChangeUnits(carriers, limits, context) {
  const units = new Map();
  for (const carrier of carriers) {
    const state = carrierState(carrier);
    const reportable = [
      ...state.units,
      ...state.reportUnits,
    ];
    for (const unit of reportable) {
      units.set(unit.id, unit);
    }
  }
  if (units.size > limits.maxChangeUnits) {
    const affectedIds = carriers.map(({ id }) => id);
    markLimit(context, "maxChangeUnits", affectedIds);
    addGap(
      context,
      "change-unit-set-incomplete",
      affectedIds,
      "change unit count exceeded the configured limit",
    );
    for (const carrier of carriers) {
      carrier.changeUnitsComplete = false;
      carrier.evidence = "partial";
      carrier.blockerCodes.push("change-unit-set-incomplete");
    }
  }
  context.counts.changeUnits = Math.min(
    units.size,
    limits.maxChangeUnits,
  );
  context.skipped.changeUnits = Math.max(
    0,
    units.size - limits.maxChangeUnits,
  );
  return [...units.values()]
    .slice(0, limits.maxChangeUnits)
    .sort((left, right) => compare(left.id, right.id));
}

function weakenMetadataEvidence(carriers, request, context) {
  if (request.depth !== "metadata") {
    return;
  }
  addGap(
    context,
    "metadata-depth-no-proof",
    carriers.map(({ id }) => id),
    "metadata depth cannot establish work preservation",
  );
  for (const carrier of carriers) {
    carrier.changeUnitsComplete = false;
    carrier.evidence = "partial";
    if (!carrier.blockerCodes.includes("metadata-depth-no-proof")) {
      carrier.blockerCodes.push("metadata-depth-no-proof");
    }
  }
}

function finalizeCarriers(carriers) {
  for (const carrier of carriers) {
    carrier.blockerCodes.sort(compare);
  }
}

async function collectEvidenceCore(repoPath, options, signal) {
  const limits = normalizeLimits(options.limits);
  const request = Object.freeze({
    scope: options.scope ?? "all",
    depth: options.depth ?? "proof",
    includeIgnored: options.includeIgnored === true,
    limits,
  });
  const context = createCollectionContext(limits, signal);
  const boundary = await createGitBoundary(repoPath, {
    timeoutMs: limits.commandTimeoutMs,
    maxStdoutBytes: limits.maxStdoutBytes,
    maxStderrBytes: limits.maxStderrBytes,
    signal,
  });
  const [capabilities, commonResult, gitDirResult, topResult] = await Promise.all([
    boundary.capabilities({ signal }),
    boundary.run([
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ], { signal }),
    boundary.run([
      "rev-parse",
      "--path-format=absolute",
      "--absolute-git-dir",
    ], { signal }),
    boundary.run([
      "rev-parse",
      "--path-format=absolute",
      "--show-toplevel",
    ], { signal }),
  ]);
  const commonDir = parseLine(commonResult.stdout, "common directory");
  const gitDir = parseLine(gitDirResult.stdout, "git directory");
  const topLevel = parseLine(topResult.stdout, "top level");

  const collectsWorkCarriers = [
    "all",
    "branches",
    "remote",
    "worktrees",
    "stashes",
  ].includes(request.scope);
  const { carriers: branchCarriers, primary } = collectsWorkCarriers
    ? await collectBranches(boundary, request, context)
    : { carriers: [], primary: null };
  const worktrees = collectsWorkCarriers
    ? await collectWorktrees(
      boundary,
      request,
      context,
      branchCarriers,
    )
    : [];
  const stashes = collectsWorkCarriers
    ? await collectStashes(boundary, request, context)
    : [];
  const shownWorktrees = ["all", "worktrees"].includes(request.scope)
    ? worktrees
    : [];
  const githubRepository = collectsWorkCarriers
    ? await collectPullRequests(
      repoPath,
      options,
      request,
      branchCarriers,
      boundary,
      primary,
      context,
    )
    : null;
  const inventory = await collectLegacyInventory(
    boundary,
    request,
    context,
    gitDir,
  );
  const carriers = [
    ...branchCarriers,
    ...shownWorktrees,
    ...stashes,
  ].sort((left, right) => compare(left.id, right.id));
  const changeUnits = capChangeUnits(carriers, limits, context);
  if (collectsWorkCarriers) {
    weakenMetadataEvidence(carriers, request, context);
  }
  const primaryWorktree =
    worktrees.find(({ observed }) => observed.main)?.identity.path ??
    rawPath(topLevel);
  const repository = {
    objectFormat: boundary.objectFormat,
    commonDir: encodeRawPath(commonDir),
    primaryWorktree,
    remotes: githubRepository
      ? [{
        id: stableId("remote", {
          repositoryId: githubRepository.id,
        }),
        host: githubRepository.host,
        repositoryId: githubRepository.id,
        displayUrl: githubRepository.displayUrl,
        transport: "https",
      }]
      : [],
  };
  context.gaps.sort(
    (left, right) =>
      compare(left.code, right.code) ||
      compare(left.reason, right.reason),
  );
  context.limitsReached.sort(compare);
  const relationships = carriers
    .filter(
      ({ type, observed }) =>
        type === "worktree" && observed.branchCarrierId,
    )
    .map((carrier) => ({
      type: "worktree-branch",
      leftId: carrier.id,
      rightId: carrier.observed.branchCarrierId,
      exact: true,
      branchCarrierId: carrier.observed.branchCarrierId,
      headOid: carrier.observed.headOid,
    }));
  finalizeCarriers(carriers);

  return {
    repository,
    request,
    carriers,
    changeUnits,
    relationships,
    inventory,
    coverage: {
      state: context.gaps.length === 0
        ? "complete"
        : carriers.length === 0 &&
            inventory.tags.length === 0 &&
            inventory.artifacts.length === 0 &&
            inventory.blobs.length === 0 &&
            inventory.maintenance === null
          ? "blocked"
          : "partial",
      observedCounts: context.counts,
      skippedCounts: context.skipped,
      gaps: context.gaps,
      limitsReached: context.limitsReached,
      capabilities,
    },
    primaryRefRawBase64: primary?.refRawBase64 ?? null,
  };
}

export async function collectEvidence(repoPath, options = {}) {
  const limits = normalizeLimits(options.limits);
  const controller = new AbortController();
  const externalAbort = () => controller.abort();
  options.signal?.addEventListener("abort", externalAbort, { once: true });
  if (options.signal?.aborted) {
    controller.abort();
  }
  const timer = setTimeout(
    () => controller.abort(),
    limits.collectionTimeoutMs,
  );
  timer.unref?.();
  try {
    return await collectEvidenceCore(
      repoPath,
      options,
      controller.signal,
    );
  } catch (error) {
    if (controller.signal.aborted && !options.signal?.aborted) {
      throw new GitBoundaryError(
        "COLLECTION_TIMEOUT",
        "collection time budget exceeded",
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", externalAbort);
  }
}
