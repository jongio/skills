import assert from "node:assert/strict";
import test from "node:test";

import {
  CARRIER_ACTIONS,
  CONFIDENCE_STATES,
  DISPOSITIONS,
  EVIDENCE_STATES,
  canonicalJson,
  categorizeEvidence,
  groupWorkItems,
  groupWorkItemsWithCoverage,
  projectCompatibility,
  setDisposition,
  stableId,
  validateLastCopyBatch,
} from "../scripts/lib/mechanical-core.mjs";
import {
  applyReview,
  validateMonotoneTransition,
  validateReview,
} from "../scripts/lib/review-policy.mjs";

const oid = (character) => character.repeat(40);

function carrier(id, {
  type = "local-branch",
  units = ["unit-a"],
  action = "keep",
  eligible = false,
  witnesses = [],
  blockers = [],
  durability = "durable",
  protection = "unprotected",
  evidence = "complete",
  identityCurrent = true,
  protectionEvidence = "complete",
  survives = true,
  displayName = id,
  identity = { refRawBase64: Buffer.from(id).toString("base64"), tipOid: oid("a") },
  observed = { tipOid: oid("a") },
  ...extra
} = {}) {
  return {
    id,
    type,
    displayName,
    identity,
    observed,
    changeUnitIds: units,
    changeUnitsComplete: true,
    durability,
    protection,
    evidence,
    identityCurrent,
    protectionEvidence,
    survives,
    observations: [],
    action,
    eligible,
    preservationWitnessIds: witnesses,
    prerequisiteIds: [],
    blockerCodes: blockers,
    ...extra,
  };
}

function workItem(id = "work-1", overrides = {}) {
  return {
    id,
    changeUnits: [{
      id: "unit-a",
      path: { rawBase64: "c3JjL2FwcC5qcw==", display: "src/app.js" },
      oldMode: "100644",
      newMode: "100644",
      oldOid: oid("1"),
      newOid: oid("2"),
      kind: "modify",
      binary: false,
      sourceComponent: "tracked",
    }],
    overlaps: [],
    recommendation: "resume",
    authority: "mechanical",
    evidence: "complete",
    confidence: "proven",
    reasons: [{
      code: "exact",
      source: "git",
      subjectId: id,
      summary: "Exact mechanical observation.",
    }],
    blockers: [],
    preservation: {
      lastCopy: false,
      durableCarrierIds: ["branch-main"],
      unwitnessedChangeUnitIds: [],
    },
    review: null,
    carriers: [carrier("branch-topic", {
      action: "delete-ref",
      eligible: true,
      witnesses: ["branch-main"],
    })],
    ...overrides,
  };
}

function mechanicalResult(items = [workItem()]) {
  return {
    schemaVersion: "1.1.0",
    operation: "analyze",
    runId: stableId("run", { fixture: true }),
    generatedAt: "2026-08-28T00:00:00Z",
    repository: {
      objectFormat: "sha1",
      commonDir: { rawBase64: "LmdpdA==", display: ".git" },
      primaryWorktree: { rawBase64: "QzpcXHJlcG8=", display: "C:\\repo" },
      remotes: [],
    },
    request: { scope: "all", depth: "review", includeIgnored: false, limits: {} },
    workItems: items,
    inventory: {
      tags: [],
      artifacts: [],
      blobs: [],
      maintenance: null,
    },
    coverage: {
      state: "complete",
      observedCounts: {},
      skippedCounts: {},
      gaps: [],
      limitsReached: [],
      capabilities: [],
    },
    actionPlan: null,
    drift: [],
    compatibility: projectCompatibility(items),
  };
}

function reviewItem(workItemId = "work-1", overrides = {}) {
  return {
    workItemId,
    summary: "A cohesive behavior adjustment.",
    riskFlags: [],
    recommendation: "resume",
    reasons: ["The work appears coherent and should be preserved."],
    ...overrides,
  };
}

function review(items = [reviewItem()]) {
  return { schemaVersion: "1.0.0", items };
}

function transition(overridesBefore = {}, overridesAfter = {}) {
  const before = workItem("transition", overridesBefore);
  const after = structuredClone(before);
  Object.assign(after, overridesAfter);
  return validateMonotoneTransition(before, after);
}

