import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { SessionTracker, readState, statePath, writeState } from "../tracker.mjs";
import { render } from "../render.mjs";
import { collect } from "../collector.mjs";

const home = mkdtempSync(join(tmpdir(), "pr-statusline-test-"));
const event = (type, data = {}, agentId) => ({ type, data, agentId });
const start = (id, command, toolName = "powershell", extra = {}) => event("tool.execution_start", {
	toolCallId: id,
	toolName,
	arguments: { command, ...extra },
});
const result = (id, content, success = true) => event("tool.execution_complete", {
	toolCallId: id,
	success,
	result: { content },
});
const pr = "https://github.com/acme/app/pull/42";

try {
	const tracker = new SessionTracker("session-a");
	tracker.observe(event("session.start", { context: { repository: "acme/app", repositoryHost: "github.com" } }));
	tracker.observe(start("view", "gh pr view 42 --json url"));
	tracker.observe(result("view", `{"url":"${pr}"}`));
	tracker.observe(start("other", "gh -R other/project pr checks --watch 9"));
	tracker.observe(event("tool.execution_start", {
		toolCallId: "mcp",
		mcpToolName: "pull_request_read",
		arguments: { owner: "third", repo: "repo", pullNumber: 7 },
	}));
	tracker.observe(start("create", "gh pr create --title 'New PR' --body-file C:\\Users\\me\\.copilot\\session-state\\session-a\\files\\pr-body.md"));
	tracker.observe(result("create", "https://github.com/fourth/repo/pull/12"));
	assert.deepEqual(tracker.state.prs.map((p) => p.label), [
		"acme/app#42",
		"other/project#9",
		"third/repo#7",
		"fourth/repo#12",
	]);
	tracker.observe(start("list", "gh pr list --json url"));
	tracker.observe(result("list", "https://github.com/acme/app/pull/99"));
	tracker.observe(start("arbitrary", `Write-Output '${pr}'`));
	tracker.observe(result("arbitrary", "https://github.com/acme/app/pull/100"));
	tracker.observe(start("explore-task", "", "task", {
		agent_type: "explore",
		prompt: "Search repo history",
	}));
	tracker.observe(result("explore-task", "Found https://github.com/acme/app/pull/102 in docs"));
	tracker.observe(start("different-cwd", "Set-Location C:\\other; gh pr view 999 --json url"));
	assert.ok(!tracker.state.prs.some((p) => p.label === "acme/app#999"));
	tracker.observe(result("different-cwd", "https://github.com/different/repo/pull/999"));
	assert.equal(tracker.state.prs.at(-1).label, "different/repo#999");
	tracker.observe(event("assistant.message", { content: "Research https://github.com/acme/app/pull/101" }));
	assert.equal(tracker.state.prs.length, 5);
	tracker.observe(event("user.message", { content: "Fix https://github.com/acme/app/pull/43/files" }));
	assert.equal(tracker.snapshot().status, "Working");
	tracker.observe(start("api", "gh api repos/acme/api/pulls/5/comments"));
	assert.equal(tracker.state.prs.at(-1).label, "acme/api#5");

	// Regression: placeholder o/r in process filter or gh api is never added
	tracker.observe(start("proc-filter", "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*gh api repos/o/r/pulls/7*' }"));
	assert.ok(!tracker.state.prs.some((p) => p.label === "o/r#7"));

	// Regression: compound command with repos/owner/repo/pulls?state=open does not scrape list output
	tracker.observe(start("compound-list", "gh pr view 104 --repo acme/app; gh api 'repos/acme/app/pulls?state=open&per_page=100'"));
	tracker.observe(result("compound-list", "https://github.com/acme/app/pull/17"));
	assert.ok(!tracker.state.prs.some((p) => p.label === "acme/app#17"));

	// Regression: gh pr close --comment 'Superseded by .../pull/105' does not close/ignore #105
	tracker.add("https://github.com/acme/app/pull/94");
	tracker.add("https://github.com/acme/app/pull/105");
	tracker.observe(start("close-loop", "foreach ($n in @(94)) { gh pr close $n --repo acme/app --comment 'Superseded by https://github.com/acme/app/pull/105' }"));
	tracker.observe(result("close-loop", "Closed pull request acme/app#94\nClosed and commented: https://github.com/acme/app/pull/94\n[{\"number\":105,\"url\":\"https://github.com/acme/app/pull/105\"}]"));
	assert.ok(!tracker.state.prs.some((p) => p.label === "acme/app#94"), "#94 closed");
	assert.ok(tracker.state.prs.some((p) => p.label === "acme/app#105"), "#105 remains active");
	tracker.manage("remove", "acme/app#105");
	tracker.manage("remove", "acme/app#104");

	tracker.manage("remove", "acme/app#42");
	const resumed = new SessionTracker("session-a", tracker.state);
	resumed.observe(start("again", `gh pr view ${pr}`), true);
	assert.ok(!resumed.state.prs.some((p) => p.url === pr));
	resumed.manage("add", "acme/app#42");
	assert.ok(resumed.state.prs.some((p) => p.url === pr));

	tracker.observe(event("assistant.turn_start"));
	assert.equal(tracker.snapshot({ hasActiveWork: true }).status, "Working");
	tracker.observe(start("ask", "", "ask_user"));
	assert.equal(tracker.snapshot().status, "Waiting on you (answer)");
	tracker.observe(result("ask", "confirmed"));
	assert.equal(tracker.snapshot().status, "Working");
	tracker.observe(event("permission.requested", { requestId: "permission", resolvedByHook: true }));
	assert.equal(tracker.snapshot().status, "Working");
	tracker.observe(event("permission.requested", { requestId: "permission" }));
	tracker.observe(event("user_input.requested", { requestId: "answer" }));
	assert.equal(tracker.snapshot({ hasActiveWork: true }).status, "Waiting on you (permission)");
	tracker.observe(event("permission.completed", { requestId: "permission" }));
	assert.equal(tracker.snapshot().status, "Waiting on you (answer)");
	tracker.observe(event("user_input.completed", { requestId: "answer" }));
	assert.equal(tracker.snapshot().status, "Working");
	tracker.observe(event("elicitation.requested", { requestId: "form" }));
	assert.equal(tracker.snapshot().status, "Waiting on you (input)");
	tracker.observe(event("elicitation.completed", { requestId: "form" }));
	tracker.observe(event("assistant.turn_end"));
	assert.equal(tracker.snapshot().status, "Waiting on you");
	tracker.observe(event("session.idle"));
	assert.equal(tracker.snapshot({ hasActiveWork: false }).status, "Waiting on you");
	assert.equal(tracker.snapshot({ hasActiveWork: true }).status, "Working");
	tracker.observe(event("subagent.started", { toolCallId: "agent" }));
	assert.match(tracker.snapshot().status, /1 background agent/);
	tracker.observe(event("subagent.completed", { toolCallId: "agent" }));
	assert.doesNotMatch(tracker.snapshot().status, /background/);
	tracker.observe(event("session.compaction_start"));
	assert.equal(tracker.snapshot({ hasActiveWork: true }).status, "Compacting context");
	tracker.observe(event("session.compaction_complete"));
	tracker.observe(event("session.error"));
	assert.equal(tracker.snapshot({ hasActiveWork: false }).status, "Error");
	tracker.observe(event("assistant.turn_start"));
	assert.equal(tracker.snapshot().status, "Working");
	tracker.observe(event("abort"));
	assert.equal(tracker.snapshot().status, "Interrupted");

	writeState(tracker.snapshot(), home);
	assert.equal(readState("session-b", home), null);
	assert.throws(() => statePath("../session-a", home), /valid session_id/);
	const output = render({ session_id: "session-a" }, { home });
	assert.ok(output.includes(`\x1b]8;;https://github.com/other/project/pull/9\x07other/project#9\x1b]8;;\x07`));
	assert.ok(output.includes(`\x1b]8;;https://github.com/acme/app/pull/43\x07acme/app#43\x1b]8;;\x07`));
	assert.ok(!output.includes("acme/app#42"));
	assert.equal(render({ session_id: "session-b" }, { home }), "");
	assert.equal(render({}, { home }), "");
	assert.match(render({ session_id: "session-a" }, { home, links: false }), /other\/project#9 \(https:/);
	tracker.manage("clear");
	writeState(tracker.snapshot(), home);
	assert.equal(render({ session_id: "session-a" }, { home }), "");

	// Live transcript incremental sync without requiring the SDK extension process
	const transcriptDir = join(home, "session-state", "transcript-session");
	mkdirSync(transcriptDir, { recursive: true });
	const transcriptFile = join(transcriptDir, "events.jsonl");
	writeFileSync(
		join(transcriptDir, "workspace.yaml"),
		"id: transcript-session\nrepository: acme/app\nbranch: pr-55\nname: Review PR #42\n",
	);
	writeFileSync(
		transcriptFile,
		[
			JSON.stringify(event("session.start", { context: { repository: "acme/app", repositoryHost: "github.com" } })),
			JSON.stringify(event("user.message", { content: "Watch PR acme/app#42 and https://github.com/acme/app/pull/48" })),
			JSON.stringify(event("user.message", { source: "skill-demo", content: "<skill-context>Ignore https://github.com/acme/app/pull/999</skill-context>" })),
			JSON.stringify(event("model.turn_started")),
		].join("\n") + "\n",
	);
	const mockPrStatuses = {
		"https://github.com/acme/app/pull/42": {
			state: "OPEN",
			isDraft: false,
			reviewDecision: "APPROVED",
			mergeStateStatus: "CLEAN",
			latestOpinionatedReviews: { nodes: [{ state: "APPROVED", author: { login: "alice" } }, { state: "APPROVED", author: { login: "bob" } }] },
			reviewRequests: { nodes: [] },
			reviewThreads: { totalCount: 4, nodes: [{ isResolved: true }, { isResolved: true }, { isResolved: true }, { isResolved: true }] },
			statusCheckRollup: [
				{ status: "COMPLETED", conclusion: "SUCCESS" },
			],
		},
		"https://github.com/acme/app/pull/55": {
			state: "OPEN",
			isDraft: false,
			reviewDecision: "APPROVED",
			mergeStateStatus: "BLOCKED",
			latestOpinionatedReviews: { nodes: [{ state: "APPROVED", author: { login: "alice" } }] },
			reviewRequests: { nodes: [{ requestedReviewer: { login: "bob" } }] },
			reviewThreads: { totalCount: 3, nodes: [{ isResolved: false }, { isResolved: true }, { isResolved: true }] },
			statusCheckRollup: [
				{ status: "COMPLETED", conclusion: "SUCCESS" },
				{ status: "IN_PROGRESS", conclusion: "" },
			],
		},
		"https://github.com/acme/app/pull/48": {
			state: "CLOSED",
		},
		"https://github.com/acme/remote/pull/88": {
			state: "OPEN",
			isDraft: true,
			reviewDecision: "REVIEW_REQUIRED",
			mergeStateStatus: "DIRTY",
			latestOpinionatedReviews: { nodes: [] },
			reviewRequests: { nodes: [{ requestedReviewer: { login: "alice" } }, { requestedReviewer: { login: "bob" } }] },
			reviewThreads: { totalCount: 2, nodes: [{ isResolved: false }, { isResolved: false }] },
			statusCheckRollup: [{ status: "COMPLETED", conclusion: "FAILURE" }],
		},
	};
	// Pass transcript_path as the session directory, matching Copilot CLI's statusObject payload
	const firstRender = render(
		{
			session_id: "transcript-session",
			transcript_path: transcriptDir,
			remote: { connected: true, repository: "acme/remote", pull_request_number: 88 },
		},
		{ home, links: false, now: 1000, fetchPrStatus: (url) => mockPrStatuses[url] ?? null },
	);
	assert.ok(firstRender.includes("\uE726 acme/app#42 (https://github.com/acme/app/pull/42) \uF058 1/1 \uF164 2/2 \uF075 4/4"));
	const unicodeRender = render(
		{
			session_id: "transcript-session",
			transcript_path: transcriptDir,
			remote: { connected: true, repository: "acme/remote", pull_request_number: 88 },
		},
		{ home, links: false, nerdFont: false, now: 1000, fetchPrStatus: (url) => mockPrStatuses[url] ?? null },
	);
	assert.ok(unicodeRender.includes("\uE0A0 acme/app#42 (https://github.com/acme/app/pull/42) \u2713 1/1 \u2605 2/2 \u2709 4/4"));
	assert.doesNotMatch(unicodeRender, /[\uE700-\uF8FF]/);
	assert.ok(firstRender.includes("\uE726 acme/app#55 (https://github.com/acme/app/pull/55) \uF252 1/2 \uF164 1/2 \uF075 2/3"));
	assert.ok(firstRender.includes("\uF4DD acme/remote#88 (https://github.com/acme/remote/pull/88) \uF057 0/1 \uF071 \uF164 0/2 \uF075 0/2"));
	const coloredFirstRender = render(
		{
			session_id: "transcript-session",
			transcript_path: transcriptDir,
			remote: { connected: true, repository: "acme/remote", pull_request_number: 88 },
		},
		{ home, links: true, color: true, now: 1000, fetchPrStatus: (url) => mockPrStatuses[url] ?? null },
	);
	assert.ok(coloredFirstRender.includes("\x1b[1;38;2;216;250;228;48;2;22;92;50m \uE726 \x1b]8;;https://github.com/acme/app/pull/42\x07acme/app#42"), "passing PR uses green badge");
	assert.ok(coloredFirstRender.includes("\x1b[1;38;2;255;238;196;48;2;118;68;16m \uE726 \x1b]8;;https://github.com/acme/app/pull/55\x07acme/app#55"), "PR with running checks/unresolved thread uses amber attention badge");
	assert.ok(coloredFirstRender.includes("\x1b[1;38;2;255;224;222;48;2;122;32;40m \uF4DD \x1b]8;;https://github.com/acme/remote/pull/88\x07acme/remote#88"), "failing PR uses red critical badge");
	assert.ok(!firstRender.includes("acme/app#48"), "closed PR should be removed from statusline");
	assert.ok(!firstRender.includes("#999"), "skill-injected example PR should be ignored");
	appendFileSync(transcriptFile, `${JSON.stringify(event("model.turn_ended"))}\n`);
	const secondRender = render(
		{ session_id: "transcript-session", transcript_path: transcriptDir },
		{ home, links: false, now: 2000, fetchPrStatus: (url) => mockPrStatuses[url] ?? null },
	);
	assert.match(secondRender, /^\uE726 acme\/app#42/);
	// Merging a PR via gh pr merge turns it purple ("\uE727 Merged"), then dismisses it on the next user input
	appendFileSync(
		transcriptFile,
		[
			JSON.stringify({ ...start("merge-42", "gh pr merge 42 --squash"), timestamp: new Date(4500).toISOString() }),
			JSON.stringify({ ...result("merge-42", "Merged pull request #42"), timestamp: new Date(4500).toISOString() }),
		].join("\n") + "\n",
	);
	const afterMergeRender = render(
		{ session_id: "transcript-session", transcript_path: transcriptDir },
		{ home, links: false, now: 3000, fetchPrStatus: (url) => mockPrStatuses[url] ?? null },
	);
	assert.ok(afterMergeRender.includes("\uE727 acme/app#42 (https://github.com/acme/app/pull/42) Merged"), "merged PR should turn into purple Merged pill");
	const coloredMergedRender = render(
		{ session_id: "transcript-session", transcript_path: transcriptDir },
		{ home, links: true, color: true, now: 3000, fetchPrStatus: (url) => mockPrStatuses[url] ?? null },
	);
	assert.ok(coloredMergedRender.includes("\x1b[1;38;2;237;224;255;48;2;88;44;142m \uE727 \x1b]8;;https://github.com/acme/app/pull/42\x07acme/app#42\x1b]8;;\x07\x1b[0m\x1b[1;38;2;237;224;255;48;2;88;44;142m Merged \x1b[0m"), "merged PR uses purple badge");
	// Scheduled prompt does NOT dismiss the merged PR
	appendFileSync(transcriptFile, `${JSON.stringify(event("user.message", { content: "[Scheduled prompt #1]\nCheck CI" }))}\n`);
	const afterScheduledRender = render(
		{ session_id: "transcript-session", transcript_path: transcriptDir },
		{ home, links: false, now: 3500, fetchPrStatus: (url) => mockPrStatuses[url] ?? null },
	);
	assert.ok(afterScheduledRender.includes("\uE727 acme/app#42 (https://github.com/acme/app/pull/42) Merged"), "scheduled prompt should not dismiss merged PR");
	// Historical user.message earlier than mergedAt does NOT dismiss the merged PR
	const stateBeforeOldInput = readState("transcript-session", home);
	const mergedPr = stateBeforeOldInput.prs.find((p) => p.url.endsWith("/pull/42"));
	mergedPr.mergedAt = 5000;
	writeState(stateBeforeOldInput, home);
	appendFileSync(transcriptFile, `${JSON.stringify({ ...event("user.message", { content: "Older message" }), timestamp: new Date(4000).toISOString() })}\n`);
	const afterOlderInputRender = render(
		{ session_id: "transcript-session", transcript_path: transcriptDir },
		{ home, links: false, now: 3600, fetchPrStatus: (url) => mockPrStatuses[url] ?? null },
	);
	assert.ok(afterOlderInputRender.includes("\uE727 acme/app#42 (https://github.com/acme/app/pull/42) Merged"), "user message older than mergedAt should not dismiss merged PR");
	// Next real user input at or after mergedAt dismisses the merged PR
	appendFileSync(transcriptFile, `${JSON.stringify({ ...event("user.message", { content: "What should we work on next?" }), timestamp: new Date(6000).toISOString() })}\n`);
	const afterNextUserInputRender = render(
		{ session_id: "transcript-session", transcript_path: transcriptDir },
		{ home, links: false, now: 3800, fetchPrStatus: (url) => mockPrStatuses[url] ?? null },
	);
	assert.ok(!afterNextUserInputRender.includes("#42"), "merged PR should be dismissed after the user's next input");
	// Corrupt cache recovers automatically when transcript exists
	writeFileSync(statePath("transcript-session", home), "{corrupt");
	const recoveredRender = render(
		{ session_id: "transcript-session", transcript_path: transcriptDir },
		{ home, links: false, now: 4000, fetchPrStatus: (url) => mockPrStatuses[url] ?? null },
	);
	assert.match(recoveredRender, /^\uE726 acme\/app#55/);

	let handler;
	let unsubscribed = false;
	const session = {
		sessionId: "collector-session",
		on(fn) {
			handler = fn;
			return () => {
				unsubscribed = true;
			};
		},
		async getEvents() {
			handler(event("user_input.requested", { requestId: "live" }));
			return [event("user.message", { content: `Work on ${pr}` })];
		},
		rpc: { metadata: { async activity() { return { hasActiveWork: true }; } } },
	};
	const collector = await collect(session, { home, interval: 100000 });
	try {
		assert.equal(readState(session.sessionId, home).status, "Waiting on you (answer)");
		assert.equal(readState(session.sessionId, home).prs[0].url, pr);
		const mtimeBeforeDelta = readState(session.sessionId, home).updatedAt;
		handler(event("assistant.message.delta", { deltaContent: "token" }));
		assert.equal(readState(session.sessionId, home).updatedAt, mtimeBeforeDelta, "streaming delta events must not trigger disk writes");
		handler(event("user_input.completed", { requestId: "live" }));
		assert.equal(readState(session.sessionId, home).status, "Working");
		collector.manage("remove", pr);
		assert.equal(readState(session.sessionId, home).prs.length, 0);
	} finally {
		collector.stop();
	}
	assert.ok(unsubscribed);

	const script = fileURLToPath(new URL("../render.mjs", import.meta.url));
	const child = spawnSync(process.execPath, [script], {
		input: JSON.stringify({ session_id: "collector-session" }),
		encoding: "utf8",
		env: { ...process.env, COPILOT_HOME: home },
	});
	assert.equal(child.status, 0, child.stderr);
	assert.equal(child.stdout, "");
	const malformed = spawnSync(process.execPath, [script], { input: "not json", encoding: "utf8" });
	assert.equal(malformed.status, 1);
	assert.equal(malformed.stdout, "");
	writeFileSync(statePath("session-a", home), "{");
	assert.throws(() => readState("session-a", home), SyntaxError);
	console.log("ok - PR detection, exclusions, session isolation, activity, transcript sync, OSC 8 links, collector and renderer");
} finally {
	rmSync(home, { recursive: true, force: true });
}

