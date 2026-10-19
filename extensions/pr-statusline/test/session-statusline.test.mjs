import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { collect } from "../collector.mjs";
import { clearSessionStatusline, refreshSessionStatusline } from "../session-statusline.mjs";
import { readPrCache, writePrCache } from "../github.mjs";
import { SessionTracker, readState, refreshTrackedPrStatuses, syncSession, writeState } from "../tracker.mjs";
import { IssueTracker, readState as readIssues, syncSession as syncIssues, writeState as writeIssues } from "../../issue-statusline/tracker.mjs";
import { readIssueCache, writeIssueCache } from "../../issue-statusline/github.mjs";
import { readState as readAgents, SubagentTracker, syncSession as syncAgents, writeState as writeAgents } from "../../subagent-statusline/tracker.mjs";
import { checkoutDivergence, checkoutKey, readJson, sessionContexts, sessionDirectory, writeJson } from "../../worktree-statusline/tracker.mjs";
import { resolveLinkedCheckouts } from "../../worktree-statusline/worktrees.mjs";

const prUrl = (n) => `https://github.com/example/widget/pull/${n}`;
const issueUrl = (n) => `https://github.com/example/widget/issues/${n}`;
const event = (type, time, data = {}) => ({ type, timestamp: new Date(time).toISOString(), data });
async function fixture(run) {
	const home = realpathSync.native(mkdtempSync(join(tmpdir(), "session-statusline-")));
	try { await run(home); } finally { rmSync(home, { recursive: true, force: true }); }
}
function transcript(home, id, events) {
	const directory = join(home, "session-state", id);
	mkdirSync(directory, { recursive: true });
	const file = join(directory, "events.jsonl");
	writeFileSync(file, events.map(JSON.stringify).join("\n") + "\n");
	return file;
}
function seed(home, id) {
	const prs = new SessionTracker(id);
	prs.manage("add", prUrl(1));
	writeState(prs.snapshot(), home);
	const issues = new IssueTracker(id);
	issues.add(issueUrl(2));
	writeIssues(issues.snapshot(), home);
	const agents = new SubagentTracker(id);
	agents.observe(event("subagent.started", 1000, { agentId: "old-agent" }));
	writeAgents(agents.snapshot(), home);
}
function fakeGit(_binary, args) {
	const cwd = args[1];
	if (args[2] === "symbolic-ref") return { status: 0, stdout: "feature\n" };
	if (args[2] === "config") return { status: 1, stdout: "" };
	if (args[2] === "status") return { status: 0, stdout: "" };
	return { status: 0, stdout: `${cwd}\n${join(cwd, ".git")}\n${join(cwd, ".git")}\n` };
}
function mockGithub(t, replies) {
	const calls = [];
	t.mock.method(childProcess, "spawnSync", (binary, args) => {
		assert.equal(binary, "gh");
		const kind = args.some((arg) => arg.includes("query=") && arg.includes("pullRequest(")) ? "pullRequest" : "issue";
		const number = Number(args.find((arg) => /^number=/.test(arg))?.split("=")[1]);
		calls.push([kind, number]);
		return { status: 0, stdout: JSON.stringify({ data: { repository: { [kind]: replies(kind, number) } } }) };
	});
	syncBuiltinESMExports();
	t.after(() => {
		t.mock.restoreAll();
		syncBuiltinESMExports();
	});
	return calls;
}

