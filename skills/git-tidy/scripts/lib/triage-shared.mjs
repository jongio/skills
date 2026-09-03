import { createHash } from "node:crypto";

import {
  canonicalJson,
  stableId,
} from "./mechanical-core.mjs";

export const SCHEMA_VERSION = "1.1.0";
export const SCOPES = Object.freeze([
  "all",
  "branches",
  "worktrees",
  "remote",
  "stashes",
  "tags",
  "artifacts",
  "blobs",
  "maintenance",
]);
export const DEPTHS = Object.freeze(["metadata", "proof", "review"]);
export const RESULT_KEYS = Object.freeze([
  "schemaVersion",
  "operation",
  "runId",
  "generatedAt",
  "repository",
  "request",
  "workItems",
  "inventory",
  "coverage",
  "reviewBundle",
  "actionPlan",
  "drift",
  "compatibility",
]);
export const DESTRUCTIVE = new Set([
  "delete-ref",
  "drop-stash",
  "remove-worktree",
]);

export function compare(left, right) {
  return String(left).localeCompare(String(right), "en");
}

export function exactKeys(value, keys) {
  return value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

export function allCarriers(items) {
  return items.flatMap(({ carriers }) => carriers)
    .sort((left, right) => compare(left.id, right.id));
}

function mechanicalCarrier(carrier) {
  return {
    id: carrier.id,
    type: carrier.type,
    identity: carrier.identity,
    observed: carrier.observed,
    changeUnitIds: carrier.changeUnitIds,
    changeUnitsComplete: carrier.changeUnitsComplete,
    evidence: carrier.evidence,
    durability: carrier.durability,
    protection: carrier.protection,
    protectionEvidence: carrier.protectionEvidence,
    identityCurrent: carrier.identityCurrent,
    survives: carrier.survives,
    blockerCodes: carrier.blockerCodes.filter(
      (code) => !code.startsWith("content-review-"),
    ),
  };
}

function mechanicalChangeUnit(unit) {
  return {
    id: unit.id,
    path: unit.path,
    oldMode: unit.oldMode,
    newMode: unit.newMode,
    oldOid: unit.oldOid,
    newOid: unit.newOid,
    kind: unit.kind,
    binary: unit.binary,
    sourceComponent: unit.sourceComponent,
  };
}

export function runDigest(
  repository,
  request,
  carriers,
  changeUnits,
  inventory,
) {
  const mechanicalIdentities = {
    carriers: carriers.map(mechanicalCarrier)
      .sort((left, right) => compare(left.id, right.id)),
    changeUnits: changeUnits.map(mechanicalChangeUnit)
      .sort((left, right) => compare(left.id, right.id)),
    inventory,
  };
  return createHash("sha256").update(canonicalJson({
    schemaVersion: SCHEMA_VERSION,
    repository,
    request,
    mechanicalIdentities,
  }), "utf8").digest("hex");
}

export function digestResult(result) {
  const units = new Map();
  for (const item of result.workItems) {
    for (const unit of item.changeUnits) {
      units.set(unit.id, unit);
    }
  }
  return runDigest(
    result.repository,
    result.request,
    allCarriers(result.workItems),
    [...units.values()].sort((left, right) => compare(left.id, right.id)),
    result.inventory,
  );
}

export function carrierSnapshot(carrier) {
  return {
    identity: carrier.identity,
    observed: carrier.observed,
    changeUnitIds: carrier.changeUnitIds,
    changeUnitsComplete: carrier.changeUnitsComplete,
    evidence: carrier.evidence,
    durability: carrier.durability,
    protection: carrier.protection,
    protectionEvidence: carrier.protectionEvidence,
    identityCurrent: carrier.identityCurrent,
    survives: carrier.survives,
    action: carrier.action,
    eligible: carrier.eligible,
    preservationWitnessIds: carrier.preservationWitnessIds,
    prerequisiteIds: carrier.prerequisiteIds,
    blockerCodes: carrier.blockerCodes,
  };
}

export function drift(
  subjectId,
  field,
  expected,
  observed,
  code = "revalidation-drift",
) {
  const display = (value) => {
    if (value === undefined) {
      return null;
    }
    return typeof value === "string" ? value : canonicalJson(value);
  };
  return {
    subjectId,
    field,
    expected: display(expected),
    observed: display(observed),
    code,
  };
}

function decodeBase64(base64, label) {
  if (typeof base64 !== "string") {
    throw new TypeError(`${label} is not base64`);
  }
  const bytes = Buffer.from(base64, "base64");
  if (bytes.toString("base64") !== base64) {
    throw new TypeError(`${label} is not canonical base64`);
  }
  return bytes;
}

export function decodeRawPath(encoded) {
  const bytes = decodeBase64(encoded?.rawBase64, "worktree path");
  const value = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (
    value.includes("\0") ||
    !Buffer.from(value, "utf8").equals(bytes)
  ) {
    throw new TypeError(
      "worktree path is not exactly representable as UTF-8",
    );
  }
  return value;
}

export function decodeFullRef(base64) {
  const bytes = decodeBase64(base64, "carrier ref");
  const value = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (
    !value.startsWith("refs/heads/") ||
    value.length === "refs/heads/".length ||
    /[\u0000-\u001f\u007f]/u.test(value) ||
    !Buffer.from(value, "utf8").equals(bytes)
  ) {
    throw new TypeError("carrier ref cannot be represented as safe argv");
  }
  return value;
}

export function planStep(carrier) {
  let argv;
  let approvalClass;
  let expected;
  if (carrier.action === "drop-stash") {
    argv = ["stash", "drop", carrier.identity.observedSelector];
    approvalClass = "stash-drop";
    expected = {
      stashOid: carrier.identity.stashOid,
      observedSelector: carrier.identity.observedSelector,
    };
  } else if (carrier.action === "remove-worktree") {
    argv = [
      "worktree",
      "remove",
      "--",
      decodeRawPath(carrier.identity.path),
    ];
    approvalClass = "worktree-removal";
    expected = {
      headOid: carrier.identity.headOid ?? "",
      statusFingerprint: carrier.identity.statusFingerprint,
    };
  } else if (
    carrier.action === "delete-ref" &&
    carrier.type === "local-branch"
  ) {
    const fullRef = decodeFullRef(carrier.identity.refRawBase64);
    argv = [
      "update-ref",
      "-d",
      fullRef,
      carrier.identity.tipOid,
    ];
    approvalClass = "local-branch-deletion";
    expected = {
      ref: fullRef,
      tipOid: carrier.identity.tipOid,
    };
  } else {
    throw new TypeError("selected carrier has no guardable local action");
  }
  return {
    id: stableId("action-step", {
      carrierId: carrier.id,
      action: carrier.action,
    }),
    carrierId: carrier.id,
    action: carrier.action,
    executable: "git",
    argv,
    expected,
    witnessIds: [...carrier.preservationWitnessIds].sort(compare),
    prerequisiteIds: [...carrier.prerequisiteIds].sort(compare),
    approvalClass,
  };
}

export function sortSteps(left, right) {
  const rank = (step) => {
    if (step.action === "remove-worktree") {
      return 0;
    }
    if (step.action === "delete-ref") {
      return 1;
    }
    return 2;
  };
  const stashIndex = (step) =>
    Number(
      /\{(\d+)\}/u.exec(step.expected.observedSelector ?? "")?.[1] ?? -1,
    );
  return rank(left) - rank(right) ||
    (
      left.action === "drop-stash"
        ? stashIndex(right) - stashIndex(left)
        : 0
    ) ||
    compare(left.id, right.id);
}
