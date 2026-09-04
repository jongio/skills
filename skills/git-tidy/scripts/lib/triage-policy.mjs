import {
  groupWorkItemsWithCoverage,
  validateLastCopyBatch,
} from "./mechanical-core.mjs";
import {
  compare,
  decodeFullRef,
  decodeRawPath,
  DESTRUCTIVE,
} from "./triage-shared.mjs";

function clone(value) {
  return structuredClone(value);
}

function reason(code, subjectId, summary) {
  return { code, source: "git", subjectId, summary };
}

function blocker(code, subjectIds, text) {
  return {
    code,
    subjectIds: [...subjectIds].sort(compare),
    reason: text,
  };
}

function actionFor(carrier) {
  if (carrier.type === "stash") {
    return "drop-stash";
  }
  if (
    carrier.type === "local-branch" ||
    carrier.type === "remote-branch"
  ) {
    return "delete-ref";
  }
  if (carrier.type === "worktree") {
    return "remove-worktree";
  }
  return "no-action";
}

function addBlockerCode(carrier, code) {
  if (!carrier.blockerCodes.includes(code)) {
    carrier.blockerCodes.push(code);
  }
}

function addRuntimeBlockers(carriers, coverage, scope) {
  const checkedOut = new Set(
    carriers
      .filter(
        ({ type, observed }) =>
          type === "worktree" && observed.branchCarrierId,
      )
      .map(({ observed }) => observed.branchCarrierId),
  );
  for (const carrier of carriers) {
    if (carrier.observed?.checkedOutWorktreeIds?.length > 0) {
      checkedOut.add(carrier.id);
    }
  }
  for (const carrier of carriers) {
    if (
      ["stashes", "worktrees"].includes(scope) &&
      ["local-branch", "remote-branch"].includes(carrier.type)
    ) {
      addBlockerCode(carrier, "scope-evidence-only");
      carrier.eligible = false;
    }
    if (
      checkedOut.has(carrier.id) &&
      !carrier.blockerCodes.includes("branch-checked-out")
    ) {
      carrier.blockerCodes.push("branch-checked-out");
    }
    if (carrier.type === "local-branch") {
      if ((coverage?.skippedCounts?.worktrees ?? 0) > 0) {
        addBlockerCode(carrier, "worktree-registration-incomplete");
        carrier.eligible = false;
      }
      try {
        decodeFullRef(carrier.identity.refRawBase64);
      } catch {
        addBlockerCode(carrier, "branch-ref-unrepresentable");
        carrier.eligible = false;
      }
    }
    if (carrier.type !== "worktree") {
      continue;
    }
    try {
      decodeRawPath(carrier.identity.path);
    } catch {
      addBlockerCode(carrier, "worktree-path-unrepresentable");
      carrier.eligible = false;
    }
    carrier.blockerCodes.sort(compare);
  }
}

function completeEvidence(members) {
  return members.every(
    (carrier) =>
      carrier.changeUnitsComplete === true &&
      !carrier.blockerCodes.some((code) =>
        /(?:unavailable|unknown|incomplete|dirty|locked|missing|prunable|metadata)/u
          .test(code)),
  );
}

function durableCarriers(members) {
  return members.filter(
    (carrier) =>
      carrier.durability === "durable" &&
      carrier.changeUnitsComplete === true &&
      carrier.protection !== "unknown",
  );
}

function canonicalCarrier(durable) {
  return [...durable].sort((left, right) => {
    const rank = (entry) => {
      if (entry.protection === "protected") {
        return 0;
      }
      if (entry.type === "local-branch") {
        return 1;
      }
      if (entry.type === "remote-branch") {
        return 2;
      }
      return 3;
    };
    return rank(left) - rank(right) || compare(left.id, right.id);
  })[0] ?? null;
}

function isIntegratedLocalBranch(carrier) {
  const ancestry = carrier.observed?.ancestry;
  return carrier.type === "local-branch"
    && ancestry?.ahead === 0
    && ancestry?.mergedIntoDefault === true
    && ancestry?.reachableFromDefault === true;
}

