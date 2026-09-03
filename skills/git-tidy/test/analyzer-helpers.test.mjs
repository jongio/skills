import assert from "node:assert/strict";
import test from "node:test";

import {
  inspectWorktree,
  matchingBranch,
  parseTrackedRecord,
  statusRecords,
} from "../scripts/lib/evidence-worktrees.mjs";
import { collectBranches } from "../scripts/lib/evidence-branches.mjs";
import {
  countIgnoredRecords,
  parseStatusRecord,
  readIgnoredState,
  readSparseState,
  summarizeStatus,
} from "../scripts/lib/worktree-state.mjs";
import {
  createCollectionContext,
  normalizeLimits,
  parseWorktrees,
} from "../scripts/lib/evidence-shared.mjs";
import {
  decodeFullRef,
  decodeRawPath,
  drift,
  planStep,
  sortSteps,
} from "../scripts/lib/triage-shared.mjs";
import { buildWorkItems } from "../scripts/lib/triage-policy.mjs";
import { collectBranchProof } from "../scripts/lib/branch-proof.mjs";
import {
  collectLegacyInventory,
  parseCountObjects,
  parseLargeBlobInventory,
  parseTagInventory,
} from "../scripts/lib/legacy-inventory.mjs";

const oid = (character) => character.repeat(40);
const encoded = (value) => ({
  rawBase64: Buffer.from(value).toString("base64"),
});

test("branch proof converts malformed and failed Git reads to explicit gaps", async () => {
  const context = createCollectionContext(normalizeLimits({}), undefined);
  for (const [responses, code] of [
    [[{ exitCode: 2, stdout: Buffer.alloc(0) }], "branch-merge-base-unavailable"],
    [[{ exitCode: 0, stdout: Buffer.from(`${oid("a")}\n`) },
      { exitCode: 2, stdout: Buffer.alloc(0) }], "branch-ancestry-unavailable"],
    [[{ exitCode: 0, stdout: Buffer.from(`${oid("a")}\n`) },
      { exitCode: 0, stdout: Buffer.from("bad\n") }], "branch-ancestry-unavailable"],
    [[{ exitCode: 0, stdout: Buffer.from(`${oid("a")}\n`) },
      { exitCode: 0, stdout: Buffer.from("9007199254740992\t1\n") }],
    "branch-ancestry-unavailable"],
  ]) {
    let index = 0;
    const result = await collectBranchProof(
      { objectFormat: "sha1", run: async () => responses[index++] },
      oid("b"), oid("c"),
      createCollectionContext(normalizeLimits({}), undefined),
    );
    assert.equal(result.complete, false);
    assert.equal(result.gap.code, code);
  }
  const rejected = await collectBranchProof(
    { objectFormat: "sha1", run: async () => { throw Object.assign(new Error(), { code: "OFFLINE" }); } },
    oid("b"), oid("c"), context,
  );
  assert.equal(rejected.gap.reason, "OFFLINE");
  let call = 0;
  const diffFailure = await collectBranchProof(
    {
      objectFormat: "sha1",
      run: async () => {
        call += 1;
        if (call === 1) {
          return { exitCode: 0, stdout: Buffer.from(`${oid("a")}\n`) };
        }
        if (call === 2) {
          return { exitCode: 0, stdout: Buffer.from("0\t1\n") };
        }
        throw Object.assign(new Error("diff unavailable"), { code: "OFFLINE" });
      },
    },
    oid("b"), oid("c"),
    createCollectionContext(normalizeLimits({}), undefined),
  );
  assert.equal(diffFailure.complete, false);
  assert.deepEqual(diffFailure.units, []);
  assert.deepEqual(diffFailure.gap, {
    code: "branch-change-units-unavailable",
    reason: "merge-base branch change units are unavailable",
  });
});

