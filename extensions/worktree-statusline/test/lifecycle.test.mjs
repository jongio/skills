import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { collect } from "../../pr-statusline/collector.mjs";
import { SessionTracker, readState, syncSession, writeState } from "../../pr-statusline/tracker.mjs";
import { reconcilePrStates } from "../../pr-statusline/lifecycle.mjs";
import { render as renderPr } from "../../pr-statusline/render.mjs";
import { atomicWriteJson, OCTICONS, PR_CLOSED_TTL_MS } from "../../pr-statusline/github.mjs";
import { SubagentTracker, writeState as writeAgents } from "../../subagent-statusline/tracker.mjs";
import { composeStatusLine } from "../compose.mjs";
import { configureStatuslines } from "../../../scripts/setup-statusline.mjs";

const url = (number) => `https://github.com/example/widget/pull/${number}`;
const event = (type, time, data = {}, agentId) => ({ type, timestamp: new Date(time).toISOString(), data, agentId });
const plain = { color: false, links: false, nerdFont: false };
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
async function fixture(run) {
	const home = mkdtempSync(join(tmpdir(), "merged-lifecycle-"));
	try { await run(home); } finally { rmSync(home, { recursive: true, force: true }); }
}
function transcript(home, id, events) {
	const directory = join(home, "session-state", id);
	mkdirSync(directory, { recursive: true });
	const path = join(directory, "events.jsonl");
	writeFileSync(path, events.map(JSON.stringify).join("\n") + "\n");
	return path;
}
const cache = (home, entries, now) => atomicWriteJson(join(home, "pr-statusline", "pr-cache.json"),
	Object.fromEntries(entries.map(([number, info]) => [url(number), { info, checkedAt: now, ttlMs: PR_CLOSED_TTL_MS }])));

test("merge detection, not remote merge time or checkedAt, defines dismissal; shared cache polls cannot resurrect", async () => fixture((home) => {
	const id = "stable";
	const file = transcript(home, id, [event("user.message", 1000, { content: "Continue" })]);
	const tracker = new SessionTracker(id);
	tracker.add(url(1));
	tracker.add(url(2));
	tracker.lastUserInputAt = 1000;
	tracker.state.transcriptOffset = statSync(file).size;
	writeState(tracker.snapshot(), home);
	const merged = { state: "MERGED", mergedAt: new Date(500).toISOString() };
	cache(home, [[1, merged], [2, { state: "OPEN" }]], 2000);
	const payload = { session_id: id };
	let output = renderPr(payload, { home, now: 2000, ...plain });
	assert.ok(output.includes("widget#1") && output.includes("Merged"), output);
	assert.equal(readState(id, home).prs[0].mergedObservedAt, 2000);
	assert.equal(readState(id, home).prs[0].mergedAt, 500);
	for (const now of [3000, 4000]) {
		cache(home, [[1, merged], [2, { state: "OPEN" }]], now);
		output = renderPr(payload, { home, now, ...plain });
		assert.ok(output.includes("widget#1") && output.includes("widget#2"), output);
		assert.equal(readState(id, home).prs[0].mergedObservedAt, 2000);
	}
	for (const message of [
		event("user.message", 4500, { content: "[Scheduled prompt #1] check" }),
		event("user.message", 4600, { content: "agent input" }, "child"),
		event("user.message", 1500, { content: "Older input" }),
	]) appendFileSync(file, JSON.stringify(message) + "\n");
	assert.ok(renderPr(payload, { home, now: 5000, ...plain }).includes("widget#1"));
	appendFileSync(file, JSON.stringify(event("user.message", 6000, { content: "Next task" })) + "\n");
	output = renderPr(payload, { home, now: 7000, ...plain });
	assert.ok(!output.includes("widget#1") && output.includes("widget#2"), output);
	for (const now of [8000, 9000]) {
		cache(home, [[1, merged], [2, { state: "OPEN" }]], now);
		assert.ok(!renderPr(payload, { home, now, ...plain }).includes("widget#1"));
		assert.ok(readState(id, home).ignored.includes(url(1)));
	}
	const restored = new SessionTracker(id, readState(id, home));
	restored.manage("add", url(1));
	writeState(restored.snapshot(), home);
	assert.ok(renderPr(payload, { home, now: 10000, fetchPrStatus: () => ({ state: "OPEN" }), ...plain }).includes("widget#1"));
	assert.equal(readState(id, home).prs.find((pr) => pr.url === url(1)).generation, 1);
}));

