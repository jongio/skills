import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
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

test("a running collector retains context discovered by clear before saving or tracking new shorthand references", async () => fixture(async (home) => {
	const id = "collector-context";
	const payload = { session_id: id, cwd: home };
	const file = transcript(home, id, [
		event("session.start", 1000, { cwd: home }),
		event("user.message", 1100, { content: prUrl(1) }),
	]);
	let handler;
	const collector = await collect({
		sessionId: id, on(fn) { handler = fn; return () => {}; },
		getEvents: async () => [],
		rpc: { metadata: { activity: async () => ({ hasActiveWork: false }) } },
	}, { home, interval: 100000 });
	try {
		assert.equal(collector.tracker.repository, null);
		writeFileSync(join(home, "session-state", id, "workspace.yaml"), "repository: example/widget\n");
		clearSessionStatusline(payload, { home, now: 2000 });
		const retained = readState(id, home);
		assert.equal(retained.repository, "example/widget");
		assert.equal(retained.lastUserInputAt, 1100);
		assert.deepEqual(retained.userRepos, ["example/widget"]);
		writeState({ ...retained, host: "github.enterprise.test" }, home);
		handler(event("session.idle", 2100));
		const saved = readState(id, home);
		assert.equal(saved.repository, retained.repository);
		assert.equal(saved.host, "github.enterprise.test");
		assert.equal(saved.lastUserInputAt, retained.lastUserInputAt);
		assert.deepEqual(saved.userRepos, retained.userRepos);
		const fresh = event("user.message", 3000, { content: "Work on PR #42" });
		appendFileSync(file, JSON.stringify(fresh) + "\n");
		handler(fresh);
		assert.deepEqual(readState(id, home).prs.map((pr) => pr.url), ["https://github.enterprise.test/example/widget/pull/42"]);
	} finally { collector.stop(); }
}));

for (const activity of ["context", "shell"]) {
	test(`post-clear subagent ${activity} activity does not expose the retained root checkout before new successful root work`, async () => fixture((home) => {
		const id = `agent-${activity}`;
		const payload = { session_id: id, cwd: home };
		const agentDirectory = join(home, "agent-checkout");
		mkdirSync(agentDirectory);
		const file = transcript(home, id, [event("session.start", 1000, { cwd: home })]);
		clearSessionStatusline(payload, { home, now: 2000 });
		const agentEvents = activity === "context"
			? [event("session.context_changed", 3000, { cwd: agentDirectory })]
			: [
				event("tool.execution_start", 3000, { toolCallId: "agent-work", toolName: "bash", arguments: { command: "git status", cwd: agentDirectory } }),
				event("tool.execution_complete", 3100, { toolCallId: "agent-work", success: true }),
			];
		appendFileSync(file, agentEvents.map((item) => JSON.stringify({ ...item, agentId: "child" })).join("\n") + "\n");
		let location = sessionDirectory(payload, { home });
		assert.equal(location.cwd, null);
		assert.deepEqual(location.directories, [agentDirectory]);
		assert.deepEqual(sessionContexts(payload, { home, run: fakeGit }).contexts.map((context) => context.root), [agentDirectory]);
		appendFileSync(file, [
			event("tool.execution_start", 3200, { toolCallId: "failed-root", toolName: "bash", arguments: { command: "git status" } }),
			event("tool.execution_complete", 3300, { toolCallId: "failed-root", success: false }),
		].map(JSON.stringify).join("\n") + "\n");
		assert.equal(sessionDirectory(payload, { home }).cwd, null);
		appendFileSync(file, JSON.stringify(event("tool.execution_start", 3400, {
			toolCallId: "root-work", toolName: "bash", arguments: { command: "git status" },
		})) + "\n");
		assert.equal(sessionDirectory(payload, { home }).cwd, null);
		appendFileSync(file, JSON.stringify(event("tool.execution_complete", 3500, { toolCallId: "root-work", success: true })) + "\n");
		location = sessionDirectory(payload, { home });
		assert.equal(location.cwd, home);
		assert.deepEqual(location.directories, [agentDirectory, home]);
	}));
}

