const nonempty = (value) => typeof value === "string" && value.length > 0;
const nonnegative = (value) => Number.isSafeInteger(value) && value >= 0;
const oneOf = (value, choices) => choices.includes(value);
const object = (value) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const exactKeys = (value, keys) =>
  object(value) &&
  Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
const canonicalBase64 = (value) =>
  typeof value === "string" &&
  value.length > 0 &&
  Buffer.from(value, "base64").toString("base64") === value;
const uniqueStrings = (value) =>
  Array.isArray(value) &&
  value.every(nonempty) &&
  new Set(value).size === value.length;

function validateOid(value, path, objectFormat, check, nullable = false) {
  check(
    nullable && value === null ||
      typeof value === "string" &&
      new RegExp(
        `^[0-9a-f]{${objectFormat === "sha256" ? 64 : 40}}$`,
        "u",
      ).test(value),
    "invalid-oid",
    path,
  );
}

function validateEncoded(value, path, check) {
  if (!check(
    exactKeys(value, ["rawBase64", "display"]),
    "invalid-encoded-path",
    path,
  )) return;
  check(
    canonicalBase64(value.rawBase64),
    "invalid-encoded-path-bytes",
    `${path}.rawBase64`,
  );
  check(
    typeof value.display === "string",
    "invalid-encoded-path-display",
    `${path}.display`,
  );
}

function validateList(value, path, validateEntry, check) {
  if (!check(Array.isArray(value), "invalid-inventory-list", path)) return;
  const ids = new Set();
  value.forEach((entry, index) => {
    const entryPath = `${path}[${index}]`;
    validateEntry(entry, entryPath, check);
    check(
      nonempty(entry?.id) && !ids.has(entry.id),
      "invalid-inventory-id",
      `${entryPath}.id`,
    );
    ids.add(entry?.id);
  });
  const sorted = [...value].sort(
    (left, right) =>
      String(left?.id).localeCompare(String(right?.id), "en"),
  );
  check(
    value.every((entry, index) => entry === sorted[index]),
    "invalid-inventory-order",
    path,
  );
}

function validateTag(tag, path, objectFormat, check) {
  const keys = [
    "id", "ref", "objectOid", "objectType", "peeledOid",
    "recommendation", "reasonCodes",
  ];
  if (!check(exactKeys(tag, keys), "invalid-tag-inventory", path)) return;
  validateEncoded(tag.ref, `${path}.ref`, check);
  validateOid(tag.objectOid, `${path}.objectOid`, objectFormat, check);
  validateOid(tag.peeledOid, `${path}.peeledOid`, objectFormat, check, true);
  check(
    oneOf(tag.objectType, ["blob", "commit", "tag", "tree"]),
    "invalid-tag-object-type",
    `${path}.objectType`,
  );
  check(
    tag.recommendation === "keep",
    "invalid-tag-recommendation",
    `${path}.recommendation`,
  );
  check(
    uniqueStrings(tag.reasonCodes),
    "invalid-inventory-reason-codes",
    `${path}.reasonCodes`,
  );
}

function validateArtifact(artifact, path, check) {
  const keys = [
    "id", "path", "trackedState", "recommendation", "reasonCodes",
  ];
  if (!check(
    exactKeys(artifact, keys),
    "invalid-artifact-inventory",
    path,
  )) return;
  validateEncoded(artifact.path, `${path}.path`, check);
  check(
    oneOf(artifact.trackedState, ["tracked", "untracked", "ignored"]),
    "invalid-artifact-state",
    `${path}.trackedState`,
  );
  check(
    artifact.recommendation === "inspect",
    "invalid-artifact-recommendation",
    `${path}.recommendation`,
  );
  check(
    uniqueStrings(artifact.reasonCodes),
    "invalid-inventory-reason-codes",
    `${path}.reasonCodes`,
  );
}

function validateBlob(blob, path, objectFormat, check) {
  const keys = ["id", "oid", "sizeBytes", "recommendation", "reasonCodes"];
  if (!check(exactKeys(blob, keys), "invalid-blob-inventory", path)) return;
  validateOid(blob.oid, `${path}.oid`, objectFormat, check);
  check(nonnegative(blob.sizeBytes), "invalid-blob-size", `${path}.sizeBytes`);
  check(
    blob.recommendation === "review",
    "invalid-blob-recommendation",
    `${path}.recommendation`,
  );
  check(
    uniqueStrings(blob.reasonCodes),
    "invalid-inventory-reason-codes",
    `${path}.reasonCodes`,
  );
}

