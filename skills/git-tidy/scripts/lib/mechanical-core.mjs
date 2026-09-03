import { createHash } from "node:crypto";

export const DISPOSITIONS = Object.freeze([
  "delete",
  "keep-save",
  "resume",
  "update-rebase",
  "merge-as-is",
  "open-pr",
  "defer",
]);

export const CARRIER_ACTIONS = Object.freeze([
  "keep",
  "delete-ref",
  "drop-stash",
  "remove-worktree",
  "no-action",
]);

export const DESTRUCTIVE_ACTIONS = Object.freeze([
  "delete-ref",
  "drop-stash",
  "remove-worktree",
]);

export const AUTHORITIES = Object.freeze([
  "mechanical",
  "content-review",
  "user-judgment",
]);

export const EVIDENCE_STATES = Object.freeze([
  "complete",
  "partial",
  "blocked",
]);

export const CONFIDENCE_STATES = Object.freeze([
  "proven",
  "strong",
  "indicative",
  "unknown",
]);

const EXACT_RELATIONSHIPS = new Set([
  "same-commit",
  "same-tree",
  "same-change-units",
  "worktree-branch",
  "tracking",
  "pr-head",
]);
const DESTRUCTIVE = new Set(DESTRUCTIVE_ACTIONS);
const DISPOSITION_SET = new Set(DISPOSITIONS);

export function isPlainObject(value) {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalize(value, seen) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Canonical JSON requires finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError("Canonical JSON does not support cycles");
    for (let index = 0; index < value.length; index += 1) {
      if (!(index in value)) throw new TypeError("Canonical JSON does not support sparse arrays");
    }
    seen.add(value);
    const result = `[${value.map((entry) => canonicalize(entry, seen)).join(",")}]`;
    seen.delete(value);
    return result;
  }
  if (!isPlainObject(value)) {
    throw new TypeError("Canonical JSON supports only JSON objects and arrays");
  }
  if (seen.has(value)) throw new TypeError("Canonical JSON does not support cycles");
  seen.add(value);
  const keys = Object.keys(value).sort();
  const fields = keys.map((key) => {
    const entry = value[key];
    if (entry === undefined || ["bigint", "function", "symbol"].includes(typeof entry)) {
      throw new TypeError("Canonical JSON does not coerce unsupported values");
    }
    return `${JSON.stringify(key)}:${canonicalize(entry, seen)}`;
  });
  seen.delete(value);
  return `{${fields.join(",")}}`;
}

export function canonicalJson(value) {
  return canonicalize(value, new Set());
}

export function stableId(type, identity) {
  if (typeof type !== "string" || type.length === 0) {
    throw new TypeError("Stable ID type must be a nonempty string");
  }
  const material = canonicalJson({ identity, type });
  return createHash("sha256").update(material, "utf8").digest("hex");
}

export function deepClone(value) {
  if (Array.isArray(value)) return value.map(deepClone);
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, deepClone(entry)]));
  }
  return value;
}

export function deepFreeze(value, seen = new Set()) {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const entry of Object.values(value)) deepFreeze(entry, seen);
  return Object.freeze(value);
}

export function immutableCopy(value) {
  return deepFreeze(deepClone(value));
}

export function compareIds(left, right) {
  return String(left).localeCompare(String(right), "en");
}

export function sortedUnique(values) {
  return [...new Set(values)].sort(compareIds);
}

function observedOid(carrier, name) {
  const value = carrier.observed?.[name] ?? carrier[name] ?? carrier.identity?.[name];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function normalizedCarrier(carrier) {
  if (!isPlainObject(carrier) || typeof carrier.type !== "string") {
    throw new TypeError("Every carrier must be an object with a type");
  }
  const identity = isPlainObject(carrier.identity) ? carrier.identity : {};
  const id = carrier.id ?? stableId(`carrier:${carrier.type}`, identity);
  if (typeof id !== "string" || id.length === 0) {
    throw new TypeError("Every carrier ID must be a nonempty string");
  }
  const result = deepClone(carrier);
  result.id = id;
  result.identity = deepClone(identity);
  result.changeUnitIds = sortedUnique(carrier.changeUnitIds ?? []);
  return result;
}

function makeDisjointSet(ids) {
  const parent = new Map(ids.map((id) => [id, id]));
  const find = (id) => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root);
    while (parent.get(id) !== id) {
      const next = parent.get(id);
      parent.set(id, root);
      id = next;
    }
    return root;
  };
  const union = (left, right) => {
    let leftRoot = find(left);
    let rightRoot = find(right);
    if (leftRoot === rightRoot) return;
    if (compareIds(leftRoot, rightRoot) > 0) [leftRoot, rightRoot] = [rightRoot, leftRoot];
    parent.set(rightRoot, leftRoot);
  };
  return { find, union };
}

