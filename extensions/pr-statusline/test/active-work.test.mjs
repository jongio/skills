import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { collect } from "../collector.mjs";
import { clearSessionStatusline } from "../session-statusline.mjs";
import { SessionTracker, readState, syncSession, writeState } from "../tracker.mjs";
import { IssueTracker, syncSession as syncIssues, writeState as writeIssues } from "../../issue-statusline/tracker.mjs";
import { SubagentTracker, readState as readAgents, syncSession as syncAgents, writeState as writeAgents } from "../../subagent-statusline/tracker.mjs";
import { configureStatuslines } from "../../../scripts/setup-statusline.mjs";
import { composeStatusLine } from "../../worktree-statusline/compose.mjs";

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
		start("mcp-write-pr", "", "github_update_pull_request", { owner: "acme", repo: "app", pullNumber: 42 }),
		complete("mcp-write-pr", pr),
		start("mcp-write-issue", "", "github_issue_write", { owner: "acme", repo: "app", issue_number: 7, state: "open" }),
		complete("mcp-write-issue", issue),
		start("project-task", "", "project_task", { agent_type: "general-purpose", description: "Update a project task, not launch an agent" }),
		start("generic-task", "", "task", { title: "Project task" }),
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

test("explicit ownership persists through restart and unowned rows never survive a current-policy cache", async () => fixture((home) => {
	for (const [Tracker, write, sync, field, reference] of [
		[SessionTracker, writeState, syncSession, "prs", pr],
		[IssueTracker, writeIssues, syncIssues, "issues", issue],
	]) {
		const tracker = new Tracker("owned-restart");
		tracker.manage("add", reference);
		const state = tracker.snapshot();
		state[field].push({ ...state[field][0], url: reference.replace(/\/\d+$/, "/99"), owned: false, active: true });
		write(state, home);
		const current = sync({ session_id: "owned-restart" }, { home, fetchPrStatus: false, fetchIssueStatus: false }).state;
		assert.deepEqual(current[field].map((item) => item.url), [reference]);
		const restored = new Tracker("owned-restart", current);
		assert.equal(restored.manage("list")[0].owned, true);
		restored.manage("clear");
		write(restored.snapshot(), home);
		assert.deepEqual(sync({ session_id: "owned-restart" }, { home, fetchPrStatus: false, fetchIssueStatus: false }).state[field], []);
	}
}));

