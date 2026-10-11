import { stableId } from "./mechanical-core.mjs";
import {
  branchAncestryObservations,
  collectBranchProof,
} from "./branch-proof.mjs";
import {
  parseBranchRefs,
  parseFixedNulRecords,
} from "./git.mjs";
import {
  addGap,
  carrierBase,
  markLimit,
  parseLine,
} from "./evidence-shared.mjs";

const BRANCH_FORMAT =
  "%(refname)%00%(objectname)%00%(objecttype)%00%(upstream)%00";

function isLocal(entry) {
  return entry.refRaw.toString("ascii").startsWith("refs/heads/");
}

function isRemote(entry) {
  const ref = entry.refRaw.toString("ascii");
  return ref.startsWith("refs/remotes/") && !ref.endsWith("/HEAD");
}

function withoutOriginHead(buffer) {
  const originHead = Buffer.from("refs/remotes/origin/HEAD");
  const records = parseFixedNulRecords(buffer, 4)
    .filter(([ref]) => !ref.equals(originHead));
  return Buffer.concat(records.flatMap((fields) => [
    ...fields.flatMap((field) => [field, Buffer.from([0])]),
    Buffer.from("\n"),
  ]));
}

function protectedByPolicy(refBytes) {
  const ref = refBytes.toString("utf8");
  return /^refs\/heads\/(?:release\/|hotfix\/)/u.test(ref) ||
    /^refs\/heads\/(?:production|staging|develop)$/u.test(ref);
}

async function resolveDefaultBranch(
  boundary,
  allRefs,
  context,
  remoteBaseline,
) {
  try {
    if (remoteBaseline?.state === "verified") {
      const branchName = remoteBaseline.defaultRef.slice(
        "refs/heads/".length,
      );
      const rawTarget = Buffer.from(
        `refs/remotes/origin/${branchName}`,
        "utf8",
      );
      const remote = allRefs.find((entry) =>
        entry.refRaw.equals(rawTarget) &&
        entry.oid === remoteBaseline.defaultOid);
      if (!remote) {
        throw new TypeError(
          "verified default branch does not match local remote-tracking state",
        );
      }
      return {
        localRef: Buffer.from(`refs/heads/${branchName}`, "utf8"),
        primary: remote,
        reason: null,
        resolved: true,
        verified: true,
      };
    }
    const result = await boundary.run([
      "symbolic-ref",
      "--quiet",
      "refs/remotes/origin/HEAD",
    ], {
      rejectNonZero: false,
      signal: context.signal,
    });
    if (result.exitCode !== 0) {
      throw new TypeError("origin HEAD is unavailable");
    }
    const rawTarget = parseLine(
      result.stdout,
      "origin HEAD symbolic ref",
    );
    const target = new TextDecoder("utf-8", { fatal: true })
      .decode(rawTarget);
    const prefix = "refs/remotes/origin/";
    if (
      !target.startsWith(prefix) ||
      target.length === prefix.length ||
      target === "refs/remotes/origin/HEAD" ||
      /[\u0000-\u001f\u007f]/u.test(target)
    ) {
      throw new TypeError("origin HEAD target is malformed");
    }

    const branchName = target.slice(prefix.length);
    const localRef = Buffer.from(`refs/heads/${branchName}`);
    const remote = allRefs.find((entry) =>
      entry.refRaw.equals(rawTarget));
    if (!remote) {
      throw new TypeError("origin HEAD target object is unavailable");
    }
    return {
      localRef,
      primary: remote,
      reason: null,
      resolved: true,
      verified: false,
    };
  } catch (error) {
    return {
      localRef: null,
      primary: null,
      reason:
        error.code ??
        error.message ??
        "default branch identity unavailable",
      resolved: false,
      verified: false,
    };
  }
}

