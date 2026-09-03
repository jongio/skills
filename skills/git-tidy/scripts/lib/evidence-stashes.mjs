import {
  addGap,
  carrierBase,
  diffUnits,
  emptyTreeOid,
  markLimit,
  parseOidOutput,
  parseStashList,
  parseStashParents,
} from "./evidence-shared.mjs";
import { updateCarrierState } from "./carrier-state.mjs";

async function stashChangeUnits(boundary, entry, context) {
  const commit = await boundary.run(
    ["cat-file", "-p", entry.oid],
    { signal: context.signal },
  );
  const [baseOid, indexOid, untrackedOid = null] = parseStashParents(
    commit.stdout,
    boundary.objectFormat,
  );
  const tree = await boundary.run(
    ["rev-parse", `${entry.oid}^{tree}`],
    { signal: context.signal },
  );
  const treeOid = parseOidOutput(
    tree.stdout,
    boundary.objectFormat,
    "stash tree",
  );
  const staged = await diffUnits(
    boundary,
    baseOid,
    indexOid,
    "staged",
    context,
  );
  const unstaged = await diffUnits(
    boundary,
    indexOid,
    treeOid,
    "unstaged",
    context,
  );
  const trackedFinal = await diffUnits(
    boundary,
    baseOid,
    treeOid,
    "trackedFinal",
    context,
  );
  let untracked = [];
  if (untrackedOid !== null) {
    const result = await boundary.run(
      ["rev-parse", `${untrackedOid}^{tree}`],
      { signal: context.signal },
    );
    const treeOid = parseOidOutput(
      result.stdout,
      boundary.objectFormat,
      "stash untracked tree",
    );
    untracked = await diffUnits(
      boundary,
      emptyTreeOid(boundary.objectFormat),
      treeOid,
      "untracked",
      context,
    );
  }
  return {
    baseOid,
    complete:
      staged !== null &&
      unstaged !== null &&
      trackedFinal !== null &&
      untracked !== null,
    indexOid,
    componentChangeUnitIds: {
      staged: (staged ?? []).map(({ id }) => id),
      unstaged: (unstaged ?? []).map(({ id }) => id),
      trackedFinal: (trackedFinal ?? []).map(({ id }) => id),
      untracked: (untracked ?? []).map(({ id }) => id),
    },
    trackedFinal: trackedFinal ?? [],
    units: [
      ...(staged ?? []),
      ...(unstaged ?? []),
      ...(untracked ?? []),
    ],
    treeOid,
    untrackedOid,
  };
}

export async function collectStashes(boundary, request, context) {
  if (!["all", "stashes"].includes(request.scope)) {
    return [];
  }

  const result = await boundary.run([
    "reflog",
    "show",
    "--format=%gD%x00%H",
    "-z",
    "refs/stash",
  ], {
    rejectNonZero: false,
    signal: context.signal,
  });
  if (result.exitCode !== 0 && result.stdout.length === 0) {
    return [];
  }

  const allEntries = parseStashList(
    result.stdout,
    boundary.objectFormat,
  );
  let entries = allEntries;
  if (entries.length > request.limits.maxStashes) {
    entries = entries.slice(0, request.limits.maxStashes);
    markLimit(context, "maxStashes");
  }
  context.counts.stashes = entries.length;
  context.skipped.stashes = allEntries.length - entries.length;

  const carriers = [];
  for (const entry of entries) {
    let proof = {
      baseOid: null,
      complete: false,
      componentChangeUnitIds: {
        staged: [],
        unstaged: [],
        trackedFinal: [],
        untracked: [],
      },
      indexOid: null,
      trackedFinal: [],
      treeOid: null,
      units: [],
      untrackedOid: null,
    };
    let topologyError = null;
    try {
      proof = await stashChangeUnits(boundary, entry, context);
    } catch (error) {
      topologyError = error.code ?? "stash topology unavailable";
    }

    const identity = {
      stashOid: entry.oid,
      baseOid: proof.baseOid,
      indexOid: proof.indexOid,
      treeOid: proof.treeOid,
      untrackedOid: proof.untrackedOid,
      observedSelector: entry.selector,
    };
    const carrier = carrierBase(
      "stash",
      identity,
      entry.selector,
      proof.units,
      {
        complete: proof.complete,
        durability: "durable",
        protection: "unprotected",
        protectionEvidence: "complete",
        identityCurrent: true,
        survives: true,
        blockers: proof.complete ? [] : ["stash-proof-incomplete"],
        observed: {
          commitOid: entry.oid,
          componentChangeUnitIds: proof.componentChangeUnitIds,
          selector: entry.selector,
        },
      },
    );
    updateCarrierState(carrier, { reportUnits: proof.trackedFinal });
    carriers.push(carrier);
    if (!proof.complete) {
      addGap(
        context,
        "stash-topology-incomplete",
        [carrier.id],
        topologyError ?? "stash change-unit proof is incomplete",
      );
    }
  }
  return carriers;
}
