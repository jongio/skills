import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  collectGitHubEvidence,
  createGitHubEnvironment,
  PR_FIELDS,
} from "../scripts/lib/github.mjs";
import {
  branchApiArgs,
  validateNameWithOwner,
} from "../scripts/lib/github-branches.mjs";
import {
  carrierHeadName,
  integrateGitHubBranches,
  matchingPullRequests,
} from "../scripts/lib/github-carriers.mjs";
import { assertReadOnlyGitArgs } from "../scripts/lib/git-boundary.mjs";
import {
  createCollectionContext,
  normalizeLimits,
} from "../scripts/lib/evidence-shared.mjs";

const oid = (character) => character.repeat(40);
const repository = {
  id: "R_repo",
  nameWithOwner: "owner/repo",
  url: "https://github.com/owner/repo",
};
const processResult = (value) => ({
  exitCode: 0,
  stdout: Buffer.from(JSON.stringify(value)),
  stderr: Buffer.alloc(0),
});

test("GitHub environment limits child executable search to trusted tools", () => {
  const root = path.parse(process.cwd()).root;
  const ghPath = path.join(root, "trusted-gh", "gh.exe");
  const gitPath = path.join(root, "trusted-git", "git.exe");
  const env = createGitHubEnvironment(ghPath, gitPath, {
    Path: path.join(root, "untrusted"),
    GH_TOKEN: "REDACTED",
    HOME: path.join(root, "home"),
    HTTPS_PROXY: "https://proxy.example",
    GIT_EXEC_PATH: path.join(root, "untrusted-git"),
    UNRELATED_SECRET: "secret",
  });

  assert.equal(
    env.PATH,
    [path.dirname(ghPath), path.dirname(gitPath)].join(path.delimiter),
  );
  assert.equal(env.GH_TOKEN, "REDACTED");
  assert.equal(env.HOME, path.join(root, "home"));
  assert.equal(env.HTTPS_PROXY, "https://proxy.example");
  assert.equal(env.GH_PROMPT_DISABLED, "1");
  assert.equal(env.GIT_TERMINAL_PROMPT, "0");
  assert.equal("Path" in env, false);
  assert.equal("GIT_EXEC_PATH" in env, false);
  assert.equal("UNRELATED_SECRET" in env, false);
  assert.equal(Object.isFrozen(env), true);

  assert.throws(
    () => createGitHubEnvironment("gh", gitPath),
    /trusted gh and git paths/u,
  );
});

