import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  defaultPrMaxWaitSec,
  evaluateMultiPrPollTick,
  evaluatePrPollTick,
  loadPersistedPrSession,
  parsePrWatchArgs,
  runCli as runPr,
  savePersistedPrSession,
} from "../scripts/pr-watch-daemon.mjs";
import {
  defaultMaxWaitSec,
  evaluateMultiRepoPollTick,
  evaluatePollTick,
  loadState,
  parseArgs,
  runCli as runCi,
  saveState,
  stateFileForRepo,
} from "../../ci-hound/scripts/ci-hound-daemon.mjs";

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

test("deadline-interrupted CI polls cannot emit cached green or an invented phase", (t) => {
  const time = clock(t);
  const args = parseArgs(["watch", "--repo", "fixture/repo"]);
  args.chunkDeadlineMs = time.now + 100;
  const state = loadState(path.join(fixture(t), "missing.json"));
  state.lastMainSha = "head";
  state.runs["1"] = { id: 1, head_sha: "head", head_branch: "main", event: "push",
    status: "completed", conclusion: "success", workflow_id: 1 };
  let calls = 0;
  const tick = evaluatePollTick(args, state, () => {
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

test("multi-repository rotation resumes later targets rather than starving them", (t) => {
  const dir = fixture(t);
  const time = clock(t);
  const args = parseArgs(["watch", "--repos", "fixture/one,fixture/two", "--config-file", path.join(dir, "config.json")]);
  args.chunkDeadlineMs = time.now + 100;
  const first = evaluateMultiRepoPollTick(args, {}, (ghArgs) => {
    assert.match(ghArgs[2], /fixture\/one/);
    time.advance(100);
    return json({ sha: "head" });
  });
  assert.equal(first.chunkTimedOut, true);
  assert.equal(loadState(path.join(dir, "_discovery.json")).metrics.nextRepo, "fixture/two");
  args.chunkDeadlineMs = time.now + 100;
  const second = evaluateMultiRepoPollTick(args, {}, (ghArgs) => {
    assert.match(ghArgs[2], /fixture\/two/);
    time.advance(100);
    return json({ sha: "head" });
  });
  assert.equal(second.chunkTimedOut, true);
});

test("owner discovery resumes interrupted pagination instead of throwing or restarting page one", (t) => {
  const dir = fixture(t);
  const time = clock(t);
  const args = parseArgs(["watch", "--owner", "@me", "--visibility", "private",
    "--config-file", path.join(dir, "config.json")]);
  args.chunkDeadlineMs = time.now + 100;
  const first = evaluateMultiRepoPollTick(args, {}, (ghArgs) => {
    assert.match(ghArgs[2], /page=1$/);
    time.advance(100);
    return json(Array.from({ length: 100 }, (_, i) => ({ full_name: `fixture/archived-${i}`, archived: true })));
  });
  assert.equal(first.chunkTimedOut, true);
  args.chunkDeadlineMs = time.now + 100;
  let calls = 0;
  const second = evaluateMultiRepoPollTick(args, {}, (ghArgs) => {
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

test("CI repository cooldown survives a terminal event from an earlier repository", (t) => {
  const dir = fixture(t);
  const time = clock(t);
  const args = parseArgs(["watch", "--repos", "fixture/one,fixture/two", "--wake-on-commit",
    "--config-file", path.join(dir, "config.json")]);
  const state = loadState(path.join(dir, "missing.json"));
  state.lastMainSha = "old";
  saveState(stateFileForRepo("fixture/one", args), state);
  const first = evaluateMultiRepoPollTick(args, {}, (ghArgs) =>
    ghArgs[2].includes("fixture/two") ? throttled() : ciExec(ghArgs));
  assert.ok(first.events.some((x) => x.type === "NEW_MAIN_COMMIT"));
  assert.equal(first.rateLimited, true);
  const second = evaluateMultiRepoPollTick(args, {}, () => assert.fail("shared cooldown must prevent requests"));
  assert.equal(second.rateLimited, true);
  assert.equal(second.nextIntervalSec, 900);
  assert.ok(loadState(path.join(dir, "_discovery.json")).metrics.repoCooldownUntilMs > time.now);
});

test("chunk expiry during automatic Copilot retries rotates cleanly without a terminal review error", (t) => {
  const time = clock(t);
  const args = parsePrWatchArgs(["watch", "--repo", "fixture/repo", "--pr", "1", "--head", "head"]);
  args.chunkDeadlineMs = time.now + 100;
  const review = { databaseId: 42, state: "COMMENTED", submittedAt: "2026-01-01T00:00:00Z",
    author: { login: "copilot" }, commit: { oid: "head" },
    body: "Copilot encountered an error and was unable to review this pull request" };
  let calls = 0;
  const tick = evaluateMultiPrPollTick(args, (ghArgs) => {
    calls += 1;
    if (calls === 4) return { ok: false, chunkTimedOut: true };
    if (ghArgs[1] === "graphql") return graph(prNode({ reviews: [review] }));
    return json({ workflow_runs: [], total_count: 0 });
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

test("review regression: completed owner inventory survives until repository polling resumes", (t) => {
  const dir = fixture(t);
  const time = clock(t);
  const args = parseArgs(["watch", "--owner", "@me", "--visibility", "private",
    "--config-file", path.join(dir, "config.json")]);
  args.chunkDeadlineMs = time.now + 200;
  const first = evaluateMultiRepoPollTick(args, {}, (ghArgs) => {
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
  evaluateMultiRepoPollTick(args, {}, (ghArgs) => {
    visited.push(ghArgs[2]);
    assert.match(ghArgs[2], /^repos\/fixture\/target\//, "completed discovery must not consume the next chunk again");
    return ciExec(ghArgs);
  });
  assert.ok(visited.some((endpoint) => endpoint.includes("/commits/")));
  const refreshed = [];
  evaluateMultiRepoPollTick(args, {}, (ghArgs) => {
    refreshed.push(ghArgs[2]);
    return json([]);
  });
  assert.match(refreshed[0], /^user\/repos.*page=1$/, "discovery refreshes after the logical repository sweep finishes");
});

test("review regression: an interrupted repository gets the next full chunk after a completed prefix", (t) => {
  const dir = fixture(t);
  const time = clock(t);
  const args = parseArgs(["watch", "--repos", "fixture/one,fixture/two",
    "--config-file", path.join(dir, "config.json")]);
  const execFn = (ghArgs) => {
    time.advance(40);
    return greenCiExec(ghArgs);
  };
  args.chunkDeadlineMs = time.now + 200;
  const first = evaluateMultiRepoPollTick(args, {}, execFn);
  assert.equal(first.chunkTimedOut, true);
  assert.ok(first.statuses.some((status) => status.repo === "fixture/one"));
  assert.equal(loadState(path.join(dir, "_discovery.json")).metrics.nextRepo, "fixture/two");
  args.chunkDeadlineMs = time.now + 200;
  const visited = [];
  const second = evaluateMultiRepoPollTick(args, {}, (ghArgs) => {
    visited.push(ghArgs[2]);
    return execFn(ghArgs);
  });
  assert.match(visited[0], /^repos\/fixture\/two\//);
  assert.ok(second.statuses.some((status) => status.repo === "fixture/two"));
});

test("review regression: logical repository sweeps retain completed green results across chunks", (t) => {
  const dir = fixture(t);
  const time = clock(t);
  const args = parseArgs(["watch", "--repos", "fixture/one,fixture/two",
    "--config-file", path.join(dir, "config.json")]);
  const execFn = (ghArgs) => {
    time.advance(40);
    return greenCiExec(ghArgs);
  };
  args.chunkDeadlineMs = time.now + 200;
  const first = evaluateMultiRepoPollTick(args, {}, execFn);
  assert.equal(first.chunkTimedOut, true);
  assert.equal(first.events.some((event) => event.type === "ALL_GREEN"), false);
  args.chunkDeadlineMs = time.now + 200;
  const second = evaluateMultiRepoPollTick(args, {}, execFn);
  assert.deepEqual(second.events.filter((event) => event.type === "ALL_GREEN").map((event) => event.repo).sort(),
    ["fixture/one", "fixture/two"]);
  args.chunkDeadlineMs = time.now + 200;
  const refreshed = [];
  const third = evaluateMultiRepoPollTick(args, {}, (ghArgs) => {
    refreshed.push(ghArgs[2]);
    return execFn(ghArgs);
  });
  assert.ok(refreshed.length > 0, "a completed logical sweep must not replay old green without polling");
  assert.equal(third.events.some((event) => event.type === "ALL_GREEN"), false);
});

test("logical sweep evidence fails closed when another poll changes its head or observation", (t) => {
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
    assert.equal(evaluateMultiRepoPollTick(args, {}, execFn).chunkTimedOut, true);
    const file = stateFileForRepo("fixture/one", args);
    const observed = loadState(file);
    if (change === "head") observed.lastMainSha = "new-head";
    else observed.metrics.lastPollAt = "2026-10-29T00:00:00Z";
    saveState(file, observed);
    args.chunkDeadlineMs = time.now + 200;
    const visited = [];
    const resumed = evaluateMultiRepoPollTick(args, {}, (ghArgs) => {
      visited.push(ghArgs[2]);
      return execFn(ghArgs);
    });
    assert.ok(visited.some((endpoint) => endpoint.includes("fixture/one/commits/")), change);
    assert.equal(resumed.events.some((event) => event.type === "ALL_GREEN"), false, change);
  }
});

test("diagnostic entrypoints poll fresh and changed watch scope cannot reuse a partial green sweep", (t) => {
  const dir = fixture(t);
  const time = clock(t);
  const args = parseArgs(["watch", "--repos", "fixture/one,fixture/two",
    "--config-file", path.join(dir, "config.json")]);
  const execFn = (ghArgs) => {
    time.advance(40);
    return greenCiExec(ghArgs);
  };
  args.chunkDeadlineMs = time.now + 200;
  assert.equal(evaluateMultiRepoPollTick(args, {}, execFn).chunkTimedOut, true);
  for (const mode of ["once", "status", "optimize"]) {
    const visited = [];
    evaluateMultiRepoPollTick({ ...args, mode, chunkDeadlineMs: undefined }, {}, (ghArgs) => {
      visited.push(ghArgs[2]);
      return execFn(ghArgs);
    });
    assert.ok(visited.some((endpoint) => endpoint.includes("fixture/one/commits/")), mode);
    assert.ok(visited.some((endpoint) => endpoint.includes("fixture/two/commits/")), mode);
  }
  const visited = [];
  const changed = evaluateMultiRepoPollTick({
    ...args, branch: "release", explicitBranch: true, chunkDeadlineMs: time.now + 500,
  }, {}, (ghArgs) => {
    visited.push(ghArgs[2]);
    return execFn(ghArgs);
  });
  assert.match(visited[0], /^repos\/fixture\/one\/commits\/release$/);
  assert.ok(visited.some((endpoint) => endpoint.includes("fixture/two/commits/release")));
  assert.equal(changed.events.some((event) => event.type === "ALL_GREEN"), false);
});

test("review regression: an interrupted PR gets the next full chunk after a completed prefix", (t) => {
  const time = clock(t);
  const args = parsePrWatchArgs(["watch", "--repo", "fixture/repo", "--prs", "1:head,2:head"]);
  const multiState = {};
  const execFn = (ghArgs) => {
    time.advance(40);
    return ghArgs[1] === "graphql" ? graph(prNode()) : json({ workflow_runs: [] });
  };
  args.chunkDeadlineMs = time.now + 120;
  const first = evaluateMultiPrPollTick(args, execFn, multiState);
  assert.equal(first.chunkTimedOut, true);
  assert.equal(first.statuses[0].pr, 1);
  assert.equal(first.nextPr, 2);
  args.nextPr = first.nextPr;
  args.chunkDeadlineMs = time.now + 120;
  const visited = [];
  const second = evaluateMultiPrPollTick(args, (ghArgs) => {
    visited.push(ghArgs);
    return execFn(ghArgs);
  }, multiState);
  assert.ok(visited[0].includes("pr=2"));
  assert.ok(second.statuses.some((status) => status.pr === 2));
});

test("review regression: CI cooldown restores saved snapshots without making API calls", (t) => {
  const dir = fixture(t);
  clock(t);
  const args = parseArgs(["watch", "--repos", "fixture/one,fixture/two",
    "--config-file", path.join(dir, "config.json")]);
  const first = evaluateMultiRepoPollTick(args, {}, (ghArgs) =>
    ghArgs[2].includes("fixture/two") ? throttled() : ciExec(ghArgs));
  assert.equal(first.rateLimited, true);
  assert.equal(first.statuses[0].repo, "fixture/one");
  const second = evaluateMultiRepoPollTick(args, {}, () => assert.fail("cooldown must not poll GitHub"));
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
