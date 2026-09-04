import { createHash } from "node:crypto";
import path from "node:path";

import { stableId } from "./mechanical-core.mjs";
import { initializeCarrierState } from "./carrier-state.mjs";
import {
  encodeRawPath,
  GitBoundaryError,
  validateOid,
} from "./git.mjs";

export const DEFAULT_ANALYSIS_LIMITS = Object.freeze({
  maxRefs: 2_000,
  maxTags: 2_000,
  maxStashes: 500,
  maxWorktrees: 100,
  maxPullRequests: 500,
  maxArtifacts: 1_000,
  maxBlobs: 20,
  maxStdoutBytes: 20 * 1024 * 1024,
  maxStderrBytes: 2 * 1024 * 1024,
  maxComparisons: 20_000,
  maxChangeUnits: 50_000,
  maxUntrackedFiles: 1_000,
  maxUntrackedBytesPerFile: 64 * 1024 * 1024,
  maxUntrackedBytesTotal: 512 * 1024 * 1024,
  maxReviewWorkItems: 20,
  maxReviewFilesPerItem: 25,
  maxReviewChangedLinesPerItem: 2_000,
  maxReviewBytesPerFile: 200 * 1024,
  maxReviewBytesTotal: 1024 * 1024,
  commandTimeoutMs: 30_000,
  collectionTimeoutMs: 180_000,
});

const COUNT_KEYS = Object.freeze([
  "localBranches",
  "remoteBranches",
  "tags",
  "worktrees",
  "stashes",
  "pullRequests",
  "artifacts",
  "blobs",
  "maintenanceSignals",
  "changeUnits",
  "reviewFiles",
]);

export function compare(left, right) {
  return String(left).localeCompare(String(right), "en");
}

export function sanitize(value) {
  return String(value)
    .replace(
      /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu,
      "\uFFFD",
    )
    .replace(/\s+/gu, " ")
    .trim();
}

export function rawPath(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return encodeRawPath(bytes);
}

export function normalizeLimits(overrides = {}) {
  if (
    overrides === null ||
    typeof overrides !== "object" ||
    Array.isArray(overrides)
  ) {
    throw new TypeError("limits must be an object");
  }

  const unknown = Object.keys(overrides).filter(
    (key) => !Object.hasOwn(DEFAULT_ANALYSIS_LIMITS, key),
  );
  if (unknown.length > 0) {
    throw new TypeError(`unknown limit: ${unknown[0]}`);
  }

  const result = {};
  for (const [name, fallback] of Object.entries(DEFAULT_ANALYSIS_LIMITS)) {
    const value = overrides[name] ?? fallback;
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(`${name} must be a nonnegative safe integer`);
    }
    result[name] = value;
  }
  return Object.freeze(result);
}

export function createCollectionContext(limits, signal) {
  return {
    counts: Object.fromEntries(COUNT_KEYS.map((key) => [key, 0])),
    skipped: Object.fromEntries(COUNT_KEYS.map((key) => [key, 0])),
    gaps: [],
    limitsReached: [],
    comparisons: 0,
    limits,
    signal,
  };
}

export function addGap(context, code, affectedIds = [], reason = code) {
  const ids = [...new Set(affectedIds)].sort(compare);
  const safeReason = sanitize(reason);
  const existing = context.gaps.find(
    (gap) => gap.code === code && gap.reason === safeReason,
  );
  if (existing) {
    existing.affectedIds = [
      ...new Set([...existing.affectedIds, ...ids]),
    ].sort(compare);
    return;
  }
  context.gaps.push({ code, affectedIds: ids, reason: safeReason });
}

export function markLimit(context, name, affectedIds = []) {
  if (!context.limitsReached.includes(name)) {
    context.limitsReached.push(name);
  }
  addGap(
    context,
    `${name}-limit`,
    affectedIds,
    `${name} collection limit reached`,
  );
}

export function parseLine(buffer, label) {
  if (
    !Buffer.isBuffer(buffer) ||
    buffer.length < 2 ||
    buffer.at(-1) !== 0x0a ||
    buffer.subarray(0, -1).includes(0x0a) ||
    buffer.includes(0x0d)
  ) {
    throw new GitBoundaryError(
      "MALFORMED_GIT_OUTPUT",
      `${label} was not one LF-terminated line`,
    );
  }
  return buffer.subarray(0, -1);
}

export function parseOidOutput(buffer, objectFormat, label) {
  const value = parseLine(buffer, label).toString("ascii");
  return validateOid(value, objectFormat);
}

