import { stableId } from "./mechanical-core.mjs";
import {
  branchAncestryObservations,
  collectBranchProof,
} from "./branch-proof.mjs";
import {
  addGap,
  carrierBase,
  compare,
} from "./evidence-shared.mjs";
import { validateOid } from "./git.mjs";

const REMOTE_URL_ARGS = Object.freeze([
  "config",
  "--local",
  "--null",
  "--get-regexp",
  "^remote\\..*\\.url$",
]);

function parseRemoteUrls(buffer) {
  if (!Buffer.isBuffer(buffer)) {
    throw new TypeError("Git remote configuration must be a Buffer");
  }
  if (buffer.length === 0) {
    return [];
  }
  if (buffer.at(-1) !== 0x00) {
    throw new TypeError("Git remote configuration has invalid framing");
  }
  const decoder = new TextDecoder("utf-8", { fatal: true });
  return buffer.subarray(0, -1).toString("binary").split("\0")
    .map((encoded) => Buffer.from(encoded, "binary"))
    .map((record) => {
      const separator = record.indexOf(0x0a);
      if (separator < 1) {
        throw new TypeError("Git remote configuration has invalid schema");
      }
      const key = record.subarray(0, separator).toString("ascii");
      if (
        record.subarray(0, separator).some((byte) => byte > 0x7f) ||
        !/^remote\..+\.url$/iu.test(key)
      ) {
        throw new TypeError("Git remote configuration has invalid key");
      }
      const remoteName = key.slice("remote.".length, -".url".length);
      const url = decoder.decode(record.subarray(separator + 1));
      return { remoteName, url };
    });
}

function canonicalRemoteRepository(value) {
  let host;
  let repositoryPath;
  try {
    const parsed = new URL(value);
    if (!["git:", "http:", "https:", "ssh:"].includes(parsed.protocol)) {
      return null;
    }
    host = parsed.hostname.toLowerCase();
    if (
      parsed.protocol === "ssh:" &&
      host === "ssh.github.com" &&
      parsed.port === "443"
    ) {
      host = "github.com";
    }
    repositoryPath = parsed.pathname.replace(/^\/+/u, "");
  } catch {
    const scp = /^(?:[^@/:]+@)?([^/:]+):(.+)$/u.exec(value);
    if (!scp) {
      return null;
    }
    host = scp[1].toLowerCase();
    repositoryPath = scp[2];
  }
  repositoryPath = repositoryPath
    .replace(/\/+$/u, "")
    .replace(/\.git$/iu, "");
  if (
    host.length === 0 ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repositoryPath)
  ) {
    return null;
  }
  return `${host}/${repositoryPath}`.toLowerCase();
}

async function matchingRemoteNames(boundary, repository, signal) {
  let result;
  try {
    result = await boundary.run([...REMOTE_URL_ARGS], {
      rejectNonZero: false,
      signal,
    });
  } catch {
    return new Set();
  }
  if (result.exitCode === 1) {
    return new Set();
  }
  if (result.exitCode !== 0) {
    return new Set();
  }
  let remotes;
  try {
    remotes = parseRemoteUrls(result.stdout);
  } catch {
    return new Set();
  }
  const expected =
    `${repository.host}/${repository.nameWithOwner}`.toLowerCase();
  return new Set(
    remotes
      .filter(({ url }) => canonicalRemoteRepository(url) === expected)
      .map(({ remoteName }) => remoteName),
  );
}

function encodedRef(carrier) {
  const encoded = carrier.identity?.refRawBase64;
  if (typeof encoded !== "string" || encoded.length === 0) return null;
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded) return null;
  try {
    const value = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return /[\u0000-\u001f\u007f]/u.test(value) ? null : value;
  } catch {
    return null;
  }
}

function remoteTrackingIdentity(carrier, remoteNames) {
  const ref = encodedRef(carrier);
  if (carrier.type !== "remote-branch" || !ref) {
    return null;
  }
  const remoteName = [...remoteNames]
    .sort((left, right) => right.length - left.length)
    .find((candidate) =>
      ref.startsWith(`refs/remotes/${candidate}/`));
  if (!remoteName) {
    return null;
  }
  const refName = ref.slice(`refs/remotes/${remoteName}/`.length);
  if (refName.length === 0 || refName === "HEAD") {
    return null;
  }
  return { remoteName, refName };
}

export function carrierHeadName(carrier) {
  if (carrier.observed?.githubBranch?.refName) {
    return carrier.observed.githubBranch.refName;
  }
  const ref = encodedRef(carrier);
  if (!ref) {
    return null;
  }
  const prefix = "refs/heads/";
  if (ref.startsWith(prefix)) {
    return ref.slice(prefix.length);
  }
  return carrier.observed?.repositoryId && carrier.observed?.refName
    ? carrier.observed.refName
    : null;
}