test("clear is session-local and persists through transcript replay, stale writes and live collector saves; new activity returns", async () => fixture(async (home) => {
	const id = "current";
	const payload = { session_id: id, cwd: home };
	const history = [
		event("session.start", 1000, { repository: "example/widget", cwd: home }),
		event("user.message", 1100, { content: `Work on PR ${prUrl(1)} and issue ${issueUrl(2)}` }),
		event("subagent.started", 1200, { agentId: "old-agent" }),
		event("tool.execution_start", 1300, { toolCallId: "old-call", toolName: "bash", arguments: { command: "echo old", cwd: home } }),
	];
	const file = transcript(home, id, history);
	const workspace = join(home, "session-state", id, "workspace.yaml");
	writeFileSync(workspace, "repository: example/widget\nbranch: pr-1\nname: issue #2\n");
	utimesSync(workspace, new Date(1000), new Date(1000));
	seed(home, id);
	seed(home, "other");
	const other = ["pr-statusline", "issue-statusline", "subagent-statusline"].map((component) => {
		const path = join(home, component, "other.json");
		return [path, readFileSync(path, "utf8")];
	});
	const config = join(home, "statusline-config.json");
	writeFileSync(config, '{"version":1,"enabled":["pr-statusline"]}');
	const configBefore = readFileSync(config, "utf8");
	let handler;
	const collector = await collect({
		sessionId: id, on(fn) { handler = fn; return () => {}; },
		getEvents: async () => history,
		rpc: { metadata: { activity: async () => ({ hasActiveWork: false }) } },
	}, { home, interval: 100000 });
	try {
		syncIssues(payload, { home, fetchIssueStatus: false });
		syncAgents(payload, { home });
		const stale = [readState(id, home), readIssues(id, home), readAgents(id, home)];
		const beforeTranscript = readFileSync(file, "utf8");
		assert.match(clearSessionStatusline(payload, { home, now: 2000 }), /^Cleared/);
		writeState(stale[0], home);
		writeIssues(stale[1], home);
		writeAgents(stale[2], home);
		handler(event("session.idle", 2100));
		assert.deepEqual(readState(id, home).prs, []);
		assert.deepEqual(readIssues(id, home).issues, []);
		assert.deepEqual(readAgents(id, home).agents, {});
		assert.equal(readFileSync(file, "utf8"), beforeTranscript);
		assert.equal(readFileSync(config, "utf8"), configBefore);
		for (const [path, before] of other) assert.equal(readFileSync(path, "utf8"), before);
		assert.deepEqual(sessionContexts(payload, { home, run: fakeGit }).contexts, []);
		// Simulate transcript re-indexing/replacement without discarding the dismissal boundary.
		for (const [read, write] of [[readState, writeState], [readIssues, writeIssues], [readAgents, writeAgents]]) {
			write({ ...read(id, home), transcriptOffset: statSync(file).size + 1 }, home);
		}
		const worktreePath = join(home, "worktree-statusline", `${id}.json`);
		writeJson(worktreePath, { ...readJson(worktreePath), version: 2 });
		appendFileSync(workspace, "updated_at: now\n");
		assert.deepEqual(syncSession({ ...payload, remote: { repository: "example/widget", pull_request_number: 1 } }, {
			home, fetchPrStatus: false,
		}).state.prs, []);
		assert.deepEqual(syncIssues(payload, { home, fetchIssueStatus: false }).state.issues, []);
		assert.equal(readState(id, home).repository, "example/widget");
		assert.equal(readIssues(id, home).repository, "example/widget");
		assert.equal(syncAgents(payload, { home }).tracker.agents.size, 0);
		assert.deepEqual(sessionDirectory(payload, { home }).directories, []);
		const fresh = [
			event("user.message", 3000, { content: "Work on PR #1 and issue #2" }),
			event("subagent.started", 3100, { agentId: "new-agent" }),
			event("tool.execution_start", 3200, { toolCallId: "new-call", toolName: "bash", arguments: { command: "echo new" } }),
			event("tool.execution_complete", 3300, { toolCallId: "new-call", success: true }),
		];
		appendFileSync(file, fresh.map(JSON.stringify).join("\n") + "\n");
		for (const item of fresh) handler(item);
		assert.deepEqual(syncSession(payload, { home, fetchPrStatus: false }).state.prs.map((pr) => pr.url), [prUrl(1)]);
		assert.deepEqual(syncIssues(payload, { home, fetchIssueStatus: false }).state.issues.map((issue) => issue.url), [issueUrl(2)]);
		assert.deepEqual([...syncAgents(payload, { home }).tracker.agents.keys()], ["new-agent"]);
		assert.deepEqual(sessionDirectory(payload, { home }).directories, [home]);
	} finally { collector.stop(); }
}));

test("collector restart skips cleared SDK history, including old reopen commands, but accepts new work", async () => fixture(async (home) => {
	seed(home, "restart");
	clearSessionStatusline({ session_id: "restart", cwd: home }, { home, now: 2000 });
	let handler;
	const collector = await collect({
		sessionId: "restart", on(fn) { handler = fn; return () => {}; },
		getEvents: async () => [
			event("user.message", 1000, { content: `PR ${prUrl(1)}` }),
			event("tool.execution_start", 1100, { toolCallId: "reopen", toolName: "bash", arguments: { command: `gh pr reopen ${prUrl(1)}` } }),
			{ type: "user.message", data: { content: `PR ${prUrl(3)}` } },
		],
		rpc: { metadata: { activity: async () => ({ hasActiveWork: false }) } },
	}, { home, interval: 100000 });
	try {
		assert.deepEqual(readState("restart", home).prs, []);
		handler(event("user.message", 3000, { content: `PR ${prUrl(1)}` }));
		assert.equal(readState("restart", home).prs.length, 1);
	} finally { collector.stop(); }
}));

