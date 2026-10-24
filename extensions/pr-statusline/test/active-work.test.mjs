import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { collect } from "../collector.mjs";
import { clearSessionStatusline } from "../session-statusline.mjs";
import { SessionTracker, readState, syncSession, writeState } from "../tracker.mjs";
import { IssueTracker, syncSession as syncIssues, writeState as writeIssues } from "../../issue-statusline/tracker.mjs";
import { SubagentTracker, syncSession as syncAgents, writeState as writeAgents } from "../../subagent-statusline/tracker.mjs";

const pr = "https://github.com/acme/app/pull/42";
const issue = "https://github.com/acme/app/issues/7";
const event = (type, data = {}, agentId) => ({ type, data, agentId, timestamp: new Date(1000).toISOString() });
const start = (id, command = "", toolName = "powershell", args = {}, agentId) => event("tool.execution_start", {
	toolCallId: id, toolName, arguments: { command, ...args },
}, agentId);
const complete = (id, content) => event("tool.execution_complete", { toolCallId: id, success: true, result: { content } });
async function fixture(run) {
	const home = mkdtempSync(join(tmpdir(), "active-pills-"));
	try { await run(home); } finally { rmSync(home, { recursive: true, force: true }); }
}

test("references, attachments, memories, schedules, lookups and delegated output never enroll new pills", () => {
	const prs = new SessionTracker("passive");
	const issues = new IssueTracker("passive");
	const agents = new SubagentTracker("passive");
	const events = [
		event("session.start", { repository: "acme/app" }),
		event("user.message", {
			content: `For reference: PR ${pr}, issue ${issue}, PR #99 and issue #98.`,
			attachments: [
				{ type: "github_reference", referenceType: "pull_request", url: pr },
				{ type: "github_reference", referenceType: "issue", url: issue },
			],
		}),
		event("user.message", { source: "session-memory-rollover", content: `Previously worked on ${pr} and ${issue}` }),
		start("schedule", "", "manage_schedule", { action: "create", prompt: `Look at ${pr}` }),
		start("pr-view", `gh pr view ${pr} --json url,title,body`),
		complete("pr-view", `${pr}\n${issue}`),
		start("checks", `gh pr checks ${pr}`),
		start("issue-view", `gh issue view ${issue}`),
		start("api-pr", "gh api repos/acme/app/pulls/42"),
		start("api-issue", "gh api repos/acme/app/issues/7"),
		start("mcp-pr", "", "github_pull_request_read", { owner: "acme", repo: "app", pullNumber: 42 }),
		start("mcp-issue", "", "github_issue_read", { owner: "acme", repo: "app", issue_number: 7 }),
		start("agent-ref", "", "read_agent", { agent_id: "someone-else" }),
		complete("agent-ref", `Agent someone-else worked on ${pr}`),
		start("list-agents", "", "list_agents"),
		complete("list-agents", `Agent other-session: ${pr}`),
		start("task", "", "task", { agent_type: "general-purpose", prompt: `Use ${pr} as background, not a work target.` }),
		complete("task", `Historical reference: ${pr}\n${issue}`),
	];
	for (const item of events) {
		prs.observe(item);
		issues.observe(item);
		agents.observe(item);
	}
	assert.deepEqual(prs.state.prs, []);
	assert.deepEqual(issues.state.issues, []);
	assert.deepEqual([...agents.agents.keys()], ["task"], "only a task actually launched by this session is tracked");
	assert.deepEqual(agents.agents.get("task").prs, []);
	assert.equal(agents.counts().inPr, 0);
});