test("GitHub branch integration fails closed on malformed local evidence", async () => {
  for (const stdout of [
    Buffer.from("not-nul"),
    Buffer.from("bad\0"),
  ]) {
    const carriers = [];
    const context = createCollectionContext(normalizeLimits({}), undefined);
    await integrateGitHubBranches({
      github: { branches: [{
        id: "remote", repositoryId: repository.id, refName: "topic",
        tipOid: oid("a"), protected: false,
      }] },
      repository,
      boundary: {
        objectFormat: "sha1",
        run: async (args, options) => args[0] === "config"
          ? { exitCode: 0, stdout, stderr: Buffer.alloc(0) }
          : { exitCode: 0, stdout: Buffer.from("bad\n"), stderr: Buffer.alloc(0) },
      },
      primary: { oid: oid("f") },
      branchCarriers: carriers,
      context,
    });
    assert.equal(carriers.length, 1);
    assert.ok(carriers[0].blockerCodes.includes("remote-content-unavailable"));
    assert.ok(context.gaps.some(
      ({ code }) => code === "remote-content-availability-unavailable",
    ));
  }

  for (const objectOutput of [
    Buffer.from(""),
    Buffer.from(`${oid("a")} commit 1`),
    Buffer.from(`${oid("a")} commit 1\r\n`),
    Buffer.from(`${oid("a")} commit 9007199254740992\n`),
    Buffer.from(`${oid("b")} commit 1\n`),
  ]) {
    const carriers = [];
    const context = createCollectionContext(normalizeLimits({}), undefined);
    await integrateGitHubBranches({
      github: { branches: [{
        id: "remote", repositoryId: repository.id, refName: "topic",
        tipOid: oid("a"), protected: false,
      }] },
      repository,
      boundary: {
        objectFormat: "sha1",
        run: async (args) => args[0] === "config"
          ? { exitCode: 1, stdout: Buffer.alloc(0) }
          : { exitCode: 0, stdout: objectOutput },
      },
      primary: { oid: oid("f") },
      branchCarriers: carriers,
      context,
    });
    assert.equal(carriers.length, 1);
    assert.ok(context.gaps.some(
      ({ code }) => code === "remote-content-availability-unavailable",
    ));
  }

  const context = createCollectionContext(normalizeLimits({}), undefined);
  const carriers = [];
  const observed = await integrateGitHubBranches({
    github: { branches: [
      { id: "wrong", repositoryId: "other", refName: "x", tipOid: oid("a"), protected: false },
      { id: "bad-oid", repositoryId: repository.id, refName: "x", tipOid: "bad", protected: false },
    ] },
    repository,
    boundary: { objectFormat: "sha1", run: async () => ({ exitCode: 1, stdout: Buffer.alloc(0) }) },
    primary: { oid: oid("f") },
    branchCarriers: carriers,
    context,
  });
  assert.equal(observed, 0);
  assert.equal(context.skipped.remoteBranches, 2);
  assert.deepEqual(carriers, []);
});
const checkRun = (overrides = {}) => ({
  __typename: "CheckRun",
  completedAt: "2026-08-28T01:00:00Z",
  conclusion: "SUCCESS",
  detailsUrl: "https://github.com/owner/repo/actions/runs/1?check=1",
  name: "test",
  startedAt: "2026-08-28T00:00:00Z",
  status: "COMPLETED",
  workflowName: "CI",
  ...overrides,
});
const pullRequest = (overrides = {}) => ({
  number: 7,
  state: "MERGED",
  isDraft: false,
  mergedAt: "2026-08-28T02:00:00Z",
  headRefOid: oid("a"),
  headRefName: "feature/topic",
  headRepository: {
    id: "R_repo",
    name: "repo",
    nameWithOwner: "owner/repo",
  },
  baseRefOid: oid("b"),
  baseRefName: "main",
  url: "https://github.com/owner/repo/pull/7",
  mergeStateStatus: "CLEAN",
  reviewDecision: "APPROVED",
  statusCheckRollup: [checkRun()],
  ...overrides,
});
const githubBranch = (overrides = {}) => ({
  name: "feature/topic",
  commit: {
    sha: oid("a"),
    url: "https://api.github.com/repos/owner/repo/commits/a",
  },
  protected: false,
  protection: {},
  protection_url:
    "https://api.github.com/repos/owner/repo/branches/feature/topic/protection",
  ...overrides,
});
const responseFor = (args, pullRequests, branchPages = [[]]) => {
  if (args[0] === "repo") {
    return repository;
  }
  if (args[0] === "api") {
    return branchPages;
  }
  return pullRequests;
};
const repositoryEvidence = {
  ...repository,
  host: "github.com",
  displayUrl: repository.url,
};
const remoteConfigResult = (entries) => ({
  exitCode: entries.length === 0 ? 1 : 0,
  stdout: Buffer.from(
    entries
      .map(({ name, url }) => `remote.${name}.url\n${url}\0`)
      .join(""),
  ),
  stderr: Buffer.alloc(0),
});
const remoteCarrier = (remoteName, refName, tipOid) => ({
  id: `remote-${remoteName}-${refName}`,
  type: "remote-branch",
  identity: {
    refRawBase64: Buffer.from(
      `refs/remotes/${remoteName}/${refName}`,
    ).toString("base64"),
    tipOid,
  },
  observed: {},
  changeUnitIds: ["unit-a"],
  changeUnitsComplete: false,
  evidence: "partial",
  durability: "unknown",
  protection: "unknown",
  protectionEvidence: "partial",
  blockerCodes: [
    "remote-protection-unknown",
    "remote-state-not-refreshed",
  ],
  observations: [],
});
const githubBranchRecord = (refName, tipOid, protectedBranch = false) => ({
  id: `github-${refName}`,
  repositoryId: repository.id,
  refName,
  tipOid,
  protected: protectedBranch,
});
const missingObjectsResult = (input) => ({
  exitCode: 0,
  stdout: Buffer.from(
    input.trimEnd().split("\n")
      .map((tipOid) => `${tipOid} missing\n`)
      .join(""),
  ),
  stderr: Buffer.alloc(0),
});