function sameCompleteChangeUnits(left, right) {
  if (left.changeUnitsComplete !== true || right.changeUnitsComplete !== true) return false;
  if (left.changeUnitIds.length === 0 || left.changeUnitIds.length !== right.changeUnitIds.length) {
    return false;
  }
  return left.changeUnitIds.every((id, index) => id === right.changeUnitIds[index]);
}

function unionIndexed(index, key, carrierId, set) {
  if (key === null) return;
  const existing = index.get(key);
  if (existing === undefined) {
    index.set(key, carrierId);
  } else {
    set.union(existing, carrierId);
  }
}

function connectEquivalentCarriers(carriers, set) {
  const commits = new Map();
  const trees = new Map();
  const changeSets = new Map();
  for (const carrier of carriers) {
    unionIndexed(commits, observedOid(carrier, "commitOid"), carrier.id, set);
    unionIndexed(trees, observedOid(carrier, "treeOid"), carrier.id, set);
    const changeSet = carrier.changeUnitsComplete === true
      && carrier.changeUnitIds.length > 0
      ? canonicalJson(carrier.changeUnitIds)
      : null;
    unionIndexed(changeSets, changeSet, carrier.id, set);
  }
}

function addOverlaps(items, maxComparisons) {
  const itemIndexesByUnit = new Map();
  const sharedByPair = new Map();
  let comparisons = 0;
  let truncated = false;
  outer:
  for (const [itemIndex, item] of items.entries()) {
    for (const unitId of item.changeUnitIds) {
      const previous = itemIndexesByUnit.get(unitId) ?? [];
      for (const otherIndex of previous) {
        if (comparisons >= maxComparisons) {
          truncated = true;
          break outer;
        }
        comparisons += 1;
        const key = `${otherIndex}:${itemIndex}`;
        const shared = sharedByPair.get(key) ?? [];
        shared.push(unitId);
        sharedByPair.set(key, shared);
      }
      previous.push(itemIndex);
      itemIndexesByUnit.set(unitId, previous);
    }
  }
  for (const [key, shared] of sharedByPair) {
    const [leftIndex, rightIndex] = key.split(":").map(Number);
    const left = items[leftIndex];
    const right = items[rightIndex];
    left.overlaps.push({
      otherWorkItemId: right.id,
      changeUnitIds: shared,
      relation: "partial",
    });
    right.overlaps.push({
      otherWorkItemId: left.id,
      changeUnitIds: shared,
      relation: "partial",
    });
  }
  for (const item of items) {
    item.overlaps.sort((left, right) =>
      compareIds(left.otherWorkItemId, right.otherWorkItemId));
  }
  return { comparisons, truncated };
}