test("canonicalJson and stableId are deterministic, typed, and strict", () => {
  assert.equal(canonicalJson({ z: 1, a: { d: 2, b: 1 } }), '{"a":{"b":1,"d":2},"z":1}');
  assert.equal(
    stableId("carrier:stash", { b: 2, a: 1 }),
    stableId("carrier:stash", { a: 1, b: 2 }),
  );
  assert.match(stableId("carrier:stash", { a: 1 }), /^[0-9a-f]{64}$/);
  assert.notEqual(
    stableId("carrier:stash", { a: 1 }),
    stableId("carrier:local-branch", { a: 1 }),
  );
  assert.throws(() => canonicalJson({ invalid: undefined }), /does not coerce/);
  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(() => canonicalJson(cyclic), /cycles/);
  assert.equal(canonicalJson([null, true, 3, "x"]), '[null,true,3,"x"]');
  assert.throws(() => canonicalJson(Number.POSITIVE_INFINITY), /finite/);
  assert.throws(() => canonicalJson(new Date()), /only JSON objects/);
  assert.throws(() => canonicalJson(Array(1)), /sparse arrays/);
  assert.throws(() => stableId("", {}), /nonempty string/);
});

test("groups carriers only by exact evidence and reports partial overlap symmetrically", () => {
  const carriers = [
    carrier("partial", {
      units: ["unit-b", "unit-c"],
      observed: { tipOid: oid("3"), commitOid: oid("3") },
      identity: { refRawBase64: "cGFydGlhbA==", tipOid: oid("3") },
    }),
    carrier("exact-b", {
      type: "stash",
      units: ["unit-a", "unit-b"],
      observed: { commitOid: oid("1") },
      identity: {
        stashOid: oid("4"),
        baseOid: oid("5"),
        indexOid: oid("6"),
        untrackedOid: null,
        observedSelector: "stash@{0}",
      },
    }),
    carrier("exact-a", {
      units: ["unit-a", "unit-b"],
      observed: { tipOid: oid("1"), commitOid: oid("1") },
      identity: { refRawBase64: "ZXhhY3QtYQ==", tipOid: oid("1") },
    }),
  ];
  const items = groupWorkItems(carriers);
  assert.equal(items.length, 2);
  const exact = items.find((item) => item.carrierIds.includes("exact-a"));
  const partial = items.find((item) => item.carrierIds.includes("partial"));
  assert.deepEqual(exact.carrierIds, ["exact-a", "exact-b"]);
  assert.deepEqual(exact.overlaps, [{
    otherWorkItemId: partial.id,
    changeUnitIds: ["unit-b"],
    relation: "partial",
  }]);
  assert.deepEqual(partial.overlaps, [{
    otherWorkItemId: exact.id,
    changeUnitIds: ["unit-b"],
    relation: "partial",
  }]);
  assert.ok(Object.isFrozen(items));
});

test("overlap grouping stops at the configured comparison budget", () => {
  const carriers = Array.from({ length: 20 }, (_, index) =>
    carrier(`carrier-${index}`, {
      units: ["shared", `unique-${index}`],
      identity: {
        refRawBase64: Buffer.from(`carrier-${index}`).toString("base64"),
        tipOid: index.toString(16).padStart(40, "0"),
      },
      observed: {
        tipOid: index.toString(16).padStart(40, "0"),
      },
    }));
  const grouped = groupWorkItemsWithCoverage(
    carriers,
    [],
    { maxComparisons: 10 },
  );

  assert.deepEqual(grouped.overlapCoverage, {
    comparisons: 10,
    truncated: true,
  });
  assert.equal(
    grouped.workItems.reduce(
      (count, item) => count + item.overlaps.length,
      0,
    ),
    20,
  );
});

test("same names, age, hints, and inexact relationships never merge work items", () => {
  const sharedDisplay = "topic";
  const left = carrier("fork-a", {
    displayName: sharedDisplay,
    units: ["unit-a"],
    observed: { tipOid: oid("1"), ageDays: 900 },
    identity: { remoteId: "repo-a", refRawBase64: "dG9waWM=", tipOid: oid("1") },
  });
  const right = carrier("fork-b", {
    displayName: sharedDisplay,
    units: ["unit-b"],
    observed: { tipOid: oid("2"), ageDays: 1 },
    identity: { remoteId: "repo-b", refRawBase64: "dG9waWM=", tipOid: oid("2") },
  });
  const items = groupWorkItems([left, right], [{
    type: "pr-head",
    leftId: "fork-a",
    rightId: "fork-b",
    exact: false,
    repositoryId: "repo-a",
    headOid: oid("1"),
    name: sharedDisplay,
  }]);
  assert.equal(items.length, 2);
});