test("legacy inventory parsers reject every hostile scalar boundary", () => {
  const malformedTags = [
    Buffer.from(`\0${oid("a")}\0commit\0\0\n`),
    Buffer.from(`refs/tags/x\0${oid("a")}\0evil\0\0\n`),
    Buffer.from(`refs/tags/x\0${oid("a")}\0commit\0${"A".repeat(40)}\0\n`),
  ];
  for (const input of malformedTags) {
    assert.throws(() => parseTagInventory(input, "sha1"));
  }
  for (const input of [
    Buffer.from([0xff]),
    Buffer.from("malformed\n"),
    Buffer.from(`${oid("a")} blob 9007199254740992\n`),
  ]) {
    assert.throws(() => parseLargeBlobInventory(input, "sha1", 1));
  }
  assert.throws(
    () => parseCountObjects(Buffer.from("count: 9007199254740992\n")),
    (error) => error.code === "MALFORMED_GIT_OUTPUT",
  );
  assert.throws(
    () => parseLargeBlobInventory(Buffer.from([0xff, 0x0a]), "sha1", 1),
    (error) =>
      error.code === "MALFORMED_GIT_OUTPUT" &&
      /not ASCII/u.test(error.message),
  );
});

test("legacy inventory failures become typed gaps while cancellation propagates", async () => {
  const limits = normalizeLimits({});
  const cases = [
    ["tags", "tag-inventory-unavailable", "tags", []],
    ["artifacts", "artifact-inventory-unavailable", "artifacts", []],
    ["blobs", "blob-inventory-unavailable", "blobs", []],
    ["maintenance", "maintenance-inventory-unavailable", "maintenance", null],
  ];
  for (const [scope, gapCode, field, empty] of cases) {
    const context = createCollectionContext(limits, undefined);
    const result = await collectLegacyInventory(
      {
        objectFormat: "sha1",
        run: async () => { throw new Error("untrusted boundary detail"); },
      },
      { scope, includeIgnored: true, limits },
      context,
      Buffer.from(process.cwd()),
    );
    assert.deepEqual(result[field], empty);
    assert.equal(context.gaps.length, scope === "artifacts" ? 3 : 1);
    assert.equal(context.gaps.every(({ code }) => code === gapCode), true);
    assert.equal(
      context.gaps.some(({ reason }) =>
        reason.includes("untrusted boundary detail")),
      false,
    );
  }

  for (const scope of ["tags", "artifacts", "blobs", "maintenance"]) {
    const context = createCollectionContext(limits, undefined);
    await assert.rejects(
      collectLegacyInventory(
        {
          objectFormat: "sha1",
          run: async () => {
            throw Object.assign(new Error("cancelled"), { code: "CANCELLED" });
          },
        },
        { scope, includeIgnored: true, limits },
        context,
        Buffer.from(process.cwd()),
      ),
      (error) => error.code === "CANCELLED",
    );
    assert.deepEqual(context.gaps, []);
  }
});

