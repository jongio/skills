import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionTracker, readState, refreshTrackedPrStatuses, syncSession, writeState } from "../../pr-statusline/tracker.mjs";
import { reconcilePrStates } from "../../pr-statusline/lifecycle.mjs";
import { OCTICONS, summarizePrStatus } from "../../pr-statusline/github.mjs";
import { SubagentTracker } from "../../subagent-statusline/tracker.mjs";

const url = "https://github.com/example/widget/pull/1";
const event = (type, time, data, agentId) => ({ type, timestamp: new Date(time).toISOString(), data, agentId });
const open = () => ({ state: "OPEN" });
function fixture(run) {
	const home = mkdtempSync(join(tmpdir(), "merge-verification-"));
	try { run(home); } finally { rmSync(home, { recursive: true, force: true }); }
}

test("running, queued and successful merge tools invalidate status without claiming a remote merge", () => {
	for (const content of [
		"<command with shellId: 1 is still running after 120 seconds.>",
		"Auto-merge enabled.\n<shellId: 1 completed with exit code 0>",
		"Merged pull request #1",
	]) for (const tool of [
		{ toolName: "powershell", arguments: { command: `gh pr merge ${url} --auto --squash` } },
		{ toolName: "merge_pull_request", arguments: { owner: "example", repo: "widget", pullNumber: 1 } },
	]) {
		const tracker = new SessionTracker("attempt");
		tracker.add(url);
		Object.assign(tracker.state.prs[0], { status: summarizePrStatus(open()), checkedAt: 500 });
		tracker.observe(event("tool.execution_start", 1000, {
			toolCallId: "merge", ...tool,
		}));
		tracker.observe(event("tool.execution_complete", 2000, {
			toolCallId: "merge", success: true, result: { content },
		}));
		assert.equal(tracker.state.prs[0].mergedAt, undefined, content);
		assert.equal(tracker.state.prs[0].checkedAt, 0, "a merge attempt must request fresh remote state");
		refreshTrackedPrStatuses(tracker, { now: 3000, fetchPrStatus: open });
		assert.doesNotMatch(tracker.state.prs[0].status, /Merged/);
		refreshTrackedPrStatuses(tracker, {
			now: 4000, prCacheTtlMs: 0,
			fetchPrStatus: () => ({ state: "MERGED", mergedAt: new Date(3500).toISOString() }),
		});
		assert.equal(tracker.state.prs[0].mergedAt, 3500);
		assert.equal(tracker.state.prs[0].mergedObservedAt, 4000);
	}
});

test("legacy optimistic flags recover to OPEN before a later user message can dismiss the PR", () => fixture((home) => {
	const tracker = new SessionTracker("legacy-attempt");
	tracker.add(url);
	const previous = tracker.snapshot();
	delete previous.mergeStateVersion;
	Object.assign(previous.prs[0], {
		status: `${OCTICONS.merged} Merged`, checkedAt: 2000, mergedAt: 2000, mergedObservedAt: 2000,
	});
	writeState(previous, home);
	const directory = join(home, "session-state", previous.sessionId);
	mkdirSync(directory, { recursive: true });
	writeFileSync(join(directory, "events.jsonl"),
		JSON.stringify(event("user.message", 3000, { content: "Continue working" })) + "\n");
	const { state } = syncSession({ session_id: previous.sessionId }, { home, now: 4000, fetchPrStatus: open });
	assert.equal(state.prs.length, 1);
	assert.equal(state.prs[0].mergedAt, undefined);
	assert.equal(state.prs[0].mergedObservedAt, undefined);
	assert.doesNotMatch(state.prs[0].status, /Merged/);
	assert.ok(!readState(previous.sessionId, home).ignored.includes(url));
}));

test("newer OPEN observations clear old merge metadata in either reconciliation direction", () => {
	const merged = new SessionTracker("reconcile-open");
	merged.add(url);
	Object.assign(merged.state.prs[0], {
		status: `${OCTICONS.merged} Merged`, checkedAt: 2000, mergedAt: 1000, mergedObservedAt: 2000,
	});
	const stale = structuredClone(merged.snapshot());
	const fresh = structuredClone(stale);
	Object.assign(fresh.prs[0], { status: summarizePrStatus(open()), checkedAt: 3000 });
	delete fresh.prs[0].mergedAt;
	delete fresh.prs[0].mergedObservedAt;
	reconcilePrStates(merged, fresh);
	assert.doesNotMatch(merged.state.prs[0].status, /Merged/);
	assert.equal(merged.state.prs[0].mergedAt, undefined);
	const reopened = new SessionTracker("reconcile-open", fresh);
	reconcilePrStates(reopened, stale);
	assert.doesNotMatch(reopened.state.prs[0].status, /Merged/);
	assert.equal(reopened.state.prs[0].mergedObservedAt, undefined);
	const refreshed = new SessionTracker("refresh-open", stale);
	refreshTrackedPrStatuses(refreshed, { now: 200000, fetchPrStatus: open });
	assert.equal(refreshed.state.prs[0].mergedAt, undefined, "merged observations must not permanently disable refresh");
});

test("subagent merge attempts and legacy settlements require confirmation and recover from OPEN cache state", () => {
	const tracker = new SubagentTracker("agent-attempt");
	tracker.ensureAgent("a");
	tracker.observe(event("tool.execution_start", 1000, {
		toolCallId: "merge", toolName: "powershell",
		arguments: { command: `gh pr merge ${url} --auto --squash` },
	}, "a"));
	tracker.observe(event("tool.execution_complete", 2000, {
		toolCallId: "merge", success: true, result: { content: "Auto-merge enabled" },
	}, "a"));
	assert.equal(tracker.counts().merged, 0);
	assert.equal(tracker.counts().inPr, 1);
	tracker.syncWithPrCache({ [url]: { info: { state: "MERGED" }, checkedAt: 3000 } }, 3000);
	assert.equal(tracker.counts().merged, 1);
	const legacy = structuredClone(tracker.snapshot());
	delete legacy.mergeStateVersion;
	assert.equal(new SubagentTracker("agent-attempt", legacy).counts().merged, 0);
	tracker.syncWithPrCache({ [url]: { info: { state: "OPEN" }, checkedAt: 4000 } }, 4000);
	assert.equal(tracker.counts().merged, 0);
	assert.equal(tracker.counts().inPr, 1);
	assert.equal(tracker.agents.get("a").settlementObservedAt, undefined);
});