for (const reindexed of [false, true]) {
	test(`clear preserves hidden agent directory context for new relative commands${reindexed ? " after cache re-indexing" : ""}`, async () => fixture((home) => {
		const id = "relative-agent";
		const payload = { session_id: id, cwd: home };
		const first = join(home, "first"), second = join(home, "second");
		mkdirSync(first);
		mkdirSync(second);
		const file = transcript(home, id, [
			event("session.start", 1000, { cwd: home }),
			{ ...event("session.context_changed", 1100, { cwd: first }), agentId: "child" },
		]);
		clearSessionStatusline(payload, { home, now: 2000 });
		const cache = join(home, "worktree-statusline", `${id}.json`);
		if (reindexed) writeJson(cache, { ...readJson(cache), version: 2 });
		let location = sessionDirectory(payload, { home });
		assert.equal(location.cwd, null);
		assert.deepEqual(location.directories, []);
		assert.equal(location.agentCwds.child?.cwd, first);
		appendFileSync(file, [
			event("tool.execution_start", 3000, { toolCallId: "relative", toolName: "bash", arguments: { command: "cd ../second" } }),
			event("tool.execution_complete", 3100, { toolCallId: "relative", success: true }),
		].map((item) => JSON.stringify({ ...item, agentId: "child" })).join("\n") + "\n");
		location = sessionDirectory(payload, { home });
		assert.equal(location.cwd, null);
		assert.deepEqual(location.directories, [second]);
		assert.equal(location.agentCwds.child.cwd, second);
	}));
}

for (const agentId of [null, "child"]) {
	test(`re-indexing after post-clear relative ${agentId ? "agent" : "root"} work starts from the clear-time directory baseline`, async () => fixture((home) => {
		const id = "relative-replay";
		const payload = { session_id: id, cwd: home };
		const agentDirectory = join(home, "agent");
		const file = transcript(home, id, [
			event("session.start", 1000, { cwd: home }),
			{ ...event("session.context_changed", 1100, { cwd: agentDirectory }), agentId: "child" },
		]);
		clearSessionStatusline(payload, { home, now: 2000 });
		appendFileSync(file, [
			event("tool.execution_start", 3000, { toolCallId: "relative", toolName: "bash", arguments: { command: "cd nested" } }),
			event("tool.execution_complete", 3100, { toolCallId: "relative", success: true }),
		].map((item) => JSON.stringify({ ...item, ...(agentId ? { agentId } : {}) })).join("\n") + "\n");
		const before = sessionDirectory(payload, { home });
		const expected = join(agentId ? agentDirectory : home, "nested");
		assert.deepEqual(before.directories, [expected]);
		assert.equal(agentId ? before.agentCwds.child.cwd : before.cwd, expected);
		const replacement = `${file}.replacement`;
		writeFileSync(replacement, readFileSync(file));
		renameSync(replacement, file);
		assert.deepEqual(sessionDirectory(payload, { home }), before);
	}));
}