test("legacy collectors preserve partial artifacts and enforce inventory limits", async () => {
  const limits = normalizeLimits({ maxArtifacts: 1, maxTags: 1, maxBlobs: 1 });
  let artifactCall = 0;
  const artifactContext = createCollectionContext(limits, undefined);
  const partial = await collectLegacyInventory(
    {
      objectFormat: "sha1",
      run: async () => {
        artifactCall += 1;
        if (artifactCall === 1) {
          return { stdout: Buffer.from("one.orig\0two.rej\0") };
        }
        throw new Error("untracked unavailable");
      },
    },
    { scope: "artifacts", includeIgnored: false, limits },
    artifactContext,
    Buffer.from(process.cwd()),
  );
  assert.equal(partial.artifacts.length, 1);
  assert.equal(artifactContext.skipped.artifacts, 1);
  assert.ok(artifactContext.limitsReached.includes("maxArtifacts"));
  assert.ok(artifactContext.gaps.some(
    ({ code }) => code === "artifact-inventory-unavailable",
  ));
  assert.ok(artifactContext.gaps.some(
    ({ code }) => code === "artifact-inventory-limit",
  ));

  for (const [scope, stdout, code] of [
    ["tags", Buffer.from("broken"), "tag-inventory-unavailable"],
    ["artifacts", Buffer.from("broken"), "artifact-inventory-unavailable"],
    ["blobs", Buffer.from([0xff, 0x0a]), "blob-inventory-unavailable"],
    ["maintenance", Buffer.from("count: 9007199254740992\n"),
      "maintenance-inventory-unavailable"],
  ]) {
    const context = createCollectionContext(limits, undefined);
    const result = await collectLegacyInventory(
      { objectFormat: "sha1", run: async () => ({ stdout }) },
      { scope, includeIgnored: false, limits },
      context,
      Buffer.from(process.cwd()),
    );
    assert.ok(context.gaps.some(({ code: actual }) => actual === code));
    assert.deepEqual(scope === "maintenance" ? result.maintenance : result[scope],
      scope === "maintenance" ? null : []);
  }

  const tagContext = createCollectionContext(limits, undefined);
  await collectLegacyInventory(
    {
      objectFormat: "sha1",
      run: async () => ({ stdout: Buffer.from(
        `refs/tags/a\0${oid("a")}\0commit\0\0\n` +
        `refs/tags/b\0${oid("b")}\0commit\0\0\n`,
      ) }),
    },
    { scope: "tags", includeIgnored: false, limits },
    tagContext,
    Buffer.from(process.cwd()),
  );
  assert.equal(tagContext.skipped.tags, 1);
  assert.ok(tagContext.limitsReached.includes("maxTags"));

  assert.deepEqual(parseCountObjects(Buffer.from(
    "count: 2\nalternate: /shared/objects\ncount: 99\ngarbage: 99\n",
  )), {
    looseObjects: 2,
    packedObjects: 0,
    packs: 0,
    sizeKiB: 0,
    garbageCount: 0,
    garbageSizeKiB: 0,
    prunePackable: 0,
  });

  const maintenanceContext = createCollectionContext(limits, undefined);
  const maintenance = await collectLegacyInventory(
    {
      objectFormat: "sha1",
      run: async () => ({
        stdout: Buffer.from("garbage: 2\nprune-packable: 1\n"),
      }),
    },
    { scope: "maintenance", includeIgnored: false, limits },
    maintenanceContext,
    Buffer.from(process.cwd()),
  );
  assert.equal(maintenance.maintenance.recommendation, "run-maintenance");
  assert.deepEqual(maintenance.maintenance.reasonCodes, [
    "repository-maintenance-recommended",
  ]);
  assert.equal(maintenanceContext.counts.maintenanceSignals, 2);
});

test("worktree state reports rejected and malformed boundary reads", async () => {
  const rejected = { run: async () => { throw Object.assign(new Error("x"), { code: "OFFLINE" }); } };
  const sparse = await readSparseState(rejected);
  assert.equal(sparse.observed.enabled, null);
  assert.equal(sparse.gaps.filter(({ reason }) => reason === "OFFLINE").length, 3);
  assert.ok(sparse.gaps.some(
    ({ reason }) => reason === "sparse-checkout enablement is unknown",
  ));
  const ignored = await readIgnoredState(rejected);
  assert.deepEqual(ignored, { count: null, reason: "OFFLINE" });

  let calls = 0;
  const malformed = await readSparseState({
    run: async () => {
      calls += 1;
      if (calls === 1) return { exitCode: 0, stdout: Buffer.from("true\n") };
      if (calls < 4) return { exitCode: 0, stdout: Buffer.from("maybe\n") };
      return { exitCode: 0, stdout: Buffer.from("missing-newline") };
    },
  });
  assert.equal(malformed.observed.patternCount, null);
  assert.ok(malformed.gaps.some(({ code }) => code === "sparse-pattern-count-unknown"));
  assert.throws(() => statusRecords(Buffer.from("not-nul")), /NUL framing/u);
});

