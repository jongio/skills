import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
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
