import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { refreshTracker } from "../../github-refresh.mjs";
import { statuslineGitHub } from "../../github-transport.mjs";
import { collect } from "../collector.mjs";
import { SessionTracker, readState, writeState } from "../tracker.mjs";
import { readPrCache, OCTICONS } from "../github.mjs";
import { clearSessionStatusline } from "../session-statusline.mjs";
import { IssueTracker, readState as readIssues, writeState as writeIssues, syncSession as syncIssues } from "../../issue-statusline/tracker.mjs";
import { reconcilePrStates } from "../lifecycle.mjs";

const refs = {
  pr: "https://github.com/acme/project/pull/1",
  issue: "https://github.com/acme/project/issues/2",
};
function fixture(t) {
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), "refresh-regression-")));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}
function seed(kind, home, id) {
  const tracker = kind === "pr" ? new SessionTracker(id) : new IssueTracker(id);
  tracker.manage("add", refs[kind]);
  (kind === "pr" ? writeState : writeIssues)(tracker.snapshot(), home);
  return tracker;
}
function mockGitHub(t, respond) {
  t.mock.method(statuslineGitHub, "cacheScope", async () => "fixture");
  t.mock.method(statuslineGitHub, "request", async (request) => {
    const kind = request.query.includes("pullRequests(") ? "branch" : request.query.includes("issue(number") ? "issue" : "pr";
    const info = await respond(kind);
    if (info instanceof Error) return { ok: false, status: 403, headers: {}, error: info.message };
    return { ok: true, status: 200, headers: {}, cacheScope: "fixture",
      data: { data: { repository: { [kind === "branch" ? "pullRequests" : kind === "pr" ? "pullRequest" : "issue"]:
        kind === "branch" ? { nodes: info } : info } } } };
  });
}
const session = (id) => ({
  sessionId: id, on: () => () => {}, getEvents: async () => [],
  rpc: { metadata: { activity: async () => ({ hasActiveWork: false }) } },
});

for (const kind of ["pr", "issue"]) {
  const read = kind === "pr" ? readState : readIssues;
  const write = kind === "pr" ? writeState : writeIssues;
  const Tracker = kind === "pr" ? SessionTracker : IssueTracker;
  const list = kind === "pr" ? "prs" : "issues";

  test(`${kind} cache hits preserve the original remote observation time`, async (t) => {
    const home = fixture(t), id = `${kind}-age`;
    seed(kind, home, id);
    let calls = 0;
    mockGitHub(t, () => { calls++; return { state: "OPEN", title: "Observed once" }; });
    await refreshTracker(kind, id, { home, now: 1000 });
    await refreshTracker(kind, id, { home, now: 2000 });
    assert.equal(calls, 1);
    assert.equal(read(id, home)[list][0].checkedAt, 1000);
  });

  test(`${kind} normal refresh persists dismissal intent across stale readers`, async (t) => {
    const home = fixture(t), id = `${kind}-dismiss`;
    const memory = seed(kind, home, id);
    const directory = join(home, "session-state", id);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "events.jsonl"), JSON.stringify({
      type: "user.message", timestamp: new Date(1000).toISOString(),
      data: { content: `Look at ${refs[kind]}` },
    }) + "\n");
    mockGitHub(t, () => kind === "pr" ? { state: "CLOSED" } : null);
    await refreshTracker(kind, id, { home, now: 2000 });
    const state = read(id, home);
    assert.deepEqual(state[list], []);
    assert.ok(state.ignored.includes(refs[kind]));
    if (kind === "pr") {
      reconcilePrStates(memory, state);
      write(memory.snapshot(), home);
      assert.deepEqual(read(id, home).prs, []);
    } else {
      assert.deepEqual(syncIssues({ session_id: id }, { home, now: 3000 }).state.issues, []);
    }
  });

  test(`${kind} explicit re-add wins over an older in-flight dismissal even with a fixed clock`, async (t) => {
    const home = fixture(t), id = `${kind}-readd`;
    t.mock.method(Date, "now", () => 1000);
    seed(kind, home, id);
    const entered = Promise.withResolvers(), finish = Promise.withResolvers();
    mockGitHub(t, async () => {
      entered.resolve();
      await finish.promise;
      return kind === "pr" ? { state: "CLOSED" } : null;
    });
    const refresh = refreshTracker(kind, id, { home, now: 2000 });
    await entered.promise;
    const current = new Tracker(id, read(id, home));
    current.manage("remove", refs[kind]);
    current.manage("add", refs[kind]);
    write(current.snapshot(), home);
    finish.resolve();
    await refresh;
    assert.deepEqual(read(id, home)[list].map((item) => item.url), [refs[kind]]);
    assert.ok(!read(id, home).ignored.includes(refs[kind]));
  });
}