function policyBranch(id, {
  type = "local-branch",
  ahead = 1,
  behind = 0,
  complete = true,
  durability = "durable",
  blockers = [],
  pullRequests = [],
  checkedOutWorktreeIds = [],
  units = ["unit-a"],
} = {}) {
  return {
    id,
    type,
    displayName: id,
    identity: {
      refRawBase64: Buffer.from(
        type === "local-branch"
          ? `refs/heads/${id}`
          : `refs/remotes/origin/${id}`,
      ).toString("base64"),
      tipOid: oid("a"),
    },
    observed: {
      tipOid: oid("a"),
      ancestry: {
        mergeBaseOid: oid("b"),
        ahead,
        behind,
        state: ahead > 0 && behind > 0
          ? "diverged"
          : ahead > 0
            ? "ahead"
            : "behind",
        mergedIntoDefault: ahead === 0,
        reachableFromDefault: ahead === 0,
      },
      checkedOutWorktreeIds,
      pullRequests,
    },
    changeUnitIds: units,
    changeUnitsComplete: complete,
    evidence: complete ? "complete" : "partial",
    durability,
    protection: "unprotected",
    protectionEvidence: "complete",
    identityCurrent: true,
    survives: true,
    observations: [],
    action: "keep",
    eligible: false,
    preservationWitnessIds: [],
    prerequisiteIds: [],
    blockerCodes: blockers,
  };
}

function policyEvidence(carriers, relationships = []) {
  return {
    carriers,
    relationships,
    changeUnits: [{
      id: "unit-a",
      path: encoded("feature.txt"),
      oldMode: "100644",
      newMode: "100644",
      oldOid: oid("b"),
      newOid: oid("a"),
      kind: "modify",
      sourceComponent: "tracked",
      binary: false,
    }],
    coverage: { skippedCounts: { worktrees: 0 } },
  };
}

test("worktree branch identities preserve UTF-8 bytes", () => {
  const branch = "refs/heads/tópico";
  const [entry] = parseWorktrees(
    Buffer.from(
      `worktree C:\\repo\0HEAD ${oid("a")}\0branch ${branch}\0\0`,
      "utf8",
    ),
    "sha1",
  );
  assert.equal(
    entry.branchRaw.toString("base64"),
    Buffer.from(branch).toString("base64"),
  );
  assert.equal(entry.branch, undefined);
});

test("metadata depth inventories branches without running proof commands", async () => {
  const calls = [];
  const tip = oid("a");
  const refs = Buffer.from(
    `refs/heads/topic\0${tip}\0commit\0\0\n` +
    `refs/remotes/origin/main\0${tip}\0commit\0\0\n`,
  );
  const boundary = {
    objectFormat: "sha1",
    run: async (args) => {
      calls.push(args);
      if (args[0] === "for-each-ref") {
        return { exitCode: 0, stdout: refs, stderr: Buffer.alloc(0) };
      }
      if (args[0] === "symbolic-ref") {
        return {
          exitCode: 0,
          stdout: Buffer.from("refs/remotes/origin/main\n"),
          stderr: Buffer.alloc(0),
        };
      }
      throw new Error(`unexpected command: ${args[0]}`);
    },
  };
  const limits = normalizeLimits({});
  const context = createCollectionContext(limits, undefined);
  const { carriers } = await collectBranches(
    boundary,
    {
      scope: "branches",
      depth: "metadata",
      limits,
    },
    context,
  );
  assert.equal(carriers.length, 2);
  assert.deepEqual(
    calls.map(([command]) => command),
    ["for-each-ref", "symbolic-ref"],
  );
  assert.equal(
    carriers.every(({ changeUnitsComplete }) => changeUnitsComplete === false),
    true,
  );
});