test("validated exact worktree and tracking relationships group deterministically", () => {
  const branch = carrier("branch", {
    observed: { tipOid: oid("7") },
    identity: { refRawBase64: "YnJhbmNo", tipOid: oid("7") },
  });
  const tree = carrier("tree", {
    type: "worktree",
    observed: { headOid: oid("7"), branchCarrierId: "branch" },
    identity: {
      path: { rawBase64: "dHJlZQ==", display: "tree" },
      gitDir: { rawBase64: "Z2l0ZGly", display: "gitdir" },
      headOid: oid("7"),
      branchRawBase64: "YnJhbmNo",
      statusFingerprint: "clean",
    },
  });
  const relation = {
    type: "worktree-branch",
    leftId: "tree",
    rightId: "branch",
    exact: true,
    branchCarrierId: "branch",
    headOid: oid("7"),
  };
  const forward = groupWorkItems([tree, branch], [relation]);
  const reverse = groupWorkItems([branch, tree], [relation]);
  assert.deepEqual(forward, reverse);
  assert.equal(forward.length, 1);
});

test("each exact relationship kind requires its typed observed identities", () => {
  const relationCases = [
    {
      carriers: [
        carrier("a", { units: ["a"], observed: { commitOid: oid("1") } }),
        carrier("b", { units: ["b"], observed: { commitOid: oid("1") } }),
      ],
      relation: { type: "same-commit", commitOid: oid("1") },
    },
    {
      carriers: [
        carrier("a", { units: ["a"], observed: { treeOid: oid("2") } }),
        carrier("b", { units: ["b"], observed: { treeOid: oid("2") } }),
      ],
      relation: { type: "same-tree", treeOid: oid("2") },
    },
    {
      carriers: [
        carrier("a", { units: ["same"], observed: { tipOid: oid("1") } }),
        carrier("b", { units: ["same"], observed: { tipOid: oid("2") } }),
      ],
      relation: { type: "same-change-units" },
    },
    {
      carriers: [
        carrier("local", {
          units: ["local-unit"],
          observed: { tipOid: oid("1"), upstreamCarrierId: "remote" },
        }),
        carrier("remote", {
          type: "remote-branch",
          units: ["remote-unit"],
          observed: { tipOid: oid("2") },
        }),
      ],
      relation: {
        type: "tracking",
        localOid: oid("1"),
        remoteOid: oid("2"),
        remoteCarrierId: "remote",
      },
    },
    {
      carriers: [
        carrier("local", {
          units: ["local-unit"],
          observed: { tipOid: oid("3"), repositoryId: "repo-1" },
          identity: { refRawBase64: "bG9jYWw=", tipOid: oid("3"), repositoryId: "repo-1" },
        }),
        carrier("remote", {
          type: "remote-branch",
          units: ["remote-unit"],
          observed: { tipOid: oid("3"), repositoryId: "repo-1" },
          identity: {
            remoteId: "origin",
            refRawBase64: "cmVtb3Rl",
            tipOid: oid("3"),
            repositoryId: "repo-1",
          },
        }),
      ],
      relation: { type: "pr-head", repositoryId: "repo-1", headOid: oid("3") },
    },
  ];
  for (const { carriers, relation } of relationCases) {
    const exact = { ...relation, leftId: carriers[0].id, rightId: carriers[1].id, exact: true };
    assert.equal(groupWorkItems(carriers, [exact]).length, 1, relation.type);
    assert.equal(groupWorkItems(carriers, [{ ...exact, exact: false }]).length,
      ["same-commit", "same-tree", "same-change-units"].includes(relation.type) ? 1 : 2);
  }
});

test("grouping rejects malformed carriers, duplicate IDs, and invalid arguments", () => {
  assert.throws(() => groupWorkItems({}), /must be arrays/);
  assert.throws(() => groupWorkItems([null]), /object with a type/);
  assert.throws(() => groupWorkItems([{ type: "stash", id: "" }]), /nonempty string/);
  assert.throws(() => groupWorkItems([carrier("same"), carrier("same")]), /Duplicate carrier ID/);
  const generated = groupWorkItems([{ type: "stash", identity: {}, changeUnitIds: [] }]);
  assert.match(generated[0].carrierIds[0], /^[0-9a-f]{64}$/);
  assert.equal(groupWorkItems([
    carrier("empty-a", { units: [] }),
    carrier("empty-b", { units: [] }),
  ]).length, 2);
  assert.equal(groupWorkItems([
    carrier("pr-a", { units: ["a"] }),
    carrier("pr-b", { type: "remote-branch", units: ["b"] }),
  ], [{
    type: "pr-head",
    leftId: "pr-a",
    rightId: "pr-b",
    exact: true,
    repositoryId: null,
    headOid: null,
  }]).length, 2);
});

