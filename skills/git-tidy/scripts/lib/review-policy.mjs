export { validateMechanicalResult } from "./result-schema.mjs";
import {
  canonicalJson,
  compareIds,
  deepClone,
  deepFreeze,
  immutableCopy,
  isPlainObject,
  projectCompatibility,
  sortedUnique,
} from "./mechanical-core.mjs";

export const REVIEW_RISK_FLAGS = Object.freeze([
  "partial-work",
  "security-sensitive",
  "behavior-change",
  "data-migration",
  "api-change",
  "test-gap",
  "conflict-risk",
  "unclear-intent",
]);

const DESTRUCTIVE = new Set(["delete-ref", "drop-stash", "remove-worktree"]);
const RISK_FLAG_SET = new Set(REVIEW_RISK_FLAGS);
const EVIDENCE_RANK = new Map(["complete", "partial", "blocked"]
  .map((value, index) => [value, index]));
const CONFIDENCE_RANK = new Map(["proven", "strong", "indicative", "unknown"]
  .map((value, index) => [value, index]));
const SAFE_RECOMMENDATIONS = new Set(["keep-save", "resume", "defer"]);
const VALID_TRANSITIONS = Object.freeze({
  delete: new Set(["keep-save", "resume", "defer"]),
  "keep-save": new Set(["keep-save", "defer"]),
  resume: new Set(["keep-save", "resume", "defer"]),
  "update-rebase": new Set(["keep-save", "resume", "defer"]),
  "merge-as-is": new Set(["keep-save", "resume", "defer"]),
  "open-pr": new Set(["keep-save", "resume", "defer"]),
  defer: new Set(["defer"]),
});