test("worktree helper parsing fails closed on malformed status", () => {
  assert.deepEqual(statusRecords(Buffer.alloc(0)), []);
  assert.deepEqual(
    statusRecords(Buffer.from("# branch.head main\0")),
    [],
  );
  assert.throws(
    () => statusRecords(Buffer.from("not terminated")),
    /framing/u,
  );
  assert.throws(
    () => statusRecords(Buffer.from([0xff, 0])),
    TypeError,
  );

  const context = createCollectionContext(normalizeLimits(), undefined);
  const units = [];
  assert.equal(
    parseTrackedRecord("not tracked", {}, units, context),
    false,
  );
  const rename = [
    "2",
    "R.",
    "N...",
    "100644",
    "100644",
    "100644",
    oid("a"),
    oid("b"),
    "R100 new.txt",
  ].join(" ");
  assert.equal(
    parseTrackedRecord(rename, {}, units, context),
    "incomplete",
  );
  assert.ok(
    context.gaps.some(({ code }) => code === "worktree-rename-incomplete"),
  );

  const cleanStaged = [
    "1",
    "M.",
    "N...",
    "100644",
    "100644",
    "100644",
    oid("a"),
    oid("b"),
    "tracked.txt",
  ].join(" ");
  assert.equal(
    parseTrackedRecord(
      cleanStaged,
      { objectFormat: "sha1" },
      units,
      context,
    ),
    true,
  );
  assert.equal(units.length, 1);

  const stagedDelete = [
    "1",
    "D.",
    "N...",
    "100644",
    "000000",
    "000000",
    oid("a"),
    oid("0"),
    "deleted.txt",
  ].join(" ");
  assert.equal(
    parseTrackedRecord(
      stagedDelete,
      { objectFormat: "sha1" },
      units,
      context,
    ),
    true,
  );
  const unstaged = [
    "1",
    ".M",
    "N...",
    "100644",
    "100644",
    "100644",
    oid("a"),
    oid("a"),
    "unstaged.txt",
  ].join(" ");
  assert.equal(
    parseTrackedRecord(
      unstaged,
      { objectFormat: "sha1" },
      units,
      context,
    ),
    "incomplete",
  );
  assert.ok(context.gaps.some(
    ({ code }) => code === "unstaged-content-unhashed",
  ));
});

test("worktree status summaries distinguish destructive state", () => {
  const staged = [
    "1", "M.", "N...", "100644", "100644", "100644",
    oid("a"), oid("b"), "staged.txt",
  ].join(" ");
  const submodule = [
    "1", ".M", "S.M.", "160000", "160000", "160000",
    oid("a"), oid("a"), "module",
  ].join(" ");
  const conflict = [
    "u", "UU", "N...", "100644", "100644", "100644", "100644",
    oid("a"), oid("b"), oid("c"), "conflicted.txt",
  ].join(" ");
  const intent = [
    "1", ".A", "N...", "000000", "100644", "100644",
    oid("0"), oid("0"), "intent.txt",
  ].join(" ");
  const records = [staged, submodule, conflict, intent, "? untracked.txt"];
  assert.deepEqual(summarizeStatus(records), {
    staged: 2,
    unstaged: 3,
    submodule: 1,
    conflict: 1,
    intentToAdd: 1,
    untracked: 1,
  });
  assert.equal(parseStatusRecord(conflict).type, "conflict");
  assert.equal(parseStatusRecord("unsupported"), null);
});

test("ignored status counts records without decoding or retaining paths", async () => {
  const hostile = Buffer.concat([
    Buffer.from("! "),
    Buffer.from([0xff, 0xfe]),
    Buffer.from([0]),
    Buffer.from("1 M. N... ignored tracked record"),
    Buffer.from([0]),
    Buffer.from("! second"),
    Buffer.from([0]),
  ]);
  assert.equal(countIgnoredRecords(Buffer.alloc(0)), 0);
  assert.equal(countIgnoredRecords(hostile), 2);
  assert.throws(
    () => countIgnoredRecords(Buffer.from("! unterminated")),
    /framing/u,
  );

  const unavailable = await readIgnoredState({
    async run() {
      return {
        exitCode: 1,
        stdout: Buffer.from(""),
      };
    },
  });
  assert.equal(unavailable.count, null);

  const malformed = await readIgnoredState({
    async run() {
      return {
        exitCode: 0,
        stdout: Buffer.from("! missing-nul"),
      };
    },
  });
  assert.equal(malformed.count, null);
});

