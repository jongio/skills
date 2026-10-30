import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fixtureRequest } from "./github-fixtures.mjs";
import {
  defaultPrMaxWaitSec,
  createPrWatchState,
  evaluateMultiPrPollTick as nativeEvaluateMultiPrPollTick,
  evaluatePrPollTick as nativeEvaluatePrPollTick,
  loadPersistedPrSession,
  parsePrWatchArgs,
  runCli as nativeRunPr,
  savePersistedPrSession,
} from "../scripts/pr-watch-daemon.mjs";
import {
  defaultMaxWaitSec,
  evaluateMultiRepoPollTick as nativeEvaluateMultiRepoPollTick,
  evaluatePollTick as nativeEvaluatePollTick,
  loadState,
  parseArgs,
  runCli as nativeRunCi,
  saveState,
  stateFileForRepo,
} from "../../ci-hound/scripts/ci-hound-daemon.mjs";

function authenticatedFixture(execute) {
  const adapter = fixtureRequest(execute);
  const request = async (input, options) => ({ ...await adapter(input, options), cacheScope: "fixture-scope" });
  request.cacheScope = async () => "fixture-scope";
  return request;
}

const evaluateMultiRepoPollTick = (args, config, execute) =>
  nativeEvaluateMultiRepoPollTick(args, config, authenticatedFixture(execute));
const evaluatePollTick = (args, state, execute) =>
  nativeEvaluatePollTick(args, state, authenticatedFixture(execute));
const evaluateMultiPrPollTick = (args, execute, state) =>
  nativeEvaluateMultiPrPollTick(args, authenticatedFixture(execute), state);
const runPr = (argv, services) =>
  nativeRunPr(argv, { ...services, execFn: authenticatedFixture(services.execFn) });
const runCi = (argv, services) =>
  nativeRunCi(argv, { ...services, execFn: authenticatedFixture(services.execFn) });

function fixture(t) {
  const root = path.resolve(".fleet-pr-192-test-fixtures");
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(path.join(root, "chunk-"));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
    if (readdirSync(root).length === 0) rmSync(root, { recursive: true });
  });
  return dir;
}

function clock(t) {
  let now = 1_800_000_000_000;
  t.mock.method(Date, "now", () => now);
  return {
    get now() { return now; },
    advance(ms) { now += ms; },
    async sleep(sec) { now += sec * 1000; },
  };
}

function capture(t) {
  const output = [];
  t.mock.method(console, "log", (body) => output.push(JSON.parse(body)));
  return output;
}

function prNode({ comments = [], reviews = [], checks = "IN_PROGRESS", head = "head" } = {}) {
  return {
    state: "OPEN",
    headRefOid: head,
    headRefName: "feature",
    headRepository: { nameWithOwner: "fixture/repo" },
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    reviewRequests: { nodes: [] },
    reviews: { nodes: reviews },
    reviewThreads: { nodes: [] },
    comments: { nodes: comments },
    commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [{
      __typename: "CheckRun", name: "test", status: checks, conclusion: checks === "COMPLETED" ? "SUCCESS" : null,
    }] } } } }] },
  };
}

const json = (body) => ({ ok: true, stdout: JSON.stringify(body), stderr: "" });
const graph = (pr) => json({ data: { repository: { pullRequest: pr } } });
const throttled = () => ({
  ok: false,
  stdout: "HTTP/2.0 429 Too Many Requests\nRetry-After: 900\n\n{}",
  stderr: "rate limited",
});
const ciExec = (args) => {
  const endpoint = args[2];
  if (endpoint.includes("/commits/")) return json({ sha: "head" });
  if (endpoint.includes("/jobs")) return json({ jobs: [] });
  return json({ workflow_runs: [] });
};

function greenCiExec(args) {
  const endpoint = args[2];
  const repo = endpoint.match(/^repos\/([^/]+\/[^/]+)/)[1];
  const sha = `${repo}-head`;
  if (endpoint.includes("/commits/")) return json({ sha });
  if (endpoint.includes("/jobs")) {
    return json({ total_count: 1, jobs: [{
      id: 10, name: "test", status: "completed", conclusion: "success", steps: [],
    }] });
  }
  return json({ workflow_runs: [{
    id: 1, workflow_id: 1, name: "CI", event: "push", head_branch: "main",
    head_sha: sha, status: "completed", conclusion: "success", updated_at: "2026-10-29T00:00:00Z",
  }] });
}

test("both direct entrypoints derive chunks strictly below even very short host waits", () => {
  for (const host of [1, 2, 4, 10, 30, 60, 61, 600, 900]) {
    const env = { COPILOT_TASK_WAIT_TIMEOUT_SECONDS: String(host) };
    for (const derive of [defaultMaxWaitSec, defaultPrMaxWaitSec]) {
      assert.ok(derive(env) > 0 && derive(env) < host);
    }
  }
  const base = ["watch", "--repo", "fixture/repo", "--pr", "1"];
  for (const value of ["1.5", "1oops", "-1"]) {
    assert.throws(() => parsePrWatchArgs([...base, "--max-wait-sec", value]), /Invalid --max-wait-sec/);
    assert.throws(() => parseArgs(["watch", "--max-wait-sec", value]), /Invalid --max-wait-sec/);
  }
  for (const value of ["1:2:3", "1:2oops", "1:"]) {
    assert.throws(() => parsePrWatchArgs([...base, "--since-comment-id", value]), /Invalid --since-comment-id/);
  }
  assert.equal(parsePrWatchArgs([...base, "--max-wait-sec", "0"]).maxWaitSec, 0);
  assert.equal(parseArgs(["watch", "--max-wait-sec", "0"]).maxWaitSec, 0);
});

test("single-PR chunks wait out their budget and restore phase, cursor, ETags, and exact-head review gates", async (t) => {
  const dir = fixture(t);
  const time = clock(t);
  const output = capture(t);
  const argv = ["watch", "--repo", "fixture/repo", "--pr", "1", "--head", "head", "--max-wait-sec", "1"];
  let calls = 0;
  const oldReview = { databaseId: 7, state: "COMMENTED", submittedAt: "2026-01-01T00:00:00Z",
    author: { login: "copilot" }, commit: { oid: "old-head" }, body: "" };
  const execFn = (args) => {
    calls += 1;
    const result = args[1] === "graphql"
      ? graph(prNode({ checks: "COMPLETED", reviews: [oldReview], comments: [{ databaseId: 10, body: "old" }] }))
      : json({ workflow_runs: [] });
    result.stdout = `HTTP/2.0 200 OK\nETag: "cached"\n\n${result.stdout}`;
    return result;
  };
  await runPr(argv, { execFn, stateDir: dir, sleep: time.sleep });
  assert.equal(calls, 2);
  const timeout = output.at(-1);
  assert.equal(timeout.events[0].type, "WATCH_CHUNK_TIMEOUT");
  assert.equal(timeout.events[0].elapsedSec, 1);
  assert.equal(timeout.events[0].latestCommentId, 10);
  assert.match(timeout.events[0].lastPhase, /copilot-waiting/);
  assert.equal(output.flatMap((x) => x.events).some((x) => x.type === "PR_READY_TO_MERGE"), false);
  let session = loadPersistedPrSession("fixture/repo", dir);
  assert.equal(session.entries[1].sinceCommentId, 10);
  assert.equal(session.entries[1].lastPhase, timeout.events[0].lastPhase);
  assert.ok(Object.keys(session.entries[1].watchState.etags).length > 0);
  assert.equal(session.entries[1].lastStatus.phase, timeout.events[0].lastPhase);
  const newExec = (args) => args[1] === "graphql"
    ? graph(prNode({ comments: [{ databaseId: 11, body: "new feedback" }] }))
    : json({ workflow_runs: [] });
  time.advance(15000);
  await runPr(argv, { execFn: newExec, stateDir: dir, sleep: time.sleep });
  assert.equal(output.at(-1).events[0].type, "NEW_PR_COMMENTS");
  session = loadPersistedPrSession("fixture/repo", dir);
  assert.equal(session.entries[1].sinceCommentId, 11);
  await runPr(argv, { execFn: newExec, stateDir: dir, sleep: time.sleep });
  assert.equal(output.at(-1).events[0].type, "WATCH_CHUNK_TIMEOUT");
});

test("CI chunks wait out their budget without additional model or API polling", async (t) => {
  const dir = fixture(t);
  const time = clock(t);
  const output = capture(t);
  let calls = 0;
  await runCi(["watch", "--repo", "fixture/repo", "--config-file", path.join(dir, "config.json"), "--max-wait-sec", "1"], {
    execFn(args) { calls += 1; return ciExec(args); },
    sleep: time.sleep,
  });
  assert.equal(calls, 3);
  assert.equal(output.at(-1).events[0].type, "WATCH_CHUNK_TIMEOUT");
  assert.equal(output.at(-1).events[0].elapsedSec, 1);
  assert.equal(output.at(-1).statuses[0].repo, "fixture/repo");
});

test("deadline-interrupted CI polls cannot emit cached green or an invented phase", async (t) => {
  const time = clock(t);
  const args = parseArgs(["watch", "--repo", "fixture/repo"]);
  args.chunkDeadlineMs = time.now + 100;
  const state = loadState(path.join(fixture(t), "missing.json"));
  state.lastMainSha = "head";
  state.runs["1"] = { id: 1, head_sha: "head", head_branch: "main", event: "push",
    status: "completed", conclusion: "success", workflow_id: 1 };
  let calls = 0;
  const tick = await evaluatePollTick(args, state, () => {
    calls += 1;
    time.advance(100);
    return json({ sha: "head" });
  });
  assert.equal(calls, 1);
  assert.equal(tick.chunkTimedOut, true);
  assert.equal(tick.status, undefined);
  assert.deepEqual(tick.events, []);
});

