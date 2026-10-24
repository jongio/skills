import assert from "node:assert/strict";
import fs, { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { collect } from "../collector.mjs";
import { SessionTracker, readState, syncSession, writeState } from "../tracker.mjs";
import { IssueTracker, readState as readIssues, syncSession as syncIssues, writeState as writeIssues } from "../../issue-statusline/tracker.mjs";
import { SubagentTracker, readState as readAgents, syncSession as syncAgents, writeState as writeAgents } from "../../subagent-statusline/tracker.mjs";

const pr = "https://github.com/acme/app/pull/43";
const issue = "https://github.com/acme/app/issues/7";
const event = (type, time, data = {}, agentId) => ({ type, timestamp: new Date(time).toISOString(), data, agentId });
const start = (id, time, command, agentId) => event("tool.execution_start", time, {
	toolCallId: id, toolName: "powershell", arguments: { command },
}, agentId);
const complete = (id, time, content) => event("tool.execution_complete", time, { toolCallId: id, success: true, result: { content } });
const encode = (events) => events.map(JSON.stringify).join("\n") + "\n";
async function fixture(run) {
	const home = realpathSync.native(mkdtempSync(join(tmpdir(), "migration-replay-")));
	try { await run(home); } finally { rmSync(home, { recursive: true, force: true }); }
}
function transcript(home, id, content) {
	const directory = join(home, "session-state", id);
	mkdirSync(directory, { recursive: true });
	const file = join(directory, "events.jsonl");
	writeFileSync(file, content);
	return file;
}

for (const [name, Tracker, read, write, sync, reference, command, field] of [
	["PR", SessionTracker, readState, writeState, syncSession, pr, "gh pr reopen 43", "prs"],
	["issue", IssueTracker, readIssues, writeIssues, syncIssues, issue, "gh issue reopen 7", "issues"],
]) {
	for (const legacy of [true, false]) {
		test(`${name} ${legacy ? "legacy migration" : "re-indexing"} preserves dismissal of consumed reopen history but accepts new reopen work`, async () => fixture((home) => {
			const id = "dismissed";
			const old = encode([event("session.start", 500, { repository: "acme/app" }), start("old", 1000, command), complete("old", 1100, reference)]);
			const file = transcript(home, id, old);
			const tracker = new Tracker(id);
			tracker.manage("add", reference);
			tracker.manage("remove", reference);
			const state = tracker.snapshot();
			if (legacy) delete state.activeTrackingVersion;
			state.transcriptOffset = Buffer.byteLength(old) + (legacy ? 0 : 1);
			state.updatedAt = 1500;
			state.lastUserInputAt = 500;
			write(state, home);
			const options = { home, now: 2000, fetchPrStatus: false, fetchIssueStatus: false };
			assert.deepEqual(sync({ session_id: id }, options).state[field], []);
			assert.ok(read(id, home).ignored.includes(reference));
			appendFileSync(file, encode([start("new", 2500, command), complete("new", 2600, reference)]));
			assert.deepEqual(sync({ session_id: id }, { ...options, now: 3000 }).state[field].map((item) => item.url), [reference]);
			assert.ok(!read(id, home).ignored.includes(reference));
		}));
	}
}

test("collector migration preserves a dismissed selector-free reopen but still accepts a fresh live reopen", async () => fixture(async (home) => {
	const id = "collector-dismissal";
	const tracker = new SessionTracker(id);
	tracker.manage("add", pr);
	tracker.manage("remove", pr);
	const state = tracker.snapshot();
	delete state.activeTrackingVersion;
	state.updatedAt = 1500;
	state.lastUserInputAt = 500;
	writeState(state, home);
	let handler;
	const collector = await collect({
		sessionId: id, on(fn) { handler = fn; return () => {}; },
		getEvents: async () => [
			event("session.start", 500, { repository: "acme/app" }),
			start("old", 1000, "gh pr reopen"), complete("old", 1100, pr),
		],
		rpc: { metadata: { activity: async () => ({ hasActiveWork: false }) } },
	}, { home, interval: 100000 });
	try {
		assert.deepEqual(readState(id, home).prs, []);
		handler(start("new", 2500, "gh pr reopen"));
		handler(complete("new", 2600, pr));
		assert.deepEqual(readState(id, home).prs.map((item) => item.url), [pr]);
		assert.equal(readState(id, home).prs[0].generation, 1);
	} finally { collector.stop(); }
}));

for (const [name, Tracker, read, write, sync] of [
	["PR", SessionTracker, readState, writeState, syncSession],
	["issue", IssueTracker, readIssues, writeIssues, syncIssues],
	["agent", SubagentTracker, readAgents, writeAgents, syncAgents],
]) {
	test(`${name} migration replays middle-of-history work with bounded reads and split UTF-8 records`, async (t) => fixture((home) => {
		const id = "long-history";
		const padding = encode([event("assistant.message", 500, { content: "x".repeat(1024) })]);
		const header = encode([event("session.start", 500, { repository: "acme/app" })]);
		const prefix = padding.repeat(96);
		const middleStart = [
			start("root-work", 1000, "gh pr checkout 43"),
			start("issue-work", 1000, "gh issue develop 7"),
			event("subagent.started", 1000, { agentId: "worker", agentType: "general-purpose" }),
			start("agent-work", 1000, "gh pr checkout 44", "worker"),
		];
		const contentPrefix = JSON.stringify(complete("agent-work", 1100, "")).indexOf('"content":"') + '"content":"'.length;
		const contentOffset = Buffer.byteLength(header + prefix + encode(middleStart)) + contentPrefix;
		const beforeGlyph = (1024 * 1024 - contentOffset % (1024 * 1024) - 1 + 1024 * 1024) % (1024 * 1024);
		const wideContent = "x".repeat(beforeGlyph) + "\u{1F4AC}" + "y".repeat(1024 * 1024 + 1);
		assert.equal((contentOffset + beforeGlyph) % (1024 * 1024), 1024 * 1024 - 1);
		const middle = encode([
			...middleStart,
			complete("agent-work", 1100, wideContent),
			complete("root-work", 1100, "Switched branch"),
			complete("issue-work", 1100, "Developed issue"),
		]);
		const suffix = padding.repeat(16400);
		assert.ok(Buffer.byteLength(header + prefix) > 64 * 1024);
		assert.ok(Buffer.byteLength(suffix) > 16 * 1024 * 1024);
		const file = transcript(home, id, header + prefix + middle + suffix);
		const size = statSync(file).size;
		const tracker = new Tracker(id);
		if (name === "PR") {
			for (const number of [43, 44, 99]) tracker.add(`acme/app#${number}`);
		} else if (name === "issue") {
			for (const number of [7, 99]) tracker.add(`acme/app#${number}`);
		} else {
			tracker.ensureAgent("worker", { agentType: "general-purpose" });
			tracker.linkPr("worker", "https://github.com/acme/app/pull/44");
			tracker.linkPr("worker", "https://github.com/acme/app/pull/99");
		}
		const previous = tracker.snapshot();
		delete previous.activeTrackingVersion;
		for (const entry of [...(previous.prs ?? []), ...(previous.issues ?? [])]) delete entry.active;
		previous.transcriptOffset = size;
		previous.updatedAt = 1500;
		write(previous, home);
		const reads = [];
		const original = fs.readSync;
		const observe = Tracker.prototype.observe;
		let observedContent;
		t.mock.method(Tracker.prototype, "observe", function (event, ...args) {
			if (event.type === "tool.execution_complete" && event.data.toolCallId === "agent-work") observedContent = event.data.result.content;
			return observe.call(this, event, ...args);
		});
		t.mock.method(fs, "readSync", (fd, buffer, offset, length, position) => {
			if (fs.fstatSync(fd).size === size) reads.push({ length, position });
			return original(fd, buffer, offset, length, position);
		});
		syncBuiltinESMExports();
		t.after(() => {
			t.mock.restoreAll();
			syncBuiltinESMExports();
		});
		sync({ session_id: id }, { home, now: 2000, fetchPrStatus: false, fetchIssueStatus: false });
		const current = read(id, home);
		if (name === "PR") assert.deepEqual(current.prs.map((item) => item.url), [pr, "https://github.com/acme/app/pull/44"]);
		else if (name === "issue") assert.deepEqual(current.issues.map((item) => item.url), [issue]);
		else assert.deepEqual(current.agents.worker.prs, ["https://github.com/acme/app/pull/44"]);
		assert.equal(current.activeTrackingVersion, 1);
		assert.equal(current.transcriptOffset, size);
		assert.ok(observedContent === wideContent, "a record spanning chunks must preserve its exact UTF-8 contents");
		assert.deepEqual(current.calls ?? current.agentToolCalls, {});
		assert.ok(reads.length > 3);
		assert.ok(reads.every((entry) => entry.length <= 1024 * 1024), "migration must not allocate a transcript-sized read");
		assert.equal(reads.reduce((sum, entry) => sum + entry.length, 0), size);
		for (let index = 1; index < reads.length; index++) {
			assert.equal(reads[index].position, reads[index - 1].position + reads[index - 1].length);
		}
	}));
}
