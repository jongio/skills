import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { composeStatusLine } from "../compose.mjs";
import { EXTENSION_CATALOG, configureStatuslines } from "../../../scripts/setup-statusline.mjs";
import { SessionTracker, readState, writeState } from "../../pr-statusline/tracker.mjs";
import { OCTICONS } from "../../pr-statusline/github.mjs";
import { mergePrProvenance, normalizePrProvenance, sourceProvenance } from "../../pr-statusline/provenance.mjs";
import { render as renderPr } from "../../pr-statusline/render.mjs";
import { IssueTracker, writeState as writeIssues } from "../../issue-statusline/tracker.mjs";
import { SubagentTracker, writeState as writeAgents } from "../../subagent-statusline/tracker.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const plain = { color: false, links: false, nerdFont: false };
const url = (number) => `https://github.com/org/one/pull/${number}`;
const event = (type, data, agentId) => ({ type, data, agentId });

function workPr(tracker, number, agentId) {
	tracker.manage("add", url(number), agentId ? { agentId } : { root: true });
}

test("PR ownership records direct root work, excludes delegation, and never upgrades unknown history to agent-only", () => {
	const tracker = new SessionTracker("ownership");
	workPr(tracker, 1, "child");
	assert.deepEqual(tracker.state.prs[0].provenance, { root: false, unknown: false, agents: ["child"] });
	workPr(tracker, 1);
	assert.equal(tracker.state.prs[0].provenance.root, true);
	workPr(tracker, 2);
	workPr(tracker, 2, "child");
	assert.equal(tracker.state.prs[1].provenance.root, true);
	tracker.add(url(3));
	workPr(tracker, 3, "child");
	assert.equal(tracker.state.prs[2].provenance.unknown, true);
	tracker.observe(event("tool.execution_start", {
		toolCallId: "delegated", toolName: "task",
		arguments: { agent_type: "general-purpose", prompt: `Implement ${url(4)}` },
	}));
	assert.equal(tracker.state.prs.length, 3, "a delegated prompt reference alone does not enroll a PR");
	workPr(tracker, 4, "child");
	assert.deepEqual(tracker.state.prs[3].provenance, { root: false, unknown: false, agents: ["child"] });
	tracker.observe(event("user.message", { content: `Please work on ${url(5)}` }));
	tracker.manage("add", url(5));
	assert.equal(tracker.state.prs[4].provenance.root, true);
	tracker.manage("add", url(6));
	assert.equal(tracker.state.prs[5].provenance.root, true);
	const creating = event("tool.execution_start", {
		toolCallId: "create", toolName: "powershell", arguments: { command: "gh pr create" },
	}, "creator");
	tracker.observe(creating);
	tracker.observe(event("tool.execution_complete", {
		toolCallId: "create", success: true, result: { content: url(7) },
	}));
	assert.equal(tracker.state.prs.length, 6, "creation output cannot infer ownership");
	workPr(tracker, 7, "creator");
	assert.deepEqual(tracker.state.prs[6].provenance, { root: false, unknown: false, agents: ["creator"] });
	tracker.observe(event("tool.execution_start", {
		toolCallId: "diff", toolName: "powershell", arguments: { command: `gh pr diff ${url(7)}` },
	}));
	assert.equal(tracker.state.prs[6].provenance.root, false, "a root lookup does not expand an agent-only PR into another pill");
	tracker.manage("add", url(7));
	assert.equal(tracker.state.prs[6].provenance.root, true, "explicit root review enrollment retains detailed PR status");
	assert.deepEqual(normalizePrProvenance({ root: "false" }), { root: false, unknown: true, agents: [] });
	assert.deepEqual(normalizePrProvenance({ root: false, unknown: false, agents: ["a", "a", null] }),
		{ root: false, unknown: false, agents: ["a"] });
	assert.deepEqual(mergePrProvenance(sourceProvenance({ agentId: "a" }), sourceProvenance({ root: true })),
		{ root: true, unknown: false, agents: ["a"] });
	assert.equal(mergePrProvenance(undefined, sourceProvenance({ agentId: "a" })).unknown, true);
	const multiPrAgent = new SubagentTracker("many-prs");
	multiPrAgent.ensureAgent("one-agent");
	for (let number = 1; number <= 20; number++) multiPrAgent.linkPr("one-agent", url(number));
	assert.equal(multiPrAgent.counts().inPr, 1, "summary counts agents rather than PRs");
});