test("clear reports incomplete worktree replay instead of skipping unread root and agent directory context", async () => fixture((home) => {
	const id = "large-clear";
	const payload = { session_id: id, cwd: home };
	const latestRoot = join(home, "latest-root"), latestAgent = join(home, "latest-agent");
	const file = transcript(home, id, [
		event("session.start", 1000, { cwd: home }),
		{ ...event("session.context_changed", 1100, { cwd: join(home, "old-agent") }), agentId: "child" },
	]);
	appendFileSync(file, (JSON.stringify(event("assistant.message", 1150, { content: "x".repeat(1000) })) + "\n").repeat(5000));
	appendFileSync(file, [
		event("session.context_changed", 1200, { cwd: latestRoot }),
		{ ...event("session.context_changed", 1300, { cwd: latestAgent }), agentId: "child" },
	].map(JSON.stringify).join("\n") + "\n");
	assert.throws(() => clearSessionStatusline(payload, { home, now: 2000 }), /history is still catching up/);
	for (const read of [readState, readIssues, readAgents]) assert.equal(read(id, home).clearedAt, 0);
	assert.equal(readJson(join(home, "worktree-statusline", `${id}.json`)).clearedAt, 0);
	assert.match(clearSessionStatusline(payload, { home, now: 2000 }), /^Cleared/);
	appendFileSync(file, [
		event("tool.execution_start", 3000, { toolCallId: "root", toolName: "bash", arguments: { command: "cd root-child" } }),
		event("tool.execution_complete", 3100, { toolCallId: "root", success: true }),
		{ ...event("tool.execution_start", 3200, { toolCallId: "agent", toolName: "bash", arguments: { command: "cd agent-child" } }), agentId: "child" },
		{ ...event("tool.execution_complete", 3300, { toolCallId: "agent", success: true }), agentId: "child" },
	].map(JSON.stringify).join("\n") + "\n");
	const location = sessionDirectory(payload, { home });
	assert.equal(location.cwd, join(latestRoot, "root-child"));
	assert.equal(location.agentCwds.child.cwd, join(latestAgent, "agent-child"));
	assert.deepEqual(location.directories, [join(latestRoot, "root-child"), join(latestAgent, "agent-child")]);
}));

test("clear waits for a complete transcript record before capturing its directory baseline", async () => fixture((home) => {
	const id = "partial-clear";
	const payload = { session_id: id, cwd: home };
	const latest = join(home, "latest");
	const file = transcript(home, id, [event("session.start", 1000, { cwd: home })]);
	appendFileSync(file, JSON.stringify(event("session.context_changed", 1200, { cwd: latest })));
	assert.throws(() => clearSessionStatusline(payload, { home, now: 2000 }), /history is still catching up/);
	assert.equal(readState(id, home).clearedAt, 0);
	appendFileSync(file, "\n");
	assert.match(clearSessionStatusline(payload, { home, now: 2000 }), /^Cleared/);
	assert.equal(readJson(join(home, "worktree-statusline", `${id}.json`)).clearedContext.cwd, latest);
}));

for (const agentId of [null, "child"]) {
	test(`clear rejects a partial ${agentId ? "agent" : "root"} directory record appended during component synchronization`, async (t) => fixture((home) => {
		const id = "append-during-clear";
		const payload = { session_id: id, cwd: home };
		const latest = join(home, "latest");
		const file = transcript(home, id, [
			event("session.start", 1000, { cwd: home }),
			{ ...event("session.context_changed", 1100, { cwd: join(home, "agent") }), agentId: "child" },
		]);
		const component = agentId ? "issue-statusline" : "pr-statusline";
		const stateFile = join(home, component, `${id}.json`);
		const rename = fs.renameSync;
		let appended = false;
		t.mock.method(fs, "renameSync", (from, to) => {
			rename(from, to);
			if (to === stateFile && !appended) {
				appendFileSync(file, JSON.stringify({
					...event("session.context_changed", 1500, { cwd: latest }), ...(agentId ? { agentId } : {}),
				}));
				appended = true;
			}
		});
		syncBuiltinESMExports();
		t.after(() => {
			t.mock.restoreAll();
			syncBuiltinESMExports();
		});
		assert.throws(() => clearSessionStatusline(payload, { home, now: 2000 }), /history is still catching up/);
		assert.equal(appended, true);
		for (const read of [readState, readIssues, readAgents]) assert.equal(read(id, home).clearedAt, 0);
		assert.equal(readJson(join(home, "worktree-statusline", `${id}.json`)).clearedAt, 0);
		appendFileSync(file, "\n");
		assert.match(clearSessionStatusline(payload, { home, now: 2000 }), /^Cleared/);
		appendFileSync(file, [
			event("tool.execution_start", 3000, { toolCallId: "relative", toolName: "bash", arguments: { command: "cd nested" } }),
			event("tool.execution_complete", 3100, { toolCallId: "relative", success: true }),
		].map((item) => JSON.stringify({ ...item, ...(agentId ? { agentId } : {}) })).join("\n") + "\n");
		const location = sessionDirectory(payload, { home });
		assert.equal(agentId ? location.agentCwds.child.cwd : location.cwd, join(latest, "nested"));
		assert.deepEqual(location.directories, [join(latest, "nested")]);
	}));
}