test("legacy merged caches receive one conservative fresh observation boundary without using checkedAt", async () => fixture((home) => {
	const tracker = new SessionTracker("legacy");
	tracker.add(url(1));
	Object.assign(tracker.state.prs[0], { mergedAt: 10, checkedAt: 9000, status: `${OCTICONS.merged} Merged` });
	tracker.lastUserInputAt = 500;
	writeState(tracker.snapshot(), home);
	let result = syncSession({ session_id: "legacy" }, { home, now: 1000, fetchPrStatus: false });
	assert.equal(result.state.prs[0].mergedObservedAt, 1000);
	assert.equal(result.state.prs[0].checkedAt, 9000);
	const current = new SessionTracker("legacy", result.state);
	current.observe(event("user.message", 750));
	assert.equal(current.state.prs.length, 1);
	current.observe(event("user.message", 1001));
	assert.equal(current.state.prs.length, 0);
	writeState(current.snapshot(), home);
	result = syncSession({ session_id: "legacy" }, { home, now: 2000, fetchPrStatus: () => ({ state: "MERGED" }) });
	assert.equal(result.state.prs.length, 0);
}));

test("revision reconciliation rejects stale saves while explicit re-add and reopen survive older tombstones", () => {
	const tracker = new SessionTracker("revisions");
	tracker.add(url(1));
	Object.assign(tracker.state.prs[0], { mergedAt: 100, mergedObservedAt: 200, checkedAt: 200, status: `${OCTICONS.merged} Merged` });
	const stale = structuredClone(tracker.snapshot());
	const laterPoll = structuredClone(stale);
	Object.assign(laterPoll.prs[0], { checkedAt: 300, mergedObservedAt: 300 });
	reconcilePrStates(tracker, laterPoll);
	assert.equal(tracker.state.prs[0].mergedObservedAt, 200);
	tracker.manage("remove", url(1));
	reconcilePrStates(tracker, stale);
	assert.equal(tracker.state.prs.length, 0);
	const removed = structuredClone(tracker.snapshot());
	tracker.observe(event("session.start", 100, { repository: "example/widget" }));
	tracker.observe(event("tool.execution_start", 200, {
		toolCallId: "reopen", toolName: "powershell", arguments: { command: `gh pr reopen ${url(1)}` },
	}));
	assert.equal(tracker.state.prs[0].generation, 1);
	reconcilePrStates(tracker, removed);
	assert.equal(tracker.state.prs.length, 1);
	assert.ok(!tracker.state.ignored.includes(url(1)));
	const delayed = new SessionTracker("revisions", removed);
	reconcilePrStates(delayed, tracker.snapshot());
	assert.equal(delayed.state.prs[0].generation, 1);
	delayed.manage("remove", url(1));
	reconcilePrStates(delayed, stale);
	assert.equal(delayed.state.prs.length, 0);
});

test("collector reconciles merge metadata before dismissal and never revives it on subsequent saves", async () => fixture(async (home) => {
	const id = "collector-lifecycle";
	let handler;
	const session = {
		sessionId: id,
		on(fn) { handler = fn; return () => {}; },
		async getEvents() { return [event("user.message", 1000, { content: `Work on ${url(1)}` })]; },
		rpc: { metadata: { async activity() { return { hasActiveWork: false }; } } },
	};
	const collector = await collect(session, { home, interval: 100000 });
	try {
		const external = readState(id, home);
		Object.assign(external.prs[0], { mergedAt: 500, mergedObservedAt: 2000, checkedAt: 2000, status: `${OCTICONS.merged} Merged` });
		external.updatedAt += 10000;
		writeState(external, home);
		handler(event("user.message", 3000, { content: "Next task" }));
		assert.equal(readState(id, home).prs.length, 0, "the user event arrived before collector memory had the disk merge");
		for (let i = 0; i < 3; i++) {
			writeState({ ...external, updatedAt: external.updatedAt + i + 1 }, home);
			handler(event("session.idle", 4000 + i));
			assert.equal(readState(id, home).prs.length, 0);
		}
		collector.manage("add", url(1));
		assert.equal(readState(id, home).prs[0].generation, 1);
		handler(event("session.idle", 5000));
		assert.equal(readState(id, home).prs.length, 1);
	} finally { collector.stop(); }
}));