test("categorical evidence is capped by authority and age has no authority", () => {
  assert.deepEqual(
    categorizeEvidence({ authority: "mechanical", coverage: "complete", exact: true, ageDays: 1 }),
    { authority: "mechanical", evidence: "complete", confidence: "proven" },
  );
  assert.deepEqual(
    categorizeEvidence({ authority: "mechanical", coverage: "complete", exact: true, ageDays: 9999 }),
    { authority: "mechanical", evidence: "complete", confidence: "proven" },
  );
  assert.deepEqual(
    categorizeEvidence({ authority: "content-review", exact: true }),
    { authority: "content-review", evidence: "complete", confidence: "indicative" },
  );
  assert.deepEqual(
    categorizeEvidence({ authority: "mechanical", corroborated: true, coverage: "partial" }),
    { authority: "mechanical", evidence: "partial", confidence: "strong" },
  );
  assert.deepEqual(
    categorizeEvidence({ authority: "mechanical", exact: true, blockers: ["missing-object"] }),
    { authority: "mechanical", evidence: "blocked", confidence: "unknown" },
  );
});

test("all seven dispositions remain outcomes and never infer carrier actions", () => {
  const original = workItem();
  for (const disposition of DISPOSITIONS) {
    const result = setDisposition(original, disposition);
    assert.equal(result.recommendation, disposition);
    assert.deepEqual(result.carriers, original.carriers);
    assert.equal(result.carriers[0].action, "delete-ref");
  }
  assert.deepEqual(DISPOSITIONS, [
    "delete",
    "keep-save",
    "resume",
    "update-rebase",
    "merge-as-is",
    "open-pr",
    "defer",
  ]);
  assert.throws(() => setDisposition(original, "drop-stash"), /Unknown disposition/);
});

test("last-copy validation evaluates the entire destructive batch", () => {
  const carriers = [
    carrier("selected-a", { units: ["unit-a", "unit-b"], action: "delete-ref" }),
    carrier("selected-b", { units: ["unit-a", "unit-b"], action: "drop-stash", type: "stash" }),
    carrier("retained", { units: ["unit-a", "unit-b"], action: "keep" }),
  ];
  const valid = validateLastCopyBatch(carriers, ["selected-b", "selected-a"]);
  assert.equal(valid.valid, true);
  assert.deepEqual(valid.selectedCarrierIds, ["selected-a", "selected-b"]);
  assert.deepEqual(valid.witnessesByCarrier["selected-a"]["unit-a"], ["retained"]);

  const invalid = validateLastCopyBatch(carriers, ["selected-a", "selected-b", "retained"]);
  assert.equal(invalid.valid, false);
  assert.equal(invalid.unwitnessed.length, 6);
  assert.ok(invalid.diagnostics.some(({ code }) => code === "last-copy-unwitnessed"));
});

test("last-copy validation rejects duplicate, unknown, incomplete, or disappearing witnesses", () => {
  assert.throws(() => validateLastCopyBatch({}, []), /must be arrays/);
  const selected = carrier("selected", { action: "delete-ref" });
  const invalidWitnesses = [
    carrier("unknown-protection", { protection: "unknown" }),
    carrier("partial", { evidence: "partial" }),
    carrier("stale", { identityCurrent: false }),
    carrier("removed", { action: "delete-ref" }),
    carrier("disappears", { survives: false }),
    carrier("incomplete", { changeUnitsComplete: false }),
  ];
  const result = validateLastCopyBatch(
    [selected, ...invalidWitnesses, carrier("partial", { evidence: "blocked" })],
    ["selected", "selected", "missing"],
  );
  assert.equal(result.valid, false);
  assert.ok(result.diagnostics.some(({ code }) => code === "duplicate-carrier-id"));
  assert.ok(result.diagnostics.some(({ code }) => code === "duplicate-selected-id"));
  assert.ok(result.diagnostics.some(({ code }) => code === "unknown-selected-id"));
});

test("last-copy witnesses require every affirmative proof field", () => {
  const mutations = [
    (candidate) => { delete candidate.identityCurrent; },
    (candidate) => { candidate.identityCurrent = "unknown"; },
    (candidate) => { delete candidate.changeUnitsComplete; },
    (candidate) => { candidate.changeUnitsComplete = "unknown"; },
    (candidate) => { delete candidate.evidence; },
    (candidate) => { candidate.evidence = "unknown"; },
    (candidate) => { candidate.evidence = "partial"; },
    (candidate) => { delete candidate.protection; },
    (candidate) => { candidate.protection = "unknown"; },
    (candidate) => { delete candidate.protectionEvidence; },
    (candidate) => { candidate.protectionEvidence = "unknown"; },
    (candidate) => { candidate.protectionEvidence = "partial"; },
    (candidate) => { delete candidate.survives; },
    (candidate) => { candidate.survives = "unknown"; },
    (candidate) => { delete candidate.durability; },
    (candidate) => { candidate.durability = "unknown"; },
  ];
  for (const mutate of mutations) {
    const witness = carrier("candidate");
    mutate(witness);
    const result = validateLastCopyBatch([
      carrier("selected", { action: "delete-ref" }),
      witness,
    ], ["selected"]);
    assert.equal(result.valid, false);
    assert.deepEqual(result.witnessesByCarrier.selected["unit-a"], []);
  }

  const affirmed = validateLastCopyBatch([
    carrier("selected", { action: "delete-ref" }),
    carrier("candidate"),
  ], ["selected"]);
  assert.equal(affirmed.valid, true);
  assert.deepEqual(affirmed.witnessesByCarrier.selected["unit-a"], ["candidate"]);
});