function validateMaintenance(maintenance, path, check) {
  if (maintenance === null) return;
  const countKeys = [
    "looseObjects", "packedObjects", "packs", "sizeKiB", "garbageCount",
    "garbageSizeKiB", "prunePackable",
  ];
  const keys = [
    "id", ...countKeys, "interruptedOperations", "recommendation",
    "reasonCodes",
  ];
  if (!check(
    exactKeys(maintenance, keys),
    "invalid-maintenance-inventory",
    path,
  )) return;
  check(nonempty(maintenance.id), "invalid-maintenance-id", `${path}.id`);
  for (const key of countKeys) {
    check(
      nonnegative(maintenance[key]),
      "invalid-maintenance-count",
      `${path}.${key}`,
    );
  }
  check(
    oneOf(maintenance.recommendation, ["none", "inspect", "run-maintenance"]),
    "invalid-maintenance-recommendation",
    `${path}.recommendation`,
  );
  check(
    uniqueStrings(maintenance.reasonCodes),
    "invalid-inventory-reason-codes",
    `${path}.reasonCodes`,
  );
  if (!check(
    Array.isArray(maintenance.interruptedOperations),
    "invalid-interrupted-operations",
    `${path}.interruptedOperations`,
  )) return;
  const types = new Set();
  maintenance.interruptedOperations.forEach((operation, index) => {
    const operationPath = `${path}.interruptedOperations[${index}]`;
    if (!check(
      exactKeys(operation, ["type", "path"]),
      "invalid-interrupted-operation",
      operationPath,
    )) return;
    check(
      oneOf(operation.type, [
        "merge", "cherry-pick", "revert", "bisect", "rebase-merge",
        "rebase-apply", "sequencer",
      ]) && !types.has(operation.type),
      "invalid-interrupted-operation-type",
      `${operationPath}.type`,
    );
    types.add(operation.type);
    validateEncoded(operation.path, `${operationPath}.path`, check);
  });
}

export function validateInventory(
  inventory,
  request,
  objectFormat,
  coverageGaps,
  path,
  check,
) {
  if (!check(
    exactKeys(inventory, ["tags", "artifacts", "blobs", "maintenance"]),
    "invalid-result-inventory",
    path,
  )) return;
  validateList(
    inventory.tags,
    `${path}.tags`,
    (entry, entryPath, entryCheck) =>
      validateTag(entry, entryPath, objectFormat, entryCheck),
    check,
  );
  validateList(
    inventory.artifacts,
    `${path}.artifacts`,
    validateArtifact,
    check,
  );
  validateList(
    inventory.blobs,
    `${path}.blobs`,
    (entry, entryPath, entryCheck) =>
      validateBlob(entry, entryPath, objectFormat, entryCheck),
    check,
  );
  validateMaintenance(inventory.maintenance, `${path}.maintenance`, check);

  const scope = request?.scope;
  if (scope !== "all") {
    if (Array.isArray(inventory.tags)) {
      check(
        scope === "tags" || inventory.tags.length === 0,
        "out-of-scope-tag-inventory",
        `${path}.tags`,
      );
    }
    if (Array.isArray(inventory.artifacts)) {
      check(
        scope === "artifacts" || inventory.artifacts.length === 0,
        "out-of-scope-artifact-inventory",
        `${path}.artifacts`,
      );
    }
    if (Array.isArray(inventory.blobs)) {
      check(
        scope === "blobs" || inventory.blobs.length === 0,
        "out-of-scope-blob-inventory",
        `${path}.blobs`,
      );
    }
    check(
      scope === "maintenance" || inventory.maintenance === null,
      "out-of-scope-maintenance-inventory",
      `${path}.maintenance`,
    );
  }
  if (scope === "maintenance" || scope === "all") {
    const unavailable = Array.isArray(coverageGaps) &&
      coverageGaps.some((gap) =>
        gap?.code === "maintenance-inventory-unavailable");
    check(
      inventory.maintenance !== null || unavailable,
      "missing-maintenance-inventory",
      `${path}.maintenance`,
    );
    check(
      inventory.maintenance === null || !unavailable,
      "inconsistent-maintenance-inventory",
      `${path}.maintenance`,
    );
  }
}