test("only explicit enrollment tracks targets; shell writes and results do not", () => {
	const prs = new SessionTracker("active");
	const issues = new IssueTracker("active");
	for (const tracker of [prs, issues]) tracker.observe(event("session.start", { repository: "acme/app" }));
	prs.observe(start("checkout", `gh pr checkout ${pr}`));
	prs.observe(start("edit", `gh pr edit 43 --body 'See https://github.com/acme/app/pull/99'`));
	prs.observe(complete("edit", "Related: https://github.com/acme/app/pull/98"));
	issues.observe(start("develop", "gh issue develop 7"));
	issues.observe(start("comment", "gh issue comment 8 --body 'See https://github.com/acme/app/issues/99'"));
	issues.observe(complete("comment", "Related: https://github.com/acme/app/issues/98"));
	assert.deepEqual(prs.state.prs, []);
	assert.deepEqual(issues.state.issues, []);
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

test("workspace names and legacy shell history cannot restore unowned pills", async () => fixture(async (home) => {
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
		delete state[field][0].owned;
		state.transcriptOffset = Buffer.byteLength(history.map(JSON.stringify).join("\n") + "\n");
		write(state, home);
	}
	assert.deepEqual(syncSession({ session_id: id }, { home, fetchPrStatus: false }).state.prs, []);
	assert.deepEqual(syncIssues({ session_id: id }, { home, fetchIssueStatus: false }).state.issues, []);
	const collector = await collect({
		sessionId: id, on: () => () => {}, getEvents: async () => history,
		rpc: { metadata: { activity: async () => ({ hasActiveWork: false }) } },
	}, { home, interval: 100000 });
	try { assert.deepEqual(readState(id, home).prs, []); }
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
	tracker.observe({ ...event("subagent.started", { agentId: "new-agent" }), timestamp: new Date(Date.now() + 1).toISOString() });
	assert.deepEqual([...tracker.agents.keys()], ["new-agent"]);
	assert.throws(() => tracker.manage("remove"), /agent ID/);
	assert.throws(() => tracker.manage("stop", "new-agent"), /list, remove, or clear/);
}));

for (const partial of [false, true]) {
	test(`component-only agent clear suppresses unread ${partial ? "partial" : "complete"} pre-clear launches but accepts new work`, async (t) => fixture((home) => {
		const id = `component-clear-${partial}`;
		const dir = join(home, "session-state", id);
		mkdirSync(dir, { recursive: true });
		const file = join(dir, "events.jsonl");
		const first = event("subagent.started", { agentId: "observed", toolCallId: "observed-call" });
		writeFileSync(file, JSON.stringify(first) + "\n");
		const tracker = syncAgents({ session_id: id }, { home }).tracker;
		const unread = { ...event("subagent.started", { agentId: "unread", toolCallId: "unread-call" }), timestamp: new Date(1500).toISOString() };
		appendFileSync(file, JSON.stringify(unread) + (partial ? "" : "\n"));
		t.mock.method(Date, "now", () => 2000);
		tracker.manage("clear");
		writeAgents(tracker.snapshot(), home);
		const fresh = { ...event("subagent.started", { agentId: "fresh" }), timestamp: new Date(2500).toISOString() };
		appendFileSync(file, (partial ? "\n" : "") + JSON.stringify(fresh) + "\n");
		const current = syncAgents({ session_id: id }, { home }).tracker;
		assert.deepEqual([...current.agents.keys()], ["fresh"]);
		assert.ok(current.ignored.has("unread"));
		assert.ok(current.ignored.has("unread-call"));
		assert.equal(current.dismissedThroughAt, 2000);
	}));
}

for (const duringSync of [false, true]) {
	test(`component-only clear rejects an unread-launch stale save${duringSync ? " and returns the saved tracker" : ""}`, async (t) => fixture((home) => {
		const id = `stale-agent-clear-${duringSync}`;
		const dir = join(home, "session-state", id);
		mkdirSync(dir, { recursive: true });
		const file = join(dir, "events.jsonl");
		writeFileSync(file, JSON.stringify(event("subagent.started", { agentId: "observed" })) + "\n");
		const clearing = syncAgents({ session_id: id }, { home }).tracker;
		const offset = clearing.transcriptOffset;
		const unread = { ...event("subagent.started", { agentId: "unread" }), timestamp: new Date(1500).toISOString() };
		appendFileSync(file, JSON.stringify(unread) + "\n");
		const snapshot = SubagentTracker.prototype.snapshot;
		let returned;
		if (duringSync) {
			let interleaved = false;
			t.mock.method(SubagentTracker.prototype, "snapshot", function () {
				const stale = snapshot.call(this);
				if (!interleaved) {
					interleaved = true;
					clearing.clear(2000);
					writeAgents(snapshot.call(clearing), home);
				}
				return stale;
			});
			returned = syncAgents({ session_id: id }, { home }).tracker;
			assert.equal(interleaved, true);
		} else {
			const stale = syncAgents({ session_id: id }, { home }).tracker.snapshot();
			clearing.clear(2000);
			writeAgents(clearing.snapshot(), home);
			returned = new SubagentTracker(id, writeAgents(stale, home));
		}
		assert.equal(returned.agents.size, 0, "a stale returned tracker must not render a dismissed launch");
		assert.equal(returned.dismissedThroughAt, 2000);
		assert.equal(readAgents(id, home).transcriptOffset, offset, "the stale cursor must not consume the unread launch");
		const fresh = { ...event("subagent.started", { agentId: "fresh" }), timestamp: new Date(2500).toISOString() };
		appendFileSync(file, JSON.stringify(fresh) + "\n");
		const current = syncAgents({ session_id: id }, { home }).tracker;
		assert.deepEqual([...current.agents.keys()], ["fresh"]);
		assert.ok(current.ignored.has("unread"));
	}));
}

test("sync returns saved agent removal even when dismissal clocks do not change", async (t) => fixture((home) => {
	const id = "concurrent-agent-remove";
	const dir = join(home, "session-state", id);
	mkdirSync(dir, { recursive: true });
	const file = join(dir, "events.jsonl");
	writeFileSync(file, ["keep", "removed"].map((agentId) =>
		JSON.stringify(event("subagent.started", { agentId, toolCallId: `${agentId}-call` }))).join("\n") + "\n");
	syncAgents({ session_id: id }, { home });
	appendFileSync(file, JSON.stringify(event("subagent.completed", { agentId: "keep" })) + "\n");
	const snapshot = SubagentTracker.prototype.snapshot;
	let interleaved = false;
	t.mock.method(SubagentTracker.prototype, "snapshot", function () {
		const stale = snapshot.call(this);
		if (!interleaved) {
			interleaved = true;
			const removal = new SubagentTracker(id, readAgents(id, home));
			removal.manage("remove", "removed");
			writeAgents(snapshot.call(removal), home);
		}
		return stale;
	});
	const current = syncAgents({ session_id: id }, { home }).tracker;
	assert.equal(interleaved, true);
	assert.deepEqual([...current.agents.keys()], ["keep"]);
	assert.equal(current.agents.get("keep").status, "completed");
	assert.ok(current.ignored.has("removed"));
	assert.ok(current.ignored.has("removed-call"));
	assert.equal(current.taskCalls.has("removed-call"), false);
	assert.deepEqual(Object.keys(readAgents(id, home).agents), ["keep"]);
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
		delete old[field][0].owned;
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
	const tracker = new SessionTracker(id);
	tracker.manage("add", pr);
	writeState(tracker.snapshot(), home);
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

test("only successful explicit tracking controls associate PRs with actual session agents", () => {
	const tracker = new SubagentTracker("created-pr");
	tracker.observe(event("subagent.started", { agentId: "worker", agentType: "general-purpose" }));
	tracker.observe(start("lookup", `gh pr view ${pr}`, "powershell", {}, "worker"));
	tracker.observe(complete("lookup", pr));
	assert.deepEqual(tracker.agents.get("worker").prs, []);
	const creation = start("create", "gh -R acme/app pr create --title feature");
	creation.data.agentId = "worker";
	tracker.observe(creation);
	tracker.observe(complete("create", pr));
	assert.deepEqual(tracker.agents.get("worker").prs, []);
	tracker.observe(start("claim", "", "session_prs", { action: "add", reference: pr }, "worker"));
	assert.deepEqual(tracker.agents.get("worker").prs, [], "an attempted control call is not successful ownership");
	tracker.observe(complete("claim", "Tracked"));
	assert.deepEqual(tracker.agents.get("worker").prs, [pr]);
	assert.equal(tracker.counts().inPr, 1);
});

test("root lookups do not promote agent-only PRs into extra detailed pills", () => {
	const tracker = new SessionTracker("ownership");
	tracker.manage("add", pr, { agentId: "worker" });
	assert.equal(tracker.state.prs[0].provenance.root, false);
	for (const command of [`gh pr view ${pr}`, `gh pr diff ${pr}`, `gh pr checks ${pr}`, "gh api repos/acme/app/pulls/42"]) {
		tracker.observe(start(command, command));
	}
	assert.equal(tracker.state.prs[0].provenance.root, false);
	tracker.manage("add", pr);
	assert.equal(tracker.state.prs[0].provenance.root, true);
});

test("an explicit re-add with unproven attribution restores detailed PR visibility", async () => fixture(async (home) => {
	configureStatuslines({ home, enabled: ["pr-statusline", "subagent-statusline"] });
	const tracker = new SessionTracker("unknown-readd");
	tracker.manage("add", pr, { agentId: "worker" });
	tracker.add(pr, false, null);
	assert.equal(tracker.state.prs[0].provenance.unknown, false, "non-explicit adds do not alter proven attribution");
	const agents = new SubagentTracker("unknown-readd");
	agents.ensureAgent("worker", { agentType: "general-purpose" });
	agents.linkPr("worker", pr);
	writeAgents(agents.snapshot(), home);
	writeState(tracker.snapshot(), home);
	const options = { home, color: false, links: false, nerdFont: false };
	assert.ok(!(await composeStatusLine({ session_id: "unknown-readd" }, options)).includes("acme/app#42"));
	tracker.manage("add", pr, null);
	writeState(tracker.snapshot(), home);
	const output = await composeStatusLine({ session_id: "unknown-readd" }, options);
	assert.ok(output.includes("acme/app#42"), output);
	assert.deepEqual(tracker.state.prs[0].provenance, { root: false, unknown: true, agents: ["worker"] });
}));

test("legacy agents without transcripts are dropped rather than promoted to verified tracking", async () => fixture((home) => {
	const tracker = new SubagentTracker("legacy-orphans");
	tracker.ensureAgent("generic-project-task");
	tracker.ensureAgent("plausible-worker", { agentType: "general-purpose" });
	tracker.taskCalls.set("old-task", "generic-project-task");
	const legacy = tracker.snapshot();
	legacy.activeTrackingVersion = 1;
	writeAgents(legacy, home);
	assert.deepEqual(new SubagentTracker("legacy-orphans", legacy).manage("list"), []);
	const current = syncAgents({ session_id: "legacy-orphans" }, { home }).tracker;
	assert.equal(current.agents.size, 0);
	assert.equal(current.taskCalls.size, 0);
	assert.equal(current.snapshot().activeTrackingVersion, 2);
}));

test("verified and simulated agent caches remain usable without a transcript", async () => fixture((home) => {
	for (const simulated of [false, true]) {
		const id = `retained-${simulated}`;
		const tracker = new SubagentTracker(id);
		tracker.ensureAgent("worker");
		const state = tracker.snapshot();
		if (simulated) {
			state.activeTrackingVersion = 1;
			state.simulated = true;
		}
		writeAgents(state, home);
		assert.deepEqual([...syncAgents({ session_id: id }, { home }).tracker.agents.keys()], ["worker"]);
	}
}));

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
		assert.deepEqual(readState("rejected-history", home).prs, []);
		handler(start("live-work", "", "session_prs", { action: "add", reference: "acme/app#44" }, "worker"));
		assert.deepEqual(readState("rejected-history", home).prs, [], "recording an attempted call is not enrollment");
		collector.manage("add", "acme/app#44", "live-work");
		const owned = readState("rejected-history", home).prs;
		assert.deepEqual(owned.map((item) => item.label), ["acme/app#44"]);
		assert.equal(owned[0].owned, true);
		assert.deepEqual(owned[0].provenance, { root: false, unknown: false, agents: ["worker"] });
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
	test(`selector-free ${command} never enrolls its successful result`, () => {
		const prs = new SessionTracker("implicit-root");
		const agents = new SubagentTracker("implicit-agent");
		for (const tracker of [prs, agents]) tracker.observe(event("session.start", { repository: "acme/app" }));
		agents.observe(event("subagent.started", { agentId: "worker", agentType: "general-purpose" }));
		prs.observe(start("write", command));
		agents.observe(start("write", command, "powershell", {}, "worker"));
		for (const tracker of [prs, agents]) tracker.observe(complete("write", `${content}\n`));
		assert.deepEqual(prs.state.prs, []);
		assert.deepEqual(agents.agents.get("worker").prs, []);
		assert.deepEqual(agents.agents.get("worker").mergedPrs, []);
	});
}

test("shell targets and results never establish ownership regardless of success or quoting", () => {
	for (const [command, content, success] of [
		["gh pr edit --add-label active", `Related: ${pr}`, true, []],
		["gh pr edit --add-label active", `${pr}\nhttps://github.com/acme/app/pull/99`, true, []],
		["gh pr edit --add-label active", JSON.stringify({ url: pr }), true, []],
		["gh pr edit --add-label active", `${pr}/files`, true, []],
		["gh pr edit --add-label active; gh pr view 42 --json url", pr, true, []],
		["gh pr edit --add-label active", pr, false, []],
		["gh pr view", pr, true, []],
		["gh pr edit 43 --add-label active", pr, true, ["https://github.com/acme/app/pull/43"]],
		['gh pr edit 43 --body="Fix 99"', pr, true],
		['gh pr merge --match-head-commit abcdef1234 43', pr, true],
		['rg "gh pr checkout 42" README.md', pr, true],
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
		assert.deepEqual(prs.state.prs, [], command);
		assert.deepEqual(agents.agents.get("worker").prs, [], command);
	}
});

test("a fresh shell reopen cannot restore a dismissed PR; an explicit control can", () => {
	const tracker = new SessionTracker("implicit-reopen");
	tracker.manage("add", pr);
	tracker.manage("remove", pr);
	tracker.observe(start("reopen", "gh pr reopen"));
	tracker.observe(complete("reopen", pr));
	assert.deepEqual(tracker.state.prs, []);
	tracker.manage("add", pr);
	assert.deepEqual(tracker.state.prs.map((item) => item.url), [pr]);
	assert.equal(tracker.state.prs[0].generation, 1);
	assert.ok(!tracker.state.ignored.includes(pr));
});

for (const [command] of [
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
	test(`checkout does not enroll root or agent ownership: ${command}`, () => {
		const prs = new SessionTracker("checkout-root");
		const agents = new SubagentTracker("checkout-agent");
		for (const tracker of [prs, agents]) tracker.observe(event("session.start", { repository: "acme/app" }));
		agents.observe(event("subagent.started", { agentId: "worker", agentType: "general-purpose" }));
		prs.observe(start("checkout", command));
		agents.observe(start("checkout", command, "powershell", {}, "worker"));
		for (const tracker of [prs, agents]) tracker.observe(complete("checkout", "Switched to branch feature"));
		assert.deepEqual(prs.state.prs, [], "root target");
		assert.deepEqual(agents.agents.get("worker").prs, [], "agent target");
	});
}

for (const flag of ["--comment", "-c", "--request-changes", "-r", "--approve"]) {
	for (const selector of ["42", "https://github.com/other/project/pull/42"]) {
		test(`review flag ${flag} and selector ${selector} cannot establish ownership`, () => {
			const command = `gh pr review ${flag} ${selector} --body LGTM --repo other/project`;
			const prs = new SessionTracker("review-root");
			const agents = new SubagentTracker("review-agent");
			for (const tracker of [prs, agents]) tracker.observe(event("session.start", { repository: "acme/app" }));
			agents.observe(event("subagent.started", { agentId: "worker", agentType: "general-purpose" }));
			prs.observe(start("review", command));
			agents.observe(start("review", command, "powershell", {}, "worker"));
			for (const tracker of [prs, agents]) tracker.observe(complete("review", "Review submitted"));
			assert.deepEqual(prs.state.prs, []);
			assert.deepEqual(agents.agents.get("worker").prs, []);
		});
	}
}