export function parseWorktrees(buffer, objectFormat) {
  if (
    !Buffer.isBuffer(buffer) ||
    (buffer.length > 0 && buffer.at(-1) !== 0)
  ) {
    throw new GitBoundaryError(
      "MALFORMED_GIT_OUTPUT",
      "malformed worktree porcelain",
    );
  }

  const fields = [];
  let offset = 0;
  while (offset < buffer.length) {
    const nul = buffer.indexOf(0, offset);
    fields.push(Buffer.from(buffer.subarray(offset, nul)));
    offset = nul + 1;
  }

  const records = [];
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let record;
  for (const raw of fields) {
    const separator = raw.indexOf(0x20);
    const prefix = raw.subarray(0, separator < 0 ? raw.length : separator)
      .toString("ascii");
    if (prefix === "worktree") {
      if (record) {
        records.push(record);
      }
      const pathRaw = raw.subarray(9);
      let worktreePath = null;
      try {
        worktreePath = decoder.decode(pathRaw);
      } catch {
        // Raw bytes remain authoritative when the path is not valid UTF-8.
      }
      record = {
        path: worktreePath,
        pathRaw,
        pathRepresentable: worktreePath !== null,
        locked: false,
        prunable: false,
      };
      continue;
    }
    if (!record) {
      continue;
    }

    if (raw.subarray(0, 5).equals(Buffer.from("HEAD "))) {
      record.headOid = validateOid(
        raw.subarray(5).toString("ascii"),
        objectFormat,
      );
    } else if (raw.subarray(0, 7).equals(Buffer.from("branch "))) {
      record.branchRaw = Buffer.from(raw.subarray(7));
    } else if (raw.equals(Buffer.from("detached"))) {
      record.detached = true;
    } else if (
      raw.equals(Buffer.from("locked")) ||
      raw.subarray(0, 7).equals(Buffer.from("locked "))
    ) {
      record.locked = true;
    } else if (
      raw.equals(Buffer.from("prunable")) ||
      raw.subarray(0, 9).equals(Buffer.from("prunable "))
    ) {
      record.prunable = true;
    }
  }
  if (record) {
    records.push(record);
  }
  if (
    records.some(
      (entry) => entry.pathRepresentable && !path.isAbsolute(entry.path),
    )
  ) {
    throw new GitBoundaryError(
      "MALFORMED_GIT_OUTPUT",
      "worktree path was not absolute",
    );
  }
  return records;
}

