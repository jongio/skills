import { sanitizeSnapshot } from "./cache-store.mjs";
import { compareText, equivalent } from "./stable-json.mjs";

export const DELTA_CLASSIFICATIONS = [
  "Added",
  "Changed",
  "Resolved",
  "Unchanged",
  "Not reverified",
];

function comparableCheck(check) {
  if (!check) return null;
  const { observedAt: _observedAt, ...comparable } = check;
  return comparable;
}

// A check recorded as "Not verified" carries a current timestamp but no
// current evidence: the audit tried and could not confirm it. Treating that
// timestamp as freshness would let an unverified control report as
// "Unchanged", which the reporting rules define as fresh evidence matching the
// cached value. That is false assurance in a security report, so the state
// gates freshness alongside the timestamp.
const NO_EVIDENCE_STATE = "Not verified";

function hasFreshEvidence(check, previousGeneratedAt) {
  return (
    check !== undefined &&
    check.state !== NO_EVIDENCE_STATE &&
    new Date(check.observedAt) > new Date(previousGeneratedAt)
  );
}

function hasFreshHealthyEvidence(check, previousGeneratedAt) {
  return (
    hasFreshEvidence(check, previousGeneratedAt) &&
    check.state === "Verified" &&
    check.health === "Healthy"
  );
}

function keysFor(previous, current) {
  return [...new Set([...Object.keys(previous), ...Object.keys(current)])].sort(compareText);
}

function deltaItem(kind, key, classification, previous, current) {
  return { kind, key, classification, previous: previous ?? null, current: current ?? null };
}

function classifyCheck(before, after, previousGeneratedAt) {
  if (!after || !hasFreshEvidence(after, previousGeneratedAt)) return "Not reverified";
  if (!before) return "Added";
  return equivalent(comparableCheck(before), comparableCheck(after)) ? "Unchanged" : "Changed";
}

function classifyFinding(key, before, after, currentChecks, previousGeneratedAt) {
  const checkId = key.split(":", 1)[0];
  // Own-property lookup only: a key such as "toString:foo" would otherwise
  // resolve to an inherited function from Object.prototype.
  const check = Object.hasOwn(currentChecks, checkId) ? currentChecks[checkId] : undefined;
  if (after && !before) {
    return hasFreshEvidence(check, previousGeneratedAt) ? "Added" : "Not reverified";
  }
  if (after && before) {
    if (!hasFreshEvidence(check, previousGeneratedAt)) return "Not reverified";
    if (before.status === "open" && after.status === "resolved") {
      return hasFreshHealthyEvidence(check, previousGeneratedAt) ? "Resolved" : "Changed";
    }
    return equivalent(before, after) ? "Unchanged" : "Changed";
  }
  return before?.status === "open" && hasFreshHealthyEvidence(check, previousGeneratedAt)
    ? "Resolved"
    : "Not reverified";
}

function classifyRemediation(before, after) {
  if (!after) return "Not reverified";
  if (!before) return "Added";
  return equivalent(before, after) ? "Unchanged" : "Changed";
}

export function classifyDelta(previousValue, currentValue) {
  const previous = sanitizeSnapshot(previousValue);
  const current = sanitizeSnapshot(currentValue, previous.domain);
  const items = [];

  if (!equivalent(previous.scope, current.scope)) {
    items.push(deltaItem("scope", "scope", "Changed", previous.scope, current.scope));
  }

  for (const key of keysFor(previous.checks, current.checks)) {
    const before = previous.checks[key];
    const after = current.checks[key];
    items.push(deltaItem(
      "check",
      key,
      classifyCheck(before, after, previous.generatedAt),
      before,
      after,
    ));
  }

  for (const key of keysFor(previous.findings, current.findings)) {
    const before = previous.findings[key];
    const after = current.findings[key];
    items.push(deltaItem(
      "finding",
      key,
      classifyFinding(key, before, after, current.checks, previous.generatedAt),
      before,
      after,
    ));
  }

  for (const key of keysFor(previous.remediation, current.remediation)) {
    const before = previous.remediation[key];
    const after = current.remediation[key];
    items.push(deltaItem(
      "remediation",
      key,
      classifyRemediation(before, after),
      before,
      after,
    ));
  }

  const counts = Object.fromEntries(DELTA_CLASSIFICATIONS.map((classification) => [classification, 0]));
  for (const item of items) {
    if (!(item.classification in counts)) {
      throw new Error(`unknown delta classification: ${item.classification}`);
    }
    counts[item.classification]++;
  }
  return {
    domain: current.domain,
    previousGeneratedAt: previous.generatedAt,
    currentGeneratedAt: current.generatedAt,
    counts,
    items,
  };
}