function hasExactMergedPullRequest(carrier) {
  const tipOid = carrier.observed?.tipOid;
  return (
    carrier.type === "local-branch" ||
    carrier.type === "remote-branch"
  ) && typeof tipOid === "string"
    && carrier.observed?.pullRequests?.some((pullRequest) =>
      pullRequest.exactHeadMatch === true
      && pullRequest.headOid === tipOid
      && (
        pullRequest.state === "MERGED" ||
        pullRequest.mergedAt !== null
      ));
}

function hasOpenPullRequest(carrier) {
  return carrier.observed?.pullRequests?.some(
    ({ state }) => state === "OPEN",
  );
}

function assignSafeActions(members, canonical, allCarriers) {
  for (const carrier of members) {
    if (
      (
        carrier.id === canonical?.id &&
        !isIntegratedLocalBranch(carrier)
      ) ||
      carrier.protection !== "unprotected" ||
      carrier.blockerCodes.length > 0 ||
      carrier.changeUnitsComplete !== true
    ) {
      continue;
    }
    const candidateAction = actionFor(carrier);
    if (
      !DESTRUCTIVE.has(candidateAction) ||
      carrier.type === "remote-branch" ||
      (carrier.type === "worktree" && carrier.observed.main)
    ) {
      continue;
    }
    const validation = validateLastCopyBatch(
      allCarriers.map(clone),
      [carrier.id],
    );
    if (!validation.valid) {
      continue;
    }
    const witnesses = Object.values(
      validation.witnessesByCarrier[carrier.id] ?? {},
    ).flat();
    carrier.action = candidateAction;
    carrier.eligible = true;
    carrier.preservationWitnessIds =
      [...new Set(witnesses)].sort(compare);
  }
}

function assignCheckoutPrerequisites(members, allCarriers) {
  const byId = new Map(allCarriers.map((carrier) => [carrier.id, carrier]));
  for (const branch of members.filter(
    (carrier) =>
      carrier.type === "local-branch" &&
      carrier.blockerCodes.includes("branch-checked-out"),
  )) {
    const worktreeIds = branch.observed?.checkedOutWorktreeIds ?? [];
    const removable = worktreeIds
      .map((id) => byId.get(id))
      .filter((carrier) =>
        carrier?.type === "worktree" &&
        carrier.action === "remove-worktree" &&
        carrier.eligible === true);
    if (
      worktreeIds.length > 0 &&
      removable.length === worktreeIds.length
    ) {
      branch.prerequisiteIds = removable
        .map(({ id }) => id)
        .sort(compare);
    }
  }
}

function itemBlockersFor(members, destructive) {
  const blockers = [];
  const relevant = destructive.length > 0 ? destructive : members;
  for (const carrier of relevant) {
    for (const code of carrier.blockerCodes) {
      blockers.push(
        blocker(code, [carrier.id], `Carrier is blocked by ${code}.`),
      );
    }
  }
  return blockers.sort((left, right) => compare(left.code, right.code));
}

function preferredBranch(members) {
  return members.find((carrier) => carrier.type === "local-branch")
    ?? members.find((carrier) => carrier.type === "remote-branch")
    ?? null;
}

function recommendationFor(members, canonical, destructive, complete) {
  if (destructive.length > 0) {
    return "delete";
  }
  const requiresAcquisition = members.some((carrier) =>
    carrier.blockerCodes.includes("isolated-acquisition-required"));
  if (requiresAcquisition && !members.some(hasExactMergedPullRequest)) {
    return "defer";
  }
  const hasDirty = members.some((carrier) =>
    carrier.blockerCodes.includes("worktree-dirty"));
  if (hasDirty) {
    return "keep-save";
  }
  if (members.some(hasOpenPullRequest)) {
    return "resume";
  }
  if (members.some(hasExactMergedPullRequest)) {
    return "delete";
  }
  if (members.some(({ prerequisiteIds }) => prerequisiteIds.length > 0)) {
    return "defer";
  }
  if (canonical === null) {
    return members.some(({ durability }) => durability === "non-durable")
      ? "keep-save"
      : "defer";
  }
  const branch = preferredBranch(members);
  const ancestry = branch?.observed?.ancestry;
  if (ancestry?.ahead > 0 && ancestry?.behind > 0) {
    return "update-rebase";
  }
  if (ancestry?.ahead > 0 && ancestry?.behind === 0) {
    return "open-pr";
  }
  return complete ? "resume" : "defer";
}