test("clear rejects a transcript replaced after replay and before dismissal", async (t) => fixture((home) => {
	const id = "replace-during-clear";
	const payload = { session_id: id, cwd: home };
	const file = transcript(home, id, [event("session.start", 1000, { cwd: home })]);
	const cache = join(home, "worktree-statusline", `${id}.json`);
	const rename = fs.renameSync;
	let replaced = false;
	t.mock.method(fs, "renameSync", (from, to) => {
		rename(from, to);
		if (to === cache && !replaced) {
			const replacement = `${file}.replacement`;
			writeFileSync(replacement, readFileSync(file));
			rename(replacement, file);
			replaced = true;
		}
	});
	syncBuiltinESMExports();
	t.after(() => {
		t.mock.restoreAll();
		syncBuiltinESMExports();
	});
	assert.throws(() => clearSessionStatusline(payload, { home, now: 2000 }), /history is still catching up/);
	assert.equal(replaced, true);
	for (const read of [readState, readIssues, readAgents]) assert.equal(read(id, home).clearedAt, 0);
	assert.equal(readJson(cache).clearedAt, 0);
	assert.match(clearSessionStatusline(payload, { home, now: 2000 }), /^Cleared/);
	assert.equal(readJson(cache).clearedContext.cwd, home);
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

test("default GitHub issue refresh reports a fetch failure and releases its shared-cache lock", async (t) => fixture((home) => {
	seed(home, "default-failure");
	mockGithub(t, (kind) => {
		if (kind === "issue") throw new Error("GitHub unavailable");
		return { state: "OPEN" };
	});
	const result = refreshSessionStatusline({ session_id: "default-failure" }, { home, now: 2000 });
	assert.match(result, /^Session statusline refresh incomplete:/);
	assert.match(result, /example\/widget#2: GitHub unavailable/);
	assert.equal(readIssues("default-failure", home).issues.length, 1);
	assert.equal(readIssues("default-failure", home).issues[0].checkedAt, undefined);
	assert.equal(readIssueCache(home)[issueUrl(2)].refreshingUntil, 0);
}));

test("refresh merges observations into current PR, issue and agent state without erasing interleaved tracking changes", async (t) => fixture((home) => {
	const id = "interleaved";
	seed(home, id);
	const initialPrs = new SessionTracker(id, readState(id, home));
	initialPrs.add(prUrl(4));
	writeState(initialPrs.snapshot(), home);
	const initialIssues = new IssueTracker(id, readIssues(id, home));
	initialIssues.add(issueUrl(5));
	writeIssues(initialIssues.snapshot(), home);
	const initialAgents = new SubagentTracker(id, readAgents(id, home));
	initialAgents.linkPr("old-agent", prUrl(1));
	initialAgents.ensureAgent("settled-agent");
	initialAgents.linkPr("settled-agent", prUrl(4));
	writeAgents(initialAgents.snapshot(), home);
	const calls = mockGithub(t, (kind, number) => {
		if (kind === "pullRequest" && number === 1) {
			const prs = new SessionTracker(id, readState(id, home));
			prs.manage("remove", prUrl(1));
			prs.add(prUrl(9));
			Object.assign(prs.state.prs.find((pr) => pr.url === prUrl(4)), {
				status: "newer merged status", checkedAt: 5000, mergedAt: 5000, mergedObservedAt: 5000,
			});
			prs.state.transcriptOffset = 999;
			prs.calls.set("new-pr-call", { command: "new work" });
			writeState(prs.snapshot(), home);
			const issues = new IssueTracker(id, readIssues(id, home));
			issues.manage("remove", issueUrl(2));
			issues.add(issueUrl(9));
			Object.assign(issues.state.issues.find((issue) => issue.url === issueUrl(5)), {
				status: "newer closed status", checkedAt: 5000, closedAt: 5000,
			});
			issues.state.transcriptOffset = 999;
			issues.calls.set("new-issue-call", { command: "new work" });
			writeIssues(issues.snapshot(), home);
			const agents = new SubagentTracker(id, readAgents(id, home));
			agents.agents.delete("old-agent");
			agents.ensureAgent("new-agent");
			agents.agents.get("settled-agent").status = "failed";
			agents.transcriptOffset = 999;
			agents.taskCalls.set("new-task-call", "new-agent");
			writeAgents(agents.snapshot(), home);
		}
		return { state: "OPEN", title: "older observation" };
	});
	assert.match(refreshSessionStatusline({ session_id: id }, { home, now: 2000 }), /^Refreshed/);
	assert.ok(calls.length >= 4);
	const prs = readState(id, home);
	assert.deepEqual(prs.prs.map((pr) => pr.url), [prUrl(4), prUrl(9)]);
	assert.ok(prs.ignored.includes(prUrl(1)));
	assert.equal(prs.prs[0].mergedAt, 5000);
	assert.equal(prs.prs[0].status, "newer merged status");
	assert.equal(prs.transcriptOffset, 999);
	assert.ok(prs.calls["new-pr-call"]);
	const issues = readIssues(id, home);
	assert.deepEqual(issues.issues.map((issue) => issue.url), [issueUrl(5), issueUrl(9)]);
	assert.ok(issues.ignored.includes(issueUrl(2)));
	assert.equal(issues.issues[0].closedAt, 5000);
	assert.equal(issues.issues[0].status, "newer closed status");
	assert.equal(issues.transcriptOffset, 999);
	assert.ok(issues.calls["new-issue-call"]);
	const agents = readAgents(id, home);
	assert.deepEqual(Object.keys(agents.agents), ["settled-agent", "new-agent"]);
	assert.equal(agents.agents["settled-agent"].status, "failed");
	assert.equal(agents.transcriptOffset, 999);
	assert.equal(agents.taskCalls["new-task-call"], "new-agent");
}));

test("refresh does not apply settlement observations based on stale agent PR membership", async (t) => fixture((home) => {
	const id = "interleaved-link";
	seed(home, id);
	const initial = new SubagentTracker(id, readAgents(id, home));
	initial.linkPr("old-agent", prUrl(1));
	initial.agents.get("old-agent").status = "completed";
	writeAgents(initial.snapshot(), home);
	mockGithub(t, (kind, number) => {
		if (kind === "pullRequest" && number === 1) {
			const latest = new SubagentTracker(id, readAgents(id, home));
			latest.linkPr("old-agent", prUrl(4));
			writeAgents(latest.snapshot(), home);
			return { state: "MERGED", mergedAt: new Date(1500).toISOString() };
		}
		return { state: "OPEN" };
	});
	assert.match(refreshSessionStatusline({ session_id: id }, { home, now: 2000 }), /^Refreshed/);
	const latest = new SubagentTracker(id, readAgents(id, home));
	const agent = latest.agents.get("old-agent");
	assert.deepEqual(agent.prs, [prUrl(1), prUrl(4)]);
	assert.equal(agent.settlementObservedAt, undefined);
	latest.observe(event("user.message", 3000, { content: "continue working" }));
	assert.equal(agent.settlementDismissed, undefined);
	assert.equal(latest.counts().inPr, 1);
}));

test("a clear during remote refresh remains authoritative for every component", async () => fixture((home) => {
	const id = "clear-during-refresh";
	seed(home, id);
	assert.match(refreshSessionStatusline({ session_id: id }, {
		home, now: 1000,
		fetchPrStatus: () => {
			clearSessionStatusline({ session_id: id }, { home, now: 2000 });
			return { state: "OPEN" };
		},
		fetchIssueStatus: () => ({ state: "OPEN" }),
	}), /^Refreshed/);
	assert.deepEqual(readState(id, home).prs, []);
	assert.deepEqual(readIssues(id, home).issues, []);
	assert.deepEqual(readAgents(id, home).agents, {});
	for (const read of [readState, readIssues, readAgents]) assert.equal(read(id, home).clearedAt, 2000);
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
