import { lstat } from "node:fs/promises";
import path from "node:path";

import { stableId } from "./mechanical-core.mjs";
import {
  addGap,
  compare,
  markLimit,
} from "./evidence-shared.mjs";
import {
  displayRawBytes,
  encodeRawPath,
  GitBoundaryError,
  parseFixedNulRecords,
  validateOid,
} from "./git.mjs";

const TAG_FORMAT =
  "%(refname)%00%(objectname)%00%(objecttype)%00%(*objectname)%00";
const OBJECT_FORMAT =
  "%(objectname) %(objecttype) %(objectsize)";
const ARTIFACT_PATHSPECS = Object.freeze(["*.orig", "*.rej"]);
const INTERRUPTED_OPERATIONS = Object.freeze([
  ["merge", "MERGE_HEAD"],
  ["cherry-pick", "CHERRY_PICK_HEAD"],
  ["revert", "REVERT_HEAD"],
  ["bisect", "BISECT_LOG"],
  ["rebase-merge", "rebase-merge"],
  ["rebase-apply", "rebase-apply"],
  ["sequencer", "sequencer"],
]);

function ascii(field, label, { allowEmpty = false } = {}) {
  if (
    (!allowEmpty && field.length === 0) ||
    field.some((byte) => byte > 0x7f)
  ) {
    throw new GitBoundaryError(
      "MALFORMED_GIT_OUTPUT",
      `${label} is not valid ASCII`,
    );
  }
  return field.toString("ascii");
}

function parseSize(field, label) {
  const value = ascii(field, label);
  if (!/^(?:0|[1-9]\d*)$/u.test(value)) {
    throw new GitBoundaryError(
      "MALFORMED_GIT_OUTPUT",
      `${label} is not a nonnegative integer`,
    );
  }
  const size = Number(value);
  if (!Number.isSafeInteger(size)) {
    throw new GitBoundaryError(
      "MALFORMED_GIT_OUTPUT",
      `${label} exceeds the safe integer range`,
    );
  }
  return size;
}

export function parseTagInventory(buffer, objectFormat) {
  return parseFixedNulRecords(buffer, 4).map(
    ([ref, oidBytes, typeBytes, peeledBytes]) => {
      if (ref.length === 0) {
        throw new GitBoundaryError(
          "MALFORMED_GIT_OUTPUT",
          "tag ref is empty",
        );
      }
      const objectOid = validateOid(
        ascii(oidBytes, "tag object name"),
        objectFormat,
      );
      const objectType = ascii(typeBytes, "tag object type");
      if (!["commit", "tag", "tree", "blob"].includes(objectType)) {
        throw new GitBoundaryError(
          "MALFORMED_GIT_OUTPUT",
          "tag object type is unsupported",
        );
      }
      const peeledText = ascii(
        peeledBytes,
        "peeled tag object name",
        { allowEmpty: true },
      );
      const peeledOid = peeledText === ""
        ? null
        : validateOid(peeledText, objectFormat);
      const identity = {
        refRawBase64: ref.toString("base64"),
        objectOid,
      };
      return {
        id: stableId("tag", identity),
        ref: {
          rawBase64: identity.refRawBase64,
          display: displayRawBytes(ref),
        },
        objectOid,
        objectType,
        peeledOid,
        recommendation: "keep",
        reasonCodes: ["tag-preserves-named-history"],
      };
    },
  ).sort((left, right) => compare(left.id, right.id));
}

export function parseLargeBlobInventory(buffer, objectFormat, limit) {
  const blobs = [];
  if (buffer.some((byte) => byte > 0x7f)) {
    throw new GitBoundaryError(
      "MALFORMED_GIT_OUTPUT",
      "object inventory is not ASCII",
    );
  }
  const text = buffer.toString("ascii");
  for (const line of text.split("\n")) {
    if (line === "") {
      continue;
    }
    const match = /^([0-9a-f]+) (blob|commit|tag|tree) (0|[1-9]\d*)$/u
      .exec(line);
    if (!match) {
      throw new GitBoundaryError(
        "MALFORMED_GIT_OUTPUT",
        "object inventory record is malformed",
      );
    }
    const oid = validateOid(
      match[1],
      objectFormat,
    );
    const objectType = match[2];
    const size = parseSize(Buffer.from(match[3], "ascii"), "object size");
    if (objectType === "blob") {
      blobs.push({
        id: stableId("blob", { oid }),
        oid,
        sizeBytes: size,
        recommendation: "review",
        reasonCodes: ["large-repository-object"],
      });
    }
  }
  blobs.sort(
    (left, right) =>
      right.sizeBytes - left.sizeBytes || compare(left.oid, right.oid),
  );
  return {
    records: blobs.slice(0, limit)
      .sort((left, right) => compare(left.id, right.id)),
    observed: blobs.length,
    skipped: Math.max(0, blobs.length - limit),
  };
}