test("every selected change unit needs an exact retained witness", () => {
  const result = validateLastCopyBatch([
    carrier("selected", { units: ["unit-a", "unit-b"], action: "delete-ref" }),
    carrier("retained", { units: ["unit-a"], action: "keep" }),
  ], ["selected"]);
  assert.equal(result.valid, false);
  assert.deepEqual(result.unwitnessed, [{ carrierId: "selected", changeUnitId: "unit-b" }]);
});

test("pull requests are never durable last-copy witnesses", () => {
  const result = validateLastCopyBatch([
    carrier("selected", { action: "delete-ref" }),
    carrier("pr-12", {
      type: "pull-request",
      durability: "durable",
      protection: "protected",
      action: "keep",
    }),
  ], ["selected"]);
  assert.equal(result.valid, false);
  assert.deepEqual(result.witnessesByCarrier.selected["unit-a"], []);
});

test("compatibility is a sorted categorical projection only", () => {
  const items = [
    workItem("low-review", { authority: "content-review", confidence: "indicative" }),
    workItem("high", {}),
    workItem("medium-user", { authority: "user-judgment", confidence: "indicative" }),
    workItem("low-blocked", {
      blockers: [{ code: "blocked", subjectIds: [], reason: "Blocked." }],
    }),
    workItem("medium-mechanical", { confidence: "strong" }),
  ];
  assert.deepEqual(projectCompatibility(items), {
    high: ["high"],
    medium: ["medium-mechanical", "medium-user"],
    low: ["low-blocked", "low-review"],
  });
  assert.deepEqual(projectCompatibility([
    workItem("uncertain", {
      preservation: {
        lastCopy: true,
        durableCarrierIds: [],
        unwitnessedChangeUnitIds: ["unit-a"],
      },
    }),
  ]), { high: [], medium: [], low: ["uncertain"] });
  assert.throws(() => projectCompatibility({}), /must be an array/);
});

test("strict review schema accepts only the closed valid shape", () => {
  const result = mechanicalResult();
  assert.deepEqual(validateReview(result, review()), { valid: true, diagnostics: [] });

  assert.equal(validateReview(result, null).valid, false);
  const unknownRoot = { ...review(), command: "git branch -D topic" };
  assert.equal(validateReview(result, unknownRoot).valid, false);
  const unknownItemField = review([{ ...reviewItem(), path: "other/file.js" }]);
  assert.equal(validateReview(result, unknownItemField).valid, false);
  assert.equal(validateReview(result, review([null])).valid, false);
  assert.equal(validateReview(result, review([reviewItem(null)])).valid, false);
  assert.equal(
    validateReview(result, review([reviewItem("work-1", { riskFlags: [null] })])).valid,
    false,
  );
  assert.equal(
    validateReview(result, review([reviewItem("work-1", { reasons: [null] })])).valid,
    false,
  );
  assert.equal(validateReview(result, review([reviewItem("missing")])).valid, false);
  assert.equal(
    validateReview(result, review([reviewItem(), reviewItem()])).valid,
    false,
  );
  assert.equal(
    validateReview(result, review([reviewItem("work-1", { riskFlags: ["api-change", "api-change"] })])).valid,
    false,
  );
});