test("explicit enrollment and concrete work track targets, not references in bodies or returned data", () => {
	const prs = new SessionTracker("active");
	const issues = new IssueTracker("active");
	for (const tracker of [prs, issues]) tracker.observe(event("session.start", { repository: "acme/app" }));
	prs.observe(start("checkout", `gh pr checkout ${pr}`));
	prs.observe(start("edit", `gh pr edit 43 --body 'See https://github.com/acme/app/pull/99'`));
	prs.observe(complete("edit", "Related: https://github.com/acme/app/pull/98"));
	issues.observe(start("develop", "gh issue develop 7"));
	issues.observe(start("comment", "gh issue comment 8 --body 'See https://github.com/acme/app/issues/99'"));
	issues.observe(complete("comment", "Related: https://github.com/acme/app/issues/98"));
	assert.deepEqual(prs.state.prs.map((item) => item.label), ["acme/app#42", "acme/app#43"]);
	assert.deepEqual(issues.state.issues.map((item) => item.label), ["acme/app#7", "acme/app#8"]);
	prs.manage("add", "acme/app#50");
	issues.manage("add", "acme/app#50");
	prs.manage("remove", pr);
	issues.manage("remove", issue);
	prs.observe(start("lookup-pr", `gh pr view ${pr}`));
	issues.observe(start("lookup-issue", `gh issue view ${issue}`));
	assert.ok(!prs.state.prs.some((item) => item.url === pr));
	assert.ok(!issues.state.issues.some((item) => item.url === issue));
	prs.manage("add", pr);
	issues.manage("add", issue);
	assert.ok(prs.state.prs.some((item) => item.url === pr));
	assert.ok(issues.state.issues.some((item) => item.url === issue));
});

test("workspace names alone do not create pills and legacy reference caches are rebuilt from active evidence", async () => fixture(async (home) => {
	const id = "migration";
	const dir = join(home, "session-state", id);
	mkdirSync(dir, { recursive: true });
	const history = [
		event("session.start", { repository: "acme/app" }),
		event("user.message", { content: `For reference: ${pr} and ${issue}` }),
		start("work-pr", "gh pr checkout 43"),
		start("work-issue", "gh issue develop 8"),
	];
	const file = join(dir, "events.jsonl");
	writeFileSync(file, history.map(JSON.stringify).join("\n") + "\n");
	writeFileSync(join(dir, "workspace.yaml"), "repository: acme/app\nbranch: pr-42\nname: PR #42 and issue #7\n");
	const oldPrs = new SessionTracker(id);
	oldPrs.add(pr);
	const oldIssues = new IssueTracker(id);
	oldIssues.add(issue);
	for (const [tracker, write, field] of [[oldPrs, writeState, "prs"], [oldIssues, writeIssues, "issues"]]) {
		const state = tracker.snapshot();
		delete state.activeTrackingVersion;
		delete state[field][0].active;
		state.transcriptOffset = Buffer.byteLength(history.map(JSON.stringify).join("\n") + "\n");
		write(state, home);
	}
	assert.deepEqual(syncSession({ session_id: id }, { home, fetchPrStatus: false }).state.prs.map((item) => item.label), ["acme/app#43"]);
	assert.deepEqual(syncIssues({ session_id: id }, { home, fetchIssueStatus: false }).state.issues.map((item) => item.label), ["acme/app#8"]);
	const collector = await collect({
		sessionId: id, on: () => () => {}, getEvents: async () => history,
		rpc: { metadata: { activity: async () => ({ hasActiveWork: false }) } },
	}, { home, interval: 100000 });
	try { assert.deepEqual(readState(id, home).prs.map((item) => item.label), ["acme/app#43"]); }
	finally { collector.stop(); }
}));

test("agent remove and clear survive transcript re-indexing without stopping other agents", async () => fixture((home) => {
	const id = "agent-dismiss";
	const dir = join(home, "session-state", id);
	mkdirSync(dir, { recursive: true });
	const history = [
		event("subagent.started", { agentId: "first", toolCallId: "task-first" }),
		event("subagent.started", { agentId: "second", toolCallId: "task-second" }),
	];
	writeFileSync(join(dir, "events.jsonl"), history.map(JSON.stringify).join("\n") + "\n");
	let tracker = syncAgents({ session_id: id }, { home }).tracker;
	const stale = structuredClone(tracker.snapshot());
	stale.transcriptOffset = Number.MAX_SAFE_INTEGER;
	tracker.manage("remove", "first");
	tracker.transcriptOffset = Number.MAX_SAFE_INTEGER;
	writeAgents(tracker.snapshot(), home);
	writeAgents(stale, home);
	tracker = syncAgents({ session_id: id }, { home }).tracker;
	assert.deepEqual([...tracker.agents.keys()], ["second"]);
	tracker.manage("clear");
	tracker.transcriptOffset = Number.MAX_SAFE_INTEGER;
	writeAgents(tracker.snapshot(), home);
	tracker = syncAgents({ session_id: id }, { home }).tracker;
	assert.equal(tracker.agents.size, 0);
	tracker.observe(event("subagent.started", { agentId: "new-agent" }));
	assert.deepEqual([...tracker.agents.keys()], ["new-agent"]);
	assert.throws(() => tracker.manage("remove"), /agent ID/);
	assert.throws(() => tracker.manage("stop", "new-agent"), /list, remove, or clear/);
}));