test("multi-PR rotation persists the next target and preserves untouched comment cursors", async (t) => {
  const dir = fixture(t);
  const time = clock(t);
  const output = capture(t);
  const argv = ["watch", "--repo", "fixture/repo", "--prs", "1:head,2:head", "--max-wait-sec", "1"];
  savePersistedPrSession("fixture/repo", { entries: {
    2: { sinceCommentId: 100, hasExplicitSinceCommentId: true, lastPhase: "saved", watchState: {} },
  } }, dir);
  let calls = 0;
  await runPr(argv, {
    stateDir: dir, sleep: time.sleep,
    execFn(args) {
      calls += 1;
      assert.ok(args.includes("pr=1"));
      time.advance(1000);
      return graph(prNode());
    },
  });
  assert.equal(calls, 1);
  assert.equal(output.at(-1).events[0].type, "WATCH_CHUNK_TIMEOUT");
  let session = loadPersistedPrSession("fixture/repo", dir);
  assert.equal(session.nextPr, 2);
  assert.equal(session.entries[2].sinceCommentId, 100);
  const resumedCalls = [];
  await runPr([...argv, "--since-comment-id", "200"], {
    stateDir: dir, sleep: time.sleep,
    execFn(args) {
      resumedCalls.push(args);
      if (args.includes("pr=2")) {
        return graph(prNode({ comments: [{ databaseId: 150, body: "unseen secondary feedback" }] }));
      }
      return args[1] === "graphql" ? graph(prNode()) : json({ workflow_runs: [] });
    },
  });
  assert.ok(resumedCalls[0].includes("pr=2"), "resume must visit the second PR first");
  assert.equal(output.at(-1).events[0].type, "NEW_PR_COMMENTS");
  assert.equal(output.at(-1).events[0].pr, 2);
  session = loadPersistedPrSession("fixture/repo", dir);
  assert.equal(session.entries[2].sinceCommentId, 150);
});

test("multi-repository rotation resumes later targets rather than starving them", async (t) => {
  const dir = fixture(t);
  const time = clock(t);
  const args = parseArgs(["watch", "--repos", "fixture/one,fixture/two", "--config-file", path.join(dir, "config.json")]);
  args.chunkDeadlineMs = time.now + 100;
  const first = await evaluateMultiRepoPollTick(args, {}, (ghArgs) => {
    assert.match(ghArgs[2], /fixture\/one/);
    time.advance(100);
    return json({ sha: "head" });
  });
  assert.equal(first.chunkTimedOut, true);
  assert.equal(loadState(path.join(dir, "_discovery.json")).metrics.nextRepo, "fixture/two");
  args.chunkDeadlineMs = time.now + 100;
  const second = await evaluateMultiRepoPollTick(args, {}, (ghArgs) => {
    assert.match(ghArgs[2], /fixture\/two/);
    time.advance(100);
    return json({ sha: "head" });
  });
  assert.equal(second.chunkTimedOut, true);
});

test("owner discovery resumes interrupted pagination instead of throwing or restarting page one", async (t) => {
  const dir = fixture(t);
  const time = clock(t);
  const args = parseArgs(["watch", "--owner", "@me", "--visibility", "private",
    "--config-file", path.join(dir, "config.json")]);
  args.chunkDeadlineMs = time.now + 100;
  const first = await evaluateMultiRepoPollTick(args, {}, (ghArgs) => {
    assert.match(ghArgs[2], /page=1$/);
    time.advance(100);
    return json(Array.from({ length: 100 }, (_, i) => ({ full_name: `fixture/archived-${i}`, archived: true })));
  });
  assert.equal(first.chunkTimedOut, true);
  args.chunkDeadlineMs = time.now + 100;
  let calls = 0;
  const second = await evaluateMultiRepoPollTick(args, {}, (ghArgs) => {
    calls += 1;
    assert.match(ghArgs[2], /page=2$/);
    return json([]);
  });
  assert.equal(calls, 1);
  assert.equal(second.chunkTimedOut, undefined);
  assert.deepEqual(second.repos, []);
});

test("terminal multi-PR feedback preserves repository cooldown across chunk restarts", async (t) => {
  const dir = fixture(t);
  const time = clock(t);
  const output = capture(t);
  const argv = ["watch", "--repo", "fixture/repo", "--prs", "1:head,2:head",
    "--since-comment-id", "1:10", "--max-wait-sec", "1"];
  await runPr(argv, {
    stateDir: dir, sleep: time.sleep,
    execFn(args) {
      return args.includes("pr=1")
        ? graph(prNode({ comments: [{ databaseId: 11, body: "feedback" }] }))
        : throttled();
    },
  });
  assert.deepEqual(output.at(-1).events.map((x) => x.type), ["NEW_PR_COMMENTS", "RATE_LIMITED"]);
  assert.equal(loadPersistedPrSession("fixture/repo", dir).cooldownUntilMs, time.now + 900_000);
  await runPr(argv, {
    stateDir: dir, sleep: time.sleep,
    execFn() { assert.fail("repository cooldown must prevent every API request"); },
  });
  assert.equal(output.at(-1).events[0].type, "WATCH_CHUNK_TIMEOUT");
});

test("CI repository cooldown survives a terminal event from an earlier repository", async (t) => {
  const dir = fixture(t);
  const time = clock(t);
  const args = parseArgs(["watch", "--repos", "fixture/one,fixture/two", "--wake-on-commit",
    "--config-file", path.join(dir, "config.json")]);
  const state = loadState(path.join(dir, "missing.json"));
  state.lastMainSha = "old";
  state.cacheScope = "fixture-scope";
  saveState(stateFileForRepo("fixture/one", args), state);
  const first = await evaluateMultiRepoPollTick(args, {}, (ghArgs) =>
    ghArgs[2].includes("fixture/two") ? throttled() : ciExec(ghArgs));
  assert.ok(first.events.some((x) => x.type === "NEW_MAIN_COMMIT"));
  assert.equal(first.rateLimited, true);
  const second = await evaluateMultiRepoPollTick(args, {}, () => assert.fail("shared cooldown must prevent requests"));
  assert.equal(second.rateLimited, true);
  assert.equal(second.nextIntervalSec, 900);
  assert.ok(loadState(path.join(dir, "_discovery.json")).metrics.repoCooldownUntilMs > time.now);
});

test("chunk expiry during automatic Copilot retries rotates cleanly without a terminal review error", async (t) => {
  const time = clock(t);
  const args = parsePrWatchArgs(["watch", "--repo", "fixture/repo", "--pr", "1", "--head", "head"]);
  args.chunkDeadlineMs = time.now + 100;
  const review = { databaseId: 42, state: "COMMENTED", submittedAt: "2026-01-01T00:00:00Z",
    author: { login: "copilot" }, commit: { oid: "head" },
    body: "Copilot encountered an error and was unable to review this pull request" };
  let calls = 0;
  const tick = await nativeEvaluateMultiPrPollTick(args, (request) => {
    calls += 1;
    if (calls === 4) return { ok: false, chunkTimedOut: true };
    if (request.kind === "graphql") return { ok: true, data: { data: { repository: { pullRequest: prNode({ reviews: [review] }) } } } };
    return { ok: true, data: { workflow_runs: [], total_count: 0 } };
  }, {});
  assert.equal(tick.chunkTimedOut, true);
  assert.equal(tick.error, undefined);
  assert.deepEqual(tick.events, []);
});

test("concurrent session writers retain different PR entries and the longest shared cooldown", async (t) => {
  const dir = fixture(t);
  const moduleUrl = new URL("../scripts/pr-watch-daemon.mjs", import.meta.url).href;
  const cooldown = Date.now() + 900_000;
  const runWriter = (pr) => new Promise((resolve, reject) => {
    const script = `import { savePersistedPrSession } from ${JSON.stringify(moduleUrl)};
      for (let i=0;i<20;i++) savePersistedPrSession("fixture/repo", {
        cooldownUntilMs: ${pr === 1 ? cooldown : "null"},
        entries: { ${pr}: { sinceCommentId: i, watchState: {} } }
      }, ${JSON.stringify(dir)});`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(stderr)));
  });
  await Promise.all([runWriter(1), runWriter(2)]);
  const session = loadPersistedPrSession("fixture/repo", dir);
  assert.equal(session.entries[1].sinceCommentId, 19);
  assert.equal(session.entries[2].sinceCommentId, 19);
  assert.equal(session.cooldownUntilMs, cooldown);
  assert.deepEqual(readdirSync(dir), ["fixture__repo.json"]);
});