export function parseStashList(buffer, objectFormat) {
  if (
    !Buffer.isBuffer(buffer) ||
    (buffer.length > 0 && buffer.at(-1) !== 0)
  ) {
    throw new GitBoundaryError(
      "MALFORMED_GIT_OUTPUT",
      "malformed stash reflog",
    );
  }
  if (buffer.length === 0) {
    return [];
  }

  const fields = buffer.subarray(0, -1).toString("ascii").split("\0")
    .filter((field) => field.length > 0);
  if (fields.length % 2 !== 0) {
    throw new GitBoundaryError(
      "MALFORMED_GIT_OUTPUT",
      "stash reflog has partial record",
    );
  }

  const records = [];
  for (let index = 0; index < fields.length; index += 2) {
    if (!/^(?:refs\/)?stash@\{(?:0|[1-9]\d*)\}$/u.test(fields[index])) {
      throw new GitBoundaryError(
        "MALFORMED_GIT_OUTPUT",
        "invalid stash selector",
      );
    }
    records.push({
      selector: fields[index].replace(/^refs\//u, ""),
      oid: validateOid(fields[index + 1], objectFormat),
    });
  }
  return records;
}

export function emptyTreeOid(objectFormat) {
  return createHash(objectFormat)
    .update(Buffer.from("tree 0\0", "ascii"))
    .digest("hex");
}

export function parseStashParents(buffer, objectFormat) {
  const end = buffer.indexOf(Buffer.from("\n\n"));
  if (end < 0) {
    throw new GitBoundaryError(
      "MALFORMED_GIT_OUTPUT",
      "stash commit has no header boundary",
    );
  }
  const header = buffer.subarray(0, end);
  if (
    header.includes(0x0d) ||
    header.includes(0x00) ||
    header.some((byte) => byte > 0x7f)
  ) {
    throw new GitBoundaryError(
      "MALFORMED_GIT_OUTPUT",
      "stash commit header is not safe ASCII",
    );
  }
  const parents = header.toString("ascii").split("\n")
    .filter((line) => line.startsWith("parent "))
    .map((line) => validateOid(line.slice(7), objectFormat));
  if (parents.length < 2 || parents.length > 3) {
    throw new GitBoundaryError(
      "MALFORMED_GIT_OUTPUT",
      "stash must have two or three parents",
    );
  }
  return parents;
}

function changeKind(code, oldMode, newMode) {
  if (oldMode === "160000" || newMode === "160000") {
    return "gitlink";
  }
  return {
    A: "add",
    D: "delete",
    M: "modify",
    T: "type-change",
  }[code] ?? "modify";
}

export function changeUnit(record, sourceComponent, objectFormat) {
  const zero = "0".repeat(objectFormat === "sha1" ? 40 : 64);
  const oldOid = record.oldOid === zero
    ? null
    : validateOid(record.oldOid, objectFormat);
  const newOid = record.newOid === zero
    ? null
    : validateOid(record.newOid, objectFormat);
  const identity = {
    path: rawPath(record.path),
    oldMode: record.oldMode === "000000" ? null : record.oldMode,
    newMode: record.newMode === "000000" ? null : record.newMode,
    oldOid,
    newOid,
    kind: changeKind(record.code, record.oldMode, record.newMode),
    sourceComponent,
  };
  return {
    id: stableId("change-unit", {
      path: identity.path,
      oldMode: identity.oldMode,
      newMode: identity.newMode,
      oldOid: identity.oldOid,
      newOid: identity.newOid,
      kind: identity.kind,
    }),
    ...identity,
    binary: record.binary === true,
  };
}

export function parseRawDiff(buffer, objectFormat, sourceComponent) {
  const fields = [];
  let offset = 0;
  while (offset < buffer.length) {
    const nul = buffer.indexOf(0, offset);
    if (nul < 0) {
      throw new GitBoundaryError(
        "MALFORMED_GIT_OUTPUT",
        "raw diff lacks NUL",
      );
    }
    fields.push(Buffer.from(buffer.subarray(offset, nul)));
    offset = nul + 1;
  }

  const units = [];
  for (let index = 0; index < fields.length;) {
    const header = fields[index++].toString("ascii");
    const match =
      /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([ADMT])$/u.exec(header);
    if (!match || index >= fields.length) {
      throw new GitBoundaryError(
        "MALFORMED_GIT_OUTPUT",
        "invalid raw diff record",
      );
    }
    units.push(changeUnit({
      oldMode: match[1],
      newMode: match[2],
      oldOid: match[3],
      newOid: match[4],
      code: match[5],
      path: fields[index++],
    }, sourceComponent, objectFormat));
  }
  return units.sort(
    (left, right) =>
      Buffer.from(left.path.rawBase64, "base64").compare(
        Buffer.from(right.path.rawBase64, "base64"),
      ) || compare(left.sourceComponent, right.sourceComponent),
  );
}

export async function diffUnits(
  boundary,
  left,
  right,
  component,
  context,
  countComparison = true,
) {
  if (
    countComparison &&
    context.comparisons >= context.limits.maxComparisons
  ) {
    markLimit(context, "maxComparisons");
    return null;
  }
  if (countComparison) {
    context.comparisons += 1;
  }
  try {
    const result = await boundary.run([
      "diff-tree",
      "-r",
      "-z",
      "--raw",
      "--no-renames",
      "--no-ext-diff",
      "--no-textconv",
      left,
      right,
    ], { signal: context.signal });
    return parseRawDiff(result.stdout, boundary.objectFormat, component);
  } catch (error) {
    addGap(
      context,
      "change-unit-unavailable",
      [],
      error.code ?? "Git diff proof unavailable",
    );
    return null;
  }
}

export function carrierBase(type, identity, displayName, units, extra = {}) {
  const id = stableId(`carrier:${type}`, identity);
  const carrier = {
    id,
    type,
    displayName: sanitize(displayName),
    identity,
    observed: extra.observed ?? {},
    changeUnitIds: units.map(({ id: unitId }) => unitId).sort(compare),
    changeUnitsComplete: extra.complete === true,
    evidence: extra.complete === true ? "complete" : "partial",
    durability: extra.durability ?? "unknown",
    protection: extra.protection ?? "unknown",
    protectionEvidence:
      extra.protectionEvidence === "complete" ? "complete" : "partial",
    identityCurrent: extra.identityCurrent === true,
    survives: extra.survives === true,
    observations: [],
    action: "keep",
    eligible: false,
    preservationWitnessIds: [],
    prerequisiteIds: [],
    blockerCodes: [...(extra.blockers ?? [])].sort(compare),
  };
  initializeCarrierState(carrier, units);
  return carrier;
}