test("carrier head names use only recognized exact ref namespaces", () => {
  assert.equal(carrierHeadName({}), null);
  assert.equal(carrierHeadName({
    observed: {
      githubBranch: {
        refName: "github-topic",
      },
    },
  }), "github-topic");
  assert.equal(carrierHeadName({
    identity: {
      refRawBase64: Buffer.from("refs/heads/local-topic").toString("base64"),
    },
    observed: {},
  }), "local-topic");
  assert.equal(carrierHeadName({
    identity: {
      refRawBase64: Buffer.from("refs/remotes/fork/topic").toString("base64"),
    },
    observed: {},
  }), null);
});

test("pull request joins require exact repository, ref name, and OID", () => {
  const carrier = {
    identity: {
      refRawBase64: Buffer.from(
        "refs/remotes/upstream/topic",
      ).toString("base64"),
    },
    observed: {
      repositoryId: repository.id,
      refName: "topic",
      tipOid: oid("a"),
    },
  };
  const records = [
    {
      headRepositoryId: repository.id,
      headRefName: "topic",
      headOid: oid("a"),
    },
    {
      headRepositoryId: "R_other",
      headRefName: "topic",
      headOid: oid("a"),
    },
    {
      headRepositoryId: repository.id,
      headRefName: "other",
      headOid: oid("a"),
    },
    {
      headRepositoryId: repository.id,
      headRefName: "topic",
      headOid: oid("b"),
    },
  ];

  assert.deepEqual(
    matchingPullRequests(records, repository.id, carrier),
    [{ ...records[0], exactHeadMatch: true }],
  );
});

test("GitHub branch joins require the immutable repository ID", async () => {
  const context = createCollectionContext(normalizeLimits({}), undefined);
  const carriers = [];
  await integrateGitHubBranches({
    github: {
      branches: [{
        ...githubBranchRecord("topic", oid("a")),
        repositoryId: "R_other",
      }],
    },
    repository: repositoryEvidence,
    boundary: {
      objectFormat: "sha1",
      run: async () => remoteConfigResult([]),
    },
    primary: { oid: oid("f") },
    branchCarriers: carriers,
    context,
  });

  assert.deepEqual(carriers, []);
  assert.ok(context.gaps.some(
    ({ code }) => code === "github-branch-repository-mismatch",
  ));
});

test("Git boundary permits only the fixed remote URL recipe", () => {
  const recipe = [
    "config",
    "--local",
    "--null",
    "--get-regexp",
    "^remote\\..*\\.url$",
  ];
  assert.deepEqual(assertReadOnlyGitArgs(recipe), recipe);
  assert.throws(
    () => assertReadOnlyGitArgs([...recipe, "remote.origin.url"]),
    (error) => error.code === "FORBIDDEN_COMMAND",
  );
});

test("GitHub evidence accepts live gh shapes and exact bounded argv", async () => {
  const calls = [];
  const result = await collectGitHubEvidence({
    cwd: "repository",
    limit: 2,
    timeoutMs: 50,
    maxStdoutBytes: 1024,
    maxStderrBytes: 128,
    reader: async (args, options) => {
      calls.push({ args, options });
      return processResult(responseFor(
        args,
        [pullRequest()],
        [[githubBranch()]],
      ));
    },
  });

  assert.deepEqual(calls.map(({ args }) => args), [
    ["repo", "view", "--json", "id,nameWithOwner,url"],
    [
      "api",
      "repos/owner/repo/branches?per_page=100",
      "--hostname",
      "github.com",
      "--paginate",
      "--slurp",
    ],
    [
      "pr",
      "list",
      "--state",
      "all",
      "--limit",
      "3",
      "--json",
      PR_FIELDS,
    ],
  ]);
  assert.equal(
    calls.every(({ options }) => options.cwd === "repository"),
    true,
  );
  assert.equal(result.repository.id, "R_repo");
  assert.deepEqual(result.branches[0], {
    id: result.branches[0].id,
    repositoryId: "R_repo",
    refName: "feature/topic",
    tipOid: oid("a"),
    protected: false,
  });
  assert.equal(result.records[0].headRepositoryId, "R_repo");
  assert.equal(result.records[0].exactHeadMatch, false);
  assert.equal(result.records[0].headRepositoryName, "repo");
  assert.equal(result.records[0].headOid, oid("a"));
  assert.equal(result.records[0].headRefName, "feature/topic");
  assert.equal(result.records[0].baseRefName, "main");
  assert.equal(result.records[0].mergeStateStatus, "CLEAN");
  assert.equal(result.records[0].reviewDecision, "APPROVED");
  assert.equal(result.records[0].checks[0].type, "check-run");
  assert.equal(
    result.records[0].checks[0].detailsUrl,
    "https://github.com/owner/repo/actions/runs/1",
  );
  assert.equal(result.records[0].hasFailingChecks, false);
  assert.equal(result.records[0].hasPendingChecks, false);
  assert.deepEqual(result.gaps, []);
});