test("review regression: completed owner inventory survives until repository polling resumes", async (t) => {
  const dir = fixture(t);
  const time = clock(t);
  const args = parseArgs(["watch", "--owner", "@me", "--visibility", "private",
    "--config-file", path.join(dir, "config.json")]);
  args.chunkDeadlineMs = time.now + 200;
  const first = await evaluateMultiRepoPollTick(args, {}, (ghArgs) => {
    time.advance(100);
    if (ghArgs[2].endsWith("page=1")) {
      return json([{ full_name: "fixture/target", private: true },
        ...Array.from({ length: 99 }, (_, i) => ({ full_name: `fixture/archived-${i}`, archived: true }))]);
    }
    assert.match(ghArgs[2], /page=2$/);
    return json([]);
  });
  assert.equal(first.chunkTimedOut, true);
  assert.deepEqual(first.repos, ["fixture/target"]);
  args.chunkDeadlineMs = time.now + 200;
  const visited = [];
  await evaluateMultiRepoPollTick(args, {}, (ghArgs) => {
    visited.push(ghArgs[2]);
    assert.match(ghArgs[2], /^repos\/fixture\/target\//, "completed discovery must not consume the next chunk again");
    return ciExec(ghArgs);
  });
  assert.ok(visited.some((endpoint) => endpoint.includes("/commits/")));
  const refreshed = [];
  await evaluateMultiRepoPollTick(args, {}, (ghArgs) => {
    refreshed.push(ghArgs[2]);
    return json([]);
  });
  assert.match(refreshed[0], /^user\/repos.*page=1$/, "discovery refreshes after the logical repository sweep finishes");
});

test("review regression: an interrupted repository gets the next full chunk after a completed prefix", async (t) => {
  const dir = fixture(t);
  const time = clock(t);
  const args = parseArgs(["watch", "--repos", "fixture/one,fixture/two",
    "--config-file", path.join(dir, "config.json")]);
  const execFn = (ghArgs) => {
    time.advance(40);
    return greenCiExec(ghArgs);
  };
  args.chunkDeadlineMs = time.now + 200;
  const first = await evaluateMultiRepoPollTick(args, {}, execFn);
  assert.equal(first.chunkTimedOut, true);
  assert.ok(first.statuses.some((status) => status.repo === "fixture/one"));
  assert.equal(loadState(path.join(dir, "_discovery.json")).metrics.nextRepo, "fixture/two");
  args.chunkDeadlineMs = time.now + 200;
  const visited = [];
  const second = await evaluateMultiRepoPollTick(args, {}, (ghArgs) => {
    visited.push(ghArgs[2]);
    return execFn(ghArgs);
  });
  assert.match(visited[0], /^repos\/fixture\/two\//);
  assert.ok(second.statuses.some((status) => status.repo === "fixture/two"));
});

test("review regression: logical repository sweeps retain completed green results across chunks", async (t) => {
  const dir = fixture(t);
  const time = clock(t);
  const args = parseArgs(["watch", "--repos", "fixture/one,fixture/two",
    "--config-file", path.join(dir, "config.json")]);
  const execFn = (ghArgs) => {
    time.advance(40);
    return greenCiExec(ghArgs);
  };
  args.chunkDeadlineMs = time.now + 200;
  const first = await evaluateMultiRepoPollTick(args, {}, execFn);
  assert.equal(first.chunkTimedOut, true);
  assert.equal(first.events.some((event) => event.type === "ALL_GREEN"), false);
  args.chunkDeadlineMs = time.now + 200;
  const second = await evaluateMultiRepoPollTick(args, {}, execFn);
  assert.deepEqual(second.events.filter((event) => event.type === "ALL_GREEN").map((event) => event.repo).sort(),
    ["fixture/one", "fixture/two"]);
  args.chunkDeadlineMs = time.now + 200;
  const refreshed = [];
  const third = await evaluateMultiRepoPollTick(args, {}, (ghArgs) => {
    refreshed.push(ghArgs[2]);
    return execFn(ghArgs);
  });
  assert.ok(refreshed.length > 0, "a completed logical sweep must not replay old green without polling");
  assert.equal(third.events.some((event) => event.type === "ALL_GREEN"), false);
});

test("logical sweep evidence fails closed when another poll changes its head or observation", async (t) => {
  const time = clock(t);
  for (const change of ["head", "observation"]) {
    const dir = fixture(t);
    const args = parseArgs(["watch", "--repos", "fixture/one,fixture/two",
      "--config-file", path.join(dir, "config.json")]);
    const execFn = (ghArgs) => {
      time.advance(40);
      return greenCiExec(ghArgs);
    };
    args.chunkDeadlineMs = time.now + 200;
    assert.equal((await evaluateMultiRepoPollTick(args, {}, execFn)).chunkTimedOut, true);
    const file = stateFileForRepo("fixture/one", args);
    const observed = loadState(file);
    if (change === "head") observed.lastMainSha = "new-head";
    else observed.metrics.lastPollAt = "2026-10-29T00:00:00Z";
    saveState(file, observed);
    args.chunkDeadlineMs = time.now + 200;
    const visited = [];
    const resumed = await evaluateMultiRepoPollTick(args, {}, (ghArgs) => {
      visited.push(ghArgs[2]);
      return execFn(ghArgs);
    });
    assert.ok(visited.some((endpoint) => endpoint.includes("fixture/one/commits/")), change);
    assert.equal(resumed.events.some((event) => event.type === "ALL_GREEN"), false, change);
  }
});

test("diagnostic entrypoints poll fresh and changed watch scope cannot reuse a partial green sweep", async (t) => {
  const dir = fixture(t);
  const time = clock(t);
  const args = parseArgs(["watch", "--repos", "fixture/one,fixture/two",
    "--config-file", path.join(dir, "config.json")]);
  const execFn = (ghArgs) => {
    time.advance(40);
    return greenCiExec(ghArgs);
  };
  args.chunkDeadlineMs = time.now + 200;
  assert.equal((await evaluateMultiRepoPollTick(args, {}, execFn)).chunkTimedOut, true);
  for (const mode of ["once", "status", "optimize"]) {
    const visited = [];
    await evaluateMultiRepoPollTick({ ...args, mode, chunkDeadlineMs: undefined }, {}, (ghArgs) => {
      visited.push(ghArgs[2]);
      return execFn(ghArgs);
    });
    assert.ok(visited.some((endpoint) => endpoint.includes("fixture/one/commits/")), mode);
    assert.ok(visited.some((endpoint) => endpoint.includes("fixture/two/commits/")), mode);
  }
  const visited = [];
  const changed = await evaluateMultiRepoPollTick({
    ...args, branch: "release", explicitBranch: true, chunkDeadlineMs: time.now + 500,
  }, {}, (ghArgs) => {
    visited.push(ghArgs[2]);
    return execFn(ghArgs);
  });
  assert.match(visited[0], /^repos\/fixture\/one\/commits\/release$/);
  assert.ok(visited.some((endpoint) => endpoint.includes("fixture/two/commits/release")));
  assert.equal(changed.events.some((event) => event.type === "ALL_GREEN"), false);
});

test("review regression: an interrupted PR gets the next full chunk after a completed prefix", async (t) => {
  const time = clock(t);
  const args = parsePrWatchArgs(["watch", "--repo", "fixture/repo", "--prs", "1:head,2:head"]);
  const multiState = {};
  const execFn = (ghArgs) => {
    time.advance(40);
    return ghArgs[1] === "graphql" ? graph(prNode()) : json({ workflow_runs: [] });
  };
  args.chunkDeadlineMs = time.now + 120;
  const first = await evaluateMultiPrPollTick(args, execFn, multiState);
  assert.equal(first.chunkTimedOut, true);
  assert.equal(first.statuses[0].pr, 1);
  assert.equal(first.nextPr, 2);
  args.nextPr = first.nextPr;
  args.chunkDeadlineMs = time.now + 120;
  const visited = [];
  const second = await evaluateMultiPrPollTick(args, (ghArgs) => {
    visited.push(ghArgs);
    return execFn(ghArgs);
  }, multiState);
  assert.ok(visited[0].includes("pr=2"));
  assert.ok(second.statuses.some((status) => status.pr === 2));
});

test("review regression: CI cooldown restores saved snapshots without making API calls", async (t) => {
  const dir = fixture(t);
  clock(t);
  const args = parseArgs(["watch", "--repos", "fixture/one,fixture/two",
    "--config-file", path.join(dir, "config.json")]);
  const first = await evaluateMultiRepoPollTick(args, {}, (ghArgs) =>
    ghArgs[2].includes("fixture/two") ? throttled() : ciExec(ghArgs));
  assert.equal(first.rateLimited, true);
  assert.equal(first.statuses[0].repo, "fixture/one");
  const second = await evaluateMultiRepoPollTick(args, {}, () => assert.fail("cooldown must not poll GitHub"));
  assert.equal(second.statuses[0]?.repo, "fixture/one");
  assert.equal(second.statuses[0].phase, first.statuses[0].phase);
});

test("review regression: single-PR cooldown saves its last completed snapshot for later chunks", async (t) => {
  const dir = fixture(t);
  const time = clock(t);
  const output = capture(t);
  const argv = ["watch", "--repo", "fixture/repo", "--pr", "1", "--head", "head",
    "--interval", "5", "--max-wait-sec", "10"];
  let calls = 0;
  await runPr(argv, {
    stateDir: dir, sleep: time.sleep,
    execFn(ghArgs) {
      calls += 1;
      if (calls > 2) return throttled();
      return ghArgs[1] === "graphql" ? graph(prNode()) : json({ workflow_runs: [] });
    },
  });
  assert.equal(calls, 3);
  const snapshot = output.at(-1).status;
  assert.ok(snapshot?.phase);
  const saved = loadPersistedPrSession("fixture/repo", dir).entries[1];
  assert.deepEqual(saved.lastStatus, snapshot);
  await runPr(argv, {
    stateDir: dir, sleep: time.sleep,
    execFn() { assert.fail("restored cooldown must not poll GitHub"); },
  });
  assert.equal(output.at(-1).events[0].type, "WATCH_CHUNK_TIMEOUT");
  assert.deepEqual(output.at(-1).status, snapshot);
});

for (const boundary of ["ci-request", "ci-auth", "pr-request", "pr-reviewer"]) {
  test(`SDK chunk cancellation reaches ${boundary} without stale readiness or an unbounded retry`, { timeout: 5000 }, async (t) => {
    const dir = fixture(t);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let startedResolve;
    const started = new Promise((resolve) => { startedResolve = resolve; });
    const waitForAbort = (signal) => {
      startedResolve();
      assert.ok(signal instanceof AbortSignal, "the native async boundary must receive the chunk signal");
      return new Promise((resolve) => signal.addEventListener("abort",
        () => resolve({ ok: false, error: "cancelled" }), { once: true }));
    };
    const erroredReview = { databaseId: 99, state: "COMMENTED", submittedAt: "2026-01-01T00:00:00Z",
      author: { login: "copilot" }, commit: { oid: "head" },
      body: "Copilot encountered an error and was unable to review this pull request" };
    let reviewerCalls = 0;
    const request = async (input, { signal } = {}) => {
      if (boundary === "ci-request" || boundary === "pr-request") return waitForAbort(signal);
      if (input.kind === "reviewer") {
        reviewerCalls += 1;
        return waitForAbort(signal);
      }
      if (input.kind === "graphql") {
        return { ok: true, data: { data: { repository: { pullRequest: prNode({ reviews: [erroredReview] }) } } } };
      }
      return { ok: true, data: { workflow_runs: [], total_count: 0 } };
    };
    if (boundary === "ci-auth") request.cacheScope = ({ signal }) => waitForAbort(signal);
    const isCi = boundary.startsWith("ci-");
    const args = isCi ? parseArgs(["watch", "--repo", "fixture/repo"])
      : parsePrWatchArgs(["watch", "--repo", "fixture/repo", "--pr", "1", "--head", "head"]);
    args.chunkDeadlineMs = Date.now() + 1000;
    const state = isCi ? loadState(path.join(dir, "missing.json")) : createPrWatchState();
    const pending = isCi ? nativeEvaluatePollTick(args, state, request)
      : nativeEvaluatePrPollTick(args, request, state);
    await started;
    t.mock.timers.tick(1000);
    const tick = await pending;
    assert.equal(tick.chunkTimedOut, true);
    assert.equal(tick.error, undefined);
    assert.equal(tick.events.some((event) => /GREEN|READY|REVIEW_ERROR/.test(event.type)), false);
    if (boundary === "pr-reviewer") {
      assert.equal(reviewerCalls, 1);
      assert.equal(state.copilotErrorRetriesByHead.head, 1, "an uncertain submitted retry still consumes its bounded attempt");
      const resumed = await nativeEvaluatePrPollTick({
        ...args, chunkDeadlineMs: undefined, maxCopilotRetries: 1,
      }, request, state);
      assert.equal(resumed.events[0].type, "COPILOT_REVIEW_ERROR");
      assert.equal(reviewerCalls, 1, "resuming cannot exceed the persisted retry limit");
    }
  });
}

test("completed owner inventory cannot cross an SDK credential identity change", async (t) => {
  const dir = fixture(t);
  const time = clock(t);
  const args = parseArgs(["watch", "--owner", "@me", "--visibility", "private",
    "--config-file", path.join(dir, "config.json")]);
  let scope = "before";
  const visited = [];
  const request = async ({ endpoint }) => {
    visited.push(endpoint);
    let data;
    if (endpoint.startsWith("user/repos")) {
      time.advance(scope === "before" ? 100 : 10);
      data = [{ full_name: `fixture/${scope}`, private: true }];
    } else data = endpoint.includes("/commits/") ? { sha: `${scope}-head` } : { workflow_runs: [] };
    return { ok: true, status: 200, cacheScope: scope, headers: {}, data };
  };
  request.cacheScope = async () => scope;
  args.chunkDeadlineMs = time.now + 100;
  assert.equal((await nativeEvaluateMultiRepoPollTick(args, {}, request)).chunkTimedOut, true);
  scope = "after";
  visited.length = 0;
  args.chunkDeadlineMs = time.now + 1000;
  const next = await nativeEvaluateMultiRepoPollTick(args, {}, request);
  assert.match(visited[0], /^user\/repos/);
  assert.deepEqual(next.repos, ["fixture/after"]);
  assert.equal(visited.some((endpoint) => endpoint.includes("repos/fixture/before/")), false);
});

test("SDK notification output retains chunk rotations for both direct entrypoints", async (t) => {
  const dir = fixture(t);
  const time = clock(t);
  capture(t);
  const prFile = path.join(dir, "pr-events.jsonl");
  await runPr(["watch", "--repo", "fixture/repo", "--pr", "1", "--head", "head",
    "--max-wait-sec", "1", "--events-file", prFile], {
    stateDir: dir, sleep: time.sleep,
    execFn: (args) => args[1] === "graphql" ? graph(prNode()) : json({ workflow_runs: [] }),
  });
  const ciFile = path.join(dir, "ci-events.jsonl");
  await runCi(["watch", "--repo", "fixture/repo", "--max-wait-sec", "1",
    "--config-file", path.join(dir, "config.json"), "--events-file", ciFile], {
    sleep: time.sleep, execFn: ciExec,
  });
  for (const file of [prFile, ciFile]) {
    const events = readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(events.filter((event) => event.type === "WATCH_CHUNK_TIMEOUT").length, 1);
    assert.ok(events.some((event) => event.type === "STATUS" && event.repo === "fixture/repo"));
  }
});

test("review 5707186762: discovery restarts every owner collection after a mid-request credential refresh", async (t) => {
  const time = clock(t);
  for (const owner of ["@me", "fixture"]) {
    const dir = fixture(t);
    const args = parseArgs(["watch", "--owner", owner, "--visibility", owner === "@me" ? "private" : "all",
      "--config-file", path.join(dir, "config.json")]);
    let scope = "before";
    const calls = [];
    const request = async ({ endpoint }) => {
      let data;
      if (endpoint.startsWith("user/repos") || endpoint.startsWith("users/fixture/repos")) {
        const page = Number(new URLSearchParams(endpoint.split("?")[1]).get("page"));
        const refreshHere = owner === "@me" || endpoint.startsWith("users/fixture/repos");
        if (scope === "before" && refreshHere && page === 2) scope = "after";
        calls.push({ endpoint, scope });
        if (scope === "before" && refreshHere) {
          time.advance(100);
          data = Array.from({ length: 100 }, (_, i) => ({
            full_name: `fixture/old-${i}`, owner: { login: "fixture" }, private: owner === "@me", archived: i > 0,
          }));
        } else if (scope === "before") {
          data = [{ full_name: "fixture/old-accessible", owner: { login: "fixture" }, private: true }];
        } else if (page === 2) data = [];
        else data = [{ full_name: owner === "@me" ? "fixture/new"
          : endpoint.startsWith("user/repos") ? "fixture/new-private" : "fixture/new-public",
        owner: { login: "fixture" }, private: !endpoint.startsWith("users/fixture/repos") }];
      } else {
        data = endpoint.includes("/commits/") ? { sha: "new-head" } : { workflow_runs: [] };
      }
      return { ok: true, status: 200, cacheScope: scope, headers: {}, data };
    };
    request.cacheScope = async () => scope;
    args.chunkDeadlineMs = time.now + 100;
    assert.equal((await nativeEvaluateMultiRepoPollTick(args, {}, request)).chunkTimedOut, true);
    args.chunkDeadlineMs = time.now + 1000;
    const resumed = await nativeEvaluateMultiRepoPollTick(args, {}, request);
    assert.deepEqual(resumed.repos.sort(), owner === "@me"
      ? ["fixture/new"] : ["fixture/new-private", "fixture/new-public"]);
    assert.ok(calls.some(({ endpoint, scope: identity }) => identity === "after" &&
      endpoint.startsWith("user/repos") && endpoint.endsWith("page=1")));
  }
});

test("review 5707186762: paginated job chunk expiry emits rotation instead of a terminal poll error", async (t) => {
  const time = clock(t);
  const output = capture(t);
  for (const expiredChunk of [true, false]) {
  const dir = fixture(t);
  output.length = 0;
  let laterPages = 0;
  await nativeRunCi(["watch", "--repo", "fixture/repo", "--max-wait-sec", "1",
    "--config-file", path.join(dir, "config.json")], {
    sleep: time.sleep,
    execFn: async ({ endpoint }) => {
      if (endpoint.includes("/jobs?") && new URLSearchParams(endpoint.split("?")[1]).get("page") === "2") {
        laterPages += 1;
        if (expiredChunk) {
          time.advance(1000);
          return { ok: false, chunkTimedOut: true };
        }
        return { ok: false, status: 0, error: "Request timed out before the chunk deadline" };
      }
      const data = endpoint.includes("/commits/") ? { sha: "head" }
        : endpoint.includes("/jobs?") ? { total_count: 51, jobs: Array.from({ length: 50 }, (_, i) => ({
          id: i + 1, name: `job-${i}`, status: "completed", conclusion: "success",
        })) } : { workflow_runs: [{
          id: 1, name: "CI", event: "push", head_branch: "main", head_sha: "head",
          status: "in_progress", conclusion: null,
        }] };
      return { ok: true, status: 200, headers: {}, data };
    },
  });
  assert.equal(laterPages, 1);
  assert.equal(output.flatMap((item) => item.events).some((event) => event.type === "POLL_ERROR"), !expiredChunk);
  assert.equal(output.at(-1).events[0].type, expiredChunk ? "WATCH_CHUNK_TIMEOUT" : "POLL_ERROR");
  }
});

test("review 5707186762: unknown-scope completed and partial saved discovery are never trusted", async (t) => {
  const time = clock(t);
  for (const complete of [true, false]) {
    for (const missingGlobalScope of [false, true]) {
    const dir = fixture(t);
    const configFile = path.join(dir, "config.json");
    const args = parseArgs(["watch", "--owner", "@me", "--visibility", "private", "--config-file", configFile]);
    const state = loadState(path.join(dir, "missing.json"));
    state.cacheScope = missingGlobalScope ? "" : "current";
    state.metrics.discoveryProgress = {
      "user/repos?affiliation=owner&visibility=private&per_page=100": {
        page: 2, complete, results: [{ full_name: "fixture/old", private: true }],
        ...(missingGlobalScope ? { cacheScope: "old-identity" } : {}),
      },
    };
    saveState(path.join(dir, "_discovery.json"), state);
    const calls = [];
    const request = async ({ endpoint }) => {
      calls.push(endpoint);
      return { ok: true, status: 200, cacheScope: "current", headers: {},
        data: endpoint.startsWith("user/repos")
          ? endpoint.endsWith("page=1") ? [{ full_name: "fixture/new", private: true }] : []
          : endpoint.includes("/commits/") ? { sha: "new" } : { workflow_runs: [] } };
    };
    request.cacheScope = async () => "current";
    args.chunkDeadlineMs = time.now + 1000;
    const result = await nativeEvaluateMultiRepoPollTick(args, {}, request);
    assert.match(calls[0], /^user\/repos.*page=1$/);
    assert.deepEqual(result.repos, ["fixture/new"]);
    }
  }
});

test("review 5707186762: a scope refresh during repository polling invalidates the owner inventory before green", async (t) => {
  const time = clock(t);
  for (const expiredChunk of [false, true]) {
  const dir = fixture(t);
  const args = parseArgs(["watch", "--owner", "@me", "--visibility", "private",
    "--config-file", path.join(dir, "config.json")]);
  let scope = "before";
  const adapter = fixtureRequest(greenCiExec);
  const request = async (input) => {
    if (input.endpoint.startsWith("user/repos")) {
      if (scope === "before") time.advance(100);
      return { ok: true, status: 200, cacheScope: scope, headers: {},
        data: [{ full_name: `fixture/${scope}`, private: true }] };
    }
    if (input.endpoint.includes("/commits/") && scope === "before") {
      scope = "after";
      if (expiredChunk) time.advance(1000);
    }
    return { ...await adapter(input), cacheScope: scope };
  };
  request.cacheScope = async () => scope;
  args.chunkDeadlineMs = time.now + 100;
  assert.equal((await nativeEvaluateMultiRepoPollTick(args, {}, request)).chunkTimedOut, true);
  args.chunkDeadlineMs = time.now + 1000;
  const changed = await nativeEvaluateMultiRepoPollTick(args, {}, request);
  assert.equal(changed.events.some((event) => /GREEN$/.test(event.type)), false);
  assert.equal(changed.events.some((event) => event.type === "POLL_ERROR"), !expiredChunk);
  assert.equal(Boolean(changed.chunkTimedOut), expiredChunk);
  args.chunkDeadlineMs = time.now + 1000;
  const fresh = await nativeEvaluateMultiRepoPollTick(args, {}, request);
  assert.deepEqual(fresh.repos, ["fixture/after"]);
  }
});

test("discovery scope reset preserves Retry-After and genuine API errors", async (t) => {
  const time = clock(t);
  for (const status of [429, 503]) {
    const dir = fixture(t);
    const args = parseArgs(["watch", "--owner", "@me", "--visibility", "private",
      "--config-file", path.join(dir, "config.json")]);
    let scope = "before";
    let calls = 0;
    const request = async ({ endpoint }) => {
      calls += 1;
      assert.equal(scope, "before", "scope reset cannot immediately retry a quota failure or transport error");
      if (endpoint.endsWith("page=1")) {
        time.advance(100);
        return { ok: true, status: 200, cacheScope: scope, headers: {},
          data: Array.from({ length: 100 }, (_, i) => ({ full_name: `fixture/old-${i}`, private: true })) };
      }
      scope = "after";
      return { ok: false, status, cacheScope: scope, rateLimited: status === 429,
        headers: status === 429 ? { "retry-after": "900" } : {}, data: null,
        error: status === 429 ? "quota" : "Service unavailable" };
    };
    request.cacheScope = async () => scope;
    args.chunkDeadlineMs = time.now + 100;
    assert.equal((await nativeEvaluateMultiRepoPollTick(args, {}, request)).chunkTimedOut, true);
    args.chunkDeadlineMs = time.now + 1000;
    if (status === 503) {
      await assert.rejects(nativeEvaluateMultiRepoPollTick(args, {}, request), /Service unavailable/);
    } else {
      const limited = await nativeEvaluateMultiRepoPollTick(args, {}, request);
      assert.equal(limited.rateLimited, true);
      assert.ok(limited.nextIntervalSec >= 900);
      const resumed = await nativeEvaluateMultiRepoPollTick(args, {}, () => assert.fail("cooldown must prevent requests"));
      assert.equal(resumed.rateLimited, true);
    }
    assert.equal(calls, 2);
  }
});

test("body review 5707347169: running single and multi PR watches observe newly shared cooldown", async (t) => {
  const time = clock(t);
  capture(t);
  for (const multi of [false, true]) {
    const dir = fixture(t);
    let injected = false;
    let calls = 0;
    await runPr(["watch", "--repo", "fixture/repo", ...(multi ? ["--prs", "1:head,2:head"] : ["--pr", "1", "--head", "head"]),
      "--interval", "5", "--max-wait-sec", "20"], {
      stateDir: dir,
      execFn(args) {
        assert.equal(injected, false, "an already running watcher must honor another PR's newly shared backoff");
        calls += 1;
        return args[1] === "graphql" ? graph(prNode()) : json({ workflow_runs: [] });
      },
      async sleep(sec) {
        if (!injected) {
          injected = true;
          savePersistedPrSession("fixture/repo", { cooldownUntilMs: time.now + 900_000,
            entries: { 99: { watchState: {}, sinceCommentId: 1 } } }, dir);
        }
        await time.sleep(sec);
      },
    });
    assert.equal(calls, multi ? 4 : 2);
  }
});

test("body review 5707347169: comment cursors and cooldowns cannot cross GitHub hosts", (t) => {
  const dir = fixture(t);
  const previous = process.env.GH_HOST;
  t.after(() => previous === undefined ? delete process.env.GH_HOST : process.env.GH_HOST = previous);
  process.env.GH_HOST = "github.com";
  const until = Date.now() + 900_000;
  savePersistedPrSession("fixture/repo", { cooldownUntilMs: until, entries: { 1: { watchState: {}, sinceCommentId: 900 } } }, dir);
  process.env.GH_HOST = "ghe.fixture.test";
  assert.deepEqual(loadPersistedPrSession("fixture/repo", dir).entries, {});
  assert.equal(loadPersistedPrSession("fixture/repo", dir).cooldownUntilMs, null);
  savePersistedPrSession("fixture/repo", { entries: { 1: { watchState: {}, sinceCommentId: 10 } } }, dir);
  process.env.GH_HOST = "github.com";
  assert.equal(loadPersistedPrSession("fixture/repo", dir).entries[1].sinceCommentId, 900);
  assert.equal(loadPersistedPrSession("fixture/repo", dir).cooldownUntilMs, until);
});

test("body review 5707347169: diagnostic owner discovery cannot reuse a partial watch inventory", async (t) => {
  const time = clock(t);
  for (const mode of ["once", "status", "optimize"]) {
    const dir = fixture(t);
    const args = parseArgs(["watch", "--owner", "@me", "--visibility", "private",
      "--config-file", path.join(dir, "config.json")]);
    let fresh = false;
    const calls = [];
    const request = async ({ endpoint }) => {
      calls.push(endpoint);
      let data;
      if (endpoint.startsWith("user/repos")) {
        if (!fresh) {
          time.advance(100);
          data = Array.from({ length: 100 }, (_, i) => ({ full_name: `fixture/old-${i}`, private: true, archived: i > 0 }));
        } else data = endpoint.endsWith("page=1") ? [{ full_name: "fixture/new", private: true }] : [];
      } else data = endpoint.includes("/commits/") ? { sha: "new" } : { workflow_runs: [] };
      return { ok: true, status: 200, cacheScope: "fixture", headers: {}, data };
    };
    request.cacheScope = async () => "fixture";
    args.chunkDeadlineMs = time.now + 100;
    assert.equal((await nativeEvaluateMultiRepoPollTick(args, {}, request)).chunkTimedOut, true);
    fresh = true;
    calls.length = 0;
    const diagnostic = await nativeEvaluateMultiRepoPollTick({ ...args, mode, chunkDeadlineMs: undefined }, {}, request);
    assert.match(calls[0], /^user\/repos.*page=1$/, mode);
    assert.deepEqual(diagnostic.repos, ["fixture/new"], mode);
  }
});

test("body review 5707347169: malformed session data cannot silently reset retry limits", (t) => {
  const dir = fixture(t);
  savePersistedPrSession("fixture/repo", { entries: {
    1: { watchState: { copilotErrorRetriesByHead: { head: 2 } }, sinceCommentId: 100 },
  } }, dir);
  const file = path.join(dir, readdirSync(dir).find((name) => name.endsWith(".json")));
  const valid = JSON.parse(readFileSync(file, "utf8"));
  for (const text of ['{"entries":', JSON.stringify({
    ...valid, entries: { 1: { watchState: { copilotErrorRetriesByHead: { head: -1 } } } },
  }), JSON.stringify({ ...valid, cooldownUntilMs: "unverified" }),
  JSON.stringify({ ...valid, entries: { 1: { watchState: { nextPollAtMs: "unverified" } } } })]) {
    writeFileSync(file, text);
    assert.throws(() => loadPersistedPrSession("fixture/repo", dir), /Invalid PR watch state/);
    assert.throws(() => savePersistedPrSession("fixture/repo", {}, dir), /Invalid PR watch state/);
    assert.equal(readFileSync(file, "utf8"), text, "do not overwrite unverified retry/cursor proof");
  }
});

test("body review 5707482862: shared cooldown reports the currently requested repository", async (t) => {
  const dir = fixture(t);
  clock(t);
  const configFile = path.join(dir, "config.json");
  const firstArgs = parseArgs(["watch", "--repo", "fixture/old", "--config-file", configFile]);
  const request = async () => ({ ok: false, status: 429, rateLimited: true,
    cacheScope: "fixture", headers: { "retry-after": "900" }, error: "quota" });
  request.cacheScope = async () => "fixture";
  assert.equal((await nativeEvaluateMultiRepoPollTick(firstArgs, {}, request)).rateLimited, true);
  const nextArgs = parseArgs(["watch", "--repo", "fixture/new", "--config-file", configFile]);
  const next = await nativeEvaluateMultiRepoPollTick(nextArgs, {}, () => assert.fail("shared cooldown must prevent requests"));
  assert.deepEqual(next.repos, ["fixture/new"]);
  assert.equal(next.statuses.some((status) => status.repo === "fixture/old"), false);
  const configured = await nativeEvaluateMultiRepoPollTick(
    parseArgs(["watch", "--config-file", configFile]), { repos: ["fixture/configured"] },
    () => assert.fail("configured watchlist must retain shared backoff"));
  assert.deepEqual(configured.repos, ["fixture/configured"]);
  const qualified = await nativeEvaluateMultiRepoPollTick(
    parseArgs(["watch", "--owner", "@me", "--watch-run", "fixture/dispatched:7", "--config-file", configFile]), {},
    () => assert.fail("qualified target must retain shared backoff"));
  assert.deepEqual(qualified.repos, ["fixture/dispatched"]);
});

test("body review 5707482862: CI cooldown state does not throttle a different GitHub host", async (t) => {
  clock(t);
  const previous = process.env.GH_HOST;
  t.after(() => previous === undefined ? delete process.env.GH_HOST : process.env.GH_HOST = previous);
  for (const explicit of [false, true]) {
  const dir = fixture(t);
  const args = parseArgs(["watch", "--repo", "fixture/repo", "--config-file", path.join(dir, "config.json"),
    ...(explicit ? ["--state-file", path.join(dir, "shared-state.json")] : [])]);
  process.env.GH_HOST = "github.com";
  const quota = async () => ({ ok: false, status: 429, rateLimited: true, cacheScope: "fixture",
    headers: { "retry-after": "900" }, error: "quota" });
  quota.cacheScope = async () => "fixture";
  assert.equal((await nativeEvaluateMultiRepoPollTick(args, {}, quota)).rateLimited, true);
  process.env.GH_HOST = "ghe.fixture.test";
  let calls = 0;
  const request = async ({ endpoint }) => {
    calls += 1;
    return { ok: true, status: 200, cacheScope: "fixture", headers: {},
      data: endpoint.includes("/commits/") ? { sha: "new" } : { workflow_runs: [] } };
  };
  request.cacheScope = async () => "fixture";
  const next = await nativeEvaluateMultiRepoPollTick(args, {}, request);
  assert.equal(next.rateLimited, false);
  assert.ok(calls > 0);
  }
});

test("body review 5707482862: multi-PR errors retain retry state from a completed prefix", async (t) => {
  const dir = fixture(t);
  clock(t);
  t.mock.method(console, "error", () => {});
  t.mock.method(process, "exit", (code) => { throw new Error(`fixture-exit-${code}`); });
  let mutations = 0;
  const failedReview = { databaseId: 123, state: "COMMENTED", submittedAt: "2026-01-01T00:00:00Z",
    author: { login: "copilot" }, commit: { oid: "head" },
    body: "Copilot encountered an error and was unable to review this pull request" };
  const request = async (input) => {
    if (input.kind === "graphql") {
      if (input.variables.pr === 2) return { ok: false, status: 503, error: "offline" };
      return { ok: true, status: 200, cacheScope: "fixture",
        data: { data: { repository: { pullRequest: prNode({ reviews: [failedReview] }) } } } };
    }
    if (input.kind === "reviewer") mutations += 1;
    return { ok: true, status: 200, cacheScope: "fixture", data: { workflow_runs: [], total_count: 0 } };
  };
  request.cacheScope = async () => "fixture";
  await assert.rejects(nativeRunPr(["watch", "--repo", "fixture/repo", "--prs", "1:head,2:head"],
    { stateDir: dir, execFn: request }), /fixture-exit-1/);
  assert.equal(mutations, 1);
  assert.equal(loadPersistedPrSession("fixture/repo", dir).entries[1]?.watchState.copilotErrorRetriesByHead.head, 1);
});

test("host-scoped CI setup retains validated discovery cache for the following watch", async (t) => {
  const dir = fixture(t);
  capture(t);
  const previous = process.env.GH_HOST;
  t.after(() => previous === undefined ? delete process.env.GH_HOST : process.env.GH_HOST = previous);
  process.env.GH_HOST = "ghe.fixture.test";
  const configFile = path.join(dir, "config.json");
  let revalidated = 0;
  const request = async ({ endpoint, headers }) => {
    if (endpoint.startsWith("user/repos")) {
      if (headers["If-None-Match"]) {
        revalidated += 1;
        return { ok: true, status: 304, cacheScope: "fixture", headers: { etag: '"inventory"' }, data: null };
      }
      return { ok: true, status: 200, cacheScope: "fixture", headers: { etag: '"inventory"' },
        data: [{ full_name: "fixture/repo", private: true }] };
    }
    return { ok: true, status: 200, cacheScope: "fixture", headers: {},
      data: endpoint.includes("/commits/") ? { sha: "new" } : { workflow_runs: [] } };
  };
  request.cacheScope = async () => "fixture";
  await nativeRunCi(["setup", "--owner", "@me", "--visibility", "private", "--config-file", configFile], { execFn: request });
  const config = JSON.parse(readFileSync(configFile, "utf8"));
  const result = await nativeEvaluateMultiRepoPollTick(parseArgs(["watch", "--config-file", configFile]), config, request);
  assert.equal(revalidated, 1);
  assert.deepEqual(result.repos, ["fixture/repo"]);
});

test("single-item once lists honor scoped comment cursors before merge readiness", async (t) => {
  const dir = fixture(t);
  const output = capture(t);
  const reviewed = { databaseId: 321, state: "COMMENTED", submittedAt: "2026-01-01T00:00:00Z",
    author: { login: "copilot" }, commit: { oid: "head" }, body: "" };
  for (const scalar of [[], ["--since-comment-id", "900"]]) {
    output.length = 0;
    await runPr(["once", "--repo", "fixture/repo", "--prs", "1:head", ...scalar,
      "--since-comment-id", "1:10"], {
      stateDir: dir,
      execFn: (args) => args[1] === "graphql"
        ? graph(prNode({ checks: "COMPLETED", reviews: [reviewed], comments: [{ databaseId: 11, body: "Hold this head" }] }))
        : json({ workflow_runs: [], total_count: 0 }),
    });
    assert.equal(output.at(-1).events[0].type, "NEW_PR_COMMENTS");
    assert.equal(output.at(-1).events.some((event) => event.type === "PR_READY_TO_MERGE"), false);
  }
});

test("inherited CI cooldown cannot report a different repository from an explicit state file", async (t) => {
  const dir = fixture(t);
  clock(t);
  const configFile = path.join(dir, "config.json");
  const stateFile = path.join(dir, "explicit.json");
  const oldArgs = parseArgs(["watch", "--repo", "fixture/old", "--config-file", configFile, "--state-file", stateFile]);
  const state = loadState(stateFile);
  state.repo = "fixture/old";
  state.cacheScope = "fixture";
  state.metrics.lastStatus = { repo: "fixture/old", branch: "main", phase: "cached-green", summary: "Old target passed" };
  saveState(stateFile, state);
  const request = async () => ({ ok: false, status: 429, rateLimited: true, cacheScope: "fixture",
    headers: { "retry-after": "900" }, error: "quota" });
  request.cacheScope = async () => "fixture";
  assert.equal((await nativeEvaluateMultiRepoPollTick(oldArgs, {}, request)).rateLimited, true);
  const args = parseArgs(["watch", "--repo", "fixture/new", "--config-file", configFile, "--state-file", stateFile]);
  const result = await nativeEvaluateMultiRepoPollTick(args, {}, () => assert.fail("unexpired quota must prevent requests"));
  assert.deepEqual(result.repos, ["fixture/new"]);
  assert.deepEqual(result.statuses, [], "a current target cannot inherit another repository's cached snapshot");
  const perRepo = parseArgs(["watch", "--repo", "fixture/new", "--config-file", path.join(dir, "fresh", "config.json"),
    "--state-file", stateFile]);
  const inherited = await nativeEvaluateMultiRepoPollTick(perRepo, {},
    () => assert.fail("a per-repository unexpired quota must also prevent requests"));
  assert.deepEqual(inherited.repos, ["fixture/new"]);
  assert.deepEqual(inherited.statuses, [], "the post-tick fallback must enforce the same snapshot identity");
});

test("short multi-PR chunks preserve an absolute shared cooldown and resume after expiry", async (t) => {
  const dir = fixture(t);
  const time = clock(t);
  capture(t);
  const previous = process.env.COPILOT_TASK_WAIT_TIMEOUT_SECONDS;
  t.after(() => previous === undefined ? delete process.env.COPILOT_TASK_WAIT_TIMEOUT_SECONDS
    : process.env.COPILOT_TASK_WAIT_TIMEOUT_SECONDS = previous);
  process.env.COPILOT_TASK_WAIT_TIMEOUT_SECONDS = "1";
  const until = time.now + 2000;
  savePersistedPrSession("fixture/repo", { cooldownUntilMs: until, entries: {
    1: { watchState: {}, sinceCommentId: 0 }, 2: { watchState: {}, sinceCommentId: 0 },
  } }, dir);
  let calls = 0;
  for (let chunk = 0; chunk < 5; chunk += 1) {
    await runPr(["watch", "--repo", "fixture/repo", "--prs", "1:head,2:head"], {
      stateDir: dir, sleep: time.sleep,
      execFn(args) {
        assert.ok(time.now >= until, "legitimate unexpired quota must not be bypassed");
        calls += 1;
        return args[1] === "graphql" ? graph(prNode()) : json({ workflow_runs: [], total_count: 0 });
      },
    });
    if (time.now < until) assert.equal(loadPersistedPrSession("fixture/repo", dir).cooldownUntilMs, until);
  }
  assert.ok(calls > 0, "an expired absolute deadline must not slide forward forever on chunk re-arm");
  assert.equal(loadPersistedPrSession("fixture/repo", dir).cooldownUntilMs, null);
});

for (const surface of ["ci", "single-pr", "multi-pr"]) {
  test(`review 5707961776: rearmed ${surface} chunks honor the existing ordinary polling interval`, async (t) => {
    const dir = fixture(t);
    const time = clock(t);
    capture(t);
    const started = time.now;
    const intervalSec = surface === "ci" ? 15 : 10;
    let calls = 0;
    const services = {
      stateDir: dir, sleep: time.sleep,
      execFn(args) {
        calls += 1;
        if (time.now !== started) assert.ok(time.now >= started + intervalSec * 1000, "re-arming cannot bypass the pending ordinary interval");
        return surface === "ci" ? ciExec(args)
          : args[1] === "graphql" ? graph(prNode()) : json({ workflow_runs: [], total_count: 0 });
      },
    };
    const argv = ["watch", "--repo", "fixture/repo", "--max-wait-sec", "1",
      ...(surface === "ci" ? ["--config-file", path.join(dir, "config.json"), "--active-interval", "15", "--idle-interval", "15"]
        : ["--interval", "10", ...(surface === "single-pr" ? ["--pr", "1", "--head", "head"] : ["--prs", "1:head,2:head"])])];
    const run = surface === "ci" ? runCi : runPr;
    await run(argv, services);
    const initialCalls = calls;
    assert.ok(initialCalls > 0);
    for (let chunk = 1; chunk < intervalSec; chunk += 1) {
      await run(argv, services);
      assert.equal(calls, initialCalls, "no API calls before the original poll deadline");
    }
    await run(argv, services);
    assert.ok(calls > initialCalls, "ordinary polling resumes after the original interval expires");
  });
}

test("review 5708185900: an idle peer ordinary interval cannot suppress another repository's due active polls", async (t) => {
  const dir = fixture(t);
  const time = clock(t);
  capture(t);
  const start = time.now;
  const activePolls = [];
  const idlePolls = [];
  const argv = ["watch", "--repos", "fixture/idle,fixture/active", "--config-file", path.join(dir, "config.json"),
    "--active-interval", "5", "--idle-interval", "15", "--max-wait-sec", "1"];
  const services = {
    sleep: time.sleep,
    execFn(args) {
      const endpoint = args[2];
      const active = endpoint.includes("fixture/active/");
      if (endpoint.includes("/commits/")) {
        (active ? activePolls : idlePolls).push(time.now - start);
        return json({ sha: "head" });
      }
      if (endpoint.includes("/jobs")) return json({ total_count: 1, jobs: [{ id: 1, name: "build", status: "in_progress" }] });
      return json({ workflow_runs: active ? [{
        id: 1, workflow_id: 1, name: "CI", event: "push", head_branch: "main",
        head_sha: "head", status: "in_progress", updated_at: "2026-10-30T00:00:00Z",
      }] : [] });
    },
  };
  for (let chunk = 0; chunk < 12; chunk += 1) await runCi(argv, services);
  assert.deepEqual(idlePolls, [0], "the idle target retains its independent fifteen-second interval");
  assert.deepEqual(activePolls, [0, 5000, 10000], "completed-sweep bookkeeping cannot hide another target after it becomes due");
});

test("review 5708286540: due completed peers cannot interrupt the final member of a passing logical sweep", async (t) => {
  const dir = fixture(t);
  const time = clock(t);
  const output = capture(t);
  const repos = ["fixture/one", "fixture/two", "fixture/three", "fixture/four"];
  const argv = ["watch", "--repos", repos.join(","), "--config-file", path.join(dir, "config.json"),
    "--idle-interval", "15", "--max-wait-sec", "70"];
  let green = [];
  for (let chunk = 0; chunk < 8; chunk += 1) {
    await runCi(argv, {
      sleep: time.sleep,
      execFn(args) {
        time.advance(10000);
        return greenCiExec(args);
      },
    });
    green = output.at(-1).events.filter((event) => event.type === "ALL_GREEN").map((event) => event.repo);
    if (green.length > 0) break;
  }
  assert.deepEqual(green.sort(), [...repos].sort(),
    "finish all outstanding members and evaluate aggregate green before an optional due-peer refresh consumes the chunk");
});

for (const boundary of ["before-request", "during-request"]) {
  test(`review 5708185900: observed ${boundary} credential change cannot carry an old snapshot into error or quota output`, async (t) => {
    const dir = fixture(t);
    const time = clock(t);
    capture(t);
    let credential = "first", responseScope = "first", failed = false, scopeUnavailable = false, calls = 0;
    const adapter = fixtureRequest(ciExec);
    const request = async (input, options) => {
      calls += 1;
      return failed
        ? { ok: false, status: 503, cacheScope: responseScope, headers: {}, error: "unavailable" }
        : { ...await adapter(input, options), cacheScope: responseScope };
    };
    request.cacheScope = async () => {
      if (scopeUnavailable) throw new Error("credential resolver unavailable");
      return credential;
    };
    const argv = ["watch", "--repo", "fixture/repo", "--config-file", path.join(dir, "config.json"), "--max-wait-sec", "1"];
    await nativeRunCi(argv, { execFn: request, sleep: time.sleep });
    const args = parseArgs(argv);
    args.respectPollInterval = true;
    const snapshot = loadState(stateFileForRepo("fixture/repo", args)).metrics.lastStatus;
    assert.ok(snapshot);
    const discoveryFile = path.join(dir, "_discovery.json");
    const sameScope = loadState(discoveryFile);
    sameScope.metrics.repoCooldownUntilMs = time.now + 5000;
    saveState(discoveryFile, sameScope);
    const sameScopeCalls = calls;
    const unchanged = await nativeEvaluateMultiRepoPollTick(args, {}, request);
    assert.equal(unchanged.statuses[0].phase, snapshot.phase, "same observed identity keeps its legitimate quota snapshot");
    assert.equal(calls, sameScopeCalls);
    sameScope.metrics.repoCooldownUntilMs = null;
    saveState(discoveryFile, sameScope);
    scopeUnavailable = true;
    const unknown = await nativeEvaluateMultiRepoPollTick(args, {}, request);
    assert.deepEqual(unknown.statuses, [], "unresolved credentials cannot reuse the last known identity's snapshot");
    scopeUnavailable = false;
    time.advance(61000);
    failed = true;
    responseScope = "second";
    if (boundary === "before-request") credential = "second";
    const changed = await nativeEvaluateMultiRepoPollTick(args, {}, request);
    assert.ok(changed.events.some((event) => event.type === "POLL_ERROR"));
    assert.deepEqual(changed.statuses, [], "the carried snapshot belongs to the previous observed credential");
    credential = "second";
    const retry = await nativeEvaluateMultiRepoPollTick(args, {}, request);
    assert.deepEqual(retry.statuses, [], "a second failure cannot rebind the old snapshot to the new credential");
    const discovery = loadState(discoveryFile);
    const until = time.now + 900000;
    discovery.metrics.repoCooldownUntilMs = until;
    saveState(discoveryFile, discovery);
    const beforeQuota = calls;
    const quota = await nativeEvaluateMultiRepoPollTick(args, {}, request);
    assert.equal(quota.rateLimited, true);
    assert.equal(calls, beforeQuota, "legitimate unexpired shared quota remains authoritative");
    assert.deepEqual(quota.statuses, [], "quota output cannot resurrect a snapshot from the old observed credential");
    assert.equal(loadState(discoveryFile).metrics.repoCooldownUntilMs, until);
  });
}

for (const boundary of ["repository-api", "credential"]) {
  test(`review 5708121188: ${boundary} errors invalidate previously passing repository proofs before recovery`, async (t) => {
    const time = clock(t);
    const dir = fixture(t);
    const args = parseArgs(["watch", "--repos", "fixture/one,fixture/two",
      "--config-file", path.join(dir, "config.json")]);
    args.respectPollInterval = true;
    args.chunkDeadlineMs = time.now + 200;
    const initial = await evaluateMultiRepoPollTick(args, {}, (ghArgs) => {
      time.advance(40);
      return greenCiExec(ghArgs);
    });
    assert.equal(initial.chunkTimedOut, true);
    assert.equal(initial.events.some((event) => /GREEN$/.test(event.type)), false);
    const discoveryFile = path.join(dir, "_discovery.json");
    const held = loadState(discoveryFile).metrics.watchSweep;
    assert.ok(held.completed["fixture/one"] && held.greenEvents["fixture/one"], boundary);
    time.advance(1000);
    args.chunkDeadlineMs = time.now + 2000;
    const failing = authenticatedFixture(() => ({ ok: false, stdout: "", stderr: "HTTP 503 unavailable" }));
    if (boundary === "credential") failing.cacheScope = async () => { throw new Error("credential resolver unavailable"); };
    const failed = await nativeEvaluateMultiRepoPollTick(args, {}, failing);
    assert.ok(failed.events.some((event) => event.type === "POLL_ERROR"), boundary);
    assert.equal(failed.events.some((event) => /GREEN$/.test(event.type)), false, boundary);
    assert.deepEqual(loadState(discoveryFile).metrics.watchSweep.repos, held.repos,
      `${boundary}: discard green proof, not the retained repository inventory`);
    time.advance(61000);
    args.chunkDeadlineMs = time.now + 2000;
    let refreshedPreviouslyPassing = false;
    const recovered = await evaluateMultiRepoPollTick(args, {}, (ghArgs) => {
      if (ghArgs[2].includes("fixture/one/")) {
        refreshedPreviouslyPassing = true;
        return ghArgs[2].includes("/commits/") ? json({ sha: "now-uncertified" }) : json({ workflow_runs: [] });
      }
      return greenCiExec(ghArgs);
    });
    assert.ok(refreshedPreviouslyPassing, `${boundary}: old peer success must be checked again after a hard error`);
    assert.equal(recovered.events.some((event) => /GREEN$/.test(event.type)), false,
      `${boundary}: a different passing peer cannot release queued green for the now-uncertified repository`);
  });
}

test("review 5707961776: poll-error recovery requires fresh current-head CI evidence before a green signal", async (t) => {
  const dir = fixture(t);
  const time = clock(t);
  const args = parseArgs(["watch", "--repo", "fixture/one", "--config-file", path.join(dir, "config.json")]);
  const state = loadState(stateFileForRepo("fixture/one", args));
  assert.ok((await evaluatePollTick(args, state, greenCiExec)).events.some((event) => event.type === "ALL_GREEN"));
  time.advance(1000);
  const failed = await evaluatePollTick(args, state, () => ({ ok: false, stdout: "", stderr: "HTTP 503 unavailable" }));
  assert.ok(failed.events.some((event) => event.type === "POLL_ERROR"));
  assert.equal(failed.events.some((event) => /GREEN$/.test(event.type) || event.deliverySkill), false);
  time.advance(1000);
  const recovering = await evaluatePollTick(args, state, (ghArgs) =>
    ghArgs[2].includes("/commits/") ? json({ sha: "new-head" }) : json({ workflow_runs: [] }));
  assert.equal(recovering.events.some((event) => /GREEN$/.test(event.type) || event.deliverySkill), false,
    "old successful runs cannot authorize recovery for a newly observed head");
  const fresh = await evaluatePollTick(args, state, (ghArgs) => {
    const response = greenCiExec(ghArgs);
    const body = JSON.parse(response.stdout);
    if (body.sha) body.sha = "new-head";
    if (body.workflow_runs) for (const run of body.workflow_runs) run.head_sha = "new-head";
    return json(body);
  });
  assert.ok(fresh.events.some((event) => event.type === "ALL_GREEN" && event.sha === "new-head"));
});

test("ordinary PR intervals do not defer a new head or a diagnostic once call", async (t) => {
  const dir = fixture(t);
  const time = clock(t);
  capture(t);
  let head = "head", calls = 0;
  const services = {
    stateDir: dir, sleep: time.sleep,
    execFn(args) {
      calls += 1;
      return args[1] === "graphql" ? graph(prNode({ head })) : json({ workflow_runs: [], total_count: 0 });
    },
  };
  const argv = ["watch", "--repo", "fixture/repo", "--pr", "1", "--head", head, "--interval", "10", "--max-wait-sec", "1"];
  await runPr(argv, services);
  const firstCalls = calls;
  head = "new-head";
  argv[argv.indexOf("--head") + 1] = head;
  await runPr(argv, services);
  assert.ok(calls > firstCalls, "the previous head's ordinary interval cannot delay a new requested head");
  const resumedCalls = calls;
  await runPr(["once", "--repo", "fixture/repo", "--pr", "1", "--head", head], services);
  assert.ok(calls > resumedCalls, "once remains fresh during a pending watch interval");
});

test("ordinary CI intervals are credential/branch scoped and diagnostics remain fresh", async (t) => {
  const dir = fixture(t);
  const time = clock(t);
  const output = capture(t);
  let scope = "first", calls = 0;
  const adapter = fixtureRequest(ciExec);
  const request = async (input, options) => {
    calls += 1;
    return { ...await adapter(input, options), cacheScope: scope };
  };
  request.cacheScope = async () => scope;
  const services = { execFn: request, sleep: time.sleep };
  const argv = ["watch", "--repo", "fixture/repo", "--config-file", path.join(dir, "config.json"), "--max-wait-sec", "1"];
  await nativeRunCi(argv, services);
  const firstCalls = calls;
  scope = "second";
  await nativeRunCi(argv, services);
  assert.ok(calls > firstCalls, "a different credential must not inherit the previous identity's ordinary interval");
  const refreshedCalls = calls;
  await nativeRunCi([...argv, "--branch", "release"], services);
  assert.ok(calls > refreshedCalls, "a different branch must poll fresh");
  for (const mode of ["once", "status", "optimize"]) {
    const before = calls;
    await nativeRunCi([mode, ...argv.slice(1), "--branch", "release"], services);
    assert.ok(calls > before, mode);
  }
  const knownScopeCalls = calls;
  scope = undefined;
  await nativeRunCi([...argv, "--branch", "release"], services);
  assert.ok(calls > knownScopeCalls, "unknown scope cannot reuse the previous credential's deferred proof");
  assert.equal(output.at(-1).events.some((event) => /GREEN$/.test(event.type)), false);
});

for (const surface of ["ci", "single-pr", "multi-pr"]) {
  test(`retained green during ${surface} interval waits cannot replay readiness or slide the original due time`, async (t) => {
    const dir = fixture(t);
    const time = clock(t);
    const output = capture(t);
    const intervalSec = surface === "ci" ? 15 : 10;
    const due = time.now + intervalSec * 1000;
    const configFile = path.join(dir, "config.json");
    const review = { databaseId: 1, state: "COMMENTED", submittedAt: "2026-10-30T00:00:00Z",
      author: { login: "copilot" }, commit: { oid: "head" }, body: "" };
    let calls = 0;
    const services = {
      stateDir: dir, sleep: time.sleep,
      execFn(args) {
        calls += 1;
        return surface === "ci" ? greenCiExec(args)
          : args[1] === "graphql" ? graph(prNode({ checks: "COMPLETED", reviews: [review] }))
            : json({ workflow_runs: [], total_count: 0 });
      },
    };
    const argv = ["watch", "--repo", "fixture/repo", "--max-wait-sec", "1",
      ...(surface === "ci" ? ["--config-file", configFile, "--idle-interval", "15"]
        : ["--interval", "10", ...(surface === "single-pr" ? ["--pr", "1", "--head", "head"] : ["--prs", "1:head,2:head"])])];
    const run = surface === "ci" ? runCi : runPr;
    const green = (event) => event.type === "ALL_GREEN" || event.type === "PR_READY_TO_MERGE";
    await run(argv, services);
    assert.ok(output.at(-1).events.some(green), "seed a real successful observation, not invented cached proof");
    const initialCalls = calls;
    for (let chunk = 0; chunk < intervalSec; chunk += 1) {
      await run(argv, services);
      assert.equal(calls, initialCalls, "waiting cannot poll or send a queued mutation");
      assert.equal(output.at(-1).events.some(green), false, "retained cached green is not a new authorization");
      assert.equal(output.at(-1).events[0].type, "WATCH_CHUNK_TIMEOUT");
      const savedDue = surface === "ci"
        ? loadState(stateFileForRepo("fixture/repo", parseArgs(argv))).metrics.nextPollAtMs
        : loadPersistedPrSession("fixture/repo", dir).entries[1].watchState.nextPollAtMs;
      assert.equal(savedDue, due, "no-op chunks retain the original absolute ordinary due time");
    }
    assert.equal(time.now, due);
    await run(argv, services);
    assert.ok(calls > initialCalls, "a fresh successful poll is required at the actual due time");
    assert.ok(output.at(-1).events.some(green));
  });
}