function relationMatches(relation, left, right) {
  if (!isPlainObject(relation) || relation.exact !== true || !EXACT_RELATIONSHIPS.has(relation.type)) {
    return false;
  }
  switch (relation.type) {
    case "same-commit": {
      const oid = relation.commitOid;
      return typeof oid === "string"
        && observedOid(left, "commitOid") === oid
        && observedOid(right, "commitOid") === oid;
    }
    case "same-tree": {
      const oid = relation.treeOid;
      return typeof oid === "string"
        && observedOid(left, "treeOid") === oid
        && observedOid(right, "treeOid") === oid;
    }
    case "same-change-units":
      return sameCompleteChangeUnits(left, right);
    case "worktree-branch": {
      const types = new Set([left.type, right.type]);
      if (!types.has("worktree") || !types.has("local-branch")) return false;
      const worktree = left.type === "worktree" ? left : right;
      const branch = left.type === "local-branch" ? left : right;
      return typeof relation.headOid === "string"
        && observedOid(worktree, "headOid") === relation.headOid
        && observedOid(branch, "tipOid") === relation.headOid
        && (worktree.observed?.branchCarrierId === branch.id
          || relation.branchCarrierId === branch.id);
    }
    case "tracking": {
      const types = new Set([left.type, right.type]);
      if (!types.has("local-branch") || !types.has("remote-branch")) return false;
      const local = left.type === "local-branch" ? left : right;
      const remote = left.type === "remote-branch" ? left : right;
      return typeof relation.localOid === "string"
        && typeof relation.remoteOid === "string"
        && observedOid(local, "tipOid") === relation.localOid
        && observedOid(remote, "tipOid") === relation.remoteOid
        && (local.observed?.upstreamCarrierId === remote.id
          || relation.remoteCarrierId === remote.id);
    }
    case "pr-head": {
      if (typeof relation.repositoryId !== "string" || typeof relation.headOid !== "string") {
        return false;
      }
      const matchesHead = (carrier) => [
        observedOid(carrier, "tipOid"),
        observedOid(carrier, "headOid"),
        observedOid(carrier, "commitOid"),
      ].includes(relation.headOid);
      const matchesRepository = (carrier) => carrier.identity?.repositoryId === relation.repositoryId
        || carrier.observed?.repositoryId === relation.repositoryId;
      return [left, right].every((carrier) => matchesHead(carrier) && matchesRepository(carrier))
        && [left, right].some((carrier) => carrier.type === "remote-branch");
    }
    default:
      return false;
  }
}

export function groupWorkItemsWithCoverage(
  carriers,
  relationships = [],
  { maxComparisons = 20_000 } = {},
) {
  if (!Array.isArray(carriers) || !Array.isArray(relationships)) {
    throw new TypeError("Carriers and relationships must be arrays");
  }
  if (!Number.isSafeInteger(maxComparisons) || maxComparisons < 0) {
    throw new TypeError("maxComparisons must be a nonnegative safe integer");
  }
  const normalized = carriers.map(normalizedCarrier).sort((a, b) => compareIds(a.id, b.id));
  const byId = new Map();
  for (const carrier of normalized) {
    if (byId.has(carrier.id)) throw new TypeError(`Duplicate carrier ID: ${carrier.id}`);
    byId.set(carrier.id, carrier);
  }
  const set = makeDisjointSet(normalized.map(({ id }) => id));
  connectEquivalentCarriers(normalized, set);

  for (const relation of relationships) {
    const left = byId.get(relation?.leftId);
    const right = byId.get(relation?.rightId);
    if (left && right && relationMatches(relation, left, right)) set.union(left.id, right.id);
  }

  const groups = new Map();
  for (const carrier of normalized) {
    const root = set.find(carrier.id);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(carrier);
  }
  const items = [...groups.values()].map((members) => {
    const sortedMembers = members.sort((a, b) => compareIds(a.id, b.id));
    const carrierIds = sortedMembers.map(({ id }) => id);
    const changeUnitIds = sortedUnique(sortedMembers.flatMap((entry) => entry.changeUnitIds));
    return {
      id: stableId("work-item", { carrierIds, changeUnitIds }),
      carrierIds,
      changeUnitIds,
      carriers: sortedMembers.map(deepClone),
      overlaps: [],
    };
  }).sort((a, b) => compareIds(a.id, b.id));

  const overlapCoverage = addOverlaps(items, maxComparisons);
  return deepFreeze({
    workItems: items,
    overlapCoverage,
  });
}

export function groupWorkItems(carriers, relationships = []) {
  return groupWorkItemsWithCoverage(carriers, relationships).workItems;
}

export function categorizeEvidence({
  authority = "mechanical",
  coverage = "complete",
  exact = false,
  corroborated = false,
  blockers = [],
} = {}) {
  if (!AUTHORITIES.includes(authority)) throw new TypeError(`Unknown authority: ${authority}`);
  if (!EVIDENCE_STATES.includes(coverage)) throw new TypeError(`Unknown evidence state: ${coverage}`);
  if (!Array.isArray(blockers)) throw new TypeError("Blockers must be an array");

  const evidence = blockers.length > 0 ? "blocked" : coverage;
  let confidence = "unknown";
  if (evidence !== "blocked") {
    if (authority === "mechanical") {
      if (evidence === "complete" && exact) confidence = "proven";
      else if (corroborated) confidence = "strong";
    } else if (exact || corroborated) {
      confidence = "indicative";
    }
  }
  return deepFreeze({ authority, evidence, confidence });
}