export function matchingPullRequests(records, repositoryId, carrier) {
  return records
    .filter(
      (record) =>
        record.headRepositoryId === repositoryId &&
        record.headRefName === carrierHeadName(carrier) &&
        record.headOid === carrier.observed.tipOid,
    )
    .map((record) => ({
      ...record,
      exactHeadMatch: true,
    }));
}

function branchObservation(carrier, code, summary) {
  carrier.observations.push({
    code,
    source: "github",
    subjectId: carrier.id,
    summary,
  });
}

function removeBlocker(carrier, code) {
  carrier.blockerCodes = carrier.blockerCodes.filter(
    (candidate) => candidate !== code,
  );
}

function attachToRemoteTracking(carrier, branch, context) {
  carrier.observed.repositoryId = branch.repositoryId;
  carrier.observed.refName = branch.refName;
  if (carrier.identity.tipOid !== branch.tipOid) {
    if (!carrier.blockerCodes.includes("remote-tracking-drift")) {
      carrier.blockerCodes.push("remote-tracking-drift");
    }
    addGap(
      context,
      "remote-tracking-drift",
      [carrier.id],
      "GitHub branch tip differs from the local remote-tracking tip",
    );
    carrier.blockerCodes.sort(compare);
    return;
  }
  carrier.observed.githubBranch = {
    repositoryId: branch.repositoryId,
    refName: branch.refName,
    tipOid: branch.tipOid,
    protected: branch.protected,
  };
  carrier.protection = branch.protected ? "protected" : "unprotected";
  carrier.protectionEvidence = "complete";
  carrier.durability = "durable";
  removeBlocker(carrier, "remote-protection-unknown");
  removeBlocker(carrier, "remote-state-not-refreshed");
  if (!carrier.blockerCodes.includes("branch-proof-incomplete")) {
    carrier.changeUnitsComplete = true;
    carrier.evidence = "complete";
  }
  branchObservation(
    carrier,
    branch.protected
      ? "github-branch-protected"
      : "github-branch-unprotected",
    `GitHub branch protection is ${branch.protected ? "enabled" : "disabled"}.`,
  );
  branchObservation(
    carrier,
    "github-branch-exact-head",
    "GitHub branch exactly matches the local remote-tracking tip.",
  );
  carrier.blockerCodes.sort(compare);
  carrier.observations.sort(
    (left, right) =>
      compare(left.code, right.code) ||
      compare(left.summary, right.summary),
  );
}

function remoteIdentity(repositoryId, branch) {
  return {
    remoteId: stableId("remote", { repositoryId }),
    refRawBase64: Buffer.from(
      `refs/heads/${branch.refName}`,
    ).toString("base64"),
    tipOid: branch.tipOid,
  };
}

function acquisitionId(branch) {
  return stableId("prerequisite", {
    kind: "isolated-acquisition",
    repositoryId: branch.repositoryId,
    refName: branch.refName,
    tipOid: branch.tipOid,
  });
}

function parseObjectAvailability(buffer, requested) {
  if (
    !Buffer.isBuffer(buffer) ||
    buffer.length === 0 ||
    buffer.at(-1) !== 0x0a ||
    buffer.includes(0x0d) ||
    buffer.some((byte) => byte > 0x7f)
  ) {
    throw new TypeError("GitHub branch object check has invalid framing");
  }
  const lines = buffer.subarray(0, -1).toString("ascii").split("\n");
  if (lines.length !== requested.length) {
    throw new TypeError("GitHub branch object check count mismatch");
  }
  return new Map(lines.map((line, index) => {
    const oid = requested[index];
    if (line === `${oid} missing`) {
      return [oid, false];
    }
    const match =
      /^([0-9a-f]{40}(?:[0-9a-f]{24})?) commit ([0-9]+)$/u.exec(line);
    if (
      !match ||
      match[1] !== oid ||
      !Number.isSafeInteger(Number(match[2]))
    ) {
      throw new TypeError("GitHub branch object check has invalid schema");
    }
    return [oid, true];
  }));
}

async function localObjectAvailability(boundary, branches, context) {
  const requested = [
    ...new Set(branches.map(({ tipOid }) => tipOid)),
  ];
  if (requested.length === 0) {
    return new Map();
  }
  try {
    const result = await boundary.run([
      "cat-file",
      "--batch-check=%(objectname) %(objecttype) %(objectsize)",
    ], {
      input: `${requested.join("\n")}\n`,
      signal: context.signal,
    });
    return parseObjectAvailability(result.stdout, requested);
  } catch (error) {
    addGap(
      context,
      "remote-content-availability-unavailable",
      branches.map(({ id }) => id),
      error.code ?? "local remote branch object availability is unknown",
    );
    return new Map(requested.map((oid) => [oid, null]));
  }
}