test("strict review schema enforces every bound and enum", () => {
  const result = mechanicalResult();
  const cases = [
    { ...review(), schemaVersion: "2.0.0" },
    review([reviewItem("work-1", { summary: "x".repeat(2001) })]),
    review([reviewItem("work-1", { reasons: [""] })]),
    review([reviewItem("work-1", { reasons: ["x".repeat(501)] })]),
    review([reviewItem("work-1", { reasons: Array.from({ length: 11 }, () => "reason") })]),
    review([reviewItem("work-1", { riskFlags: ["not-a-risk"] })]),
    review([reviewItem("work-1", { recommendation: "delete" })]),
    { schemaVersion: "1.0.0", items: null },
    review([reviewItem("work-1", { summary: null })]),
    review([reviewItem("work-1", { riskFlags: null })]),
    review([reviewItem("work-1", { riskFlags: Array(9).fill("api-change") })]),
    review([reviewItem("work-1", { reasons: null })]),
  ];
  for (const candidate of cases) assert.equal(validateReview(result, candidate).valid, false);

  const manyItemsResult = mechanicalResult(
    Array.from({ length: 21 }, (_, index) => workItem(`work-${index}`)),
  );
  const tooMany = review(
    Array.from({ length: 21 }, (_, index) => reviewItem(`work-${index}`)),
  );
  assert.equal(validateReview(manyItemsResult, tooMany).valid, false);
});

test("review text rejects controls, boundaries, URLs, commands, OIDs, refs, paths, and carrier IDs", () => {
  const result = mechanicalResult();
  const forbidden = [
    "unsafe\u0001control",
    "BEGIN EXTERNAL DATA",
    "See https://example.test/report",
    "Fetch git@example.test:org/repo.git",
    "git branch -D topic",
    "npm test",
    `Commit ${oid("a")}`,
    "Use refs/heads/topic",
    "Inspect ./other/file.js",
    "Inspect src/other.js",
    "Inspect src/lib",
    "Carrier branch-topic",
    "Known path src/app.js",
  ];
  for (const summary of forbidden) {
    const validation = validateReview(result, review([reviewItem("work-1", { summary })]));
    assert.equal(validation.valid, false, `expected forbidden text rejection: ${summary}`);
  }
});

test("valid applyReview is immutable, interpretive, and weakens destructive state", () => {
  const input = mechanicalResult();
  const snapshot = structuredClone(input);
  const applied = applyReview(input, review([reviewItem("work-1", {
    riskFlags: ["api-change"],
    recommendation: "keep-save",
  })]));
  assert.equal(applied.accepted, true);
  assert.deepEqual(input, snapshot);
  assert.ok(Object.isFrozen(applied.result));
  const item = applied.result.workItems[0];
  assert.equal(item.recommendation, "keep-save");
  assert.equal(item.authority, "content-review");
  assert.equal(item.evidence, "blocked");
  assert.equal(item.confidence, "unknown");
  assert.equal(item.carriers[0].action, "no-action");
  assert.equal(item.carriers[0].eligible, false);
  assert.deepEqual(item.carriers[0].preservationWitnessIds, ["branch-main"]);
  assert.ok(item.blockers.some(({ code }) => code === "review-risk:api-change"));
  assert.deepEqual(applied.result.compatibility, { high: [], medium: [], low: ["work-1"] });
});

test("applyReview rejects the whole batch and returns an unchanged immutable result", () => {
  const first = workItem("first", { recommendation: "delete" });
  const second = workItem("second", { recommendation: "defer" });
  const input = mechanicalResult([first, second]);
  const proposed = review([
    reviewItem("first", { recommendation: "keep-save" }),
    reviewItem("second", { recommendation: "resume" }),
  ]);
  const applied = applyReview(input, proposed);
  assert.equal(applied.accepted, false);
  assert.deepEqual(applied.result, input);
  assert.ok(Object.isFrozen(applied.result));
  assert.ok(applied.diagnostics.some(({ code }) => code === "unsafe-recommendation-transition"));
  assert.equal(applied.result.workItems[0].review, null);
});

test("applyReview rejects unknown fields, IDs, and forbidden content without partial application", () => {
  const input = mechanicalResult();
  const cases = [
    { ...review(), commands: ["git branch -D topic"] },
    review([{ ...reviewItem(), url: "https://example.test" }]),
    review([reviewItem("unknown")]),
    review([reviewItem("work-1", { reasons: ["Run gh pr merge topic"] })]),
  ];
  for (const candidate of cases) {
    const applied = applyReview(input, candidate);
    assert.equal(applied.accepted, false);
    assert.deepEqual(applied.result, input);
  }
});

test("every recommendation transition is explicitly monotone or rejected", () => {
  const allowed = {
    delete: ["keep-save", "resume", "defer"],
    "keep-save": ["keep-save", "defer"],
    resume: ["keep-save", "resume", "defer"],
    "update-rebase": ["keep-save", "resume", "defer"],
    "merge-as-is": ["keep-save", "resume", "defer"],
    "open-pr": ["keep-save", "resume", "defer"],
    defer: ["defer"],
  };
  for (const before of DISPOSITIONS) {
    for (const after of DISPOSITIONS) {
      const result = transition(
        { recommendation: before },
        { recommendation: after },
      );
      assert.equal(
        result.valid,
        allowed[before].includes(after),
        `${before} -> ${after}`,
      );
    }
  }
});

