import assert from "node:assert/strict";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  SCHEMA_VERSION,
  analyzeRepository as analyzeRepositoryWithGitHub,
  parseArguments,
  revalidateRepository as revalidateRepositoryWithGitHub,
} from "../scripts/triage.mjs";
import {
  DEFAULT_ANALYSIS_LIMITS,
  collectEvidence as collectEvidenceWithGitHub,
  emptyTreeOid,
  normalizeLimits,
  parseRawDiff,
  parseStashList,
  parseStashParents,
  parseWorktrees,
} from "../scripts/lib/evidence.mjs";
import { digestResult } from "../scripts/lib/triage-shared.mjs";
import {
  hashFilesystemEntry,
  parseBranchRefs,
  parseFixedNulRecords,
  parseReplacementRefs,
} from "../scripts/lib/git.mjs";
import { validateMechanicalResult } from "../scripts/lib/review-policy.mjs";
import {
  parseCountObjects,
  parseLargeBlobInventory,
  parseTagInventory,
} from "../scripts/lib/legacy-inventory.mjs";
import {
  cleanupRepoFixtures,
  createRepoFixture,
} from "./helpers/repo-fixture.mjs";

after(cleanupRepoFixtures);

const script = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "scripts",
  "triage.mjs",
);
const oid = (character) => character.repeat(40);
const analyzeRepository = (repoPath, options = {}) =>
  analyzeRepositoryWithGitHub(repoPath, {
    githubEnabled: false,
    ...options,
  });
const collectEvidence = (repoPath, options = {}) =>
  collectEvidenceWithGitHub(repoPath, {
    githubEnabled: false,
    ...options,
  });
const revalidateRepository = (
  repoPath,
  prior,
  selectedCarrierIds,
  options = {},
) => revalidateRepositoryWithGitHub(
  repoPath,
  prior,
  selectedCarrierIds,
  {
    githubEnabled: false,
    ...options,
  },
);
const resultKeys = [
  "schemaVersion", "operation", "runId", "generatedAt", "repository",
  "request", "workItems", "coverage", "reviewBundle", "actionPlan", "drift",
  "compatibility", "inventory",
].sort();
const carrierKeys = [
  "id", "type", "displayName", "identity", "observed", "changeUnitIds",
  "changeUnitsComplete", "evidence", "durability", "protection",
  "protectionEvidence", "identityCurrent", "survives", "observations",
  "action", "eligible", "preservationWitnessIds", "prerequisiteIds",
  "blockerCodes",
].sort();

function livePullRequest(number, headOid, overrides = {}) {
  return {
    number,
    state: "OPEN",
    isDraft: false,
    mergedAt: null,
    headRefOid: headOid,
    headRefName: "topic",
    headRepository: {
      id: "R_repo",
      name: "repo",
      nameWithOwner: "owner/repo",
    },
    baseRefOid: headOid,
    baseRefName: "main",
    url: `https://github.com/owner/repo/pull/${number}`,
    mergeStateStatus: "CLEAN",
    reviewDecision: "REVIEW_REQUIRED",
    statusCheckRollup: [],
    ...overrides,
  };
}

function liveBranch(refName, tipOid, protectedBranch = false) {
  return {
    name: refName,
    commit: {
      sha: tipOid,
      url: `https://api.github.com/repos/owner/repo/commits/${tipOid}`,
    },
    protected: protectedBranch,
    protection: {},
    protection_url:
      `https://api.github.com/repos/owner/repo/branches/${refName}/protection`,
  };
}

async function committedFixture(label) {
  const fixture = await createRepoFixture(label);
  await fixture.write("tracked.txt", "base\n");
  fixture.commit("base");
  fixture.git([
    "update-ref",
    "refs/remotes/origin/main",
    fixture.oid(),
  ]);
  fixture.git([
    "symbolic-ref",
    "refs/remotes/origin/HEAD",
    "refs/remotes/origin/main",
  ]);
  return fixture;
}

function carriers(result) {
  return result.workItems.flatMap(({ carriers: itemCarriers }) => itemCarriers);
}

function findCarrier(result, type, predicate = () => true) {
  return carriers(result).find((carrier) => carrier.type === type && predicate(carrier));
}

async function duplicateStashFixture(label) {
  const fixture = await committedFixture(label);
  await fixture.write("tracked.txt", "saved\n");
  fixture.git(["stash", "push", "-m", "duplicate"]);
  fixture.git(["switch", "-c", "saved-copy"]);
  await fixture.write("tracked.txt", "saved\n");
  fixture.commit("saved copy");
  return fixture;
}

test("analysis is read-only and emits the closed stable schema", async () => {
  const fixture = await committedFixture("triage-schema");
  try {
    fixture.git(["branch", "topic"]);
    const before = await fixture.snapshot();
    const first = await analyzeRepository(fixture.root, {
      scope: "all",
      depth: "proof",
    });
    const second = await analyzeRepository(fixture.root, {
      scope: "all",
      depth: "proof",
    });
    const metadata = await analyzeRepository(fixture.root, {
      scope: "all",
      depth: "metadata",
    });
    const review = await analyzeRepository(fixture.root, {
      scope: "all",
      depth: "review",
    });
    assert.deepEqual(Object.keys(first).sort(), resultKeys);
    assert.equal(first.schemaVersion, SCHEMA_VERSION);
    assert.equal(first.operation, "analyze");
    assert.match(first.runId, /^[0-9a-f]{64}$/u);
    assert.equal(first.runId, second.runId);
    assert.deepEqual(first.repository, second.repository);
    assert.deepEqual(first.request, second.request);
    assert.equal(first.actionPlan, null);
    assert.deepEqual(first.drift, []);
    assert.equal(metadata.request.depth, "metadata");
    assert.equal(review.request.depth, "review");
    assert.equal(metadata.actionPlan, null);
    assert.equal(review.actionPlan, null);
    for (const carrier of carriers(first)) {
      assert.deepEqual(Object.keys(carrier).sort(), carrierKeys);
      assert.equal(typeof carrier.observed, "object");
    }
    assert.deepEqual(await fixture.snapshot(), before);
  } finally {
    await fixture.cleanup();
  }
});

test("unique stash remains preserved regardless of metadata or age", async () => {
  const fixture = await committedFixture("triage-unique-stash");
  try {
    await fixture.write("tracked.txt", "unique\n");
    fixture.git(["stash", "push", "-m", "ancient; $(not-a-command)"]);
    const result = await analyzeRepository(fixture.root, {
      scope: "stashes",
      depth: "proof",
    });
    const stash = findCarrier(result, "stash");
    assert.ok(stash);
    assert.equal(
      stash.identity.treeOid,
      fixture.oid("stash@{0}^{tree}"),
    );
    assert.equal(stash.action, "keep");
    assert.equal(stash.eligible, false);
    const item = result.workItems.find(({ carriers: list }) =>
      list.some(({ id }) => id === stash.id));
    assert.notEqual(item.recommendation, "delete");
    assert.equal(item.preservation.lastCopy, true);
  } finally {
    await fixture.cleanup();
  }
});