function exactKeys(value, keys) {
  if (!isPlainObject(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function charLength(value) {
  return [...value].length;
}

function collectKnownForbiddenStrings(mechanicalResult) {
  const strings = new Set();
  const visit = (value, key = "") => {
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry, key);
    } else if (isPlainObject(value)) {
      for (const [childKey, entry] of Object.entries(value)) visit(entry, childKey);
    } else if (typeof value === "string"
      && /(?:display|displayName|path|ref|url)/iu.test(key)
      && value.length >= 2) {
      strings.add(value);
    }
  };
  visit(mechanicalResult?.repository);
  for (const item of mechanicalResult?.workItems ?? []) {
    for (const carrier of item.carriers ?? []) {
      if (typeof carrier.id === "string") strings.add(carrier.id);
      visit(carrier);
    }
    for (const unit of item.changeUnits ?? []) visit(unit);
  }
  return [...strings].sort((a, b) => b.length - a.length || compareIds(a, b));
}

function forbiddenTextCode(value, knownStrings) {
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value)) {
    return "unsafe-control";
  }
  if (/(?:begin|end)[^\r\n]{0,48}(?:external|untrusted)[-_ ]?data|(?:external|untrusted)[-_ ]?data[^\r\n]{0,24}(?:begin|end)|<\/?external[-_ ]?data/iu.test(value)) {
    return "boundary-token";
  }
  if (/(?:\b[a-z][a-z0-9+.-]{1,31}:\/\/|\b(?:mailto|data|file|ssh|git):\S|\bwww\.|\b(?:[\w.-]+@)?[\w.-]+\.[a-z]{2,}(?::|\/)\S+)/iu.test(value)) {
    return "uri";
  }
  if (/(?:^|[^0-9a-f])[0-9a-f]{40}(?:[^0-9a-f]|$)|(?:^|[^0-9a-f])[0-9a-f]{64}(?:[^0-9a-f]|$)/iu.test(value)) {
    return "raw-oid";
  }
  if (/(?:^|\r?\n)\s*(?:[$>]\s*)?(?:(?:git|gh)\s+\S|(?:rm|del|erase|remove-item|curl|wget|invoke-webrequest|npm|npx|pnpm|yarn|node|python|dotnet|go|cargo|make|cmake|echo|cat|type|copy|move|mv|cp)\s+\S|(?:cmd|powershell|pwsh|bash|sh)\s+(?:\/c|-c|-command)\b)|\b(?:run|execute)\s+(?:git|gh|rm|del|erase|remove-item|curl|wget|npm|npx|pnpm|yarn|node|python|dotnet|go|cargo|make)\b|\$\([^)]*\)/iu.test(value)) {
    return "command";
  }
  if (/\brefs\/(?:heads|remotes|tags)\/\S+|refs\/stash\b|stash@\{\d+\}/iu.test(value)) {
    return "ref";
  }
  if (/(?:^|[\s("'`])(?:[a-z]:\\|\\\\|\/(?!\/)|\.\.?[\\/])\S+|(?:^|[\s("'`])[\w.-]{2,}[\\/][\w.\\/-]{2,}\b/ium.test(value)) {
    return "path";
  }
  if (knownStrings.some((known) => value.includes(known))) return "known-identity";
  return null;
}

function diagnostic(code, path) {
  return { code, path };
}

export function validateReview(mechanicalResult, review) {
  const diagnostics = [];
  const knownIds = new Set((mechanicalResult?.workItems ?? []).map(({ id }) => id));
  const forbiddenStrings = collectKnownForbiddenStrings(mechanicalResult);

  if (!exactKeys(review, ["schemaVersion", "items"])) {
    diagnostics.push(diagnostic("invalid-root-shape", "$"));
  } else {
    if (review.schemaVersion !== "1.0.0") {
      diagnostics.push(diagnostic("unsupported-schema-version", "$.schemaVersion"));
    }
    if (!Array.isArray(review.items)) {
      diagnostics.push(diagnostic("items-not-array", "$.items"));
    } else {
      if (review.items.length > 20) diagnostics.push(diagnostic("too-many-items", "$.items"));
      const seenIds = new Set();
      review.items.forEach((item, index) => {
        const path = `$.items[${index}]`;
        if (!exactKeys(item, [
          "workItemId",
          "summary",
          "riskFlags",
          "recommendation",
          "reasons",
        ])) {
          diagnostics.push(diagnostic("invalid-item-shape", path));
          return;
        }
        if (typeof item.workItemId !== "string" || !knownIds.has(item.workItemId)) {
          diagnostics.push(diagnostic("unknown-work-item-id", `${path}.workItemId`));
        } else if (seenIds.has(item.workItemId)) {
          diagnostics.push(diagnostic("duplicate-work-item-id", `${path}.workItemId`));
        }
        seenIds.add(item.workItemId);

        if (typeof item.summary !== "string" || charLength(item.summary) > 2000) {
          diagnostics.push(diagnostic("invalid-summary", `${path}.summary`));
        } else {
          const code = forbiddenTextCode(item.summary, forbiddenStrings);
          if (code) diagnostics.push(diagnostic(`forbidden-${code}`, `${path}.summary`));
        }

        if (!Array.isArray(item.riskFlags) || item.riskFlags.length > 8) {
          diagnostics.push(diagnostic("invalid-risk-flags", `${path}.riskFlags`));
        } else {
          const seenFlags = new Set();
          for (const flag of item.riskFlags) {
            if (typeof flag !== "string" || !RISK_FLAG_SET.has(flag)) {
              diagnostics.push(diagnostic("unknown-risk-flag", `${path}.riskFlags`));
            } else if (seenFlags.has(flag)) {
              diagnostics.push(diagnostic("duplicate-risk-flag", `${path}.riskFlags`));
            }
            seenFlags.add(flag);
          }
        }

        if (!SAFE_RECOMMENDATIONS.has(item.recommendation)) {
          diagnostics.push(diagnostic("invalid-review-recommendation", `${path}.recommendation`));
        }

        if (!Array.isArray(item.reasons) || item.reasons.length > 10) {
          diagnostics.push(diagnostic("invalid-reasons", `${path}.reasons`));
        } else {
          item.reasons.forEach((reason, reasonIndex) => {
            const reasonPath = `${path}.reasons[${reasonIndex}]`;
            if (typeof reason !== "string" || charLength(reason) < 1 || charLength(reason) > 500) {
              diagnostics.push(diagnostic("invalid-reason", reasonPath));
            } else {
              const code = forbiddenTextCode(reason, forbiddenStrings);
              if (code) diagnostics.push(diagnostic(`forbidden-${code}`, reasonPath));
            }
          });
        }
      });
    }
  }
  return deepFreeze({ valid: diagnostics.length === 0, diagnostics });
}

function containsByCanonical(superset, subset) {
  const values = new Set((superset ?? []).map(canonicalJson));
  return (subset ?? []).every((entry) => values.has(canonicalJson(entry)));
}

function sameValue(left, right) {
  if (left === undefined || right === undefined) return left === right;
  return canonicalJson(left) === canonicalJson(right);
}

function carrierTransitionDiagnostics(before, after, path) {
  const diagnostics = [];
  for (const field of [
    "id",
    "type",
    "displayName",
    "identity",
    "observed",
    "changeUnitIds",
    "durability",
    "protection",
    "observations",
    "prerequisiteIds",
  ]) {
    if (!sameValue(before[field], after[field])) {
      diagnostics.push(diagnostic("changed-carrier-fact", `${path}.${field}`));
    }
  }
  if (!containsByCanonical(before.preservationWitnessIds, after.preservationWitnessIds)) {
    diagnostics.push(diagnostic("added-witness", `${path}.preservationWitnessIds`));
  }
  if (!containsByCanonical(after.blockerCodes, before.blockerCodes)) {
    diagnostics.push(diagnostic("removed-carrier-blocker", `${path}.blockerCodes`));
  }
  if (before.eligible === false && after.eligible === true) {
    diagnostics.push(diagnostic("increased-eligibility", `${path}.eligible`));
  }
  const beforeDestructive = DESTRUCTIVE.has(before.action);
  const afterDestructive = DESTRUCTIVE.has(after.action);
  if ((!beforeDestructive && afterDestructive)
    || (beforeDestructive && afterDestructive && before.action !== after.action)) {
    diagnostics.push(diagnostic("strengthened-carrier-action", `${path}.action`));
  }
  return diagnostics;
}

export function validateMonotoneTransition(before, after) {
  const diagnostics = [];
  if (!isPlainObject(before) || !isPlainObject(after) || before.id !== after.id) {
    return deepFreeze({
      valid: false,
      diagnostics: [diagnostic("changed-work-item-identity", "$")],
    });
  }
  for (const key of Object.keys(after)) {
    if (!(key in before) && key !== "review") {
      diagnostics.push(diagnostic("added-work-item-field", `$.${key}`));
    }
  }
  for (const field of ["id", "changeUnits", "overlaps", "preservation"]) {
    if (!sameValue(before[field], after[field])) {
      diagnostics.push(diagnostic("changed-work-item-fact", `$.${field}`));
    }
  }
  if (!VALID_TRANSITIONS[before.recommendation]?.has(after.recommendation)) {
    diagnostics.push(diagnostic("unsafe-recommendation-transition", "$.recommendation"));
  }
  if ((EVIDENCE_RANK.get(after.evidence) ?? -1) < (EVIDENCE_RANK.get(before.evidence) ?? -1)) {
    diagnostics.push(diagnostic("improved-evidence", "$.evidence"));
  }
  if ((CONFIDENCE_RANK.get(after.confidence) ?? -1)
    < (CONFIDENCE_RANK.get(before.confidence) ?? -1)) {
    diagnostics.push(diagnostic("improved-confidence", "$.confidence"));
  }
  if (after.authority !== before.authority && after.authority !== "content-review") {
    diagnostics.push(diagnostic("strengthened-authority", "$.authority"));
  }
  if (before.review !== null
    && before.review !== undefined
    && !sameValue(before.review, after.review)) {
    diagnostics.push(diagnostic("changed-applied-review", "$.review"));
  } else if (!sameValue(before.review, after.review) && after.review !== null) {
    if (!exactKeys(after.review, [
      "schemaVersion",
      "summary",
      "riskFlags",
      "recommendation",
      "reasons",
    ])
      || after.review.schemaVersion !== "1.0.0"
      || typeof after.review.summary !== "string"
      || forbiddenTextCode(after.review.summary, []) !== null
      || !Array.isArray(after.review.riskFlags)
      || after.review.riskFlags.some((flag) => !RISK_FLAG_SET.has(flag))
      || !SAFE_RECOMMENDATIONS.has(after.review.recommendation)
      || !Array.isArray(after.review.reasons)
      || after.review.reasons.some((reason) => typeof reason !== "string"
        || forbiddenTextCode(reason, []) !== null)) {
      diagnostics.push(diagnostic("invalid-applied-review", "$.review"));
    }
  }
  if (!containsByCanonical(after.blockers, before.blockers)) {
    diagnostics.push(diagnostic("removed-blocker", "$.blockers"));
  }
  if (!containsByCanonical(after.reasons, before.reasons)) {
    diagnostics.push(diagnostic("removed-reason", "$.reasons"));
  }
  if (!Array.isArray(before.carriers)
    || !Array.isArray(after.carriers)
    || before.carriers.length !== after.carriers.length) {
    diagnostics.push(diagnostic("changed-carrier-set", "$.carriers"));
  } else {
    const beforeById = new Map(before.carriers.map((carrier) => [carrier.id, carrier]));
    after.carriers.forEach((carrier, index) => {
      const original = beforeById.get(carrier.id);
      if (!original) diagnostics.push(diagnostic("added-carrier", `$.carriers[${index}]`));
      else diagnostics.push(...carrierTransitionDiagnostics(original, carrier, `$.carriers[${index}]`));
    });
  }
  return deepFreeze({ valid: diagnostics.length === 0, diagnostics });
}

function sortCanonical(values) {
  return [...values].sort((left, right) => compareIds(canonicalJson(left), canonicalJson(right)));
}

function applyReviewItem(item, reviewItem) {
  const result = deepClone(item);
  result.recommendation = reviewItem.recommendation;
  result.authority = "content-review";
  result.review = {
    schemaVersion: "1.0.0",
    summary: reviewItem.summary,
    riskFlags: [...reviewItem.riskFlags],
    recommendation: reviewItem.recommendation,
    reasons: [...reviewItem.reasons],
  };
  result.confidence = CONFIDENCE_RANK.get(result.confidence) < CONFIDENCE_RANK.get("indicative")
    ? "indicative"
    : result.confidence;

  const addedBlockers = reviewItem.riskFlags.map((flag) => ({
    code: `review-risk:${flag}`,
    subjectIds: [item.id],
    reason: `Content review identified ${flag}.`,
  }));
  if (addedBlockers.length > 0) {
    result.evidence = "blocked";
    result.confidence = "unknown";
  }
  result.blockers = sortCanonical([...(result.blockers ?? []), ...addedBlockers]);
  result.reasons = sortCanonical([
    ...(result.reasons ?? []),
    ...reviewItem.reasons.map((summary) => ({
      code: "content-review",
      source: "review",
      subjectId: item.id,
      summary,
    })),
  ]);
  result.carriers = (result.carriers ?? []).map((carrier) => {
    if (!DESTRUCTIVE.has(carrier.action)) return carrier;
    return {
      ...carrier,
      action: "no-action",
      eligible: false,
      blockerCodes: sortedUnique([
        ...(carrier.blockerCodes ?? []),
        "content-review-non-authoritative",
      ]),
    };
  }).sort((left, right) => compareIds(left.id, right.id));
  return result;
}

export function applyReview(mechanicalResult, review) {
  const original = immutableCopy(mechanicalResult);
  const validation = validateReview(original, review);
  if (!validation.valid) {
    return deepFreeze({ accepted: false, result: original, diagnostics: validation.diagnostics });
  }

  const result = deepClone(original);
  const reviewById = new Map(review.items.map((item) => [item.workItemId, item]));
  const transitionDiagnostics = [];
  result.workItems = result.workItems.map((item) => {
    const reviewItem = reviewById.get(item.id);
    if (!reviewItem) return item;
    const candidate = applyReviewItem(item, reviewItem);
    const transition = validateMonotoneTransition(item, candidate);
    transitionDiagnostics.push(...transition.diagnostics.map((entry) => ({
      ...entry,
      workItemId: item.id,
    })));
    return candidate;
  }).sort((left, right) => compareIds(left.id, right.id));

  if (transitionDiagnostics.length > 0) {
    return deepFreeze({ accepted: false, result: original, diagnostics: transitionDiagnostics });
  }
  if ("compatibility" in result) result.compatibility = projectCompatibility(result.workItems);
  return deepFreeze({ accepted: true, result, diagnostics: [] });
}