test("every confidence and evidence transition preserves or lowers proof", () => {
  for (const before of CONFIDENCE_STATES) {
    for (const after of CONFIDENCE_STATES) {
      const result = transition({ confidence: before }, { confidence: after });
      assert.equal(
        result.valid,
        CONFIDENCE_STATES.indexOf(after) >= CONFIDENCE_STATES.indexOf(before),
        `confidence ${before} -> ${after}`,
      );
    }
  }
  for (const before of EVIDENCE_STATES) {
    for (const after of EVIDENCE_STATES) {
      const result = transition({ evidence: before }, { evidence: after });
      assert.equal(
        result.valid,
        EVIDENCE_STATES.indexOf(after) >= EVIDENCE_STATES.indexOf(before),
        `evidence ${before} -> ${after}`,
      );
    }
  }
});

test("every carrier action transition forbids new or stronger destruction", () => {
  const destructive = new Set(["delete-ref", "drop-stash", "remove-worktree"]);
  for (const beforeAction of CARRIER_ACTIONS) {
    for (const afterAction of CARRIER_ACTIONS) {
      const beforeCarrier = carrier("action", { action: beforeAction });
      const afterCarrier = { ...structuredClone(beforeCarrier), action: afterAction };
      const result = transition(
        { carriers: [beforeCarrier] },
        { carriers: [afterCarrier] },
      );
      const expected = destructive.has(beforeAction)
        ? afterAction === beforeAction || !destructive.has(afterAction)
        : !destructive.has(afterAction);
      assert.equal(result.valid, expected, `${beforeAction} -> ${afterAction}`);
    }
  }
});

test("monotonic validation rejects entity, fact, witness, blocker, and eligibility escalation", () => {
  const original = workItem("transition", {
    blockers: [{ code: "existing", subjectIds: ["transition"], reason: "Existing." }],
    carriers: [carrier("action", {
      action: "no-action",
      eligible: false,
      witnesses: ["retained"],
      blockers: ["existing"],
    })],
  });
  const mutations = [
    (candidate) => candidate.carriers.push(carrier("added")),
    (candidate) => candidate.changeUnits.push({
      ...candidate.changeUnits[0],
      id: "new-unit",
      path: { rawBase64: "bmV3", display: "new/file.js" },
    }),
    (candidate) => { candidate.carriers[0].identity.refRawBase64 = "bmV3LXJlZg=="; },
    (candidate) => { candidate.carriers[0].preservationWitnessIds.push("new-witness"); },
    (candidate) => { candidate.blockers = []; },
    (candidate) => { candidate.carriers[0].blockerCodes = []; },
    (candidate) => { candidate.carriers[0].eligible = true; },
    (candidate) => { candidate.url = "https://example.test"; },
    (candidate) => { candidate.command = "git branch -D topic"; },
    (candidate) => { candidate.oid = oid("f"); },
    (candidate) => { candidate.path = "new/file.js"; },
    (candidate) => { candidate.authority = "user-judgment"; },
    (candidate) => { candidate.reasons = []; },
    (candidate) => { candidate.review = { command: "git branch -D topic" }; },
    (candidate) => { candidate.carriers = []; },
  ];
  for (const mutate of mutations) {
    const candidate = structuredClone(original);
    mutate(candidate);
    assert.equal(validateMonotoneTransition(original, candidate).valid, false);
  }
});

test("monotonic validation rejects malformed or changed work-item identity", () => {
  assert.equal(validateMonotoneTransition(null, workItem()).valid, false);
  assert.equal(validateMonotoneTransition(workItem("a"), workItem("b")).valid, false);
});

test("monotonic validation cannot replace or remove an applied review", () => {
  const original = workItem("transition", {
    authority: "content-review",
    confidence: "indicative",
    review: {
      schemaVersion: "1.0.0",
      summary: "Initial assessment.",
      riskFlags: [],
      recommendation: "resume",
      reasons: ["Initial reason."],
    },
  });
  const candidate = structuredClone(original);
  candidate.review = null;
  assert.equal(validateMonotoneTransition(original, candidate).valid, false);
});