test("clear without a transcript suppresses payload directory fallback and remains repeatable", async () => fixture((home) => {
	const payload = { session_id: "empty", cwd: home };
	clearSessionStatusline(payload, { home, now: 1000 });
	clearSessionStatusline(payload, { home, now: 1000 });
	assert.deepEqual(sessionDirectory(payload, { home }).directories, []);
	assert.equal(sessionDirectory(payload, { home }).cwd, null);
	assert.equal(readState("empty", home).clearedAt, 1001);
}));

test("refresh bypasses per-item TTLs, shared caches and in-flight locks, preserves tracking and settings, and updates agent-only PRs", async (t) => fixture((home) => {
	const id = "refresh";
	seed(home, id);
	seed(home, "other");
	const prs = readState(id, home);
	Object.assign(prs.prs[0], { checkedAt: 9000, status: "cached", mergedAt: 500, mergedObservedAt: 600 });
	writeState(prs, home);
	const issues = readIssues(id, home);
	Object.assign(issues.issues[0], { checkedAt: 9000, status: "cached", closedAt: 500 });
	writeIssues(issues, home);
	const agents = new SubagentTracker(id, readAgents(id, home));
	agents.linkPr("old-agent", prUrl(3));
	writeAgents(agents.snapshot(), home);
	const cached = { checkedAt: 9000, ttlMs: 120000, refreshingUntil: 20000 };
	writePrCache({ [prUrl(1)]: { ...cached, info: { state: "MERGED" } }, [prUrl(3)]: { ...cached, info: { state: "OPEN" } }, unrelated: cached }, home);
	writeIssueCache({ [issueUrl(2)]: { ...cached, info: { state: "CLOSED" } }, unrelated: cached }, home);
	writeFileSync(join(home, "statusline-config.json"), '{"enabled":["pr-statusline"]}');
	const protectedPaths = [
		join(home, "statusline-config.json"),
		...["pr-statusline", "issue-statusline", "subagent-statusline"].map((component) => join(home, component, "other.json")),
	];
	const before = protectedPaths.map((path) => readFileSync(path, "utf8"));
	const calls = mockGithub(t, (kind, number) => kind === "issue"
		? { state: "OPEN", title: "Reopened issue" }
		: { state: number === 3 ? "MERGED" : "OPEN", title: "Fresh PR" });
	assert.match(refreshSessionStatusline({ session_id: id }, { home, now: 10000 }), /^Refreshed/);
	assert.deepEqual(calls, [["pullRequest", 1], ["pullRequest", 3], ["issue", 2]]);
	assert.equal(readState(id, home).prs.length, 1);
	assert.equal(readState(id, home).prs[0].title, "Fresh PR");
	assert.equal(readState(id, home).prs[0].mergedAt, undefined);
	assert.equal(readState(id, home).prs[0].checkedAt, 10000);
	assert.equal(readIssues(id, home).issues[0].closedAt, undefined);
	assert.equal(readIssues(id, home).issues[0].title, "Reopened issue");
	assert.deepEqual(readAgents(id, home).agents["old-agent"].mergedPrs, [prUrl(3)]);
	assert.equal(readPrCache(home)[prUrl(1)].refreshingUntil, 0);
	assert.equal(readIssueCache(home)[issueUrl(2)].refreshingUntil, 0);
	assert.deepEqual(readPrCache(home).unrelated, cached);
	assert.deepEqual(readIssueCache(home).unrelated, cached);
	protectedPaths.forEach((path, i) => assert.equal(readFileSync(path, "utf8"), before[i]));
}));