test("GitHub evidence accepts a nullable check rollup", async () => {
  const result = await collectGitHubEvidence({
    cwd: "repository",
    limit: 1,
    branchLimit: 1,
    timeoutMs: 50,
    maxStdoutBytes: 1024,
    maxStderrBytes: 128,
    reader: async (args) => processResult(responseFor(
      args,
      [pullRequest({ statusCheckRollup: null })],
    )),
  });

  assert.deepEqual(result.records[0].checks, []);
  assert.equal(result.records[0].hasFailingChecks, false);
  assert.equal(result.records[0].hasPendingChecks, false);
  assert.equal(result.repository.id, "R_repo");
});

test("GitHub evidence preserves PR states, checks, reviews, and mergeability", async () => {
  const values = [
    pullRequest({
      number: 1,
      state: "OPEN",
      isDraft: true,
      mergedAt: null,
      mergeStateStatus: "DRAFT",
      reviewDecision: "CHANGES_REQUESTED",
      statusCheckRollup: [
        checkRun({ conclusion: "FAILURE" }),
        checkRun({
          name: "pending",
          status: "IN_PROGRESS",
          conclusion: "",
          completedAt: "",
          detailsUrl: "",
          workflowName: "",
        }),
      ],
    }),
    pullRequest({
      number: 2,
      state: "CLOSED",
      mergedAt: null,
      mergeStateStatus: "DIRTY",
      reviewDecision: "REVIEW_REQUIRED",
      statusCheckRollup: [],
    }),
    pullRequest({
      number: 3,
      state: "MERGED",
      mergeStateStatus: "CLEAN",
      reviewDecision: "APPROVED",
    }),
  ];
  const result = await collectGitHubEvidence({
    limit: 3,
    reader: async (args) =>
      processResult(responseFor(args, values)),
  });
  const byNumber = new Map(
    result.records.map((record) => [record.number, record]),
  );

  assert.equal(byNumber.get(1).state, "OPEN");
  assert.equal(byNumber.get(1).isDraft, true);
  assert.equal(byNumber.get(1).hasFailingChecks, true);
  assert.equal(byNumber.get(1).hasPendingChecks, true);
  assert.equal(byNumber.get(1).checks[1].conclusion, null);
  assert.equal(byNumber.get(1).checks[1].workflowName, null);
  assert.equal(byNumber.get(1).reviewDecision, "CHANGES_REQUESTED");
  assert.equal(byNumber.get(2).state, "CLOSED");
  assert.equal(byNumber.get(2).mergedAt, null);
  assert.equal(byNumber.get(2).mergeStateStatus, "DIRTY");
  assert.equal(byNumber.get(3).state, "MERGED");
  assert.equal(byNumber.get(3).reviewDecision, "APPROVED");
});