export function parseCountObjects(buffer) {
  const result = {
    looseObjects: 0,
    packedObjects: 0,
    packs: 0,
    sizeKiB: 0,
    garbageCount: 0,
    garbageSizeKiB: 0,
    prunePackable: 0,
  };
  const fields = new Map([
    ["count", "looseObjects"],
    ["in-pack", "packedObjects"],
    ["packs", "packs"],
    ["size", "sizeKiB"],
    ["garbage", "garbageCount"],
    ["size-garbage", "garbageSizeKiB"],
    ["prune-packable", "prunePackable"],
  ]);
  let encounteredAlternate = false;
  for (const line of buffer.toString("ascii").split(/\r?\n/u)) {
    if (encounteredAlternate || line === "") {
      continue;
    }
    if (line.startsWith("alternate: ")) {
      encounteredAlternate = true;
      continue;
    }
    const match = /^([a-z-]+): (0|[1-9]\d*)$/u.exec(line);
    if (!match) {
      continue;
    }
    const target = fields.get(match[1]);
    if (target) {
      const value = Number(match[2]);
      if (!Number.isSafeInteger(value)) {
        throw new GitBoundaryError(
          "MALFORMED_GIT_OUTPUT",
          "count-objects value exceeds the safe integer range",
        );
      }
      result[target] = value;
    }
  }
  return result;
}

function parseNulPaths(buffer) {
  if (buffer.length === 0) {
    return [];
  }
  if (buffer.at(-1) !== 0) {
    throw new GitBoundaryError(
      "MALFORMED_GIT_OUTPUT",
      "artifact path list is not NUL-terminated",
    );
  }
  const records = [];
  let offset = 0;
  while (offset < buffer.length) {
    const nul = buffer.indexOf(0, offset);
    const record = Buffer.from(buffer.subarray(offset, nul));
    if (record.length === 0) {
      throw new GitBoundaryError(
        "MALFORMED_GIT_OUTPUT",
        "artifact path is empty",
      );
    }
    records.push(record);
    offset = nul + 1;
  }
  return records;
}

async function collectTags(boundary, request, context) {
  if (!["all", "tags"].includes(request.scope)) {
    return [];
  }
  let records;
  try {
    const result = await boundary.run([
      "for-each-ref",
      "--sort=refname",
      `--format=${TAG_FORMAT}`,
      "refs/tags/",
    ], { signal: context.signal });
    records = parseTagInventory(result.stdout, boundary.objectFormat);
  } catch (error) {
    if (context.signal?.aborted || error?.code === "CANCELLED") throw error;
    addGap(
      context,
      "tag-inventory-unavailable",
      [],
      "tag inventory is unavailable",
    );
    return [];
  }
  context.counts.tags = Math.min(records.length, request.limits.maxTags);
  context.skipped.tags = Math.max(
    0,
    records.length - request.limits.maxTags,
  );
  if (context.skipped.tags > 0) {
    markLimit(context, "maxTags");
    addGap(
      context,
      "tag-inventory-limit",
      [],
      "tag inventory exceeded the configured limit",
    );
  }
  return records.slice(0, request.limits.maxTags);
}

async function collectArtifacts(boundary, request, context) {
  if (!["all", "artifacts"].includes(request.scope)) {
    return [];
  }
  const commands = [
    ["tracked", ["ls-files", "-z", "--cached", "--", ...ARTIFACT_PATHSPECS]],
    [
      "untracked",
      [
        "ls-files",
        "-z",
        "--others",
        "--exclude-standard",
        "--",
        ...ARTIFACT_PATHSPECS,
      ],
    ],
  ];
  if (request.includeIgnored) {
    commands.push([
      "ignored",
      [
        "ls-files",
        "-z",
        "--others",
        "--ignored",
        "--exclude-standard",
        "--",
        ...ARTIFACT_PATHSPECS,
      ],
    ]);
  }
  const byPath = new Map();
  for (const [trackedState, args] of commands) {
    try {
      const result = await boundary.run(args, { signal: context.signal });
      for (const raw of parseNulPaths(result.stdout)) {
        const key = raw.toString("base64");
        if (!byPath.has(key)) {
          byPath.set(key, {
            id: stableId("artifact", {
              pathRawBase64: key,
              trackedState,
            }),
            path: encodeRawPath(raw),
            trackedState,
            recommendation: "inspect",
            reasonCodes: ["potential-recovery-content"],
          });
        }
      }
    } catch (error) {
      if (context.signal?.aborted || error?.code === "CANCELLED") throw error;
      addGap(
        context,
        "artifact-inventory-unavailable",
        [],
        `${trackedState} artifact inventory is unavailable`,
      );
    }
  }
  const records = [...byPath.values()]
    .sort((left, right) => compare(left.id, right.id));
  context.counts.artifacts = Math.min(
    records.length,
    request.limits.maxArtifacts,
  );
  context.skipped.artifacts = Math.max(
    0,
    records.length - request.limits.maxArtifacts,
  );
  if (context.skipped.artifacts > 0) {
    markLimit(context, "maxArtifacts");
    addGap(
      context,
      "artifact-inventory-limit",
      [],
      "artifact inventory exceeded the configured limit",
    );
  }
  return records.slice(0, request.limits.maxArtifacts);
}

