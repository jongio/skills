import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IssueTracker, readState, writeState } from "../tracker.mjs";
import { render } from "../render.mjs";

const home = mkdtempSync(join(tmpdir(), "issue-statusline-test-"));
const event = (type, data = {}, agentId, timestamp = new Date(1000).toISOString()) => ({
	type,
	data,
	agentId,
	timestamp,
});

try {
	const tracker = new IssueTracker("issue-session");
	tracker.observe(event("session.start", { context: { repository: "Azure/azure-dev", repositoryHost: "github.com" } }));
	tracker.observe(event("user.message", { content: "Work on issue #3315 and https://github.com/Azure/azure-dev/issues/3318" }));
	assert.deepEqual(tracker.state.issues.map((i) => i.label), [
		"Azure/azure-dev#3318",
		"Azure/azure-dev#3315",
	]);

	// Batch gh issue list loops and PR comment REST API calls (/issues/92/comments) are ignored
	tracker.observe(event("tool.execution_start", {
		toolCallId: "batch",
		toolName: "powershell",
		arguments: { command: "gh issue list --repo Azure/azure-dev --limit 50" },
	}));
	tracker.observe(event("tool.execution_start", {
		toolCallId: "pr-comments",
		toolName: "powershell",
		arguments: { command: "gh api --paginate repos/Azure/azure-dev/issues/92/comments" },
	}));
	assert.equal(tracker.state.issues.length, 2);

	const transcriptDir = join(home, "session-state", "live-issues");
	mkdirSync(transcriptDir, { recursive: true });
	const transcriptFile = join(transcriptDir, "events.jsonl");
	writeFileSync(
		transcriptFile,
		[
			JSON.stringify(event("session.start", { context: { repository: "Azure/azure-dev", repositoryHost: "github.com" } })),
			JSON.stringify(event("user.message", { content: "Fix issue #3315 and https://github.com/Azure/azure-dev/issues/3318" }, undefined, new Date(1000).toISOString())),
		].join("\n") + "\n",
	);

	const mockIssues = {
		"https://github.com/Azure/azure-dev/issues/3315": {
			state: "OPEN",
			labels: { nodes: [{ name: "P1" }] },
			assignees: { nodes: [{ login: "jongio" }] },
			comments: { totalCount: 4 },
			closedByPullRequestsReferences: { nodes: [{ number: 4812, repository: { nameWithOwner: "Azure/azure-dev" } }] },
		},
		"https://github.com/Azure/azure-dev/issues/3318": {
			state: "OPEN",
			labels: { nodes: [{ name: "bug" }] },
			assignees: { nodes: [] },
			comments: { totalCount: 2 },
			closedByPullRequestsReferences: { nodes: [] },
		},
	};

	const plain = render(
		{ session_id: "live-issues", transcript_path: transcriptDir },
		{ home, links: false, color: false, now: 2000, fetchIssueStatus: (url) => mockIssues[url] ?? null },
	);
	assert.ok(plain.includes("\uF41B Azure/azure-dev#3315 (https://github.com/Azure/azure-dev/issues/3315) P1 \uE726 \uF415 jongio \uF075 4"));
	assert.ok(plain.includes("\uF188 Azure/azure-dev#3318 (https://github.com/Azure/azure-dev/issues/3318) bug \uF075 2"));

	// Closing issue #3318 turns it purple ("\uF41D Closed"), then dismisses on next user input
	appendFileSync(
		transcriptFile,
		[
			JSON.stringify(event("tool.execution_start", { toolCallId: "close-3318", toolName: "powershell", arguments: { command: "gh issue close 3318 --repo Azure/azure-dev" } }, undefined, new Date(3000).toISOString())),
			JSON.stringify(event("tool.execution_complete", { toolCallId: "close-3318", success: true, result: { content: "Closed issue #3318" } }, undefined, new Date(3100).toISOString())),
		].join("\n") + "\n",
	);
	const afterCloseColored = render(
		{ session_id: "live-issues", transcript_path: transcriptDir },
		{ home, links: true, color: true, now: 3200, fetchIssueStatus: (url) => mockIssues[url] ?? null },
	);
	assert.ok(afterCloseColored.includes("\x1b[1;38;2;237;224;255;48;2;88;44;142m \uF41D \x1b]8;;https://github.com/Azure/azure-dev/issues/3318\x07Azure/azure-dev#3318\x1b]8;;\x07\x1b[0m\x1b[1;38;2;237;224;255;48;2;88;44;142m Closed \x1b[0m"));

	appendFileSync(
		transcriptFile,
		`${JSON.stringify(event("user.message", { content: "Thanks, what next?" }, undefined, new Date(4000).toISOString()))}\n`,
	);
	const afterNextInput = render(
		{ session_id: "live-issues", transcript_path: transcriptDir },
		{ home, links: false, color: false, now: 4100, fetchIssueStatus: (url) => mockIssues[url] ?? null },
	);
	assert.ok(!afterNextInput.includes("#3318"), "closed issue should be dismissed after next user input");
	assert.ok(afterNextInput.includes("#3315"), "open issue remains visible");

	writeState(readState("live-issues", home), home);
	console.log("ok - issue detection, labels/linked-PR/assignee/comment metadata, purple closed lifecycle, and next-input dismissal");
} finally {
	rmSync(home, { recursive: true, force: true });
}