test("exact duplicate stash is eligible only while a durable copy remains", async () => {
  const fixture = await duplicateStashFixture("triage-duplicate-stash");
  try {
    const result = await analyzeRepository(fixture.root, {
      scope: "all",
      depth: "proof",
    });

    const stash = findCarrier(result, "stash");
    const branch = findCarrier(result, "local-branch", ({ displayName }) =>
      displayName === "refs/heads/saved-copy");
    assert.ok(stash);
    assert.ok(branch);
    assert.equal(stash.action, "drop-stash");
    assert.equal(stash.eligible, true);
    assert.ok(stash.preservationWitnessIds.includes(branch.id));
    for (const exact of [stash, branch]) {
      assert.equal(exact.changeUnitsComplete, true);
      assert.equal(exact.evidence, "complete");
      assert.equal(exact.identityCurrent, true);
      assert.equal(exact.protectionEvidence, "complete");
      assert.equal(exact.survives, true);
      assert.equal(typeof exact.observed, "object");
    }

    const stashOnly = await analyzeRepository(fixture.root, {
      scope: "stashes",
      depth: "proof",
    });
    const stashOnlyBranch = findCarrier(
      stashOnly,
      "local-branch",
      ({ displayName }) => displayName === "refs/heads/saved-copy",
    );
    const stashOnlyStash = findCarrier(stashOnly, "stash");
    assert.equal(stashOnlyBranch.action, "keep");
    assert.equal(stashOnlyBranch.eligible, false);
    assert.ok(stashOnlyBranch.blockerCodes.includes("scope-evidence-only"));
    assert.equal(stashOnlyStash.action, "drop-stash");
    assert.equal(stashOnlyStash.eligible, true);
    assert.ok(stashOnlyStash.preservationWitnessIds.includes(stashOnlyBranch.id));

    const selected = structuredClone(result);
    const selectedBranch = findCarrier(selected, "local-branch", ({ id }) => id === branch.id);
    selectedBranch.action = "delete-ref";
    selectedBranch.eligible = true;
    selectedBranch.preservationWitnessIds = [stash.id];
    await assert.rejects(
      revalidateRepository(
        fixture.root,
        selected,
        [stash.id, branch.id],
      ),
      /closed analyze 1\.1\.0 result/u,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("stash components preserve snapshots while review follows final intent", async () => {
  const fixture = await committedFixture("triage-stash-components");
  try {
    const stashOids = {};
    const save = (name, includeUntracked = false) => {
      fixture.git([
        "stash",
        "push",
        ...(includeUntracked ? ["--include-untracked"] : []),
        "-m",
        name,
      ]);
      stashOids[name] = fixture.oid("refs/stash");
    };

    await fixture.write("tracked.txt", "staged-only\n");
    fixture.git(["add", "tracked.txt"]);
    save("staged-only");

    await fixture.write("tracked.txt", "unstaged-only\n");
    save("unstaged-only");

    await fixture.write("tracked.txt", "staged-reverted\n");
    fixture.git(["add", "tracked.txt"]);
    await fixture.write("tracked.txt", "base\n");
    save("staged-reverted");

    await fixture.write("tracked.txt", "mixed-staged\n");
    fixture.git(["add", "tracked.txt"]);
    await fixture.write("tracked.txt", "mixed-final\n");
    await fixture.write("mixed-untracked.txt", "mixed untracked\n");
    save("mixed", true);

    await fixture.write("only-untracked.txt", "only untracked\n");
    save("untracked-only", true);

    const result = await analyzeRepository(fixture.root, {
      scope: "stashes",
      depth: "review",
    });
    const byName = Object.fromEntries(
      Object.entries(stashOids).map(([name, stashOid]) => [
        name,
        findCarrier(
          result,
          "stash",
          ({ identity }) => identity.stashOid === stashOid,
        ),
      ]),
    );
    const components = (name) =>
      byName[name].observed.componentChangeUnitIds;

    assert.deepEqual(
      Object.fromEntries(Object.entries(components("staged-only"))
        .map(([name, ids]) => [name, ids.length])),
      { staged: 1, unstaged: 0, trackedFinal: 1, untracked: 0 },
    );
    assert.deepEqual(
      components("staged-only").staged,
      components("staged-only").trackedFinal,
    );
    assert.deepEqual(
      Object.fromEntries(Object.entries(components("unstaged-only"))
        .map(([name, ids]) => [name, ids.length])),
      { staged: 0, unstaged: 1, trackedFinal: 1, untracked: 0 },
    );
    assert.deepEqual(
      Object.fromEntries(Object.entries(components("staged-reverted"))
        .map(([name, ids]) => [name, ids.length])),
      { staged: 1, unstaged: 1, trackedFinal: 0, untracked: 0 },
    );
    assert.deepEqual(
      Object.fromEntries(Object.entries(components("mixed"))
        .map(([name, ids]) => [name, ids.length])),
      { staged: 1, unstaged: 1, trackedFinal: 1, untracked: 1 },
    );
    assert.deepEqual(
      Object.fromEntries(Object.entries(components("untracked-only"))
        .map(([name, ids]) => [name, ids.length])),
      { staged: 0, unstaged: 0, trackedFinal: 0, untracked: 1 },
    );

    const mixedFinalId = components("mixed").trackedFinal[0];
    assert.equal(
      byName.mixed.changeUnitIds.includes(mixedFinalId),
      false,
    );
    assert.match(
      result.reviewBundle.prompt,
      /-base\r?\n\+\+\+ after\r?\n\+mixed-final/u,
    );

    const comparisonLimited = await collectEvidence(fixture.root, {
      scope: "stashes",
      depth: "proof",
      limits: {
        maxComparisons: 0,
        maxStashes: 1,
      },
    });
    const limitedStash = comparisonLimited.carriers.find(
      ({ type }) => type === "stash",
    );
    assert.equal(limitedStash.changeUnitsComplete, false);
    assert.deepEqual(limitedStash.observed.componentChangeUnitIds, {
      staged: [],
      unstaged: [],
      trackedFinal: [],
      untracked: [],
    });
  } finally {
    await fixture.cleanup();
  }
});

test("main and linked dirty worktrees are inventoried and never removable", async () => {
  const fixture = await committedFixture("triage-dirty-worktrees");
  try {
    fixture.git(["branch", "linked"]);
    const linkedPath = path.join(fixture.root, "linked-tree");
    fixture.git(["worktree", "add", "--quiet", linkedPath, "linked"]);
    await fixture.write("main-untracked.txt", "main dirty\n");
    await fixture.write(path.join("linked-tree", "linked-untracked.txt"), "linked dirty\n");
    const result = await analyzeRepository(fixture.root, {
      scope: "worktrees",
      depth: "proof",
    });
    const trees = carriers(result).filter(({ type }) => type === "worktree");
    assert.equal(trees.length, 2);
    assert.equal(trees.some(({ observed }) => observed.main), true);
    const linkedGitDir = fixture.git([
      "-C",
      linkedPath,
      "rev-parse",
      "--path-format=absolute",
      "--absolute-git-dir",
    ]).stdout.toString("utf8").trim();
    const linkedTree = trees.find(({ observed }) => !observed.main);
    assert.equal(
      Buffer.from(
        linkedTree.identity.gitDir.rawBase64,
        "base64",
      ).toString("utf8"),
      linkedGitDir,
    );
    assert.notDeepEqual(
      trees[0].identity.gitDir,
      trees[1].identity.gitDir,
    );
    for (const tree of trees) {
      assert.equal(tree.action, "keep");
      assert.equal(tree.eligible, false);
      assert.ok(tree.blockerCodes.includes("worktree-dirty"));
      assert.match(tree.identity.statusFingerprint, /^[0-9a-f]{64}$/u);
    }
    for (const branch of carriers(result).filter(({ type }) =>
      type === "local-branch" || type === "remote-branch")) {
      assert.equal(branch.action, "keep");
      assert.equal(branch.eligible, false);
      assert.ok(branch.blockerCodes.includes("scope-evidence-only"));
    }
  } finally {
    await fixture.cleanup();
  }
});

test("clean sparse worktree reports bounded configuration observations", async () => {
  const fixture = await committedFixture("triage-sparse-worktree");
  try {
    await fixture.write("src/kept.txt", "kept\n");
    fixture.commit("add sparse directory");
    fixture.git(["sparse-checkout", "init", "--cone", "--sparse-index"]);
    fixture.git(["sparse-checkout", "set", "src"]);
    fixture.git(["config", "--local", "core.sparseCheckout", "true"]);
    fixture.git(["config", "--local", "core.sparseCheckoutCone", "true"]);
    fixture.git(["config", "--local", "index.sparse", "true"]);

    const result = await analyzeRepository(fixture.root, {
      scope: "worktrees",
      depth: "proof",
    });
    const main = findCarrier(
      result,
      "worktree",
      ({ observed }) => observed.main,
    );
    assert.deepEqual(main.observed.sparse, {
      enabled: true,
      cone: true,
      sparseIndex: true,
      patternCount: 1,
    });
    assert.deepEqual(main.observed.statusCounts, {
      staged: 0,
      unstaged: 0,
      submodule: 0,
      conflict: 0,
      intentToAdd: 0,
      untracked: 0,
    });
    assert.ok(main.blockerCodes.includes("worktree-main"));
    assert.equal(main.protection, "protected");
  } finally {
    await fixture.cleanup();
  }
});

test("ignored-only linked worktree is blocked without leaking ignored data", async () => {
  const fixture = await committedFixture("triage-ignored-worktree");
  try {
    await fixture.write(".gitignore", "*.private\n");
    fixture.commit("ignore private files");
    fixture.git(["branch", "ignored-linked"]);
    const linkedPath = path.join(fixture.root, "ignored-linked-tree");
    fixture.git([
      "worktree",
      "add",
      "--quiet",
      linkedPath,
      "ignored-linked",
    ]);
    const secretName = "do-not-serialize.private";
    const secretPayload = "ignored payload must remain unread";
    await fixture.write(
      path.join("ignored-linked-tree", secretName),
      secretPayload,
    );

    const result = await analyzeRepository(fixture.root, {
      scope: "worktrees",
      depth: "review",
    });
    const linked = findCarrier(
      result,
      "worktree",
      ({ observed }) => !observed.main,
    );
    assert.equal(linked.observed.ignoredPathCount, 1);
    assert.deepEqual(linked.observed.statusCounts, {
      staged: 0,
      unstaged: 0,
      submodule: 0,
      conflict: 0,
      intentToAdd: 0,
      untracked: 0,
    });
    assert.ok(linked.blockerCodes.includes("ignored-content-present"));
    assert.equal(linked.action, "keep");
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes(secretName), false);
    assert.equal(serialized.includes(secretPayload), false);
  } finally {
    await fixture.cleanup();
  }
});

test("submodule dirtiness has a specific worktree blocker", async () => {
  const source = await committedFixture("triage-submodule-source");
  const fixture = await committedFixture("triage-submodule-worktree");
  try {
    fixture.git([
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      "--quiet",
      source.root,
      "module",
    ]);
    fixture.commit("add submodule");
    await fixture.write("module/tracked.txt", "dirty submodule\n");

    const result = await analyzeRepository(fixture.root, {
      scope: "worktrees",
      depth: "proof",
    });
    const main = findCarrier(result, "worktree");
    assert.equal(main.observed.statusCounts.submodule, 1);
    assert.equal(main.observed.statusCounts.unstaged, 1);
    assert.ok(main.blockerCodes.includes("worktree-submodule-dirty"));
    assert.ok(main.blockerCodes.includes("worktree-dirty"));
  } finally {
    await fixture.cleanup();
    await source.cleanup();
  }
});

test("conflict and intent-to-add status fail closed with exact counts", async () => {
  const conflict = await committedFixture("triage-conflict-worktree");
  const intent = await committedFixture("triage-intent-worktree");
  try {
    conflict.git(["switch", "--quiet", "-c", "conflict-side"]);
    await conflict.write("tracked.txt", "side\n");
    conflict.commit("side change");
    conflict.git(["switch", "--quiet", "main"]);
    await conflict.write("tracked.txt", "main\n");
    conflict.commit("main change");
    const merge = conflict.git(
      ["merge", "--no-edit", "conflict-side"],
      { allowFailure: true },
    );
    assert.notEqual(merge.status, 0);

    const conflicted = await analyzeRepository(conflict.root, {
      scope: "worktrees",
      depth: "proof",
    });
    const conflictedMain = findCarrier(conflicted, "worktree");
    assert.equal(conflictedMain.observed.statusCounts.conflict, 1);
    assert.ok(conflictedMain.blockerCodes.includes("worktree-conflict"));
    assert.equal(conflictedMain.changeUnitsComplete, false);

    await intent.write("intent.txt", "intent\n");
    intent.git(["add", "--intent-to-add", "intent.txt"]);
    const intended = await analyzeRepository(intent.root, {
      scope: "worktrees",
      depth: "proof",
    });
    const intendedMain = findCarrier(intended, "worktree");
    assert.equal(intendedMain.observed.statusCounts.intentToAdd, 1);
    assert.ok(
      intendedMain.blockerCodes.includes("worktree-intent-to-add"),
    );
    assert.equal(intendedMain.changeUnitsComplete, false);
  } finally {
    await conflict.cleanup();
    await intent.cleanup();
  }
});

test("remote-tracking-only evidence records explicit refresh and identity gaps", async () => {
  const fixture = await committedFixture("triage-remote-gap");
  try {
    fixture.git(["update-ref", "refs/remotes/origin/remote-only", fixture.oid()]);
    const result = await analyzeRepository(fixture.root, {
      scope: "remote",
      depth: "proof",
      githubReader: async () => {
        const error = new Error("offline");
        error.code = "OFFLINE";
        throw error;
      },
    });
    const remote = findCarrier(result, "remote-branch");
    assert.ok(remote);
    assert.equal(remote.changeUnitsComplete, false);
    assert.equal(remote.evidence, "partial");
    assert.equal(remote.identityCurrent, true);
    assert.equal(remote.protectionEvidence, "partial");
    assert.equal(remote.survives, true);
    assert.equal(result.coverage.state, "partial");
    const gapCodes = result.coverage.gaps.map(({ code }) => code);
    assert.ok(gapCodes.includes("remote-state-not-refreshed"));
    assert.ok(gapCodes.includes("remote-identity-unavailable"));
    assert.ok(gapCodes.includes("github-evidence-unavailable"));
    assert.equal(result.repository.remotes.length, 0);
  } finally {
    await fixture.cleanup();
  }
});

test("hostile ref metadata remains inert and display-safe", async () => {
  const fixture = await committedFixture("triage-hostile-ref");
  try {
    const marker = path.join(fixture.root, "executed.txt");
    fixture.git(["branch", "hostile;$(echo-owned)"]);
    const result = await analyzeRepository(fixture.root, {
      scope: "branches",
      depth: "metadata",
    });
    const hostile = findCarrier(result, "local-branch", ({ displayName }) =>
      displayName.includes("hostile"));
    assert.ok(hostile);
    assert.equal(
      Buffer.from(hostile.identity.refRawBase64, "base64").toString("utf8"),
      "refs/heads/hostile;$(echo-owned)",
    );
    assert.doesNotMatch(hostile.displayName, /[\u0000-\u001f\u007f]/u);
    await assert.rejects(access(marker));
  } finally {
    await fixture.cleanup();
  }
});

test("collector enforces named limits and reports skipped proof", async () => {
  const fixture = await committedFixture("triage-limits");
  try {
    fixture.git(["branch", "a"]);
    fixture.git(["branch", "b"]);
    const evidence = await collectEvidence(fixture.root, {
      scope: "branches",
      depth: "proof",
      limits: { maxRefs: 1, maxChangeUnits: 0 },
    });
    assert.equal(evidence.request.limits.maxRefs, 1);
    assert.equal(
      evidence.request.limits.maxStashes,
      DEFAULT_ANALYSIS_LIMITS.maxStashes,
    );
    assert.ok(evidence.coverage.limitsReached.includes("maxRefs"));
    assert.ok(evidence.coverage.gaps.some(({ code }) => code === "maxRefs-limit"));
    assert.ok(evidence.coverage.skippedCounts.localBranches > 0);
    await assert.rejects(
      collectEvidence(fixture.root, { limits: { invented: 1 } }),
      /unknown limit/u,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("review depth builds a bounded bundle without invoking a model", async () => {
  const fixture = await committedFixture("triage-review");
  try {
    fixture.git(["switch", "-c", "review-topic"]);
    await fixture.write("tracked.txt", "reviewed\n");
    fixture.commit("review content");
    fixture.git(["switch", "main"]);
    const result = await analyzeRepository(fixture.root, {
      scope: "branches",
      depth: "review",
      limits: { maxReviewBytesTotal: 100 },
    });
    assert.equal(result.request.depth, "review");
    assert.equal(result.reviewBundle.schemaVersion, "1.0.0");
    assert.equal(result.reviewBundle.limits.maxBytesTotal, 100);
    assert.ok(result.reviewBundle.counts.includedBytes > 0);
    assert.match(result.reviewBundle.prompt, /-base/u);
    assert.match(result.reviewBundle.prompt, /\+reviewed/u);
    assert.equal(result.workItems.every(({ review }) => review === null), true);
    assert.deepEqual(Object.keys(result).sort(), resultKeys);
    assert.ok(JSON.parse(JSON.stringify(result)).reviewBundle);

    const limited = await analyzeRepository(fixture.root, {
      scope: "branches",
      depth: "review",
      limits: { maxReviewBytesTotal: 1 },
    });
    assert.ok(limited.coverage.observedCounts.reviewFiles > 0);
    assert.ok(limited.coverage.skippedCounts.reviewFiles > 0);
    const workItemIds = new Set(
      limited.workItems.map(({ id }) => id),
    );
    const readGap = limited.reviewBundle.gaps.find(
      ({ code }) => code === "review-byte-limit",
    );
    assert.ok(readGap);
    assert.equal(
      readGap.affectedIds.every((id) => workItemIds.has(id)),
      true,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("stable revalidation emits an inert plan and drift suppresses it", async () => {
  const fixture = await duplicateStashFixture("triage-revalidate");
  try {
    const before = await fixture.snapshot();
    const analyzed = await analyzeRepository(fixture.root, {
      scope: "all",
      depth: "proof",
    });

    const stash = findCarrier(analyzed, "stash", ({ eligible }) => eligible);
    assert.ok(stash);
    const stable = await revalidateRepository(fixture.root, analyzed, [stash.id]);
    assert.equal(stable.operation, "revalidate");
    assert.deepEqual(stable.drift, []);
    assert.equal(stable.actionPlan.authorized, false);
    assert.equal(stable.actionPlan.basedOnRunId, analyzed.runId);
    assert.deepEqual(stable.actionPlan.selectedCarrierIds, [stash.id]);
    assert.deepEqual(stable.actionPlan.steps[0].argv, [
      "stash", "drop", stash.identity.observedSelector,
    ]);
    assert.deepEqual(await fixture.snapshot(), before);

    const proofTampered = structuredClone(analyzed);
    const proofCarrier = findCarrier(
      proofTampered,
      "stash",
      ({ id }) => id === stash.id,
    );
    Object.assign(proofCarrier, {
      changeUnitsComplete: false,
      evidence: "partial",
      protectionEvidence: "partial",
      identityCurrent: false,
      survives: false,
    });

    test("revalidation rejects invalid selections and records material drift", async () => {
      const fixture = await duplicateStashFixture("triage-revalidate-drift");
      const other = await committedFixture("triage-revalidate-other");
      try {
        const analyzed = await analyzeRepository(fixture.root, {
          scope: "all",
          depth: "proof",
        });
        const stash = findCarrier(analyzed, "stash", ({ eligible }) => eligible);
        assert.ok(stash);
        for (const selected of [[], [stash.id, stash.id], [1], null]) {
          await assert.rejects(
            revalidateRepository(fixture.root, analyzed, selected),
            /nonempty unique string array/u,
          );
        }
        const moved = await revalidateRepository(other.root, analyzed, [stash.id]);
        assert.ok(moved.drift.some(({ subjectId, field }) =>
          subjectId === "repository" && field === "identity"));
        assert.ok(moved.drift.some(({ subjectId, code }) =>
          subjectId === stash.id && code === "carrier-missing"));
        fixture.git(["switch", "main"]);
        fixture.git(["branch", "-D", "saved-copy"]);
        const weakened = await revalidateRepository(fixture.root, analyzed, [stash.id]);
        assert.equal(weakened.actionPlan, null);
        assert.ok(weakened.drift.some(({ code }) => code === "last-copy-drift"));
        assert.ok(weakened.drift.some(({ code }) => code === "carrier-ineligible"));
      } finally {
        await fixture.cleanup();
        await other.cleanup();
      }
    });
    proofTampered.runId = digestResult(proofTampered);
    await assert.rejects(
      revalidateRepository(
        fixture.root,
        proofTampered,
        [stash.id],
      ),
      /closed analyze 1\.1\.0 result/u,
    );

    await fixture.write("drift.txt", "new stash\n");
    fixture.git(["stash", "push", "--include-untracked", "-m", "selector drift"]);
    const drifted = await revalidateRepository(fixture.root, analyzed, [stash.id]);
    assert.equal(drifted.actionPlan, null);
    assert.ok(drifted.drift.length > 0);

    for (const mutate of [
      (value) => {
        value.runId = "0".repeat(64);
      },
      (value) => {
        value.generatedAt = "not-a-timestamp";
      },
      (value) => {
        findCarrier(value, "stash").displayName = 42;
      },
      (value) => {
        value.inventory.tags = [{}];
      },
    ]) {
      const tampered = structuredClone(analyzed);
      mutate(tampered);
      await assert.rejects(
        revalidateRepository(fixture.root, tampered, [stash.id]),
        /closed analyze 1\.1\.0 result/u,
      );
    }

  } finally {
    await fixture.cleanup();
  }
});

test("argument parsing and CLI failures are strict", async () => {
  assert.throws(() => parseArguments(null), TypeError);
  assert.deepEqual(parseArguments([]), {
    operation: "analyze",
    scope: "all",
    depth: "proof",
    includeIgnored: false,
    dryRun: false,
  });
  assert.deepEqual(parseArguments([
    "analyze", "stashes", "--depth", "review", "--include-ignored", "--dry-run",
  ]), {
    operation: "analyze",
    scope: "stashes",
    depth: "review",
    includeIgnored: true,
    dryRun: true,
  });
  for (const argv of [
    ["unknown"],
    ["branches", "stashes"],
    ["--depth"],
    ["--depth", "deep"],
    ["branches", "analyze"],
    ["revalidate", "branches"],
    ["--dry-run", "--dry-run"],
    ["--depth", "proof", "--depth", "review"],
  ]) {
    assert.throws(() => parseArguments(argv), TypeError);
  }

  const fixture = await committedFixture("triage-cli-errors");
  try {
    for (const argv of [["--wat"], ["revalidate", "--dry-run"]]) {
      const result = spawnSync(process.execPath, [script, ...argv], {
        cwd: fixture.root,
        encoding: "utf8",
        shell: false,
      });
      assert.equal(result.status, 2);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /^git-tidy: /u);
    }
    const hostile = spawnSync(process.execPath, [script, "--bad\nsecond-line"], {
      cwd: fixture.root,
      encoding: "utf8",
      shell: false,
    });
    assert.equal(hostile.status, 2);
    assert.equal(hostile.stderr.trim().split(/\r?\n/u).length, 1);
    const missingInput = spawnSync(process.execPath, [script, "revalidate"], {
      cwd: fixture.root,
      input: "",
      encoding: "utf8",
      shell: false,
    });
    assert.equal(missingInput.status, 2);
    assert.match(missingInput.stderr, /requires JSON stdin/u);
    for (const input of [
      Buffer.from([0xff]),
      "{",
      JSON.stringify({ result: {}, selectedCarrierIds: [], extra: true }),
    ]) {
      const invalid = spawnSync(process.execPath, [script, "revalidate"], {
        cwd: fixture.root,
        input,
        encoding: "utf8",
        shell: false,
      });
      assert.equal(invalid.status, 2);
      assert.equal(invalid.stdout, "");
      assert.equal(invalid.stderr.trim().split(/\r?\n/u).length, 1);
    }
    const oversized = spawnSync(process.execPath, [script, "revalidate"], {
      cwd: fixture.root,
      input: Buffer.alloc(20 * 1024 * 1024 + 1, 0x20),
      encoding: "utf8",
      shell: false,
      maxBuffer: 1024 * 1024,
    });
    assert.equal(oversized.status, 2);
    assert.equal(oversized.stdout, "");
    assert.match(oversized.stderr, /exceeds the 20 MiB limit/u);
  } finally {
    await fixture.cleanup();
  }
});

test("extended proof paths fail closed and guarded plans stay inert", async () => {
  const fixture = await committedFixture("triage-extended");
  try {
    fixture.git(["branch", "topic"]);
    fixture.git(["branch", "linked"]);
    const linkedPath = path.join(fixture.root, "linked-clean");
    fixture.git(["worktree", "add", "--quiet", linkedPath, "linked"]);

    await fixture.write("tracked.txt", "staged\n");
    fixture.git(["add", "tracked.txt"]);
    await fixture.write("tracked.txt", "unstaged\n");
    await fixture.write("untracked.txt", "untracked\n");
    await fixture.makeSymlink("untracked-link", "tracked.txt");
    const dirty = await collectEvidence(fixture.root, {
      scope: "worktrees",
      depth: "proof",
      includeIgnored: true,
    });
    const components = new Set(dirty.changeUnits.map(({ sourceComponent }) => sourceComponent));
    assert.ok(components.has("staged"));
    assert.ok(dirty.coverage.gaps.some(
      ({ code }) => code === "unstaged-content-unhashed",
    ));
    assert.ok(components.has("untracked"));
    assert.ok(dirty.coverage.gaps.some(({ code }) => code === "ignored-content-not-read"));

    const analyzed = await analyzeRepository(fixture.root, {
      scope: "all",
      depth: "proof",
    });
    assert.ok(analyzed.inventory.maintenance);
    const topic = findCarrier(analyzed, "local-branch", ({ displayName }) =>
      displayName === "refs/heads/topic");
    const linked = findCarrier(analyzed, "worktree", ({ observed }) => !observed.main);
    assert.equal(topic.action, "delete-ref");
    assert.equal(linked.action, "remove-worktree");
    const stable = await revalidateRepository(
      fixture.root,
      analyzed,
      [topic.id, linked.id],
    );
    assert.equal(stable.actionPlan.authorized, false);
    assert.deepEqual(stable.actionPlan.steps.map(({ action }) => action), [
      "remove-worktree", "delete-ref",
    ]);
    assert.deepEqual(
      stable.actionPlan.steps.map(({ approvalClass }) => approvalClass),
      ["worktree-removal", "local-branch-deletion"],
    );
    assert.equal(
      stable.actionPlan.steps[0].argv[3],
      Buffer.from(linked.identity.path.rawBase64, "base64").toString("utf8"),
    );
    assert.deepEqual(stable.actionPlan.steps[1].argv, [
      "update-ref",
      "-d",
      Buffer.from(topic.identity.refRawBase64, "base64").toString("utf8"),
      topic.identity.tipOid,
    ]);

    const runtimeBlocked = await analyzeRepository(fixture.root, {
      scope: "branches",
      depth: "review",
      nodePath: "git",
    });
    assert.equal(runtimeBlocked.request.depth, "metadata");
    assert.ok(runtimeBlocked.coverage.gaps.some(
      ({ code }) => code === "node-runtime-unavailable",
    ));
    assert.equal(carriers(runtimeBlocked).some(({ eligible }) => eligible), false);

    fixture.git(["tag", "release-candidate"]);
    const tags = await analyzeRepository(fixture.root, {
      scope: "tags",
      depth: "proof",
    });
    assert.equal(tags.inventory.tags.length, 1);
    assert.equal(tags.inventory.tags[0].recommendation, "keep");
    assert.equal(tags.coverage.gaps.some(
      ({ code }) => code === "scope-not-collected",
    ), false);
    const limited = await collectEvidence(fixture.root, {
      scope: "worktrees",
      limits: { maxWorktrees: 0 },
    });
    assert.ok(limited.coverage.limitsReached.includes("maxWorktrees"));
  } finally {
    await fixture.cleanup();
  }
});

test("legacy inventories are typed, bounded, and read-only", async () => {
      const fixture = await committedFixture("triage-legacy-inventory");
      try {
        fixture.git(["tag", "lightweight"]);
        fixture.git(["tag", "-a", "annotated", "-m", "release"]);
        for (let index = 0; index < 20; index += 1) {
          fixture.git([
            "branch",
            `noise-${index}-${"x".repeat(80)}`,
          ]);
        }
        await fixture.write("tracked.orig", "tracked recovery\n");
        fixture.git(["add", "tracked.orig"]);
        fixture.commit("add tracked recovery artifact");
        await fixture.write(".gitignore", "*.orig\n");
        fixture.git(["add", ".gitignore"]);
        fixture.commit("ignore recovery artifacts");
        await fixture.write("untracked.rej", "untracked recovery\n");
        await fixture.write("ignored.orig", "ignored recovery\n");
        await mkdir(path.join(fixture.root, ".git", "rebase-merge"));
        const before = await fixture.snapshot();

        const tags = await analyzeRepository(fixture.root, {
          scope: "tags",
          depth: "proof",
        });
        assert.equal(tags.schemaVersion, "1.1.0");
        assert.equal(tags.inventory.tags.length, 2);
        assert.equal(tags.inventory.tags.some(({ peeledOid }) => peeledOid), true);
        assert.deepEqual(tags.inventory.artifacts, []);
        assert.equal(tags.inventory.maintenance, null);
        const isolatedTags = await analyzeRepository(fixture.root, {
          scope: "tags",
          depth: "metadata",
          limits: { maxStdoutBytes: 512 },
        });
        assert.equal(isolatedTags.inventory.tags.length, 2);
        assert.equal(isolatedTags.workItems.length, 0);
        assert.equal(isolatedTags.coverage.gaps.some(
          ({ code }) => code === "metadata-depth-no-proof",
        ), false);

        const artifacts = await analyzeRepository(fixture.root, {
          scope: "artifacts",
          depth: "proof",
          includeIgnored: true,
        });
        assert.deepEqual(
          artifacts.inventory.artifacts.map(({ trackedState }) => trackedState)
            .sort(),
          ["ignored", "tracked", "untracked"],
        );
        assert.equal(
          artifacts.inventory.artifacts.every(
            ({ recommendation }) => recommendation === "inspect",
          ),
          true,
        );

        const blobs = await analyzeRepository(fixture.root, {
          scope: "blobs",
          depth: "proof",
          limits: { maxBlobs: 2 },
        });
        assert.equal(blobs.inventory.blobs.length, 2);
        assert.equal(blobs.coverage.limitsReached.includes("maxBlobs"), true);
        assert.equal(
          blobs.inventory.blobs.every(
            ({ recommendation }) => recommendation === "review",
          ),
          true,
        );

        const maintenance = await analyzeRepository(fixture.root, {
          scope: "maintenance",
          depth: "proof",
        });
        assert.equal(maintenance.inventory.maintenance.recommendation, "inspect");
        assert.deepEqual(
          maintenance.inventory.maintenance.interruptedOperations.map(
            ({ type }) => type,
          ),
          ["rebase-merge"],
        );
        for (const result of [tags, artifacts, blobs, maintenance]) {
          assert.deepEqual(validateMechanicalResult(result), {
            valid: true,
            diagnostics: [],
          });
        }
        assert.deepEqual(await fixture.snapshot(), before);
      } finally {
        await fixture.cleanup();
      }
});

test("legacy inventory parsers reject malformed output", () => {
      const objectOid = oid("a");
      const peeledOid = oid("b");
      const tags = parseTagInventory(Buffer.from(
        `refs/tags/v1\0${objectOid}\0tag\0${peeledOid}\0\n`,
        "ascii",
      ), "sha1");
      assert.equal(tags[0].peeledOid, peeledOid);
      assert.throws(
        () => parseTagInventory(Buffer.from("broken", "ascii"), "sha1"),
        ({ code }) => code === "MALFORMED_GIT_OUTPUT",
      );

      const blobs = parseLargeBlobInventory(Buffer.from(
        `${oid("c")} blob 12\n${oid("d")} commit 120\n`,
        "ascii",
      ), "sha1", 1);
      assert.equal(blobs.records[0].sizeBytes, 12);
      assert.equal(blobs.observed, 1);
      assert.throws(
        () => parseLargeBlobInventory(Buffer.from("broken\n"), "sha1", 1),
        ({ code }) => code === "MALFORMED_GIT_OUTPUT",
      );

      assert.deepEqual(parseCountObjects(Buffer.from(
        "count: 3\nsize: 1\nin-pack: 4\npacks: 1\nsize-pack: 2\n" +
        "prune-packable: 1\ngarbage: 2\nsize-garbage: 3\n",
        "ascii",
      )), {
        looseObjects: 3,
        packedObjects: 4,
        packs: 1,
        sizeKiB: 1,
        garbageCount: 2,
        garbageSizeKiB: 3,
        prunePackable: 1,
      });
});

test("branch scope collects hidden worktree safety evidence", async () => {
  const fixture = await committedFixture("triage-branch-worktree-safety");
  try {
    fixture.git(["branch", "checked-out-topic"]);
    const linkedPath = path.join(fixture.root, "linked-safety");
    fixture.git(["worktree", "add", "--quiet", linkedPath, "checked-out-topic"]);
    const result = await analyzeRepository(fixture.root, {
      scope: "branches",
      depth: "proof",
    });
    assert.equal(carriers(result).some(({ type }) => type === "worktree"), false);
    assert.equal(result.coverage.observedCounts.worktrees, 2);
    const topic = findCarrier(result, "local-branch", ({ displayName }) =>
      displayName === "refs/heads/checked-out-topic");
    assert.ok(topic.observed.checkedOutWorktreeIds.length > 0);
    assert.ok(topic.blockerCodes.includes("branch-checked-out"));
    assert.equal(topic.eligible, false);
  } finally {
    await fixture.cleanup();
  }
});

test("worktree truncation globally blocks local branch deletion", async () => {
  const fixture = await committedFixture("triage-worktree-truncation");
  try {
    fixture.git(["branch", "checked-out-omitted"]);
    const linkedPath = path.join(fixture.root, "omitted-linked");
    fixture.git([
      "worktree",
      "add",
      "--quiet",
      linkedPath,
      "checked-out-omitted",
    ]);

    const result = await analyzeRepository(fixture.root, {
      scope: "branches",
      depth: "proof",
      limits: { maxWorktrees: 1 },
    });
    const topic = findCarrier(
      result,
      "local-branch",
      ({ displayName }) => displayName === "refs/heads/checked-out-omitted",
    );
    assert.equal(result.coverage.skippedCounts.worktrees, 1);
    assert.ok(
      topic.blockerCodes.includes("worktree-registration-incomplete"),
    );
    assert.equal(topic.action, "keep");
    assert.equal(topic.eligible, false);
  } finally {
    await fixture.cleanup();
  }
});

test("detached worktree commits are proved against the default branch", async () => {
  const fixture = await committedFixture("triage-detached-worktree");
  try {
    const linkedPath = path.join(fixture.root, "detached-linked");
    fixture.git([
      "worktree",
      "add",
      "--quiet",
      "--detach",
      linkedPath,
    ]);
    await fixture.write(
      path.join("detached-linked", "detached-only.txt"),
      "detached work\n",
    );
    fixture.git(["-C", linkedPath, "add", "detached-only.txt"]);
    fixture.git(
      ["-C", linkedPath, "commit", "--quiet", "-m", "detached work"],
      {
        env: {
          GIT_AUTHOR_DATE: "2001-01-01T00:01:00+0000",
          GIT_COMMITTER_DATE: "2001-01-01T00:01:00+0000",
        },
      },
    );

    const result = await analyzeRepository(fixture.root, {
      scope: "worktrees",
      depth: "proof",
    });
    const detached = findCarrier(
      result,
      "worktree",
      ({ observed }) => !observed.main && observed.branchCarrierId === null,
    );
    assert.equal(detached.changeUnitsComplete, true);
    assert.equal(detached.observed.committedAncestry.state, "ahead");
    assert.equal(detached.observed.committedAncestry.ahead, 1);
    assert.equal(
      detached.blockerCodes.includes(
        "worktree-committed-proof-incomplete",
      ),
      false,
    );
    assert.ok(detached.changeUnitIds.length > 0);
    const detachedUnits = result.workItems.flatMap(
      ({ changeUnits }) => changeUnits,
    ).filter(({ id }) => detached.changeUnitIds.includes(id));
    assert.ok(detachedUnits.some(({ path: unitPath }) =>
      Buffer.from(unitPath.rawBase64, "base64").toString("utf8") ===
        "detached-only.txt"));
    assert.equal(detached.eligible, false);
  } finally {
    await fixture.cleanup();
  }
});

test("untracked worktree limits share one collection budget", async (t) => {
  const fixture = await committedFixture("triage-shared-untracked-budget");
  try {
    fixture.git(["branch", "budget-linked"]);
    const linkedPath = path.join(
      path.dirname(fixture.root),
      "triage-shared-untracked-budget-linked",
    );
    fixture.git([
      "worktree",
      "add",
      "--quiet",
      linkedPath,
      "budget-linked",
    ]);
    await fixture.write("main-budget.txt", "one\n");
    await writeFile(path.join(linkedPath, "linked-budget.txt"), "two\n");
    await Promise.all([
      readFile(path.join(fixture.root, "main-budget.txt")),
      readFile(path.join(linkedPath, "linked-budget.txt")),
    ]);

    await t.test("file count", async () => {
      const result = await collectEvidence(fixture.root, {
        scope: "worktrees",
        depth: "proof",
        limits: { maxUntrackedFiles: 1 },
      });
      assert.equal(
        result.changeUnits.filter(
          ({ sourceComponent }) => sourceComponent === "untracked",
        ).length,
        1,
      );
      assert.ok(
        result.coverage.limitsReached.includes("maxUntrackedFiles"),
      );
    });

    await t.test("total bytes", async () => {
      const result = await collectEvidence(fixture.root, {
        scope: "worktrees",
        depth: "proof",
        limits: {
          maxUntrackedFiles: 10,
          maxUntrackedBytesPerFile: 100,
          maxUntrackedBytesTotal: 6,
        },
      });
      assert.equal(
        result.changeUnits.filter(
          ({ sourceComponent }) => sourceComponent === "untracked",
        ).length,
        1,
      );
      assert.ok(
        result.coverage.limitsReached.includes(
          "maxUntrackedBytesTotal",
        ),
      );
    });
  } finally {
    await fixture.cleanup();
  }
});

test("origin HEAD selects and protects a trunk default proof base", async () => {
  const fixture = await committedFixture("triage-default-trunk");
  try {
    fixture.git(["switch", "-c", "trunk"]);
    await fixture.write("tracked.txt", "trunk\n");
    fixture.commit("trunk default");
    fixture.git(["branch", "topic"]);
    fixture.git([
      "update-ref",
      "refs/remotes/origin/trunk",
      fixture.oid(),
    ]);
    fixture.git([
      "symbolic-ref",
      "refs/remotes/origin/HEAD",
      "refs/remotes/origin/trunk",
    ]);

    const result = await analyzeRepository(fixture.root, {
      scope: "branches",
      depth: "proof",
    });
    const trunk = findCarrier(
      result,
      "local-branch",
      ({ displayName }) => displayName === "refs/heads/trunk",
    );
    const main = findCarrier(
      result,
      "local-branch",
      ({ displayName }) => displayName === "refs/heads/main",
    );
    assert.equal(trunk.protection, "protected");
    assert.equal(trunk.protectionEvidence, "complete");
    assert.equal(trunk.action, "keep");
    assert.equal(trunk.eligible, false);
    assert.deepEqual(trunk.changeUnitIds, []);
    assert.deepEqual(main.changeUnitIds, []);
    assert.equal(main.observed.ancestry.state, "behind");
    assert.equal(main.observed.ancestry.mergedIntoDefault, true);
    assert.equal(
      result.coverage.gaps.some(
        ({ code }) => code === "default-branch-identity",
      ),
      false,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("branch proof uses merge-base unique work and ancestry counts", async (t) => {
  await t.test("behind merged branch excludes later default work", async () => {
    const fixture = await committedFixture("triage-branch-behind");
    try {
      fixture.git(["branch", "behind"]);
      await fixture.write("default-only.txt", "later default\n");
      fixture.commit("advance default");
      fixture.git([
        "update-ref",
        "refs/remotes/origin/main",
        fixture.oid(),
      ]);

      const result = await analyzeRepository(fixture.root, {
        scope: "branches",
        depth: "proof",
      });
      const branch = findCarrier(
        result,
        "local-branch",
        ({ displayName }) => displayName === "refs/heads/behind",
      );
      assert.deepEqual(branch.changeUnitIds, []);
      assert.deepEqual(branch.observed.ancestry, {
        mergeBaseOid: branch.identity.tipOid,
        ahead: 0,
        behind: 1,
        state: "behind",
        mergedIntoDefault: true,
        reachableFromDefault: true,
      });
      assert.ok(branch.observations.some(
        ({ code }) => code === "branch-no-unique-work",
      ));
      assert.ok(branch.observations.some(
        ({ code }) => code === "branch-behind",
      ));
    } finally {
      await fixture.cleanup();
    }
  });

  await t.test("ahead branch diffs its merge base to its tip", async () => {
    const fixture = await committedFixture("triage-branch-ahead");
    try {
      fixture.git(["switch", "-c", "ahead"]);
      await fixture.write("ahead-only.txt", "unique\n");
      fixture.commit("advance branch");
      fixture.git(["switch", "main"]);

      const result = await analyzeRepository(fixture.root, {
        scope: "branches",
        depth: "proof",
      });
      const branch = findCarrier(
        result,
        "local-branch",
        ({ displayName }) => displayName === "refs/heads/ahead",
      );
      assert.ok(branch.changeUnitIds.length > 0);
      assert.equal(branch.observed.ancestry.state, "ahead");
      assert.equal(branch.observed.ancestry.ahead, 1);
      assert.equal(branch.observed.ancestry.behind, 0);
      assert.equal(branch.observed.ancestry.mergedIntoDefault, false);
      assert.ok(branch.observations.some(
        ({ code }) => code === "branch-ahead",
      ));
    } finally {
      await fixture.cleanup();
    }
  });

  await t.test("diverged branch retains only branch-side work", async () => {
    const fixture = await committedFixture("triage-branch-diverged");
    try {
      fixture.git(["switch", "-c", "diverged"]);
      await fixture.write("branch-only.txt", "branch\n");
      fixture.commit("advance branch");
      fixture.git(["switch", "main"]);
      await fixture.write("default-only.txt", "default\n");
      fixture.commit("advance default");
      fixture.git([
        "update-ref",
        "refs/remotes/origin/main",
        fixture.oid(),
      ]);

      const result = await analyzeRepository(fixture.root, {
        scope: "branches",
        depth: "proof",
      });
      const branch = findCarrier(
        result,
        "local-branch",
        ({ displayName }) => displayName === "refs/heads/diverged",
      );
      assert.equal(branch.observed.ancestry.state, "diverged");
      assert.equal(branch.observed.ancestry.ahead, 1);
      assert.equal(branch.observed.ancestry.behind, 1);
      assert.equal(branch.changeUnitIds.length, 1);
      assert.ok(branch.observations.some(
        ({ code }) => code === "branch-diverged",
      ));
    } finally {
      await fixture.cleanup();
    }
  });

  await t.test("unrelated history fails closed with an explicit gap", async () => {
    const fixture = await committedFixture("triage-branch-unrelated");
    try {
      fixture.git(["switch", "--orphan", "unrelated"]);
      await fixture.write("tracked.txt", "unrelated root\n");
      fixture.commit("unrelated root");
      fixture.git(["switch", "main"]);

      const result = await analyzeRepository(fixture.root, {
        scope: "branches",
        depth: "proof",
      });
      const branch = findCarrier(
        result,
        "local-branch",
        ({ displayName }) => displayName === "refs/heads/unrelated",
      );
      assert.equal(branch.changeUnitsComplete, false);
      assert.equal(branch.observed.ancestry, null);
      assert.equal(branch.eligible, false);
      assert.ok(branch.blockerCodes.includes("branch-proof-incomplete"));
      assert.ok(result.coverage.gaps.some(
        ({ code, affectedIds }) =>
          code === "branch-merge-base-unavailable" &&
          affectedIds.includes(branch.id),
      ));
    } finally {
      await fixture.cleanup();
    }
  });
});

test("missing origin HEAD blocks branch destructive eligibility", async () => {
  const fixture = await committedFixture("triage-default-missing");
  try {
    fixture.git(["branch", "topic"]);
    fixture.git([
      "symbolic-ref",
      "--delete",
      "refs/remotes/origin/HEAD",
    ]);
    const result = await analyzeRepository(fixture.root, {
      scope: "branches",
      depth: "proof",
    });
    const localBranches = carriers(result).filter(
      ({ type }) => type === "local-branch",
    );
    assert.ok(result.coverage.gaps.some(
      ({ code }) => code === "default-branch-identity",
    ));
    for (const branch of localBranches) {
      assert.equal(branch.protection, "unknown");
      assert.equal(branch.protectionEvidence, "partial");
      assert.ok(
        branch.blockerCodes.includes(
          "default-branch-identity-unknown",
        ),
      );
      assert.equal(branch.eligible, false);
    }
  } finally {
    await fixture.cleanup();
  }
});

test("dangling origin HEAD target becomes an explicit identity gap", async () => {
  const fixture = await committedFixture("triage-default-dangling");
  try {
    fixture.git([
      "update-ref",
      "-d",
      "refs/remotes/origin/main",
    ]);
    const result = await analyzeRepository(fixture.root, {
      scope: "branches",
      depth: "proof",
    });
    assert.ok(result.coverage.gaps.some(
      ({ code }) => code === "default-branch-identity",
    ));
    assert.equal(
      carriers(result)
        .filter(({ type }) => type === "local-branch")
        .some(({ eligible }) => eligible),
      false,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("GitHub PR evidence joins only immutable repository ID and exact OID", async () => {
  const fixture = await committedFixture("triage-github-join");
  try {
    const tip = fixture.oid();
    fixture.git([
      "remote",
      "add",
      "origin",
      "https://github.com/owner/repo.git",
    ]);
    fixture.git([
      "remote",
      "add",
      "upstream",
      "git@github.com:owner/repo.git",
    ]);
    fixture.git([
      "remote",
      "add",
      "fork",
      "https://github.com/other/repo.git",
    ]);
    fixture.git(["update-ref", "refs/remotes/upstream/topic", tip]);
    fixture.git(["update-ref", "refs/remotes/fork/topic", tip]);
    const githubReader = async (args) => {
      const value = args[0] === "repo"
        ? {
          id: "R_repo",
          nameWithOwner: "owner/repo",
          url: "https://github.com/owner/repo",
        }
        : args[0] === "api"
          ? [[liveBranch("topic", tip)]]
          : [
            livePullRequest(1, tip),
            livePullRequest(2, tip, {
              headRepository: {
                id: "R_fork",
                name: "repo",
                nameWithOwner: "fork/repo",
              },
            }),
          ];
      return {
        exitCode: 0,
        stdout: Buffer.from(JSON.stringify(value)),
        stderr: Buffer.alloc(0),
      };
    };
    const result = await analyzeRepository(fixture.root, {
      scope: "remote", depth: "proof", githubReader,
    });
    const remote = findCarrier(
      result,
      "remote-branch",
      ({ displayName }) => displayName === "refs/remotes/upstream/topic",
    );
    const unrelated = findCarrier(
      result,
      "remote-branch",
      ({ displayName }) => displayName === "refs/remotes/fork/topic",
    );
    assert.deepEqual(remote.observed.pullRequests.map(({ number }) => number), [1]);
    assert.equal(remote.observed.pullRequests[0].exactHeadMatch, true);
    assert.deepEqual(remote.observed.githubBranch, {
      repositoryId: "R_repo",
      refName: "topic",
      tipOid: tip,
      protected: false,
    });
    assert.equal(remote.protection, "unprotected");
    assert.equal(remote.protectionEvidence, "complete");
    assert.equal(
      remote.blockerCodes.includes("remote-protection-unknown"),
      false,
    );
    assert.equal(result.coverage.observedCounts.pullRequests, 2);
    assert.equal(result.repository.remotes[0].repositoryId, "R_repo");
    assert.ok(remote.observations.some(
      ({ source }) => source === "github",
    ));
    assert.ok(remote.blockerCodes.includes("pr-open"));
    assert.equal(unrelated.observed.repositoryId, undefined);
    assert.equal(unrelated.observed.pullRequests, undefined);
    const identityGap = result.coverage.gaps.find(
      ({ code }) => code === "remote-identity-unavailable",
    );
    assert.deepEqual(identityGap.affectedIds, [unrelated.id]);
    const stateGap = result.coverage.gaps.find(
      ({ code }) => code === "remote-state-not-refreshed",
    );
    assert.equal(stateGap.affectedIds.includes(remote.id), false);
  } finally {
    await fixture.cleanup();
  }
});

test("GitHub remote-only branches remain visible and require acquisition", async () => {
  const fixture = await committedFixture("triage-github-remote-only");
  try {
    const openOid = oid("a");
    const noPrOid = oid("b");
    const protectedOid = oid("c");
    const githubReader = async (args) => {
      let value;
      if (args[0] === "repo") {
        value = {
          id: "R_repo",
          nameWithOwner: "owner/repo",
          url: "https://github.com/owner/repo",
        };
      } else if (args[0] === "api") {
        value = [[
          liveBranch("remote-open", openOid),
          liveBranch("remote-no-pr", noPrOid),
          liveBranch("remote-protected", protectedOid, true),
        ]];
      } else {
        value = [
          livePullRequest(10, openOid, {
            headRefName: "remote-open",
          }),
          livePullRequest(11, noPrOid, {
            headRefName: "remote-no-pr",
            headRepository: {
              id: "R_fork",
              name: "repo",
              nameWithOwner: "fork/repo",
            },
          }),
          livePullRequest(12, noPrOid, {
            headRefName: "same-oid-wrong-name",
          }),
        ];
      }
      return {
        exitCode: 0,
        stdout: Buffer.from(JSON.stringify(value)),
        stderr: Buffer.alloc(0),
      };
    };

    const result = await analyzeRepository(fixture.root, {
      scope: "remote",
      depth: "proof",
      githubReader,
    });
    assert.deepEqual(validateMechanicalResult(result), {
      valid: true,
      diagnostics: [],
    });
    const byName = new Map(
      carriers(result)
        .filter(({ type, observed }) =>
          type === "remote-branch" && observed.githubBranch)
        .map((carrier) => [carrier.observed.githubBranch.refName, carrier]),
    );
    assert.equal(byName.size, 3);
    const open = byName.get("remote-open");
    const withoutPr = byName.get("remote-no-pr");
    const protectedBranch = byName.get("remote-protected");
    assert.deepEqual(
      open.observed.pullRequests.map(({ number }) => number),
      [10],
    );
    assert.ok(open.blockerCodes.includes("pr-open"));
    assert.deepEqual(withoutPr.observed.pullRequests, []);
    assert.equal(protectedBranch.protection, "protected");
    assert.ok(
      protectedBranch.blockerCodes.includes("remote-branch-protected"),
    );

    for (const branch of [open, withoutPr, protectedBranch]) {
      assert.equal(branch.changeUnitsComplete, false);
      assert.equal(branch.evidence, "partial");
      assert.equal(branch.action, "keep");
      assert.equal(branch.eligible, false);
      assert.ok(
        branch.blockerCodes.includes("remote-content-unavailable"),
      );
      assert.ok(
        branch.blockerCodes.includes("isolated-acquisition-required"),
      );
      assert.equal(branch.prerequisiteIds.length, 1);
      const item = result.workItems.find(({ carriers: members }) =>
        members.some(({ id }) => id === branch.id));
      assert.equal(item.recommendation, "defer");
    }
    assert.ok(result.coverage.gaps.some(
      ({ code }) => code === "remote-content-unavailable",
    ));
    assert.equal(
      fixture.git([
        "show-ref",
        "--verify",
        "--quiet",
        "refs/remotes/origin/remote-open",
      ], { allowFailure: true }).status,
      1,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("GitHub branch network failure remains an explicit unknown", async () => {
  const fixture = await committedFixture("triage-github-branch-offline");
  try {
    const result = await analyzeRepository(fixture.root, {
      scope: "remote",
      depth: "proof",
      githubReader: async (args) => {
        if (args[0] === "api") {
          const error = new Error("offline details");
          error.code = "OFFLINE";
          throw error;
        }
        return {
          exitCode: 0,
          stdout: Buffer.from(JSON.stringify(
            args[0] === "repo"
              ? {
                id: "R_repo",
                nameWithOwner: "owner/repo",
                url: "https://github.com/owner/repo",
              }
              : [],
          )),
          stderr: Buffer.alloc(0),
        };
      },
    });
    assert.equal(result.repository.remotes[0].repositoryId, "R_repo");
    assert.ok(result.coverage.gaps.some(
      ({ code }) => code === "github-branches-unavailable",
    ));
    assert.equal(
      carriers(result).some(({ observed }) => observed.githubBranch),
      false,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("work-bearing local scope records live PR states and check protection", async () => {
  const fixture = await committedFixture("triage-github-states");
  try {
    fixture.git(["branch", "topic"]);
    const tip = fixture.oid();
    let calls = 0;
    const githubReader = async (args) => {
      calls += 1;
      const value = args[0] === "repo"
        ? {
          id: "R_repo",
          nameWithOwner: "owner/repo",
          url: "https://github.com/owner/repo",
        }
        : args[0] === "api"
          ? [[liveBranch("topic", tip)]]
          : [
          livePullRequest(1, tip, {
            isDraft: true,
            mergeStateStatus: "DRAFT",
            reviewDecision: "CHANGES_REQUESTED",
            statusCheckRollup: [{
              __typename: "CheckRun",
              completedAt: "2026-08-28T01:00:00Z",
              conclusion: "FAILURE",
              detailsUrl: "https://github.com/owner/repo/actions/runs/1",
              name: "failed",
              startedAt: "2026-08-28T00:00:00Z",
              status: "COMPLETED",
              workflowName: "CI",
            }, {
              __typename: "CheckRun",
              completedAt: null,
              conclusion: null,
              detailsUrl: null,
              name: "pending",
              startedAt: "2026-08-28T00:00:00Z",
              status: "IN_PROGRESS",
              workflowName: "CI",
            }],
          }),
          livePullRequest(2, tip, {
            state: "CLOSED",
            mergeStateStatus: "DIRTY",
          }),
          livePullRequest(3, tip, {
            state: "MERGED",
            mergedAt: "2026-08-28T02:00:00Z",
            mergeStateStatus: "CLEAN",
            reviewDecision: "APPROVED",
          }),
          livePullRequest(4, tip, {
            headRepository: {
              id: "R_fork",
              name: "repo",
              nameWithOwner: "fork/repo",
            },
          }),
          ];
      return {
        exitCode: 0,
        stdout: Buffer.from(JSON.stringify(value)),
        stderr: Buffer.alloc(0),
      };
    };
    const result = await analyzeRepository(fixture.root, {
      scope: "branches",
      depth: "proof",
      githubReader,
    });
    const topic = findCarrier(
      result,
      "local-branch",
      ({ displayName }) => displayName === "refs/heads/topic",
    );
    assert.equal(calls, 3);
    assert.deepEqual(
      topic.observed.pullRequests.map(({ number }) => number)
        .sort((left, right) => left - right),
      [1, 2, 3],
    );
    assert.ok(topic.blockerCodes.includes("pr-open"));
    assert.ok(topic.blockerCodes.includes("pr-draft"));
    const codes = topic.observations.map(({ code }) => code);
    for (const code of [
      "pr-closed-unmerged",
      "pr-merged-exact-head",
      "pr-check-failure",
      "pr-check-pending",
      "pr-review-approved",
      "pr-review-changes-requested",
      "pr-review-review-required",
      "pr-merge-state-clean",
      "pr-merge-state-dirty",
      "pr-merge-state-draft",
    ]) {
      assert.ok(codes.includes(code), code);
    }
  } finally {
    await fixture.cleanup();
  }
});

test("malformed stash topology remains a partial carrier", async () => {
  const fixture = await committedFixture("triage-malformed-stash");
  try {
    const tree = fixture.git(["write-tree"]).stdout.toString("ascii").trim();
    const malformed = fixture.git(
      ["commit-tree", tree, "-p", fixture.oid()],
      { input: "malformed stash\n" },
    ).stdout.toString("ascii").trim();
    fixture.git([
      "update-ref", "--create-reflog", "-m", "malformed",
      "refs/stash", malformed,
    ]);
    const result = await analyzeRepository(fixture.root, {
      scope: "stashes",
      depth: "proof",
    });
    const stash = findCarrier(result, "stash");
    assert.ok(stash);
    assert.equal(stash.changeUnitsComplete, false);
    assert.equal(stash.evidence, "partial");
    assert.equal(stash.action, "keep");
    assert.ok(result.coverage.gaps.some(({ code, affectedIds }) =>
      code === "stash-topology-incomplete" && affectedIds.includes(stash.id)));
    assert.equal(stash.identity.treeOid, null);
    assert.deepEqual(stash.observed.componentChangeUnitIds, {
      staged: [],
      unstaged: [],
      trackedFinal: [],
      untracked: [],
    });

    const missingTree = oid("f");
    const parent = fixture.oid();
    const missingTreeCommit = fixture.git(
      ["hash-object", "-t", "commit", "-w", "--stdin"],
      {
        input: [
          `tree ${missingTree}`,
          `parent ${parent}`,
          `parent ${parent}`,
          "author Fixture <fixture@example.invalid> 1000000000 +0000",
          "committer Fixture <fixture@example.invalid> 1000000000 +0000",
          "",
          "missing tree",
          "",
        ].join("\n"),
      },
    ).stdout.toString("ascii").trim();
    fixture.git([
      "update-ref",
      "-m",
      "missing tree",
      "refs/stash",
      missingTreeCommit,
    ]);
    const missing = await analyzeRepository(fixture.root, {
      scope: "stashes",
      depth: "proof",
    });
    const missingCarrier = findCarrier(
      missing,
      "stash",
      ({ identity }) => identity.stashOid === missingTreeCommit,
    );
    assert.equal(missingCarrier.identity.treeOid, null);
    assert.equal(missingCarrier.changeUnitsComplete, false);
  } finally {
    await fixture.cleanup();
  }
});

test("comparison and collection budgets are behaviorally enforced", async () => {
  const fixture = await committedFixture("triage-runtime-limits");
  try {
    fixture.git(["branch", "topic"]);
    const limited = await collectEvidence(fixture.root, {
      scope: "branches",
      limits: { maxComparisons: 0 },
    });
    assert.ok(limited.coverage.limitsReached.includes("maxComparisons"));
    assert.ok(limited.coverage.gaps.some(({ code }) => code === "maxComparisons-limit"));

    fixture.git(["update-ref", "refs/remotes/origin/topic", fixture.oid()]);
    const hangingReader = async (args, { signal }) =>
      new Promise((resolve, reject) => {
        const cancel = () => {
          const error = new Error("cancelled");
          error.code = "CANCELLED";
          reject(error);
        };
        if (signal.aborted) cancel();
        else signal.addEventListener("abort", cancel, { once: true });
      });
    await assert.rejects(
      collectEvidence(fixture.root, {
        scope: "remote",
        githubReader: hangingReader,
        limits: { collectionTimeoutMs: 0 },
      }),
      (error) => error.code === "COLLECTION_TIMEOUT",
    );
  } finally {
    await fixture.cleanup();
  }
});

test("porcelain rename records make worktree evidence incomplete", async () => {
  const fixture = await committedFixture("triage-rename-status");
  try {
    fixture.git(["mv", "tracked.txt", "renamed.txt"]);
    const evidence = await collectEvidence(fixture.root, {
      scope: "worktrees",
      depth: "proof",
    });
    const tree = evidence.carriers.find(({ type }) => type === "worktree");
    assert.equal(tree.changeUnitsComplete, false);
    assert.ok(evidence.coverage.gaps.some(
      ({ code }) => code === "worktree-rename-incomplete",
    ));
  } finally {
    await fixture.cleanup();
  }
});

test("failed untracked hashes consume the file attempt budget", async () => {
  const fixture = await committedFixture("triage-untracked-budget");
  try {
    await fixture.write("first.txt", "first\n");
    await fixture.write("second.txt", "second\n");
    const result = await collectEvidence(fixture.root, {
      scope: "worktrees",
      depth: "proof",
      limits: {
        maxUntrackedFiles: 1,
        maxUntrackedBytesPerFile: 0,
      },
    });
    const codes = result.coverage.gaps.map(({ code }) => code);
    assert.ok(codes.includes("untracked-hash-unavailable"));
    assert.ok(codes.includes("maxUntrackedFiles-limit"));
    assert.ok(
      result.coverage.limitsReached.includes("maxUntrackedFiles"),
    );
  } finally {
    await fixture.cleanup();
  }
});

test("stash third-parent and change-unit limits are explicit gaps", async () => {
  const fixture = await committedFixture("triage-more-limits");
  try {
    await fixture.write("untracked.txt", "stash me\n");
    fixture.git(["stash", "push", "--include-untracked", "-m", "third parent"]);
    const stashEvidence = await collectEvidence(fixture.root, {
      scope: "stashes",
      depth: "proof",
      limits: { maxStashes: 1 },
    });
    const stash = stashEvidence.carriers.find(({ type }) => type === "stash");
    assert.equal(stash.changeUnitsComplete, true);
    assert.equal(stash.evidence, "complete");
    assert.ok(stashEvidence.changeUnits.some(
      ({ sourceComponent }) => sourceComponent === "untracked",
    ));
    const noStashes = await collectEvidence(fixture.root, {
      scope: "stashes",
      depth: "proof",
      limits: { maxStashes: 0 },
    });
    assert.equal(
      noStashes.carriers.some(({ type }) => type === "stash"),
      false,
    );
    assert.ok(
      noStashes.coverage.limitsReached.includes("maxStashes"),
    );

    fixture.git(["switch", "-c", "unique"]);
    await fixture.write("tracked.txt", "different\n");
    fixture.commit("unique");
    fixture.git(["switch", "main"]);
    const limited = await collectEvidence(fixture.root, {
      scope: "branches",
      depth: "proof",
      limits: { maxChangeUnits: 0 },
    });
    assert.ok(limited.coverage.limitsReached.includes("maxChangeUnits"));
    assert.ok(limited.carriers.every(({ evidence }) => evidence === "partial"));
    assert.ok(limited.carriers.every(({ blockerCodes }) =>
      blockerCodes.includes("change-unit-set-incomplete")));
  } finally {
    await fixture.cleanup();
  }
});

test("evidence parsers reject malformed framing and preserve typed records", async () => {
  assert.equal(emptyTreeOid("sha1"), "4b825dc642cb6eb9a060e54bf8d69288fbee4904");
  assert.match(emptyTreeOid("sha256"), /^[0-9a-f]{64}$/u);
  assert.deepEqual(normalizeLimits().maxRefs, DEFAULT_ANALYSIS_LIMITS.maxRefs);
  assert.equal(
    Object.hasOwn(DEFAULT_ANALYSIS_LIMITS, "maxProtectedBases"),
    false,
  );
  assert.equal(
    Object.hasOwn(DEFAULT_ANALYSIS_LIMITS, "maxConcurrentGitProcesses"),
    false,
  );
  assert.throws(
    () => normalizeLimits({ maxProtectedBases: 1 }),
    /unknown limit/u,
  );
  assert.throws(
    () => normalizeLimits({ maxConcurrentGitProcesses: 1 }),
    /unknown limit/u,
  );
  for (const limits of [null, [], { maxRefs: -1 }, { maxRefs: 1.5 }]) {
    assert.throws(() => normalizeLimits(limits));
  }

  const absolute = path.resolve("synthetic-worktree");
  const worktreeBytes = Buffer.from(
    `worktree ${absolute}\0HEAD ${"a".repeat(40)}\0detached\0locked reason\0prunable reason\0`,
  );
  assert.deepEqual(parseWorktrees(worktreeBytes, "sha1"), [{
    path: absolute,
    pathRaw: Buffer.from(absolute),
    pathRepresentable: true,
    headOid: "a".repeat(40),
    detached: true,
    locked: true,
    prunable: true,
  }]);
  const invalidPath = Buffer.concat([
    Buffer.from("worktree C:\\invalid-"),
    Buffer.from([0xff, 0]),
  ]);
  const [unrepresentable] = parseWorktrees(invalidPath, "sha1");
  assert.equal(unrepresentable.path, null);
  assert.equal(unrepresentable.pathRepresentable, false);
  assert.deepEqual(unrepresentable.pathRaw, invalidPath.subarray(9, -1));
  for (const malformed of [
    Buffer.from("not-terminated"),
    Buffer.from("worktree relative\0"),
  ]) {
    assert.throws(() => parseWorktrees(malformed, "sha1"));
  }

  assert.deepEqual(parseStashList(Buffer.alloc(0), "sha1"), []);
  assert.deepEqual(
    parseStashList(
      Buffer.from(`refs/stash@{0}\0${"b".repeat(40)}\0\0`),
      "sha1",
    ),
    [{ selector: "stash@{0}", oid: "b".repeat(40) }],
  );
  for (const malformed of [
    Buffer.from("bad"),
    Buffer.from(`stash@{0}\0${"b".repeat(40)}\0extra\0`),
    Buffer.from(`stash@{x}\0${"b".repeat(40)}\0`),
  ]) {
    assert.throws(() => parseStashList(malformed, "sha1"));
  }
  assert.deepEqual(
    parseStashParents(Buffer.from(
      `tree ${oid("1")}\nparent ${oid("2")}\nparent ${oid("3")}\n\nmessage\n`,
    ), "sha1"),
    [oid("2"), oid("3")],
  );
  assert.throws(() => parseStashParents(Buffer.from(
    `tree ${oid("1")}\nparent ${oid("2")}\n\nmessage\n`,
  ), "sha1"));

  const zero = "0".repeat(40);
  const raw = Buffer.from(
    `:000000 100644 ${zero} ${"c".repeat(40)} A\0z.txt\0` +
    `:100644 000000 ${"d".repeat(40)} ${zero} D\0a.txt\0`,
  );
  const units = parseRawDiff(raw, "sha1", "tracked");
  assert.deepEqual(units.map(({ kind, path: unitPath }) => [
    kind,
    Buffer.from(unitPath.rawBase64, "base64").toString("utf8"),
  ]), [["delete", "a.txt"], ["add", "z.txt"]]);
  assert.equal(units[0].newOid, null);
  assert.equal(units[1].oldOid, null);
  for (const malformed of [
    Buffer.from("missing-nul"),
    Buffer.from("invalid\0path\0"),
    Buffer.from(`:000000 100644 ${zero} ${"c".repeat(40)} A\0`),
  ]) {
    assert.throws(() => parseRawDiff(malformed, "sha1", "tracked"));
  }
  assert.throws(() => parseFixedNulRecords(Buffer.alloc(0), 0));
  assert.throws(() => parseReplacementRefs(
    Buffer.from(`\0${oid("a")}\0commit\0\n`), "sha1",
  ));
  assert.throws(() => parseReplacementRefs(
    Buffer.from(`refs/x\0${oid("a")}\0nope\0\n`), "sha1",
  ));
  assert.throws(() => parseBranchRefs(
    Buffer.from(`refs/heads/x\0${oid("a")}\0nope\0\0\n`), "sha1",
  ));
  await assert.rejects(
    hashFilesystemEntry("not-read", { maxBytes: -1 }),
    /non-negative/u,
  );
});