test("legacy reference-only caches do not survive manual listing or a missing transcript", async () => fixture((home) => {
	for (const [Tracker, write, sync, field, reference, fetch] of [
		[SessionTracker, writeState, syncSession, "prs", pr, { fetchPrStatus: false }],
		[IssueTracker, writeIssues, syncIssues, "issues", issue, { fetchIssueStatus: false }],
	]) {
		const tracker = new Tracker("legacy");
		tracker.add(reference);
		const old = tracker.snapshot();
		delete old.activeTrackingVersion;
		delete old[field][0].active;
		old.calls = { old: { targeted: true, scrapeResultUrls: true, targets: [] } };
		write(old, home);
		const listed = new Tracker("legacy", old);
		assert.deepEqual(listed.manage("list"), []);
		listed.observe(complete("old", reference));
		assert.deepEqual(listed.manage("list"), []);
		assert.deepEqual(sync({ session_id: "legacy" }, { home, ...fetch }).state[field], []);
	}
}));

test("a renamed workspace cannot revive cleared checkout-linked pills", async () => fixture((home) => {
	const id = "renamed";
	const dir = join(home, "session-state", id);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "events.jsonl"), [
		event("session.start", { repository: "acme/app" }), start("checkout", "gh pr checkout 42"),
	].map(JSON.stringify).join("\n") + "\n");
	const workspace = join(dir, "workspace.yaml");
	writeFileSync(workspace, "repository: acme/app\nbranch: pr-42\n");
	const payload = { session_id: id };
	assert.equal(syncSession(payload, { home, fetchPrStatus: false }).state.prs.length, 1);
	clearSessionStatusline(payload, { home, now: 2000 });
	writeFileSync(workspace, `repository: acme/app\nbranch: pr-42\nname: Historical ${pr}\n`);
	assert.deepEqual(syncSession(payload, { home, fetchPrStatus: false }).state.prs, []);
	assert.deepEqual(syncIssues(payload, { home, fetchIssueStatus: false }).state.issues, []);
}));

test("checkout names, issue branches and remote payloads alone are not active work", async () => fixture((home) => {
	for (const branch of ["pr-42", "issue/7", "feature/topic"]) {
		const id = branch.replace(/\W/g, "-");
		const dir = join(home, "session-state", id);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "workspace.yaml"), `repository: acme/app\nbranch: ${branch}\nname: Review PR #42 and issue #7\ncwd: C:\\pr-review-app-42-abcdef0\n`);
		const payload = { session_id: id, remote: { repository: "acme/app", pull_request_number: 42 } };
		assert.deepEqual(syncSession(payload, { home, fetchPrStatus: false }).state.prs, []);
		assert.deepEqual(syncIssues(payload, { home, fetchIssueStatus: false }).state.issues, []);
	}
}));

test("agent creation results associate only with actual session launches, including global gh flags", () => {
	const tracker = new SubagentTracker("created-pr");
	tracker.observe(event("subagent.started", { agentId: "worker", agentType: "general-purpose" }));
	tracker.observe(start("lookup", `gh pr view ${pr}`, "powershell", {}, "worker"));
	tracker.observe(complete("lookup", pr));
	assert.deepEqual(tracker.agents.get("worker").prs, []);
	const creation = start("create", "gh -R acme/app pr create --title feature");
	creation.data.agentId = "worker";
	tracker.observe(creation);
	tracker.observe(complete("create", pr));
	assert.deepEqual(tracker.agents.get("worker").prs, [pr]);
	assert.equal(tracker.counts().inPr, 1);
});

test("root lookups do not promote agent-only PRs into extra detailed pills", () => {
	const tracker = new SessionTracker("ownership");
	tracker.observe(start("work", `gh pr checkout ${pr}`, "powershell", {}, "worker"));
	assert.equal(tracker.state.prs[0].provenance.root, false);
	for (const command of [`gh pr view ${pr}`, `gh pr diff ${pr}`, `gh pr checks ${pr}`, "gh api repos/acme/app/pulls/42"]) {
		tracker.observe(start(command, command));
	}
	assert.equal(tracker.state.prs[0].provenance.root, false);
	tracker.manage("add", pr);
	assert.equal(tracker.state.prs[0].provenance.root, true);
});

