import { createHash } from "node:crypto";

import { collectBranchProof } from "./branch-proof.mjs";
import {
  addGap,
  carrierBase,
  compare,
  markLimit,
  parseWorktrees,
  rawPath,
} from "./evidence-shared.mjs";
import {
  inspectWorktree,
  statusChangeUnits,
} from "./worktree-changes.mjs";
import { carrierState } from "./carrier-state.mjs";

export {
  inspectWorktree,
  parseTrackedRecord,
  statusRecords,
} from "./worktree-changes.mjs";

export function matchingBranch(entry, branchCarriers) {
  if (!entry.branchRaw) {
    return null;
  }
  const branchBase64 = entry.branchRaw.toString("base64");
  return branchCarriers.find(
    (candidate) =>
      candidate.type === "local-branch" &&
      candidate.identity.refRawBase64 === branchBase64,
  ) ?? null;
}

function defaultBranchOid(branchCarriers) {
  const carrier = branchCarriers.find(({ identity, observed }) =>
    typeof identity?.tipOid === "string" &&
    observed?.ancestry?.state === "identical" &&
    observed.ancestry.mergeBaseOid === identity.tipOid);
  return carrier?.identity.tipOid ?? null;
}

function incompleteCommittedProof(reason) {
  return {
    ancestry: null,
    complete: false,
    gap: {
      code: "worktree-committed-proof-incomplete",
      reason,
    },
    units: [],
  };
}

async function committedWorktreeProof(
  entry,
  inspection,
  branch,
  defaultOid,
  request,
  context,
) {
  if (branch) {
    return {
      ancestry: branch.observed.ancestry,
      complete: branch.changeUnitsComplete,
      gap: branch.changeUnitsComplete
        ? null
        : {
          code: "worktree-committed-proof-incomplete",
          reason: "checked-out branch proof is incomplete",
        },
      units: carrierState(branch).units,
    };
  }
  if (!entry.detached) {
    return incompleteCommittedProof(
      "worktree branch registration has no collected branch carrier",
    );
  }
  if (request.depth === "metadata") {
    return incompleteCommittedProof(
      "metadata depth does not prove detached worktree commits",
    );
  }
  if (!inspection.boundary || !entry.headOid) {
    return incompleteCommittedProof(
      "detached worktree boundary or HEAD is unavailable",
    );
  }

  const proof = await collectBranchProof(
    inspection.boundary,
    defaultOid,
    entry.headOid,
    context,
  );
  if (proof.complete) {
    return proof;
  }
  return {
    ...proof,
    gap: {
      code: "worktree-committed-proof-incomplete",
      reason: proof.gap?.reason ?? "detached worktree proof is incomplete",
    },
  };
}

export async function collectWorktrees(
  boundary,
  request,
  context,
  branchCarriers,
) {
  if (!["all", "branches", "worktrees", "stashes"].includes(request.scope)) {
    return [];
  }

  const listed = await boundary.run([
    "worktree",
    "list",
    "--porcelain",
    "-z",
  ], { signal: context.signal });
  const allEntries = parseWorktrees(listed.stdout, boundary.objectFormat);
  let entries = allEntries;
  if (entries.length > request.limits.maxWorktrees) {
    entries = entries.slice(0, request.limits.maxWorktrees);
    markLimit(context, "maxWorktrees");
  }
  context.counts.worktrees = entries.length;
  context.skipped.worktrees = allEntries.length - entries.length;

  const carriers = [];
  const defaultOid = defaultBranchOid(branchCarriers);
  const untrackedBudget = { attempts: 0, bytes: 0 };
  for (const [index, entry] of entries.entries()) {
    const inspection = await inspectWorktree(entry, request, context);
    const status = await statusChangeUnits(
      entry,
      inspection,
      request,
      context,
      untrackedBudget,
    );
    const branch = matchingBranch(entry, branchCarriers);
    const committed = await committedWorktreeProof(
      entry,
      inspection,
      branch,
      defaultOid,
      request,
      context,
    );
    const combined = [...committed.units, ...status.units];
    const branchRef = entry.branchRaw ?? null;
    const fingerprint = createHash("sha256")
      .update(inspection.rawStatus)
      .digest("hex");
    const identity = {
      path: rawPath(entry.pathRaw),
      gitDir: rawPath(inspection.gitDir),
      headOid: entry.headOid ?? null,
      branchRawBase64: branchRef?.toString("base64") ?? null,
      statusFingerprint: fingerprint,
    };
    const dirty = status.records.length > 0;
    const blockers = [
      ...(dirty ? ["worktree-dirty"] : []),
      ...(status.counts.conflict > 0 ? ["worktree-conflict"] : []),
      ...(status.counts.submodule > 0
        ? ["worktree-submodule-dirty"]
        : []),
      ...(status.counts.intentToAdd > 0
        ? ["worktree-intent-to-add"]
        : []),
      ...(inspection.ignored.count > 0 && index !== 0
        ? ["ignored-content-present"]
        : []),
      ...(inspection.ignored.count === null
        ? ["ignored-state-unknown"]
        : []),
      ...(index === 0 ? ["worktree-main"] : []),
      ...(entry.locked ? ["worktree-locked"] : []),
      ...(entry.prunable ? ["worktree-prunable"] : []),
      ...(inspection.missing ? ["worktree-missing"] : []),
      ...(inspection.unknown ? ["worktree-status-unknown"] : []),
      ...(!committed.complete
        ? ["worktree-committed-proof-incomplete"]
        : []),
    ];
    const carrier = carrierBase(
      "worktree",
      identity,
      identity.path.display,
      combined,
      {
        complete:
          committed.complete &&
          status.complete &&
          !dirty &&
          inspection.ignored.count !== null,
        durability: "non-durable",
        protection: index === 0
          ? "protected"
          : branch?.protection ?? "unknown",
        protectionEvidence: index === 0
          ? "complete"
          : branch?.protectionEvidence ?? "partial",
        identityCurrent: !inspection.unknown && !inspection.missing,
        survives: !inspection.missing,
        blockers,
        observed: {
          headOid: entry.headOid ?? null,
          branchCarrierId: branch?.id ?? null,
          committedAncestry: committed.ancestry,
          ignoredPathCount: inspection.ignored.count,
          sparse: inspection.sparse.observed,
          statusCounts: status.counts,
          statusFingerprint: fingerprint,
          main: index === 0,
        },
      },
    );
    for (const gap of inspection.sparse.gaps) {
      addGap(context, gap.code, [carrier.id], gap.reason);
    }
    if (inspection.ignored.count === null) {
      addGap(
        context,
        "ignored-state-unknown",
        [carrier.id],
        inspection.ignored.reason,
      );
    }
    if (committed.gap) {
      addGap(
        context,
        committed.gap.code,
        [carrier.id],
        committed.gap.reason,
      );
    }
    if (branch) {
      branch.observed.checkedOutWorktreeIds = [
        ...(branch.observed.checkedOutWorktreeIds ?? []),
        carrier.id,
      ].sort(compare);
    }
    carriers.push(carrier);
  }

  if (request.includeIgnored) {
    addGap(
      context,
      "ignored-content-not-read",
      carriers.map(({ id }) => id),
      "ignored content requires a separate approval and was not read",
    );
  }
  return carriers;
}