test("20 subagent-only PRs collapse into one overall summary while root, unknown and linked issues remain visible", async () => {
	const root = mkdtempSync(join(tmpdir(), "statusline-compact-"));
	try {
		const repository = join(root, "checkout");
		mkdirSync(repository);
		for (const args of [
			["init", "--initial-branch=main"],
			["remote", "add", "origin", "https://github.com/org/one.git"],
		]) {
			const result = spawnSync("git", ["-C", repository, ...args], { encoding: "utf8", timeout: 10000, windowsHide: true });
			assert.ifError(result.error);
			assert.equal(result.status, 0, result.stderr);
		}
		const home = join(root, "home");
		configureStatuslines({ home, repoRoot, enabled: EXTENSION_CATALOG.map((item) => item.id) });
		const directory = join(home, "session-state", "compact");
		mkdirSync(directory, { recursive: true });
		const transcript = join(directory, "events.jsonl");
		writeFileSync(transcript, JSON.stringify(event("session.start", { cwd: repository })) + "\n");
		const offset = statSync(transcript).size;
		const now = Date.now();
		const prs = new SessionTracker("compact");
		const agents = new SubagentTracker("compact");
		for (let number = 1; number <= 20; number++) {
			workPr(prs, number, `agent-${number}`);
			agents.ensureAgent(`agent-${number}`);
			agents.linkPr(`agent-${number}`, url(number));
		}
		workPr(prs, 100);
		workPr(prs, 100, "shared");
		agents.ensureAgent("shared");
		agents.linkPr("shared", url(100));
		prs.add(url(101));
		workPr(prs, 101, "legacy");
		agents.ensureAgent("legacy");
		agents.linkPr("legacy", url(101));
		workPr(prs, 102, "merged");
		agents.ensureAgent("merged");
		agents.linkPr("merged", url(102), true);
		agents.ensureAgent("starting");
		agents.ensureAgent("exploring", { agentType: "explore" });
		agents.ensureAgent("failed").status = "failed";
		for (const pr of prs.state.prs) Object.assign(pr, {
			headRefName: "main", headRepositoryUrl: "https://github.com/org/one",
			status: `${OCTICONS.pass} 1/1 ${OCTICONS.approved} 0/0 ${OCTICONS.comment} 0/0`, checkedAt: now,
		});
		prs.state.prs.find((pr) => pr.url === url(102)).mergedAt = now;
		const issueUrl = "https://github.com/org/one/issues/1";
		prs.state.prs[0].issueUrls = [issueUrl];
		delete prs.state.prs.find((pr) => pr.url === url(101)).provenance;
		prs.state.transcriptOffset = offset;
		writeState(prs.snapshot(), home);
		assert.equal(readState("compact", home).prs[0].provenance.unknown, false);
		assert.equal(readState("compact", home).prs.find((pr) => pr.url === url(101)).provenance.unknown, true);
		const issues = new IssueTracker("compact");
		issues.add(issueUrl);
		Object.assign(issues.state.issues[0], { status: "\uF075 0", checkedAt: now });
		issues.state.transcriptOffset = offset;
		writeIssues(issues.snapshot(), home);
		agents.transcriptOffset = offset;
		writeAgents(agents.snapshot(), home);
		const payload = { session_id: "compact", cwd: root };
		const configPath = join(home, "statusline-config.json");
		const config = readFileSync(configPath, "utf8");
		const settingsPath = join(home, "settings.json");
		const settings = readFileSync(settingsPath, "utf8");
		const output = await composeStatusLine(payload, { home, now, ...plain });
		for (let number = 1; number <= 20; number++) assert.ok(!output.includes(`(${url(number)})`), output);
		assert.ok(!output.includes(`(${url(102)})`), output);
		assert.ok(output.includes(`(${url(100)})`) && output.includes(`(${url(101)})`), output);
		assert.ok(output.split("\n")[0].includes(issueUrl), "issues stay associated through compacted PR metadata");
		assert.equal(output.split("\n").length, 2);
		for (const part of ["1 starting", "1 exploring", "22 in PR", "1 merged", "1 failed"]) {
			assert.equal(output.split(part).length - 1, 1, output);
		}
		assert.doesNotMatch(output.split("\n")[1], /^(?:Session|[ \t·])/);
		assert.equal(readFileSync(configPath, "utf8"), config);
		assert.equal(readFileSync(settingsPath, "utf8"), settings);
		const colored = await composeStatusLine(payload, { home, now, color: true, links: true });
		assert.equal(colored.split("22 in PR").length - 1, 1);
		assert.ok(colored.split("\n")[1].startsWith("\x1b["), colored);
		assert.ok(!colored.includes(`\x1b]8;;${url(1)}\x07`), colored);
		writeFileSync(configPath, JSON.stringify({ enabled: ["pr-statusline", "subagent-statusline"] }));
		const horizontal = await composeStatusLine(payload, { home, now, ...plain });
		assert.ok(!horizontal.includes(`(${url(1)})`), horizontal);
		assert.ok(horizontal.includes("22 in PR"), horizontal);
		writeFileSync(configPath, JSON.stringify({ enabled: ["pr-statusline", "worktree-statusline"] }));
		const withoutAgents = await composeStatusLine(payload, { home, now, ...plain });
		for (let number = 1; number <= 20; number++) assert.ok(withoutAgents.includes(`org/one#${number} (`), withoutAgents);
		assert.ok(!withoutAgents.includes("22 in PR"));
		assert.ok(renderPr(payload, { home, ...plain }).includes("org/one#1 ("), "standalone PR rendering remains detailed");
		writeFileSync(configPath, JSON.stringify({ enabled: ["pr-statusline", "subagent-statusline", "worktree-statusline"] }));
		agents.dismissed = true;
		writeAgents(agents.snapshot(), home);
		const dismissed = await composeStatusLine(payload, { home, now, ...plain });
		assert.ok(dismissed.includes(`(${url(1)})`) && !dismissed.includes("22 in PR"), dismissed);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