test("rejected enrollment history cannot prevent collector startup or later live tracking", async () => fixture(async (home) => {
	let handler;
	let unsubscribed = false;
	const history = [event("session.start", { repository: "acme/app" })];
	for (const [index, reference] of [undefined, "#42", "not a URL", issue].entries()) {
		history.push(start(`rejected-${index}`, "", "session_prs", { action: "add", reference }));
		history.push(event("tool.execution_complete", { toolCallId: `rejected-${index}`, success: false }));
	}
	history.push(start("concrete-work", "gh pr checkout 43"));
	const collector = await collect({
		sessionId: "rejected-history",
		on(fn) { handler = fn; return () => { unsubscribed = true; }; },
		getEvents: async () => history,
		rpc: { metadata: { activity: async () => ({ hasActiveWork: true }) } },
	}, { home, interval: 100000 });
	try {
		assert.equal(unsubscribed, false);
		assert.deepEqual(readState("rejected-history", home).prs.map((item) => item.label), ["acme/app#43"]);
		handler(start("live-work", "", "session_prs", { action: "add", reference: "acme/app#44" }));
		assert.deepEqual(readState("rejected-history", home).prs.map((item) => item.label), ["acme/app#43", "acme/app#44"]);
	} finally { collector.stop(); }
	assert.equal(unsubscribed, true);
}));

for (const [command, content] of [
	["gh pr edit --add-label active", pr],
	["gh pr review --approve", pr],
	["gh pr ready", pr],
	["gh pr comment --body done", `${pr}#issuecomment-123`],
	["gh pr merge --squash", pr],
]) {
	test(`selector-free ${command} recovers its standalone successful target for root and agent tracking`, () => {
		const prs = new SessionTracker("implicit-root");
		const agents = new SubagentTracker("implicit-agent");
		for (const tracker of [prs, agents]) tracker.observe(event("session.start", { repository: "acme/app" }));
		agents.observe(event("subagent.started", { agentId: "worker", agentType: "general-purpose" }));
		prs.observe(start("write", command));
		agents.observe(start("write", command, "powershell", {}, "worker"));
		for (const tracker of [prs, agents]) tracker.observe(complete("write", `${content}\n`));
		assert.deepEqual(prs.state.prs.map((item) => item.url), [pr]);
		assert.equal(prs.state.prs[0].provenance.root, true);
		assert.deepEqual(agents.agents.get("worker").prs, [pr]);
		assert.equal(prs.state.prs[0].mergedAt, undefined, "command success is not remote merge confirmation");
		assert.deepEqual(agents.agents.get("worker").mergedPrs, []);
	});
}

test("implicit target recovery rejects incidental, compound, failed, read-only and unrelated explicit-target results", () => {
	for (const [command, content, success, expected] of [
		["gh pr edit --add-label active", `Related: ${pr}`, true, []],
		["gh pr edit --add-label active", `${pr}\nhttps://github.com/acme/app/pull/99`, true, []],
		["gh pr edit --add-label active", JSON.stringify({ url: pr }), true, []],
		["gh pr edit --add-label active", `${pr}/files`, true, []],
		["gh pr edit --add-label active; gh pr view 42 --json url", pr, true, []],
		["gh pr edit --add-label active", pr, false, []],
		["gh pr view", pr, true, []],
		["gh pr edit 43 --add-label active", pr, true, ["https://github.com/acme/app/pull/43"]],
	]) {
		const prs = new SessionTracker("non-target-root");
		const agents = new SubagentTracker("non-target-agent");
		for (const tracker of [prs, agents]) tracker.observe(event("session.start", { repository: "acme/app" }));
		agents.observe(event("subagent.started", { agentId: "worker", agentType: "general-purpose" }));
		prs.observe(start("operation", command));
		agents.observe(start("operation", command, "powershell", {}, "worker"));
		for (const tracker of [prs, agents]) {
			tracker.observe(event("tool.execution_complete", { toolCallId: "operation", success, result: { content } }));
		}
		assert.deepEqual(prs.state.prs.map((item) => item.url), expected, command);
		assert.deepEqual(agents.agents.get("worker").prs, expected, command);
	}
});