function recommendationReason(recommendation, groupId, destructive) {
  if (destructive.length > 0) {
    return reason(
      "exact-duplicate-preserved",
      groupId,
      "Exact duplicate work has a retained durable witness.",
    );
  }
  const details = {
    delete: [
      "merged-pr-exact-head",
      "The live branch tip exactly matches a merged pull request head.",
    ],
    "update-rebase": [
      "branch-diverged-update",
      "Unique branch work has diverged from the observed default tip.",
    ],
    "open-pr": [
      "branch-ready-for-pr",
      "Unique branch work is ahead of the observed default tip with no open pull request.",
    ],
    resume: [
      "active-work-resume",
      "The work has an active durable carrier to resume.",
    ],
    "keep-save": [
      "unique-work-save",
      "Unique work is not yet represented by a complete durable carrier.",
    ],
    defer: [
      "mechanical-evidence-incomplete",
      "The available mechanical evidence is insufficient for a stronger outcome.",
    ],
  }[recommendation];
  return reason(details[0], groupId, details[1]);
}

function workItem(group, evidence, allCarriers) {
  const unitById = new Map(
    evidence.changeUnits.map((unit) => [unit.id, unit]),
  );
  const members = group.carriers.map(clone);
  const complete = completeEvidence(members);
  const durable = durableCarriers(members);
  const canonical = canonicalCarrier(durable);
  assignSafeActions(members, canonical, allCarriers);
  assignCheckoutPrerequisites(members, members);

  const destructive = members.filter(
    ({ action, eligible }) =>
      eligible && DESTRUCTIVE.has(action),
  );
  const blockers = itemBlockersFor(members, destructive);
  const unitIds = [
    ...new Set(members.flatMap(({ changeUnitIds }) => changeUnitIds)),
  ].sort(compare);
  const durableCopiesByUnit = new Map();
  for (const carrier of durable) {
    for (const unitId of carrier.changeUnitIds) {
      durableCopiesByUnit.set(
        unitId,
        (durableCopiesByUnit.get(unitId) ?? 0) + 1,
      );
    }
  }
  const unwitnessed = unitIds.filter(
    (unitId) => (durableCopiesByUnit.get(unitId) ?? 0) < 2,
  );
  const actionEvidenceComplete = destructive.length > 0
    ? completeEvidence(destructive)
    : complete;
  const evidenceState =
    blockers.length > 0
      ? "blocked"
      : actionEvidenceComplete
        ? "complete"
        : "partial";
  const recommendation = recommendationFor(
    members,
    canonical,
    destructive,
    complete,
  );
  return {
    id: group.id,
    changeUnits: unitIds.map((id) => unitById.get(id)).filter(Boolean),
    overlaps: group.overlaps,
    recommendation,
    authority: "mechanical",
    evidence: evidenceState,
    confidence: evidenceState === "complete" ? "proven" : "unknown",
    reasons: [
      recommendationReason(recommendation, group.id, destructive),
    ],
    blockers,
    preservation: {
      lastCopy: unwitnessed.length > 0,
      durableCarrierIds: durable.map(({ id }) => id).sort(compare),
      unwitnessedChangeUnitIds: unwitnessed,
    },
    review: null,
    carriers: members.sort((left, right) => compare(left.id, right.id)),
  };
}

export function buildWorkItems(evidence) {
  const carriers = evidence.carriers.map(clone);
  addRuntimeBlockers(
    carriers,
    evidence.coverage,
    evidence.request?.scope ?? "all",
  );
  const grouped = groupWorkItemsWithCoverage(
    carriers,
    evidence.relationships,
    {
      maxComparisons: evidence.request?.limits?.maxComparisons ?? 20_000,
    },
  );
  if (grouped.overlapCoverage.truncated) {
    evidence.coverage.state = "partial";
    evidence.coverage.gaps ??= [];
    evidence.coverage.gaps.push({
      code: "work-item-overlap-limit",
      affectedIds: carriers.map(({ id }) => id).sort(compare),
      reason: "Work-item overlap comparisons reached the configured limit.",
    });
  }
  return grouped.workItems.map(
    (group) => workItem(group, evidence, carriers),
  ).sort((left, right) => compare(left.id, right.id));
}