test("GitHub evidence fails closed on process and hostile schema", async () => {
  await assert.rejects(
    collectGitHubEvidence({ limit: 10_000 }),
    /limit/u,
  );
  const failed = await collectGitHubEvidence({
    limit: 1,
    reader: async () => {
      const error = new Error("hostile\nmetadata");
      error.code = "AUTH\u0007FAIL";
      throw error;
    },
  });
  assert.equal(failed.repository, null);
  assert.deepEqual(failed.gaps, [{
    code: "github-evidence-unavailable",
    affectedIds: [],
    reason: "AUTH\uFFFDFAIL",
  }]);

  const malformedHead = pullRequest({
    headRepository: {
      id: "R_repo",
      nameWithOwner: "owner/repo",
    },
  });
  const malformedCheck = pullRequest({
    statusCheckRollup: [{
      ...checkRun(),
      unknown: "not trusted",
    }],
  });
  const malformedCheckList = pullRequest({
    statusCheckRollup: {},
  });
  for (const response of [
    { id: "only-id" },
    [malformedHead],
    [malformedCheck],
    [malformedCheckList],
  ]) {
    const result = await collectGitHubEvidence({
      limit: 1,
      reader: async (args) =>
        processResult(responseFor(args, response)),
    });
    assert.equal(
      result.gaps[0].code,
      "github-response-invalid",
    );
    assert.notEqual(result.gaps[0].reason, "TypeError");
  }
});

test("limit plus one detects truncation with a real skipped count", async () => {
  const calls = [];
  const result = await collectGitHubEvidence({
    limit: 1,
    reader: async (args) => {
      calls.push(args);
      return processResult(responseFor(args, [
          pullRequest({ number: 1 }),
          pullRequest({ number: 2 }),
        ]));
    },
  });

  assert.equal(calls[2][5], "2");
  assert.equal(result.records.length, 1);
  assert.equal(result.observed, 1);
  assert.equal(result.skipped, 1);
  assert.ok(result.gaps.some(
    ({ code }) => code === "maxPullRequests-limit",
  ));
});

test("branch inventory validates pagination, canonical names, and limits", async () => {
  assert.deepEqual(branchApiArgs("owner/repo", "github.com"), [
    "api",
    "repos/owner/repo/branches?per_page=100",
    "--hostname",
    "github.com",
    "--paginate",
    "--slurp",
  ]);
  for (const hostile of [
    "owner/repo/extra",
    "../repo",
    "owner/repo?x=1",
    "owner\\repo",
  ]) {
    assert.throws(() => validateNameWithOwner(hostile), /canonical/u);
  }

  const result = await collectGitHubEvidence({
    limit: 1,
    branchLimit: 1,
    reader: async (args) => processResult(responseFor(
      args,
      [],
      [
        [githubBranch()],
        [githubBranch({
          name: "other",
          commit: {
            sha: oid("b"),
            url: "https://api.github.com/commit/b",
          },
        })],
      ],
    )),
  });
  assert.equal(result.branches.length, 1);
  assert.equal(result.branchObserved, 1);
  assert.equal(result.branchSkipped, 1);
  assert.ok(result.gaps.some(({ code }) => code === "maxRefs-limit"));
});

test("branch inventory targets the host parsed from repository URL", async () => {
  const calls = [];
  const result = await collectGitHubEvidence({
    limit: 1,
    reader: async (args) => {
      calls.push(args);
      if (args[0] === "repo") {
        return processResult({
          id: "R_enterprise",
          nameWithOwner: "owner/repo",
          url: "https://git.example.corp/owner/repo",
        });
      }
      return processResult(args[0] === "api" ? [[]] : []);
    },
  });

  assert.equal(result.repository.host, "git.example.corp");
  assert.deepEqual(calls[1], [
    "api",
    "repos/owner/repo/branches?per_page=100",
    "--hostname",
    "git.example.corp",
    "--paginate",
    "--slurp",
  ]);
  assert.throws(
    () => branchApiArgs("owner/repo", "github.com\n--method=DELETE"),
    /host is not canonical/u,
  );
});