test("sparse state accepts only exact boolean output and counts patterns", async () => {
  const outputs = new Map([
    ["core.sparseCheckout", {
      exitCode: 0,
      stdout: Buffer.from("true\n"),
    }],
    ["core.sparseCheckoutCone", {
      exitCode: 0,
      stdout: Buffer.from("false\n"),
    }],
    ["index.sparse", {
      exitCode: 1,
      stdout: Buffer.alloc(0),
    }],
  ]);
  const boundary = {
    async run(args) {
      if (args[0] === "sparse-checkout") {
        return {
          exitCode: 0,
          stdout: Buffer.from("src\nlib\n"),
        };
      }
      return outputs.get(args.at(-1));
    },
  };
  assert.deepEqual(await readSparseState(boundary), {
    gaps: [],
    observed: {
      enabled: true,
      cone: false,
      sparseIndex: false,
      patternCount: 2,
    },
  });

  const unknown = await readSparseState({
    async run(args) {
      if (args.at(-1) === "core.sparseCheckout") {
        return {
          exitCode: 0,
          stdout: Buffer.from("yes\n"),
        };
      }
      return {
        exitCode: 1,
        stdout: Buffer.from("unexpected"),
      };
    },
  });
  assert.equal(unknown.observed.enabled, null);
  assert.equal(unknown.observed.patternCount, null);
  assert.ok(unknown.gaps.some(({ code }) =>
    code === "sparse-enabled-unknown"));
  assert.ok(unknown.gaps.some(({ code }) =>
    code === "sparse-pattern-count-unknown"));
});

test("unrepresentable and missing worktrees remain explicit", async () => {
  const limits = normalizeLimits();
  const request = { limits };

  const unrepresentableContext = createCollectionContext(
    limits,
    undefined,
  );
  const unrepresentable = await inspectWorktree({
    path: null,
    pathRepresentable: false,
  }, request, unrepresentableContext);
  assert.equal(unrepresentable.unknown, true);
  assert.equal(
    unrepresentableContext.gaps[0].code,
    "worktree-path-unrepresentable",
  );

  const missingContext = createCollectionContext(limits, undefined);
  const missing = await inspectWorktree({
    path: "C:\\path-that-does-not-exist\\worktree",
    pathRepresentable: true,
  }, request, missingContext);
  assert.equal(missing.missing, true);
  assert.equal(missingContext.gaps[0].code, "worktree-missing");

  assert.equal(matchingBranch({}, []), null);
});

test("raw argv decoders require exact canonical UTF-8 identities", () => {
  assert.equal(
    decodeRawPath(encoded("C:\\repo\\tree")),
    "C:\\repo\\tree",
  );
  assert.equal(
    decodeFullRef(
      Buffer.from("refs/heads/topic").toString("base64"),
    ),
    "refs/heads/topic",
  );
  for (const value of [
    {},
    { rawBase64: "***" },
    encoded("bad\0path"),
    { rawBase64: Buffer.from([0xff]).toString("base64") },
  ]) {
    assert.throws(() => decodeRawPath(value));
  }
  for (const value of [
    null,
    "***",
    Buffer.from("refs/tags/v1").toString("base64"),
    Buffer.from("refs/heads/").toString("base64"),
    Buffer.from("refs/heads/bad\nref").toString("base64"),
    Buffer.from([0xff]).toString("base64"),
  ]) {
    assert.throws(() => decodeFullRef(value));
  }
});