test("monotonic validation rejects every malformed applied-review field", () => {
  const invalidReviews = [
    {
      schemaVersion: "2.0.0",
      summary: "Assessment.",
      riskFlags: [],
      recommendation: "resume",
      reasons: [],
    },
    {
      schemaVersion: "1.0.0",
      summary: null,
      riskFlags: [],
      recommendation: "resume",
      reasons: [],
    },
    {
      schemaVersion: "1.0.0",
      summary: "npm test",
      riskFlags: [],
      recommendation: "resume",
      reasons: [],
    },
    {
      schemaVersion: "1.0.0",
      summary: "Assessment.",
      riskFlags: null,
      recommendation: "resume",
      reasons: [],
    },
    {
      schemaVersion: "1.0.0",
      summary: "Assessment.",
      riskFlags: ["unknown-risk"],
      recommendation: "resume",
      reasons: [],
    },
    {
      schemaVersion: "1.0.0",
      summary: "Assessment.",
      riskFlags: [],
      recommendation: "delete",
      reasons: [],
    },
    {
      schemaVersion: "1.0.0",
      summary: "Assessment.",
      riskFlags: [],
      recommendation: "resume",
      reasons: null,
    },
    {
      schemaVersion: "1.0.0",
      summary: "Assessment.",
      riskFlags: [],
      recommendation: "resume",
      reasons: ["https://example.test"],
    },
  ];
  for (const appliedReview of invalidReviews) {
    const original = workItem("transition", { review: null });
    const candidate = structuredClone(original);
    candidate.review = appliedReview;
    assert.equal(validateMonotoneTransition(original, candidate).valid, false);
  }
});

test("monotonic validation permits adding blockers/reasons and removing witnesses", () => {
  const original = workItem("transition", {
    carriers: [carrier("action", {
      action: "delete-ref",
      eligible: true,
      witnesses: ["retained-a", "retained-b"],
    })],
  });
  const candidate = structuredClone(original);
  candidate.recommendation = "defer";
  candidate.evidence = "partial";
  candidate.confidence = "indicative";
  candidate.authority = "content-review";
  candidate.blockers.push({ code: "review", subjectIds: ["transition"], reason: "Review risk." });
  candidate.reasons.push({
    code: "review",
    source: "review",
    subjectId: "transition",
    summary: "Interpretive reason.",
  });
  candidate.carriers[0].action = "keep";
  candidate.carriers[0].eligible = false;
  candidate.carriers[0].preservationWitnessIds = ["retained-a"];
  candidate.carriers[0].blockerCodes.push("review");
  assert.equal(validateMonotoneTransition(original, candidate).valid, true);
});

test("applyReview preserves non-destructive carriers and works without compatibility projection", () => {
  const item = workItem("work-1", {
    carriers: [carrier("kept", { action: "keep", eligible: false })],
  });
  const input = mechanicalResult([item]);
  delete input.compatibility;
  const applied = applyReview(input, review([reviewItem()]));
  assert.equal(applied.accepted, true);
  assert.equal(applied.result.workItems[0].carriers[0].action, "keep");
  assert.equal("compatibility" in applied.result, false);
});

test("applyReview keeps compatibility categories for unreviewed items", () => {
  const reviewed = workItem("reviewed");
  const high = workItem("high");
  const medium = workItem("medium", {
    authority: "user-judgment",
    confidence: "indicative",
  });
  const strong = workItem("strong", { confidence: "strong" });
  const input = mechanicalResult([medium, reviewed, strong, high]);
  const applied = applyReview(input, review([reviewItem("reviewed")]));
  assert.equal(applied.accepted, true);
  assert.deepEqual(applied.result.compatibility, {
    high: ["high"],
    medium: ["medium", "strong"],
    low: ["reviewed"],
  });

  const empty = applyReview(input, review([]));
  assert.equal(empty.accepted, true);
  assert.deepEqual(empty.result.compatibility, input.compatibility);
});

test("group and compatibility output ordering is independent of input ordering", () => {
  const carriers = [
    carrier("z", { units: ["z-unit"], observed: { tipOid: oid("1") } }),
    carrier("a", { units: ["a-unit"], observed: { tipOid: oid("2") } }),
    carrier("m", { units: ["m-unit"], observed: { tipOid: oid("3") } }),
  ];
  assert.deepEqual(groupWorkItems(carriers), groupWorkItems([...carriers].reverse()));

  const items = [
    workItem("z", { authority: "content-review", confidence: "indicative" }),
    workItem("a"),
    workItem("m", { confidence: "strong" }),
  ];
  assert.deepEqual(projectCompatibility(items), projectCompatibility([...items].reverse()));
});

test("grouping remains bounded at the configured carrier ceiling", () => {
  const carriers = Array.from({ length: 2_600 }, (_, index) =>
    carrier(`carrier-${index}`, {
      units: [`unit-${index}`],
      observed: { tipOid: oid((index % 10).toString()) },
    }));
  const items = groupWorkItems(carriers);
  assert.equal(items.length, carriers.length);
  assert.equal(items.every(({ overlaps }) => overlaps.length === 0), true);
});