test("a fresh selector-free reopen can explicitly restore a dismissed PR", () => {
	const tracker = new SessionTracker("implicit-reopen");
	tracker.manage("add", pr);
	tracker.manage("remove", pr);
	tracker.observe(start("reopen", "gh pr reopen"));
	tracker.observe(complete("reopen", pr));
	assert.deepEqual(tracker.state.prs.map((item) => item.url), [pr]);
	assert.equal(tracker.state.prs[0].generation, 1);
	assert.ok(!tracker.state.ignored.includes(pr));
});

for (const [command, expected] of [
	["gh pr checkout --force 42 --repo other/project", ["https://github.com/other/project/pull/42"]],
	["gh pr checkout --repo other/project --branch 99 42", ["https://github.com/other/project/pull/42"]],
	['gh pr checkout --worktree "42" 43 --repo other/project', ["https://github.com/other/project/pull/43"]],
	['gh pr checkout --worktree "C:\\path with 99" --branch "123" 43 --repo other/project', ["https://github.com/other/project/pull/43"]],
	['gh -Rother/project pr checkout --force "42"', ["https://github.com/other/project/pull/42"]],
	["gh pr co --force 42 --repo other/project", ["https://github.com/other/project/pull/42"]],
	["gh pr checkout 42 --repo github.example.com/other/project", ["https://github.example.com/other/project/pull/42"]],
	["gh pr checkout 42 --repo https://github.example.com/other/project", ["https://github.example.com/other/project/pull/42"]],
	["Set-Location C:\\other-project; gh pr checkout 42", []],
	["cd C:\\other-project; gh pr checkout 42 --repo other/project", ["https://github.com/other/project/pull/42"]],
	["Push-Location C:\\other-project; gh pr checkout https://github.com/other/project/pull/42", ["https://github.com/other/project/pull/42"]],
	["gh pr checkout 42 --repo not-a-qualified-repo", []],
	["gh pr checkout 42 --repo http://github.example.com/other/project", []],
	["gh pr checkout feature-42 --branch 99 --repo other/project", []],
	["gh pr checkout --force https://github.com/other/project/pull/42", ["https://github.com/other/project/pull/42"]],
	["gh pr checkout -Rother/project -b99 42", ["https://github.com/other/project/pull/42"]],
]) {
	test(`root and agent checkout targets agree without guessing: ${command}`, () => {
		const prs = new SessionTracker("checkout-root");
		const agents = new SubagentTracker("checkout-agent");
		for (const tracker of [prs, agents]) tracker.observe(event("session.start", { repository: "acme/app" }));
		agents.observe(event("subagent.started", { agentId: "worker", agentType: "general-purpose" }));
		prs.observe(start("checkout", command));
		agents.observe(start("checkout", command, "powershell", {}, "worker"));
		for (const tracker of [prs, agents]) tracker.observe(complete("checkout", "Switched to branch feature"));
		assert.deepEqual(prs.state.prs.map((item) => item.url), expected, "root target");
		assert.deepEqual(agents.agents.get("worker").prs, expected, "agent target");
	});
}

for (const flag of ["--comment", "-c", "--request-changes", "-r", "--approve"]) {
	for (const selector of ["42", "https://github.com/other/project/pull/42"]) {
		test(`boolean review flag ${flag} cannot consume the root or agent PR selector ${selector}`, () => {
			const command = `gh pr review ${flag} ${selector} --body LGTM --repo other/project`;
			const prs = new SessionTracker("review-root");
			const agents = new SubagentTracker("review-agent");
			for (const tracker of [prs, agents]) tracker.observe(event("session.start", { repository: "acme/app" }));
			agents.observe(event("subagent.started", { agentId: "worker", agentType: "general-purpose" }));
			prs.observe(start("review", command));
			agents.observe(start("review", command, "powershell", {}, "worker"));
			for (const tracker of [prs, agents]) tracker.observe(complete("review", "Review submitted"));
			assert.deepEqual(prs.state.prs.map((item) => item.url), ["https://github.com/other/project/pull/42"]);
			assert.deepEqual(agents.agents.get("worker").prs, ["https://github.com/other/project/pull/42"]);
		});
	}
}