test("configured non-origin remote represents an exact GitHub branch", async () => {
  const carrier = remoteCarrier("upstream", "feature/topic", oid("a"));
  const calls = [];
  const signal = new AbortController().signal;
  const context = createCollectionContext(normalizeLimits({}), signal);
  await integrateGitHubBranches({
    github: {
      branches: [githubBranchRecord("feature/topic", oid("a"), true)],
    },
    repository: repositoryEvidence,
    boundary: {
      objectFormat: "sha1",
      run: async (args, options) => {
        calls.push(args);
        assert.equal(options.signal, signal);
        return remoteConfigResult([{
          name: "upstream",
          url: "git@github.com:owner/repo.git",
        }]);
      },
    },
    primary: { oid: oid("f") },
    branchCarriers: [carrier],
    context,
  });

  assert.deepEqual(calls, [[
    "config",
    "--local",
    "--null",
    "--get-regexp",
    "^remote\\..*\\.url$",
  ]]);
  assert.deepEqual(carrier.observed.githubBranch, {
    repositoryId: repository.id,
    refName: "feature/topic",
    tipOid: oid("a"),
    protected: true,
  });
  assert.equal(carrier.observed.repositoryId, repository.id);
  assert.equal(carrier.observed.refName, "feature/topic");
  assert.equal(
    carrier.blockerCodes.includes("remote-state-not-refreshed"),
    false,
  );
  assert.equal(carrier.changeUnitsComplete, true);
  assert.equal(carrier.evidence, "complete");
  assert.equal(carrier.durability, "durable");
});

test("GitHub SSH endpoint alias matches the canonical repository host", async () => {
  const carrier = remoteCarrier("origin", "topic", oid("a"));
  const context = createCollectionContext(normalizeLimits({}), undefined);
  await integrateGitHubBranches({
    github: { branches: [githubBranchRecord("topic", oid("a"))] },
    repository: repositoryEvidence,
    boundary: {
      objectFormat: "sha1",
      run: async () => remoteConfigResult([{
        name: "origin",
        url: "ssh://git@ssh.github.com:443/owner/repo.git",
      }]),
    },
    primary: { oid: oid("f") },
    branchCarriers: [carrier],
    context,
  });

  assert.equal(carrier.observed.repositoryId, repository.id);
  assert.equal(carrier.observed.githubBranch.tipOid, oid("a"));
});

test("same-name branch on an unrelated remote does not represent GitHub", async () => {
  const unrelated = remoteCarrier("fork", "topic", oid("a"));
  const context = createCollectionContext(normalizeLimits({}), undefined);
  const carriers = [unrelated];
  await integrateGitHubBranches({
    github: { branches: [githubBranchRecord("topic", oid("a"))] },
    repository: repositoryEvidence,
    boundary: {
      objectFormat: "sha1",
      run: async (args, options) =>
        args[0] === "config"
          ? remoteConfigResult([{
            name: "fork",
            url: "https://github.com/other/repo.git",
          }])
          : missingObjectsResult(options.input),
    },
    primary: { oid: oid("f") },
    branchCarriers: carriers,
    context,
  });

  assert.equal(unrelated.observed.repositoryId, undefined);
  assert.equal(unrelated.observed.githubBranch, undefined);
  assert.equal(carriers.length, 2);
  const remoteOnly = carriers.find((carrier) => carrier !== unrelated);
  assert.deepEqual(remoteOnly.identity, {
    remoteId: remoteOnly.identity.remoteId,
    refRawBase64: Buffer.from("refs/heads/topic").toString("base64"),
    tipOid: oid("a"),
  });
  assert.equal(Object.hasOwn(remoteOnly, "_refRaw"), false);
});

test("drifted tracking ref and live GitHub tip remain separate carriers", async () => {
  const stale = remoteCarrier("upstream", "topic", oid("b"));
  const context = createCollectionContext(normalizeLimits({}), undefined);
  const carriers = [stale];
  await integrateGitHubBranches({
    github: { branches: [githubBranchRecord("topic", oid("a"), true)] },
    repository: repositoryEvidence,
    boundary: {
      objectFormat: "sha1",
      run: async (args, options) =>
        args[0] === "config"
          ? remoteConfigResult([{
            name: "upstream",
            url: "ssh://git@github.com/owner/repo.git",
          }])
          : missingObjectsResult(options.input),
    },
    primary: { oid: oid("f") },
    branchCarriers: carriers,
    context,
  });

  assert.equal(carriers.length, 2);
  assert.equal(stale.identity.tipOid, oid("b"));
  assert.equal(stale.observed.repositoryId, repository.id);
  assert.equal(stale.observed.githubBranch, undefined);
  assert.ok(stale.blockerCodes.includes("remote-tracking-drift"));
  assert.ok(stale.blockerCodes.includes("remote-state-not-refreshed"));
  const live = carriers.find((carrier) => carrier !== stale);
  assert.equal(
    Buffer.from(live.identity.refRawBase64, "base64").toString("utf8"),
    "refs/heads/topic",
  );
  assert.equal(live.identity.tipOid, oid("a"));
  assert.equal(live.observed.githubBranch.tipOid, oid("a"));
  assert.ok(live.blockerCodes.includes("remote-content-unavailable"));
  assert.ok(context.gaps.some(({ code }) => code === "remote-tracking-drift"));
});