test("optional branch discovery failure does not block known PRs and issues", async (t) => {
  const home = fixture(t), id = "discovery";
  seed("pr", home, id);
  seed("issue", home, id);
  const directory = join(home, "session-state", id);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "workspace.yaml"), "repository: inaccessible/workspace\nbranch: feature\n");
  mockGitHub(t, (kind) => kind === "branch" ? new Error("Branch discovery unavailable")
    : { state: "OPEN", title: kind === "pr" ? "Updated PR" : "Updated issue" });
  const reports = [];
  const collector = await collect(session(id), { home, report: (message) => reports.push(message) });
  t.after(() => collector.stop());
  await collector.initialPoll;
  assert.equal(readState(id, home).prs[0].title, "Updated PR");
  assert.equal(readIssues(id, home).issues[0].title, "Updated issue");
  assert.ok(reports.some((message) => /discovery/i.test(message)));
});

test("successful remote recovery clears a running collector's stale flag", async (t) => {
  const home = fixture(t), id = "recover";
  const tracker = seed("pr", home, id);
  Object.assign(tracker.state.prs[0], { checkedAt: 1000, stale: true, status: "Old observation" });
  writeState(tracker.snapshot(), home);
  mockGitHub(t, () => ({ state: "OPEN", title: "Recovered" }));
  const collector = await collect(session(id), { home });
  t.after(() => collector.stop());
  await collector.initialPoll;
  assert.equal(readState(id, home).prs[0].stale, false);
  assert.equal(collector.tracker.state.prs[0].stale, false);
});

test("issue state preserves an explicit stale flag through serialization", (t) => {
  const home = fixture(t), id = "issue-stale";
  const tracker = seed("issue", home, id);
  tracker.state.issues[0].stale = true;
  writeIssues(tracker.snapshot(), home);
  assert.equal(readIssues(id, home).issues[0].stale, true);
});

test("cached recovery clears stale state without requiring a newer observation timestamp", async (t) => {
  const home = fixture(t), id = "cached-recovery";
  seed("pr", home, id);
  let calls = 0, unavailable = false;
  mockGitHub(t, () => { calls++; return { state: "OPEN", title: "Snapshot" }; });
  t.mock.method(statuslineGitHub, "cacheScope", async () => {
    if (unavailable) throw new Error("Credential lookup temporarily unavailable");
    return "fixture";
  });
  await refreshTracker("pr", id, { home, now: 1000 });
  unavailable = true;
  await refreshTracker("pr", id, { home, now: 2000 });
  assert.equal(readState(id, home).prs[0].stale, true);
  unavailable = false;
  t.mock.method(Date, "now", () => 3000);
  const collector = await collect(session(id), { home });
  t.after(() => collector.stop());
  await collector.initialPoll;
  assert.equal(calls, 1, "the valid cached observation is reused");
  assert.equal(readState(id, home).prs[0].checkedAt, 1000);
  assert.equal(readState(id, home).prs[0].stale, false);
  assert.equal(collector.tracker.state.prs[0].stale, false);
});

for (const check of [
  { state: "PENDING", context: "commit-status" },
  { status: "WAITING", name: "waiting-check" },
  { status: "REQUESTED", name: "requested-check" },
  { missing: true },
]) {
  test(`running-check TTL follows the rendered classification: ${check.context || check.name || "missing required"}`, async (t) => {
    const home = fixture(t), id = "running-ttl";
    seed("pr", home, id);
    let calls = 0;
    mockGitHub(t, () => {
      calls++;
      return { state: "OPEN", commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: check.missing ? [] : [check] } } } }] },
        baseRef: { branchProtectionRule: { requiredStatusCheckContexts: check.missing ? ["required-check"] : [] } } };
    });
    await refreshTracker("pr", id, { home, now: 1000 });
    assert.ok(readState(id, home).prs[0].status.includes(OCTICONS.running));
    assert.equal(readPrCache(home)[refs.pr].ttlMs, 20000);
    await refreshTracker("pr", id, { home, now: 31000 });
    assert.equal(calls, 2, "a healthy collector refreshes the running observation before reusing an expired cache");
  });
}

test("local controls initialize while the first remote poll is blocked, and stop cancels it", async (t) => {
  const home = fixture(t), id = "slow-start";
  seed("pr", home, id);
  const entered = Promise.withResolvers(), finish = Promise.withResolvers();
  let requestSignal;
  t.mock.method(statuslineGitHub, "cacheScope", async () => "fixture");
  t.mock.method(statuslineGitHub, "request", async (_input, _host, { signal }) => {
    requestSignal = signal;
    entered.resolve();
    await finish.promise;
    return { ok: true, cacheScope: "fixture", data: { data: { repository: { pullRequest: { state: "OPEN" } } } } };
  });
  const started = collect(session(id), { home, report: () => {} });
  t.after(async () => { finish.resolve(); (await started).stop(); });
  await entered.promise;
  let deadline;
  const collector = await Promise.race([started, new Promise((_, reject) => {
    deadline = setTimeout(() => reject(new Error("collector still blocked on remote startup")), 250);
  })]).finally(() => clearTimeout(deadline));
  collector.manage("add", "https://github.com/acme/project/pull/3");
  clearSessionStatusline({ session_id: id }, { home });
  collector.stop();
  assert.equal(requestSignal.aborted, true);
  finish.resolve();
  await collector.initialPoll;
  assert.deepEqual(readState(id, home).prs, []);
});