test("plan helpers emit guarded local commands and stable ordering", () => {
  const base = {
    id: "carrier",
    preservationWitnessIds: [],
    prerequisiteIds: [],
  };
  const worktree = planStep({
    ...base,
    action: "remove-worktree",
    identity: {
      path: encoded("C:\\repo\\tree"),
      headOid: null,
      statusFingerprint: "fingerprint",
    },
  });
  assert.equal(worktree.expected.headOid, "");

  const branch = planStep({
    ...base,
    action: "delete-ref",
    type: "local-branch",
    identity: {
      refRawBase64: Buffer.from("refs/heads/topic").toString("base64"),
      tipOid: oid("a"),
    },
  });
  assert.deepEqual(branch.argv, [
    "update-ref",
    "-d",
    "refs/heads/topic",
    oid("a"),
  ]);
  assert.throws(() => planStep({
    ...base,
    action: "delete-ref",
    type: "remote-branch",
    identity: {},
  }));

  const stashZero = {
    id: "zero",
    action: "drop-stash",
    expected: { observedSelector: "stash@{0}" },
  };
  const stashTwo = {
    id: "two",
    action: "drop-stash",
    expected: { observedSelector: "stash@{2}" },
  };
  assert.ok(sortSteps(worktree, branch) < 0);
  assert.ok(sortSteps(branch, stashZero) < 0);
  assert.ok(sortSteps(stashTwo, stashZero) < 0);
  assert.equal(
    drift("subject", "field", undefined, undefined).expected,
    null,
  );
});

test("unrepresentable local refs are blocked before action planning", () => {
  const branch = (id, refRawBase64, protection) => ({
    id,
    type: "local-branch",
    displayName: id,
    identity: {
      refRawBase64,
      tipOid: oid("a"),
    },
    observed: {
      tipOid: oid("a"),
    },
    changeUnitIds: ["unit-a"],
    changeUnitsComplete: true,
    evidence: "complete",
    durability: "durable",
    protection,
    protectionEvidence: "complete",
    identityCurrent: true,
    survives: true,
    observations: [],
    action: "keep",
    eligible: false,
    preservationWitnessIds: [],
    prerequisiteIds: [],
    blockerCodes: [],
  });
  const evidence = {
    carriers: [
      branch(
        "invalid-ref",
        Buffer.from([0xff]).toString("base64"),
        "unprotected",
      ),
      branch(
        "protected-copy",
        Buffer.from("refs/heads/main").toString("base64"),
        "protected",
      ),
    ],
    relationships: [],
    changeUnits: [{ id: "unit-a" }],
    coverage: { skippedCounts: { worktrees: 0 } },
  };

  let items;
  assert.doesNotThrow(() => {
    items = buildWorkItems(evidence);
  });
  const invalid = items.flatMap(({ carriers }) => carriers)
    .find(({ id }) => id === "invalid-ref");
  assert.ok(invalid.blockerCodes.includes("branch-ref-unrepresentable"));
  assert.equal(invalid.action, "keep");
  assert.equal(invalid.eligible, false);
});

test("policy deletes merged local refs and distinguishes active branch outcomes", () => {
  const merged = buildWorkItems(policyEvidence([
    policyBranch("merged", { ahead: 0, behind: 5, units: [] }),
  ]))[0];
  assert.equal(merged.recommendation, "delete");
  assert.equal(merged.evidence, "complete");
  assert.equal(merged.confidence, "proven");
  assert.equal(merged.carriers[0].action, "delete-ref");
  assert.equal(merged.carriers[0].eligible, true);

  const diverged = buildWorkItems(policyEvidence([
    policyBranch("diverged", { ahead: 2, behind: 4 }),
  ]))[0];
  assert.equal(diverged.recommendation, "update-rebase");
  assert.equal(diverged.reasons[0].code, "branch-diverged-update");

  const ahead = buildWorkItems(policyEvidence([
    policyBranch("ahead", { ahead: 2, behind: 0 }),
  ]))[0];
  assert.equal(ahead.recommendation, "open-pr");
  assert.equal(ahead.reasons[0].code, "branch-ready-for-pr");
});

