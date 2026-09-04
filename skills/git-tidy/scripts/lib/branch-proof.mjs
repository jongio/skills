import {
  diffUnits,
  markLimit,
  parseLine,
  parseOidOutput,
} from "./evidence-shared.mjs";

function ancestryState(ahead, behind) {
  if (ahead === 0 && behind === 0) {
    return "identical";
  }
  if (ahead === 0) {
    return "behind";
  }
  if (behind === 0) {
    return "ahead";
  }
  return "diverged";
}

function parseCounts(buffer) {
  const line = parseLine(buffer, "branch ahead/behind counts")
    .toString("ascii");
  const match = /^(\d+)\t(\d+)$/u.exec(line);
  if (!match) {
    throw new TypeError("branch ahead/behind counts are malformed");
  }
  const behind = Number(match[1]);
  const ahead = Number(match[2]);
  if (!Number.isSafeInteger(ahead) || !Number.isSafeInteger(behind)) {
    throw new TypeError("branch ahead/behind counts exceed safe bounds");
  }
  return { ahead, behind };
}

function incomplete(code, reason) {
  return {
    ancestry: null,
    complete: false,
    gap: { code, reason },
    units: [],
  };
}

export async function collectBranchProof(
  boundary,
  defaultOid,
  tipOid,
  context,
) {
  if (!defaultOid) {
    return incomplete(
      "branch-merge-base-unavailable",
      "default branch tip is unavailable",
    );
  }
  if (context.comparisons >= context.limits.maxComparisons) {
    markLimit(context, "maxComparisons");
    return incomplete(
      "branch-proof-limit",
      "branch proof comparison limit was reached",
    );
  }
  context.comparisons += 1;

  let mergeBaseOid;
  try {
    const mergeBase = await boundary.run([
      "merge-base",
      defaultOid,
      tipOid,
    ], {
      rejectNonZero: false,
      signal: context.signal,
    });
    if (mergeBase.exitCode !== 0) {
      return incomplete(
        "branch-merge-base-unavailable",
        "branch has no available merge base with the default tip",
      );
    }
    mergeBaseOid = parseOidOutput(
      mergeBase.stdout,
      boundary.objectFormat,
      "branch merge base",
    );
  } catch (error) {
    return incomplete(
      "branch-merge-base-unavailable",
      error.code ?? "branch merge base is unavailable",
    );
  }

  let counts;
  try {
    const result = await boundary.run([
      "rev-list",
      "--left-right",
      "--count",
      `${defaultOid}...${tipOid}`,
    ], {
      rejectNonZero: false,
      signal: context.signal,
    });
    if (result.exitCode !== 0) {
      return incomplete(
        "branch-ancestry-unavailable",
        "branch ahead/behind counts are unavailable",
      );
    }
    counts = parseCounts(result.stdout);
  } catch (error) {
    return incomplete(
      "branch-ancestry-unavailable",
      error.code ?? "branch ahead/behind counts are unavailable",
    );
  }

  const ancestry = {
    mergeBaseOid,
    ahead: counts.ahead,
    behind: counts.behind,
    state: ancestryState(counts.ahead, counts.behind),
    mergedIntoDefault: counts.ahead === 0,
    reachableFromDefault: counts.ahead === 0,
  };
  if (counts.ahead === 0) {
    return {
      ancestry,
      complete: true,
      gap: null,
      units: [],
    };
  }

  const units = await diffUnits(
    boundary,
    mergeBaseOid,
    tipOid,
    "tracked",
    context,
    false,
  );
  if (units === null) {
    return {
      ancestry,
      complete: false,
      gap: {
        code: "branch-change-units-unavailable",
        reason: "merge-base branch change units are unavailable",
      },
      units: [],
    };
  }
  return {
    ancestry,
    complete: true,
    gap: null,
    units,
  };
}

export function branchAncestryObservations(carrier, ancestry) {
  if (!ancestry) {
    return [];
  }
  const observations = [];
  if (ancestry.ahead === 0) {
    observations.push({
      code: "branch-no-unique-work",
      source: "git",
      subjectId: carrier.id,
      summary: "Branch tip is reachable from the observed default tip.",
    });
  }
  observations.push({
    code: `branch-${ancestry.state}`,
    source: "git",
    subjectId: carrier.id,
    summary:
      `Branch is ${ancestry.ahead} ahead and ${ancestry.behind} behind the default tip.`,
  });
  return observations;
}