export async function collectBranches(
  boundary,
  request,
  context,
  remoteBaseline = null,
) {
  const result = await boundary.run([
    "for-each-ref",
    "--sort=refname",
    `--format=${BRANCH_FORMAT}`,
    "refs/heads/",
    "refs/remotes/",
  ], { signal: context.signal });

  const allRefs = parseBranchRefs(
    withoutOriginHead(result.stdout),
    boundary.objectFormat,
  );
  let refs = allRefs;
  if (refs.length > request.limits.maxRefs) {
    refs = refs.slice(0, request.limits.maxRefs);
    markLimit(context, "maxRefs");
  }

  const local = refs.filter(isLocal);
  const remote = refs.filter(isRemote);
  const verifiedHeads = remoteBaseline?.state === "verified"
    ? new Map(remoteBaseline.heads.map(({ ref, oid }) => [
      `refs/remotes/origin/${ref.slice("refs/heads/".length)}`,
      oid,
    ]))
    : null;
  const observedOrigin = new Map(
    remote
      .filter(({ refRaw }) =>
        refRaw.toString("utf8").startsWith("refs/remotes/origin/"))
      .map((entry) => [entry.refRaw.toString("utf8"), entry.oid]),
  );
  const baselineConsistent = verifiedHeads === null || (
    verifiedHeads.size === observedOrigin.size &&
    [...verifiedHeads].every(
      ([ref, oid]) => observedOrigin.get(ref) === oid,
    )
  );
  context.counts.localBranches = local.length;
  context.counts.remoteBranches = remote.length;
  context.skipped.localBranches =
    allRefs.filter(isLocal).length - local.length;
  context.skipped.remoteBranches =
    allRefs.filter(isRemote).length - remote.length;

  const defaultBranch = await resolveDefaultBranch(
    boundary,
    allRefs,
    context,
    remoteBaseline,
  );
  const primary = defaultBranch.primary;
  const carriers = [];

  for (const entry of [...local, ...remote]) {
    const remoteEntry = isRemote(entry);
    const supportedScope = [
      "all",
      "branches",
      "remote",
      "worktrees",
      "stashes",
    ].includes(request.scope);
    if (!supportedScope) {
      continue;
    }

    const proof = request.depth === "metadata"
      ? {
        ancestry: null,
        complete: false,
        gap: null,
        units: [],
      }
      : await collectBranchProof(
        boundary,
        primary?.oid ?? null,
        entry.oid,
        context,
      );
    const refBase64 = entry.refRawBase64;
    const remoteName = remoteEntry
      ? entry.refRaw.toString("utf8")
        .slice("refs/remotes/".length)
        .split("/")[0]
      : null;
    const identity = remoteEntry
      ? {
        remoteId: stableId("remote-name", { remoteName }),
        refRawBase64: refBase64,
        tipOid: entry.oid,
      }
      : {
        refRawBase64: refBase64,
        tipOid: entry.oid,
      };
    const policyProtected =
      !remoteEntry && protectedByPolicy(entry.refRaw);
    const defaultProtected =
      !remoteEntry &&
      defaultBranch.localRef !== null &&
      entry.refRaw.equals(defaultBranch.localRef);
    const protection = remoteEntry
      ? "unknown"
      : policyProtected || defaultProtected
        ? "protected"
        : defaultBranch.resolved
          ? "unprotected"
          : "unknown";
    const blockers = [];
    if (!proof.complete) {
      blockers.push("branch-proof-incomplete");
    }
    if (remoteEntry && remoteBaseline?.state !== "verified") {
      blockers.push("remote-state-not-refreshed", "remote-protection-unknown");
    }
    if (!baselineConsistent) {
      blockers.push("remote-baseline-local-drift");
    }
    if (!remoteEntry && !defaultBranch.resolved) {
      blockers.push("default-branch-identity-unknown");
    }

    const carrier = carrierBase(
      remoteEntry ? "remote-branch" : "local-branch",
      identity,
      entry.displayName,
      proof.units,
      {
        complete: proof.complete && !remoteEntry,
        durability: remoteEntry ? "unknown" : "durable",
        protection,
        protectionEvidence:
          remoteEntry || (!defaultBranch.resolved && !policyProtected)
            ? "partial"
            : "complete",
        identityCurrent: true,
        survives: true,
        blockers,
        observed: {
          tipOid: entry.oid,
          commitOid: entry.oid,
          ancestry: proof.ancestry,
        },
      },
    );
    carrier.observations.push(
      ...branchAncestryObservations(carrier, proof.ancestry),
    );
    if (proof.gap) {
      addGap(
        context,
        proof.gap.code,
        [carrier.id],
        proof.gap.reason,
      );
    }
    carriers.push(carrier);
  }

  if (remote.length > 0 && remoteBaseline?.state !== "verified") {
    const remoteIds = carriers
      .filter(({ type }) => type === "remote-branch")
      .map(({ id }) => id);
    addGap(
      context,
      "remote-state-not-refreshed",
      remoteIds,
      "remote-tracking refs are local observations; no network refresh was performed",
    );
    addGap(
      context,
      "remote-identity-unavailable",
      remoteIds,
      "remote URL and immutable repository identity were not read",
    );
  }
  if (!baselineConsistent) {
    addGap(
      context,
      "remote-baseline-local-drift",
      carriers.map(({ id }) => id),
      "local origin remote-tracking refs do not match the verified baseline",
    );
  }
  if (!defaultBranch.resolved) {
    addGap(
      context,
      "default-branch-identity",
      carriers
        .filter(({ type }) => type === "local-branch")
        .map(({ id }) => id),
      defaultBranch.reason,
    );
  }

  return { carriers, primary };
}