export function setDisposition(workItem, recommendation) {
  if (!isPlainObject(workItem)) throw new TypeError("Work item must be an object");
  if (!DISPOSITION_SET.has(recommendation)) {
    throw new TypeError(`Unknown disposition: ${recommendation}`);
  }
  const result = deepClone(workItem);
  result.recommendation = recommendation;
  return deepFreeze(result);
}

function carrierCanWitness(carrier, selected) {
  return !selected.has(carrier.id)
    && carrier.type !== "pull-request"
    && carrier.durability === "durable"
    && carrier.changeUnitsComplete === true
    && carrier.evidence === "complete"
    && carrier.identityCurrent === true
    && (carrier.protection === "protected" || carrier.protection === "unprotected")
    && carrier.protectionEvidence === "complete"
    && carrier.survives === true
    && !DESTRUCTIVE.has(carrier.action);
}

export function validateLastCopyBatch(carriers, selectedCarrierIds) {
  if (!Array.isArray(carriers) || !Array.isArray(selectedCarrierIds)) {
    throw new TypeError("Carriers and selected carrier IDs must be arrays");
  }
  const normalized = carriers.map(normalizedCarrier).sort((a, b) => compareIds(a.id, b.id));
  const byId = new Map(normalized.map((carrier) => [carrier.id, carrier]));
  const selectedIds = sortedUnique(selectedCarrierIds);
  const selected = new Set(selectedIds);
  const diagnostics = [];
  const witnessesByCarrier = {};
  const unwitnessed = [];

  if (byId.size !== normalized.length) diagnostics.push({ code: "duplicate-carrier-id" });
  if (selected.size !== selectedCarrierIds.length) diagnostics.push({ code: "duplicate-selected-id" });
  for (const id of selectedIds) {
    if (!byId.has(id)) diagnostics.push({ code: "unknown-selected-id", carrierId: id });
  }
  const witnessIdsByUnit = new Map();
  for (const candidate of normalized) {
    if (!carrierCanWitness(candidate, selected)) continue;
    for (const changeUnitId of candidate.changeUnitIds) {
      const witnessIds = witnessIdsByUnit.get(changeUnitId) ?? [];
      witnessIds.push(candidate.id);
      witnessIdsByUnit.set(changeUnitId, witnessIds);
    }
  }
  for (const id of selectedIds) {
    const carrier = byId.get(id);
    if (!carrier) continue;
    const units = {};
    for (const changeUnitId of carrier.changeUnitIds) {
      const witnessIds = witnessIdsByUnit.get(changeUnitId) ?? [];
      units[changeUnitId] = witnessIds;
      if (witnessIds.length === 0) {
        unwitnessed.push({ carrierId: id, changeUnitId });
      }
    }
    witnessesByCarrier[id] = units;
  }
  if (unwitnessed.length > 0) diagnostics.push({ code: "last-copy-unwitnessed" });
  return deepFreeze({
    valid: diagnostics.length === 0,
    selectedCarrierIds: selectedIds,
    witnessesByCarrier,
    unwitnessed,
    diagnostics,
  });
}

export function compatibilityCategory(item) {
  const blockerFree = (item.blockers?.length ?? 0) === 0;
  const preservationKnown = (item.preservation?.unwitnessedChangeUnitIds?.length ?? 0) === 0
    && item.preservation?.uncertain !== true;
  const complete = item.evidence === "complete";
  if (item.authority === "mechanical"
    && item.confidence === "proven"
    && complete
    && blockerFree
    && preservationKnown) {
    return "high";
  }
  if (blockerFree
    && preservationKnown
    && complete
    && ((item.authority === "mechanical" && item.confidence === "strong")
      || item.authority === "user-judgment")) {
    return "medium";
  }
  return "low";
}

export function projectCompatibility(workItems) {
  if (!Array.isArray(workItems)) throw new TypeError("Work items must be an array");
  const projection = { high: [], medium: [], low: [] };
  for (const item of [...workItems].sort((a, b) => compareIds(a.id, b.id))) {
    projection[compatibilityCategory(item)].push(item.id);
  }
  return deepFreeze(projection);
}