async function remoteOnlyCarrier(
  branch,
  repository,
  boundary,
  primary,
  context,
  locallyAvailable,
) {
  const identity = remoteIdentity(repository.id, branch);
  const proof = locallyAvailable
    ? await collectBranchProof(
      boundary,
      primary?.oid ?? null,
      branch.tipOid,
      context,
    )
    : {
      ancestry: null,
      complete: false,
      gap: null,
      units: [],
    };
  const complete = proof.complete;
  const carrier = carrierBase(
    "remote-branch",
    identity,
    `github:${repository.nameWithOwner}:refs/heads/${branch.refName}`,
    proof.units,
    {
      complete,
      durability: "durable",
      protection: branch.protected ? "protected" : "unprotected",
      protectionEvidence: "complete",
      identityCurrent: true,
      survives: true,
      blockers: [
        ...(branch.protected ? ["remote-branch-protected"] : []),
        ...(!locallyAvailable
          ? [
            "remote-content-unavailable",
            "isolated-acquisition-required",
          ]
          : []),
        ...(locallyAvailable && !complete
          ? ["branch-proof-incomplete"]
          : []),
      ],
      observed: {
        tipOid: branch.tipOid,
        commitOid: branch.tipOid,
        repositoryId: repository.id,
        refName: branch.refName,
        githubBranch: {
          repositoryId: repository.id,
          refName: branch.refName,
          tipOid: branch.tipOid,
          protected: branch.protected,
        },
        ancestry: proof.ancestry,
        pullRequests: [],
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
  if (!locallyAvailable) {
    carrier.prerequisiteIds = [acquisitionId(branch)];
    addGap(
      context,
      "remote-content-unavailable",
      [carrier.id],
      "GitHub branch content is unavailable locally; no fetch was performed",
    );
    addGap(
      context,
      "isolated-acquisition-required",
      [carrier.id],
      "An external isolated-acquisition workflow requires separate approval",
    );
  }
  branchObservation(
    carrier,
    branch.protected
      ? "github-branch-protected"
      : "github-branch-unprotected",
    `GitHub branch protection is ${branch.protected ? "enabled" : "disabled"}.`,
  );
  return carrier;
}

export async function integrateGitHubBranches({
  github,
  repository,
  boundary,
  primary,
  branchCarriers,
  context,
}) {
  const valid = [];
  for (const branch of github.branches) {
    if (branch.repositoryId !== repository.id) {
      context.skipped.remoteBranches += 1;
      addGap(
        context,
        "github-branch-repository-mismatch",
        [branch.id],
        "GitHub branch repository ID does not match the observed repository",
      );
      continue;
    }
    try {
      validateOid(branch.tipOid, boundary.objectFormat);
      valid.push(branch);
    } catch {
      context.skipped.remoteBranches += 1;
      addGap(
        context,
        "github-branch-oid-invalid",
        [branch.id],
        "GitHub branch OID does not match the repository object format",
      );
    }
  }

  const remoteNames = await matchingRemoteNames(
    boundary,
    repository,
    context.signal,
  );
  const tracking = branchCarriers
    .map((carrier) => ({
      carrier,
      tracking: remoteTrackingIdentity(carrier, remoteNames),
    }))
    .filter(({ tracking: identity }) => identity !== null);
  for (const { carrier, tracking: identity } of tracking) {
    carrier.observed.repositoryId = repository.id;
    carrier.observed.refName = identity.refName;
  }
  const remoteOnly = valid.filter((branch) =>
    !tracking.some(
      ({ carrier, tracking: identity }) =>
        identity.refName === branch.refName &&
        carrier.identity.tipOid === branch.tipOid,
    ));
  const availability = await localObjectAvailability(
    boundary,
    remoteOnly,
    context,
  );
  for (const branch of valid) {
    const represented = tracking.filter(
      ({ tracking: identity }) => identity.refName === branch.refName,
    );
    for (const { carrier } of represented) {
      attachToRemoteTracking(carrier, branch, context);
    }
    if (represented.some(
      ({ carrier }) => carrier.identity.tipOid === branch.tipOid,
    )) {
      continue;
    }
    branchCarriers.push(await remoteOnlyCarrier(
      branch,
      repository,
      boundary,
      primary,
      context,
      availability.get(branch.tipOid) === true,
    ));
  }
  branchCarriers.sort((left, right) => compare(left.id, right.id));
  return valid.length;
}