test("remote-only object availability uses one bounded batch read", async () => {
  const branches = Array.from({ length: 50 }, (_, index) => {
    const tipOid = (index + 1).toString(16).padStart(40, "0");
    return {
      id: `github-branch-${index}`,
      repositoryId: repository.id,
      refName: `remote-only-${index}`,
      tipOid,
      protected: false,
    };
  });
  const calls = [];
  const boundary = {
    objectFormat: "sha1",
    run: async (args, options) => {
      calls.push({ args, options });
      return args[0] === "config"
        ? remoteConfigResult([])
        : missingObjectsResult(options.input);
    },
  };
  const context = createCollectionContext(
    normalizeLimits({ maxComparisons: 2 }),
    undefined,
  );
  const carriers = [];

  await integrateGitHubBranches({
    github: { branches },
    repository: repositoryEvidence,
    boundary,
    primary: { oid: oid("f") },
    branchCarriers: carriers,
    context,
  });

  const batchCalls = calls.filter(({ args }) => args[0] === "cat-file");
  assert.equal(batchCalls.length, 1);
  assert.deepEqual(batchCalls[0].args, [
    "cat-file",
    "--batch-check=%(objectname) %(objecttype) %(objectsize)",
  ]);
  assert.equal(
    batchCalls[0].options.input.trimEnd().split("\n").length,
    50,
  );
  assert.equal(context.comparisons, 0);
  assert.equal(carriers.length, 50);
  assert.equal(
    carriers.every((carrier) =>
      carrier.blockerCodes.includes("remote-content-unavailable") &&
      carrier.blockerCodes.includes("isolated-acquisition-required") &&
      carrier.prerequisiteIds.length === 1),
    true,
  );
});

test("branch inventory fails closed without discarding repository identity", async () => {
  for (const branchResponse of [
    [{ not: "nested pages" }],
    [[githubBranch({ unknown: true })]],
    [[githubBranch({ protected: "yes" })]],
    [[{
      ...githubBranch(),
      protection: "not-an-object",
    }]],
    [[{
      name: "missing-record-fields",
      commit: {
        sha: oid("a"),
        url: "https://api.github.com/commit/a",
      },
      protected: false,
    }]],
  ]) {
    const result = await collectGitHubEvidence({
      limit: 1,
      branchLimit: 1,
      reader: async (args) =>
        processResult(responseFor(args, [], branchResponse)),
    });
    assert.equal(result.repository.id, "R_repo");
    assert.deepEqual(result.branches, []);
    assert.ok(result.gaps.some(
      ({ code }) => code === "github-branches-unavailable",
    ));
  }

  const failed = await collectGitHubEvidence({
    limit: 1,
    branchLimit: 1,
    reader: async (args) => {
      if (args[0] === "api") {
        const error = new Error("network details");
        error.code = "OFFLINE";
        throw error;
      }
      return processResult(responseFor(args, []));
    },
  });
  assert.equal(failed.repository.id, "R_repo");
  assert.ok(failed.gaps.some(
    ({ code, reason }) =>
      code === "github-branches-unavailable" && reason === "OFFLINE",
  ));
});

test("zero PR budget reads only repository identity", async () => {
  let calls = 0;
  const result = await collectGitHubEvidence({
    limit: 0,
    reader: async () => {
      calls += 1;
      return processResult({
        ...repository,
        url: `${repository.url}?ignored=true#fragment`,
      });
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.records.length, 0);
  assert.equal(result.repository.displayUrl, repository.url);
  assert.ok(result.gaps.some(
    ({ code }) => code === "maxPullRequests-limit",
  ));
});

test("GitHub cancellation propagates without becoming evidence", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    collectGitHubEvidence({
      limit: 1,
      signal: controller.signal,
      reader: async () => {
        throw new Error("cancelled");
      },
    }),
    /cancelled/u,
  );
});