test("collector startup replay cannot restore an old reopen, while a new live reopen can", async () => fixture(async (home) => {
	const id = "replay-reopen";
	const tracker = new SessionTracker(id);
	tracker.add(url(1));
	tracker.manage("remove", url(1));
	tracker.lastUserInputAt = 3000;
	writeState(tracker.snapshot(), home);
	let handler;
	const reopen = (time) => event("tool.execution_start", time, {
		toolCallId: `reopen-${time}`, toolName: "powershell", arguments: { command: `gh pr reopen ${url(1)}` },
	});
	const collector = await collect({
		sessionId: id,
		on(fn) { handler = fn; return () => {}; },
		async getEvents() { return [event("user.message", 1000), reopen(1500), event("user.message", 3000)]; },
		rpc: { metadata: { async activity() { return { hasActiveWork: false }; } } },
	}, { home, interval: 100000 });
	try {
		assert.equal(readState(id, home).prs.length, 0);
		handler(reopen(4000));
		assert.equal(readState(id, home).prs[0].generation, 1);
	} finally { collector.stop(); }
}));

test("settled subagent counts dismiss independently, without losing active PRs or ongoing merged agents", () => {
	const tracker = new SubagentTracker("mixed");
	tracker.ensureAgent("settled").status = "completed";
	tracker.linkPr("settled", url(1));
	tracker.linkPr("open", url(2));
	tracker.ensureAgent("running");
	tracker.linkPr("running-merged", url(3), true, 2000);
	const data = { [url(1)]: { info: { state: "MERGED", mergedAt: new Date(1).toISOString() }, checkedAt: 2000 } };
	tracker.syncWithPrCache(data, 2000);
	assert.equal(tracker.counts().merged, 2);
	tracker.observe(event("user.message", 1500));
	assert.equal(tracker.counts().merged, 2, "a user message before detection doesn't dismiss newly observed settlement");
	tracker.syncWithPrCache(data, 4000);
	assert.equal(tracker.agents.get("settled").settlementObservedAt, 2000);
	tracker.observe(event("user.message", 5000));
	assert.equal(tracker.counts().merged, 0);
	assert.equal(tracker.counts().inPr, 1);
	assert.equal(tracker.counts().starting, 2, "a still-running agent survives dismissal of its merged contribution");
	tracker.syncWithPrCache(data, 6000);
	assert.equal(tracker.counts().merged, 0);
	assert.equal(tracker.agents.get("settled").settlementObservedAt, 2000);
	const legacy = new SubagentTracker("legacy-agents", {
		lastUserInputAt: 500,
		agents: { a: { id: "a", status: "completed", prs: [url(1)], mergedPrs: [url(1)], completedAt: 10 } },
	});
	legacy.syncWithPrCache(data, 1000);
	assert.equal(legacy.agents.get("a").settlementObservedAt, 1000);
	legacy.observe(event("user.message", 750));
	assert.equal(legacy.counts().merged, 1);
	legacy.observe(event("user.message", 1001));
	assert.equal(legacy.counts().total, 0);
});