test("policy preserves open pull requests and identifies exact merged remote heads", () => {
  const pullRequest = (state) => ({
    state,
    mergedAt: state === "MERGED" ? "2026-08-31T00:00:00Z" : null,
    exactHeadMatch: true,
    headOid: oid("a"),
  });
  const open = buildWorkItems(policyEvidence([
    policyBranch("open", {
      pullRequests: [pullRequest("OPEN")],
      blockers: ["pr-open"],
    }),
  ]))[0];
  assert.equal(open.recommendation, "resume");

  const merged = buildWorkItems(policyEvidence([
    policyBranch("remote-merged", {
      type: "remote-branch",
      ahead: 3,
      behind: 8,
      pullRequests: [pullRequest("MERGED")],
    }),
  ]))[0];
  assert.equal(merged.recommendation, "delete");
  assert.equal(merged.evidence, "complete");
  assert.equal(merged.reasons[0].code, "merged-pr-exact-head");
  assert.equal(merged.carriers[0].eligible, false);

  const mergedCheckedOut = policyBranch("merged-checked-out", {
    pullRequests: [pullRequest("MERGED")],
    blockers: ["branch-checked-out"],
    checkedOutWorktreeIds: ["dirty-worktree"],
  });
  const dirtyWorktree = {
    ...policyBranch("dirty-worktree", {
      type: "worktree",
      durability: "non-durable",
      blockers: ["worktree-dirty"],
    }),
    identity: {
      path: encoded("C:/dirty-worktree"),
      headOid: oid("a"),
      statusFingerprint: "dirty",
    },
    observed: {
      main: false,
      headOid: oid("a"),
      branchCarrierId: mergedCheckedOut.id,
    },
  };
  const mergedDirty = buildWorkItems(policyEvidence(
    [mergedCheckedOut, dirtyWorktree],
    [{
      type: "worktree-branch",
      exact: true,
      leftId: mergedCheckedOut.id,
      rightId: dirtyWorktree.id,
      headOid: oid("a"),
      branchCarrierId: mergedCheckedOut.id,
    }],
  ))[0];
  assert.equal(mergedDirty.recommendation, "keep-save");

  const partial = buildWorkItems(policyEvidence([
    policyBranch("remote-partial", {
      type: "remote-branch",
      complete: false,
    }),
  ]))[0];
  assert.equal(partial.recommendation, "defer");
});

test("cleanup evidence ignores blockers on retained carriers and records worktree prerequisites", () => {
  const branch = policyBranch("checked-out", {
    ahead: 0,
    behind: 3,
    units: [],
    blockers: ["branch-checked-out"],
    checkedOutWorktreeIds: ["worktree"],
  });
  const worktree = {
    ...policyBranch("worktree", {
      type: "worktree",
      ahead: 0,
      behind: 3,
      units: [],
      durability: "non-durable",
    }),
    identity: {
      path: encoded("C:/repo-worktree"),
      headOid: oid("a"),
      statusFingerprint: "clean",
    },
    observed: {
      main: false,
      headOid: oid("a"),
      branchCarrierId: branch.id,
    },
  };
  const [item] = buildWorkItems(policyEvidence(
    [branch, worktree],
    [{
      type: "worktree-branch",
      exact: true,
      leftId: branch.id,
      rightId: worktree.id,
      headOid: oid("a"),
      branchCarrierId: branch.id,
    }],
  ));
  const byId = new Map(item.carriers.map((carrier) => [carrier.id, carrier]));
  assert.equal(item.recommendation, "delete");
  assert.equal(item.evidence, "complete");
  assert.equal(item.confidence, "proven");
  assert.deepEqual(item.blockers, []);
  assert.equal(byId.get("worktree").action, "remove-worktree");
  assert.equal(byId.get("worktree").eligible, true);
  assert.deepEqual(byId.get("checked-out").prerequisiteIds, ["worktree"]);
});

test("policy records partial overlap coverage at the comparison limit", () => {
  const evidence = policyEvidence(
    Array.from({ length: 5 }, (_, index) =>
      policyBranch(`overlap-${index}`, {
        units: ["unit-a", `unique-${index}`],
      })),
  );
  evidence.request = {
    scope: "all",
    limits: { maxComparisons: 2 },
  };
  evidence.coverage.gaps = [];

  const items = buildWorkItems(evidence);

  assert.equal(items.length, 5);
  assert.equal(evidence.coverage.state, "partial");
  assert.deepEqual(
    evidence.coverage.gaps.map(({ code }) => code),
    ["work-item-overlap-limit"],
  );
});