test("refresh reports partial failures explicitly and leaves failed items tracked with their prior observations", async () => fixture((home) => {
	seed(home, "failure");
	transcript(home, "failure", [event("session.start", 1000, { cwd: home })]);
	const result = refreshSessionStatusline({ session_id: "failure" }, {
		home, now: 2000, fetchPrStatus: () => { throw new Error("offline"); },
		fetchIssueStatus: () => null, run: () => { throw new Error("Git unavailable"); },
	});
	assert.match(result, /^Session statusline refresh incomplete:/);
	assert.match(result, /example\/widget#1: offline/);
	assert.match(result, /example\/widget#2: GitHub returned no status/);
	assert.match(result, /Worktrees: Git unavailable/);
	assert.equal(readState("failure", home).prs.length, 1);
	assert.equal(readState("failure", home).prs[0].checkedAt, 0);
	assert.equal(readIssues("failure", home).issues.length, 1);
}));

test("refresh does not remove tracked closed or missing items", async () => fixture((home) => {
	seed(home, "closed");
	assert.match(refreshSessionStatusline({ session_id: "closed" }, {
		home, fetchPrStatus: () => ({ state: "CLOSED" }),
		fetchIssueStatus: () => ({ state: "NOT_FOUND" }),
	}), /^Refreshed/);
	assert.equal(readState("closed", home).prs.length, 1);
	assert.equal(readState("closed", home).prs[0].status, "CLOSED");
	assert.equal(readIssues("closed", home).issues.length, 1);
	assert.equal(readIssues("closed", home).issues[0].status, "NOT_FOUND");
}));

test("normal refresh retains TTL behavior while forced refresh queries every tracked item", async () => fixture((home) => {
	const tracker = new SessionTracker("ttl");
	tracker.add(prUrl(1));
	let calls = 0;
	const fetchPrStatus = () => { calls++; return { state: "OPEN" }; };
	refreshTrackedPrStatuses(tracker, { home, now: 1000, fetchPrStatus });
	refreshTrackedPrStatuses(tracker, { home, now: 1001, fetchPrStatus });
	assert.equal(calls, 1);
	refreshTrackedPrStatuses(tracker, { home, now: 1002, fetchPrStatus, force: true });
	assert.equal(calls, 2);
}));

test("forced Git refresh reads all tracked directories instead of just the rotating cache budget", async () => fixture((home) => {
	const paths = Array.from({ length: 20 }, (_, i) => join(home, `checkout-${i}`));
	for (const path of paths) mkdirSync(path);
	transcript(home, "git", paths.map((cwd) => event("session.context_changed", 1000, { cwd })));
	const payload = { session_id: "git" };
	assert.equal(sessionContexts(payload, { home, run: fakeGit }).contexts.length, 16);
	let reads = 0;
	const run = (...args) => { reads++; return fakeGit(...args); };
	assert.equal(sessionContexts(payload, { home, run, force: true }).contexts.length, 20);
	assert.equal(reads, 80);
}));

test("forced linked-worktree refresh bypasses fresh inventories and surfaces Git errors", async () => fixture((home) => {
	const root = join(home, "repo");
	const linked = join(home, "linked");
	mkdirSync(root);
	mkdirSync(linked);
	const payload = { session_id: "linked" };
	const commonDir = checkoutKey(join(root, ".git"));
	const checkouts = [{ root, commonDir, branch: "main", remoteUrls: ["https://github.com/example/widget"], remainingGitDirectories: 4 }];
	const prs = [{ headRepositoryUrl: "https://github.com/example/widget", headRefName: "feature" }];
	let inventories = 0;
	const run = (binary, args) => {
		if (args[2] === "worktree") {
			inventories++;
			return { status: 0, stdout: `worktree ${linked}\0branch refs/heads/feature\0\0` };
		}
		if (args[2] === "config") return { status: 0, stdout: "remote.origin.url\nhttps://github.com/example/widget\0" };
		if (args[2] === "rev-parse") return { status: 0, stdout: `${linked}\n${commonDir}\n${join(commonDir, "worktrees", "linked")}\n` };
		return fakeGit(binary, args);
	};
	assert.equal(resolveLinkedCheckouts(payload, checkouts, prs, { home, now: 1000, run }).length, 1);
	resolveLinkedCheckouts(payload, checkouts, prs, { home, now: 1001, run });
	assert.equal(inventories, 1);
	assert.equal(resolveLinkedCheckouts(payload, checkouts, prs, { home, now: 1002, run, force: true }).length, 1);
	assert.equal(inventories, 2);
	assert.throws(() => resolveLinkedCheckouts(payload, checkouts, prs, {
		home, now: 1003, force: true, run: () => ({ status: 1, stderr: "cannot read inventory" }),
	}), /cannot read inventory/);
}));

test("forced divergence refresh reports graph-query failures instead of silently returning unknown counts", () => {
	const context = { root: "checkout", upstream: { remotes: ["."], merges: ["refs/heads/main"] } };
	const run = () => ({ status: 128, stderr: "missing local ref" });
	assert.equal(checkoutDivergence(context, [], { run }).upstream.behind, null);
	assert.throws(() => checkoutDivergence(context, [], { run, force: true }), /missing local ref/);
	assert.throws(() => checkoutDivergence(context, [], {
		run: () => ({ status: 0, stdout: "not counts" }), force: true,
	}), /Invalid Git divergence/);
});