async function collectBlobs(boundary, request, context) {
  if (!["all", "blobs"].includes(request.scope)) {
    return [];
  }
  let result;
  try {
    result = await boundary.run([
      "cat-file",
      "--batch-all-objects",
      `--batch-check=${OBJECT_FORMAT}`,
    ], { signal: context.signal });
  } catch (error) {
    if (context.signal?.aborted || error?.code === "CANCELLED") throw error;
    addGap(
      context,
      "blob-inventory-unavailable",
      [],
      error instanceof GitBoundaryError &&
        ["OUTPUT_LIMIT", "COMMAND_FAILED"].includes(error.code)
        ? "object inventory exceeded a process limit or is unsupported"
        : "object inventory is unavailable",
    );
    return [];
  }
  let inventory;
  try {
    inventory = parseLargeBlobInventory(
      result.stdout,
      boundary.objectFormat,
      request.limits.maxBlobs,
    );
  } catch (error) {
    if (context.signal?.aborted || error?.code === "CANCELLED") throw error;
    addGap(
      context,
      "blob-inventory-unavailable",
      [],
      "object inventory is unavailable",
    );
    return [];
  }
  context.counts.blobs = inventory.records.length;
  context.skipped.blobs = inventory.skipped;
  if (inventory.skipped > 0) {
    markLimit(context, "maxBlobs");
    addGap(
      context,
      "blob-inventory-limit",
      inventory.records.map(({ id }) => id),
      "only the largest blobs up to the configured limit are reported",
    );
  }
  return inventory.records;
}

async function pathExists(candidate) {
  try {
    await lstat(candidate);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function decodeAbsoluteGitPath(raw) {
  if (!Buffer.isBuffer(raw)) {
    throw new TypeError("Git directory must be a Buffer");
  }
  let value;
  try {
    value = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    throw new GitBoundaryError(
      "MALFORMED_GIT_OUTPUT",
      "Git directory is not valid UTF-8",
    );
  }
  if (
    value.includes("\0") ||
    !path.isAbsolute(value) ||
    !Buffer.from(value, "utf8").equals(raw)
  ) {
    throw new GitBoundaryError(
      "MALFORMED_GIT_OUTPUT",
      "Git directory is not an absolute filesystem path",
    );
  }
  return value;
}

async function collectMaintenance(
  boundary,
  request,
  context,
  gitDir,
) {
  if (!["all", "maintenance"].includes(request.scope)) {
    return null;
  }
  try {
    const gitDirPath = decodeAbsoluteGitPath(gitDir);
    const result = await boundary.run(
      ["count-objects", "-v"],
      { signal: context.signal },
    );
    const counts = parseCountObjects(result.stdout);
    const interruptedOperations = [];
    for (const [type, marker] of INTERRUPTED_OPERATIONS) {
      const markerPath = path.join(gitDirPath, marker);
      if (await pathExists(markerPath)) {
        interruptedOperations.push({
          type,
          path: encodeRawPath(Buffer.from(markerPath, "utf8")),
        });
      }
    }
    const reasonCodes = [];
    if (interruptedOperations.length > 0) {
      reasonCodes.push("interrupted-operation-present");
    }
    if (counts.garbageCount > 0 || counts.prunePackable > 0) {
      reasonCodes.push("repository-maintenance-recommended");
    }
    context.counts.maintenanceSignals =
      interruptedOperations.length +
      Number(counts.garbageCount > 0) +
      Number(counts.prunePackable > 0);
    return {
      id: stableId("maintenance", {
        gitDirRawBase64: gitDir.toString("base64"),
      }),
      ...counts,
      interruptedOperations,
      recommendation: interruptedOperations.length > 0
        ? "inspect"
        : reasonCodes.length > 0
          ? "run-maintenance"
          : "none",
      reasonCodes,
    };
  } catch (error) {
    if (context.signal?.aborted || error?.code === "CANCELLED") throw error;
    addGap(
      context,
      "maintenance-inventory-unavailable",
      [],
      "repository maintenance inventory is unavailable",
    );
    return null;
  }
}

export async function collectLegacyInventory(
  boundary,
  request,
  context,
  gitDir,
) {
  const [tags, artifacts, blobs, maintenance] = await Promise.all([
    collectTags(boundary, request, context),
    collectArtifacts(boundary, request, context),
    collectBlobs(boundary, request, context),
    collectMaintenance(boundary, request, context, gitDir),
  ]);
  return {
    tags,
    artifacts,
    blobs,
    maintenance,
  };
}