test("subagent merge attempts require success and settle only their targeted PR", () => {
	const tracker = new SubagentTracker("targets");
	tracker.linkPr("a", url(1));
	tracker.linkPr("a", url(2));
	const start = (id) => event("tool.execution_start", 1000, {
		toolCallId: id, toolName: "powershell", arguments: { command: `gh pr merge ${url(1)} --body 'Related ${url(2)}'` },
	}, "a");
	tracker.observe(start("failed"));
	assert.deepEqual(tracker.agents.get("a").mergedPrs, []);
	tracker.observe(event("tool.execution_complete", 2000, { toolCallId: "failed", success: false }, "a"));
	assert.deepEqual(tracker.agents.get("a").mergedPrs, []);
	tracker.observe(start("success"));
	tracker.observe(event("tool.execution_complete", 3000, {
		toolCallId: "success", success: true, result: { content: `Merged ${url(1)}. Related ${url(2)}` },
	}, "a"));
	assert.deepEqual(tracker.agents.get("a").mergedPrs, [url(1)]);
	assert.equal(tracker.counts().inPr, 1);
	tracker.observe(event("user.message", 4000));
	assert.equal(tracker.counts().inPr, 1);
});

test("last merged PR dismissal removes empty historical checkout rows but preserves current external focus", async () => fixture(async (home) => {
	const main = join(home, "main"), merged = join(home, "merged"), focus = join(home, "focus");
	mkdirSync(main);
	const git = (...args) => {
		const result = spawnSync("git", ["-C", main, ...args], { encoding: "utf8", timeout: 10000, windowsHide: true });
		assert.ifError(result.error);
		assert.equal(result.status, 0, result.stderr);
	};
	git("init", "--initial-branch=main");
	git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
		"-c", `core.hooksPath=${join(home, "no-hooks")}`, "commit", "--allow-empty", "-m", "fixture");
	git("remote", "add", "origin", "https://github.com/example/widget");
	git("worktree", "add", "-b", "feat/merged", merged);
	git("worktree", "add", "-b", "feat/working", focus);
	configureStatuslines({ home, repoRoot, enabled: ["pr-statusline", "subagent-statusline", "worktree-statusline"] });
	const file = transcript(home, "group-dismissal", [
		event("session.start", 100, { cwd: main }), event("session.context_changed", 200, { cwd: merged }),
		event("session.context_changed", 300, { cwd: focus }),
		event("tool.execution_start", 400, { toolCallId: "cwd", toolName: "powershell", arguments: { command: "git status", cwd: merged } }, "a"),
		event("tool.execution_complete", 500, { toolCallId: "cwd", success: true }, "a"),
	]);
	const prs = new SessionTracker("group-dismissal");
	prs.add(url(1), false, { root: true });
	Object.assign(prs.state.prs[0], {
		headRepositoryUrl: "https://github.com/example/widget", headRefName: "feat/merged",
		mergedAt: 1000, mergedObservedAt: 2000, checkedAt: 2000, status: `${OCTICONS.merged} Merged`,
	});
	prs.state.transcriptOffset = statSync(file).size;
	writeState(prs.snapshot(), home);
	const agents = new SubagentTracker("group-dismissal");
	agents.ensureAgent("a").status = "completed";
	agents.linkPr("a", url(1), true, 2000);
	agents.transcriptOffset = statSync(file).size;
	writeAgents(agents.snapshot(), home);
	const payload = { session_id: "group-dismissal", cwd: home };
	const before = await composeStatusLine(payload, { home, ...plain });
	assert.ok(before.includes(`${merged} [⎇ feat/merged]`) && before.includes("widget#1") && before.includes("1 merged"), before);
	appendFileSync(file, JSON.stringify(event("user.message", 3000, { content: "Next task" })) + "\n");
	for (const color of [false, true]) {
		const output = await composeStatusLine(payload, { home, ...plain, color });
		const expected = `${focus} [⎇ feat/working]`;
		assert.equal(output, color ? `\x1b[1;38;2;219;234;254;48;2;30;64;115m ${expected} \x1b[0m` : expected);
	}
	cache(home, [[1, { state: "MERGED" }]], Date.now());
	assert.equal(await composeStatusLine(payload, { home, ...plain }), `${focus} [⎇ feat/working]`);
	appendFileSync(file, JSON.stringify(event("session.context_changed", 4000, { cwd: merged })) + "\n");
	assert.equal(await composeStatusLine(payload, { home, ...plain }), `${merged} [⎇ feat/merged]`);
	assert.ok(!readFileSync(join(home, "pr-statusline", "group-dismissal.json"), "utf8").includes('"prs":[{'));
}));
