import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { composeGroups, repositoryKey } from "../grouping.mjs";
import { checkoutKey, sessionContexts, sessionDirectory } from "../tracker.mjs";
import { composeStatusLine, ensurePluginStatuslineRegistered } from "../compose.mjs";
import { EXTENSION_CATALOG, SHARED_RUNTIME_FILES, configureStatuslines } from "../../../scripts/setup-statusline.mjs";
import { SessionTracker, readState as readPrState, writeState as writePrState } from "../../pr-statusline/tracker.mjs";
import { OCTICONS, prContextFields, refreshTrackedPrStatuses, summarizePrStatus, writePrCache } from "../../pr-statusline/github.mjs";
import { IssueTracker, readState as readIssueState, writeState as writeIssueState } from "../../issue-statusline/tracker.mjs";
import { issueContextFields, refreshTrackedIssueStatuses, writeIssueCache } from "../../issue-statusline/github.mjs";
import { SubagentTracker, writeState as writeAgentState } from "../../subagent-statusline/tracker.mjs";
import { render as renderPr, renderEntries as prEntries } from "../../pr-statusline/render.mjs";
import { render as renderIssue, renderEntries as issueEntries } from "../../issue-statusline/render.mjs";
import { render as renderAgents, renderEntries as agentEntries, renderGroup } from "../../subagent-statusline/render.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const plain = { color: false, links: false, nerdFont: false };
const prUrl = (number) => `https://github.com/org/one/pull/${number}`;
const issueUrl = (number) => `https://github.com/org/one/issues/${number}`;
const event = (type, data, agentId) => ({ type, data, agentId });

async function fixture(run) {
	const root = realpathSync.native(mkdtempSync(join(tmpdir(), "statusline-grouping-")));
	try {
		return await run(root);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

function git(cwd, ...args) {
	const result = spawnSync("git", ["-C", cwd, ...args], {
		encoding: "utf8", timeout: 10000, windowsHide: true,
	});
	assert.ifError(result.error);
	assert.equal(result.status, 0, result.stderr);
}

function repository(root, name, remote) {
	const path = join(root, name);
	mkdirSync(path);
	git(path, "init", "--initial-branch=main");
	git(path, "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
		"-c", `core.hooksPath=${join(root, "no-hooks")}`, "commit", "--allow-empty", "-m", "fixture");
	git(path, "remote", "add", "origin", remote);
	return path;
}

test("repository identity normalizes SSH/HTTPS and rejects branch-only or malformed identities", () => {
	for (const value of ["git@GitHub.com:Org/One.git", "ssh://git@github.com/ORG/one.git", "https://github.com/org/one/"]) {
		assert.equal(repositoryKey(value), "github.com/org/one");
	}
	for (const value of [null, "org/one", "feat/one", "file:///org/one", "https://github.com/one"]) {
		assert.equal(repositoryKey(value), null);
	}
	assert.notEqual(repositoryKey("https://enterprise.example/org/one"), repositoryKey("https://github.com/org/one"));
});

test("remote shell and PowerShell installer runtime lists match the canonical catalog", () => {
	const shell = readFileSync(join(repoRoot, "install-statusline.sh"), "utf8");
	const powershell = readFileSync(join(repoRoot, "install-statusline.ps1"), "utf8");
	const sharedShell = /for file in ([^;\r\n]+); do\r?\n\s*curl[^\r\n]+extensions\/\$file/.exec(shell)?.[1];
	assert.deepEqual(sharedShell?.split(/\s+/), SHARED_RUNTIME_FILES);
	const sharedPs = /foreach \(\$file in @\(([^)]+)\)\) \{\r?\n\s*Invoke-WebRequest[^\r\n]+extensions\/\$file/.exec(powershell)?.[1];
	assert.deepEqual([...String(sharedPs).matchAll(/'([^']+)'/g)].map((match) => match[1]), SHARED_RUNTIME_FILES);
	for (const { id, files } of EXTENSION_CATALOG) {
		const shellList = new RegExp(`for file in ([^;\\r\\n]+); do\\r?\\n\\s*mkdir -p "\\$TEMP_ROOT/extensions/${id}"`).exec(shell)?.[1];
		assert.ok(shellList, `${id} shell manifest`);
		assert.deepEqual(shellList.split(/\s+/), files);
		const psList = new RegExp(`'${id}'\\s*=\\s*@\\(([^)]+)\\)`).exec(powershell)?.[1];
		assert.ok(psList, `${id} PowerShell manifest`);
		assert.deepEqual([...psList.matchAll(/'([^']+)'/g)].map((match) => match[1]), files);
	}
});

test("ambiguous repositories, linked issues and historical agent checkouts stay session-wide without duplication", () => {
	const checkouts = [
		{ kind: "checkout", key: "a", branch: "same", remoteUrls: ["git@github.com:org/one.git"], text: "A [same]" },
		{ kind: "checkout", key: "b", branch: "same", remoteUrls: ["https://github.com/org/one"], text: "B [same]" },
	];
	checkouts[0].agentCheckouts = { multi: ["a", "b"], unresolved: ["a", null], conflict: ["a"] };
	const blocks = [
		{ name: "worktree-statusline", entries: checkouts },
		{ name: "pr-statusline", entries: [
			{ url: prUrl(1), text: "ambiguous PR", headRepositoryUrl: "https://github.com/org/one", headRefName: "same" },
			{ url: prUrl(2), text: "branch-only PR", headRefName: "same" },
		] },
		{ name: "issue-statusline", entries: [{ url: issueUrl(1), text: "issue", prUrls: [prUrl(1)] }] },
		{ name: "subagent-statusline", entries: [
			{ agentId: "multi" }, { agentId: "unresolved" },
		], renderGroup: (entries) => `${entries.length} agents` },
		{ name: "third-party", entries: [{ text: "opaque\n  continuation  " }] },
	];
	assert.equal(composeGroups(blocks, plain),
		"A [same]\nB [same]\nambiguous PR · branch-only PR · issue · 2 agents · opaque\n  continuation  ");
	checkouts[0].agentCheckouts = { single: ["a"], multi: ["a", "b"] };
	blocks[1].entries[0].provenance = { root: false, unknown: false, agents: ["single"] };
	assert.ok(composeGroups(blocks, plain).startsWith("A [same] · ambiguous PR · issue\n"));
	blocks[1].entries[0].provenance.agents = ["multi"];
	assert.ok(composeGroups(blocks, plain).startsWith("A [same]\nB [same]\nambiguous PR"));
	assert.equal(composeGroups([{ name: "worktree-statusline", entries: [] }], plain), "");
	assert.equal(composeGroups([{ name: "worktree-statusline", entries: [{ text: "syncing" }] }], plain), "syncing");
});

test("one global agent summary is retained independently of checkout ownership", () => {
	const blocks = [
		{ name: "worktree-statusline", entries: [
			{ kind: "checkout", key: "a", branch: "same", remoteUrls: ["https://github.com/org/one"], text: "A [same]",
				agentCheckouts: { conflict: ["b"], multi: ["a", "b"], missing: ["a", null] } },
			{ kind: "checkout", key: "b", branch: "same", remoteUrls: ["https://github.com/org/two"], text: "B [same]" },
			{ kind: "checkout", key: "local", branch: "main", remoteUrls: ["https://github.com/org/one"], text: "" },
		] },
		{ name: "pr-statusline", entries: [
			{ url: prUrl(1), text: "PR1", headRepositoryUrl: "https://github.com/org/one", headRefName: "same", issueUrls: [issueUrl(1)] },
			{ url: prUrl(2), text: "PR2", headRepositoryUrl: "https://github.com/org/two", headRefName: "same" },
			{ url: prUrl(3), text: "local PR", headRepositoryUrl: "https://github.com/org/one", headRefName: "main" },
		] },
		{ name: "issue-statusline", entries: [
			{ url: issueUrl(1), text: "issue1" },
			{ url: issueUrl(2), prUrls: [prUrl(1), prUrl(99)], text: "unresolved issue" },
		] },
		{ name: "subagent-statusline", entries: [
			{ agentId: "linked", prUrls: [prUrl(1)] },
			{ agentId: "conflict", prUrls: [prUrl(1), prUrl(99)] },
			{ agentId: "multi", prUrls: [prUrl(1)] },
			{ agentId: "missing", prUrls: [prUrl(1)] },
			{ agentId: "split", prUrls: [prUrl(1), prUrl(2)] },
		], renderGroup: (entries) => entries.map((entry) => entry.agentId).join(",") },
	];
	assert.equal(composeGroups(blocks, plain),
		"A [same] · PR1 · issue1\nB [same] · PR2\nlocal PR · unresolved issue · linked,conflict,multi,missing,split");
});

test("collector metadata enriches older PR/issue items and survives persistence, including fresh shared caches", async () => fixture((home) => {
	const pr = new SessionTracker("metadata");
	pr.add(prUrl(1));
	const info = {
		state: "OPEN", headRefName: "feat/a", headRepository: { url: "https://github.com/org/one" },
		closingIssuesReferences: { nodes: [{ url: issueUrl(1) }] },
	};
	assert.equal(refreshTrackedPrStatuses(pr, { home, now: 1000, fetchPrStatus: () => info }), true);
	writePrState(pr.snapshot(), home);
	assert.deepEqual(prContextFields(readPrState("metadata", home).prs[0]), {
		headRefName: "feat/a", headRepositoryUrl: "https://github.com/org/one", issueUrls: [issueUrl(1)],
	});
	const old = new SessionTracker("old");
	old.add(prUrl(1));
	Object.assign(old.state.prs[0], { status: summarizePrStatus(info), checkedAt: 1000 });
	writePrCache({ [prUrl(1)]: { info, checkedAt: 1000 } }, home);
	assert.equal(refreshTrackedPrStatuses(old, { home, now: 1001 }), true);
	assert.equal(old.state.prs[0].headRefName, "feat/a", "metadata hydrates before the fresh-status TTL early return");
	old.state.prs[0].headRefName = "newer";
	old.state.prs[0].checkedAt = 1002;
	refreshTrackedPrStatuses(old, { home, now: 1003 });
	assert.equal(old.state.prs[0].headRefName, "newer", "an older shared snapshot cannot overwrite newer persisted context");
	const issue = new IssueTracker("metadata");
	issue.add(issueUrl(1));
	const issueInfo = { state: "OPEN", closedByPullRequestsReferences: { nodes: [{ url: prUrl(1) }] } };
	assert.equal(refreshTrackedIssueStatuses(issue, { home, now: 1000, fetchIssueStatus: () => issueInfo }), true);
	writeIssueState(issue.snapshot(), home);
	assert.deepEqual(issueContextFields(readIssueState("metadata", home).issues[0]), { prUrls: [prUrl(1)] });
	delete issue.state.issues[0].prUrls;
	writeIssueCache({ [issueUrl(1)]: { info: issueInfo, checkedAt: 1000 } }, home);
	assert.equal(refreshTrackedIssueStatuses(issue, { home, now: 1001 }), true);
	assert.deepEqual(issue.state.issues[0].prUrls, [prUrl(1)]);
	issue.state.issues[0].prUrls = [prUrl(2)];
	issue.state.issues[0].checkedAt = 1002;
	refreshTrackedIssueStatuses(issue, { home, now: 1003 });
	assert.deepEqual(issue.state.issues[0].prUrls, [prUrl(2)]);
	assert.deepEqual(prContextFields({ headRefName: 1, headRepository: null, issueUrls: [null, issueUrl(1)] }), {
		headRefName: null, headRepositoryUrl: null, issueUrls: [issueUrl(1)],
	});
	assert.deepEqual(issueContextFields(null), {});
	assert.deepEqual(issueContextFields({ prUrls: [null, prUrl(1)] }), { prUrls: [prUrl(1)] });
}));

test("schema-two migration replays all historical agent directories instead of trusting the latest cwd", async () => fixture((home) => {
	const directory = join(home, "session-state", "migration");
	mkdirSync(directory, { recursive: true });
	const path = join(directory, "events.jsonl");
	writeFileSync(path, [
		event("session.start", { cwd: "/first" }, "a"),
		event("tool.execution_start", { toolCallId: "switch", toolName: "bash", arguments: { command: "cd /second" } }, "a"),
		event("tool.execution_complete", { toolCallId: "switch", success: true }),
	].map(JSON.stringify).join("\n") + "\n");
	sessionDirectory({ session_id: "migration" }, { home });
	const cachePath = join(home, "worktree-statusline", "migration.json");
	const cache = JSON.parse(readFileSync(cachePath, "utf8"));
	cache.version = 2;
	delete cache.agentDirectories;
	writeFileSync(cachePath, JSON.stringify(cache));
	const migrated = sessionDirectory({ session_id: "migration" }, { home });
	assert.deepEqual(migrated.agentDirectories, { a: ["/first", "/second"] });
	assert.equal(JSON.parse(readFileSync(cachePath, "utf8")).version, 3);
}));

test("Git refresh work is bounded and rotates through cached directories without losing discovered rows", async () => fixture((home) => {
	const directory = join(home, "session-state", "bounded");
	mkdirSync(directory, { recursive: true });
	const paths = Array.from({ length: 20 }, (_, i) => join(home, `checkout-${i}`));
	for (const path of paths) mkdirSync(path);
	writeFileSync(join(directory, "events.jsonl"), paths.map((cwd) =>
		JSON.stringify(event("session.context_changed", { cwd }))).join("\n") + "\n");
	let calls = 0;
	const run = (_command, args) => {
		calls++;
		const cwd = args[1];
		if (args[2] === "symbolic-ref") return { status: 0, stdout: "main\n" };
		if (args[2] === "config") return { status: 1, stdout: "" };
		if (args[2] === "status") return { status: 0, stdout: "" };
		return { status: 0, stdout: `${cwd}\n${join(cwd, ".git")}\n${join(cwd, ".git")}\n` };
	};
	const first = sessionContexts({ session_id: "bounded" }, { home, run });
	assert.equal(calls, 16 * 4);
	assert.equal(first.contexts.length, 16);
	calls = 0;
	const second = sessionContexts({ session_id: "bounded" }, { home, run });
	assert.equal(calls, 16 * 4);
	assert.equal(second.contexts.length, 20);
	calls = 0;
	const reserved = sessionContexts({ session_id: "bounded" }, { home, run, reserveGitDirectories: 4 });
	assert.equal(calls, 12 * 4);
	assert.equal(reserved.remainingGitDirectories, 4);
	assert.equal(reserved.contexts.length, 20);
}));

test("installed compositor keeps the checkout first after real PR provider metadata enrichment in plain and color", async () => fixture(async (root) => {
	const main = repository(root, "main", "https://github.com/org/one.git");
	const worktree = join(root, "feature-worktree");
	const branch = "feat/branch-worktree-statusline";
	git(main, "worktree", "add", "-b", branch, worktree);
	const home = join(root, "home");
	configureStatuslines({ home, repoRoot, enabled: ["pr-statusline", "worktree-statusline"] });
	const directory = join(home, "session-state", "enrichment-order");
	mkdirSync(directory, { recursive: true });
	const transcript = join(directory, "events.jsonl");
	writeFileSync(transcript, [
		event("session.start", { cwd: main }),
		event("session.context_changed", { cwd: worktree }),
	].map(JSON.stringify).join("\n") + "\n");
	const now = Date.now();
	const prs = new SessionTracker("enrichment-order");
	prs.add(prUrl(119));
	Object.assign(prs.state.prs[0], {
		status: `${OCTICONS.pass} 7/7 ${OCTICONS.approved} 0/0 ${OCTICONS.comment} 0/0`, checkedAt: now,
	});
	prs.state.transcriptOffset = statSync(transcript).size;
	writePrState(prs.snapshot(), home);
	const payload = { session_id: "enrichment-order", cwd: main };
	const installedComposer = await import(pathToFileURL(join(home, "statusline-compose.mjs")).href);
	const installedPr = await import(pathToFileURL(join(home, "extensions", "pr-statusline", "render.mjs")).href);
	const before = await installedComposer.composeStatusLine(payload, { home, now, ...plain });
	assert.equal(before.split("\n")[0], `${worktree} [⎇ ${branch}]`);
	assert.equal(before.split("\n")[1], installedPr.render(payload, { home, now, ...plain }));
	assert.ok(before.split("\n")[1].includes(prUrl(119)), before);
	installedPr.render(payload, {
		home, now: now + 1, ...plain, prCacheTtlMs: 0,
		fetchPrStatus: () => ({
			state: "OPEN", headRefName: branch, headRepository: { url: "https://github.com/org/one" },
			statusCheckRollup: Array.from({ length: 7 }, () => ({ conclusion: "SUCCESS" })),
		}),
	});
	const enriched = readPrState("enrichment-order", home).prs[0];
	assert.equal(enriched.headRefName, branch);
	assert.equal(enriched.headRepositoryUrl, "https://github.com/org/one");
	for (const color of [false, true]) {
		const options = { home, now: now + 1, color, links: color, nerdFont: false };
		const entries = await installedPr.renderEntries(payload, options);
		assert.equal(entries[0].url, prUrl(119));
		const output = await installedComposer.composeStatusLine(payload, options);
		const prefix = color
			? `\x1b[1;38;2;219;234;254;48;2;30;64;115m ${worktree} [⎇ ${branch} base?] \x1b[0m `
			: `${worktree} [⎇ ${branch} base?] · `;
		assert.equal(output.split("\n").length, 1, output);
		assert.ok(output.startsWith(prefix), output);
		assert.equal(output, prefix + entries[0].text, "provider-rendered PR pill must follow the checkout label");
	}
}));

test("installed structured providers group independent checkouts, preserve local items and respect saved selections", async () => fixture(async (root) => {
	const firstRepo = repository(root, "one", "git@github.com:org/one.git");
	const otherRepo = repository(root, "two", "https://github.com/org/two.git");
	git(otherRepo, "switch", "-c", "feat/a");
	const first = join(root, "first");
	const second = join(root, "second");
	git(firstRepo, "worktree", "add", "-b", "feat/a", first);
	git(firstRepo, "worktree", "add", "-b", "feat/b", second);
	const home = join(root, "home");
	configureStatuslines({ home, repoRoot, enabled: EXTENSION_CATALOG.map((item) => item.id) });
	const directory = join(home, "session-state", "grouped");
	mkdirSync(directory, { recursive: true });
	const transcript = join(directory, "events.jsonl");
	const visits = [[firstRepo, null], [first, "a"], [second, "b"], [otherRepo, "other"], [first, "multi"], [second, "multi"], [firstRepo, "local"]];
	writeFileSync(transcript, visits.map(([cwd, agentId]) =>
		JSON.stringify(event("session.context_changed", { cwd }, agentId))).join("\n") + "\n");
	const offset = statSync(transcript).size;
	const now = Date.now();
	const prs = new SessionTracker("grouped");
	const states = [
		[1, "feat/a", "https://github.com/org/one", [issueUrl(1)]],
		[2, "feat/b", "https://github.com/org/one", []],
		[3, "feat/a", "https://github.com/org/two", []],
		[4, "main", "https://github.com/org/one", []],
		[5, null, null, []],
	];
	for (const [number, headRefName, headRepositoryUrl, issueUrls] of states) {
		prs.add(prUrl(number));
		Object.assign(prs.state.prs.at(-1), {
			headRefName, headRepositoryUrl, issueUrls,
			status: `${OCTICONS.pass} 1/1 ${OCTICONS.approved} 0/0 ${OCTICONS.comment} 0/0`, checkedAt: now,
		});
	}
	prs.state.transcriptOffset = offset;
	writePrState(prs.snapshot(), home);
	const issues = new IssueTracker("grouped");
	for (const [number, urls] of [[1, []], [2, [prUrl(2)]], [3, []], [4, [prUrl(1), prUrl(2)]]]) {
		issues.add(issueUrl(number));
		Object.assign(issues.state.issues.at(-1), { prUrls: urls, status: "\uF075 0", checkedAt: now });
	}
	issues.state.transcriptOffset = offset;
	writeIssueState(issues.snapshot(), home);
	const agents = new SubagentTracker("grouped");
	for (const id of ["a", "b", "other", "multi", "local", "unknown"]) agents.ensureAgent(id);
	agents.transcriptOffset = offset;
	writeAgentState(agents.snapshot(), home);
	const unknown = join(home, "extensions", "unknown");
	mkdirSync(unknown);
	writeFileSync(join(unknown, "render.mjs"),
		'export const render = () => "opaque\\n  extra  "; export const renderEntries = () => { throw new Error("third-party API"); };');
	const configPath = join(home, "statusline-config.json");
	writeFileSync(configPath, JSON.stringify({ enabled: [...EXTENSION_CATALOG.map((item) => item.id), "unknown"] }));
	const config = readFileSync(configPath, "utf8");
	const settingsPath = join(home, "settings.json");
	const settings = readFileSync(settingsPath, "utf8");
	const payload = { session_id: "grouped", cwd: firstRepo };
	const text = await composeStatusLine(payload, { home, now, ...plain });
	const rows = text.split("\n");
	assert.equal(rows.length, 5, text);
	assert.ok(rows[0].startsWith(`${first} [⎇ feat/a base?]`), text);
	assert.ok(rows[1].startsWith(`${second} [⎇ feat/b base?]`), text);
	assert.ok(rows[2].startsWith(`${otherRepo} [⎇ feat/a base?]`), text);
	for (const [index, number] of [[0, 1], [1, 2], [2, 3]]) {
		assert.ok(rows[index].includes(prUrl(number)), text);
		assert.ok(!rows[index].includes("starting"), text);
		for (const other of [1, 2, 3, 4, 5].filter((n) => n !== number)) assert.ok(!rows[index].includes(prUrl(other)));
	}
	assert.ok(rows[0].indexOf(prUrl(1)) < rows[0].indexOf(issueUrl(1)));
	assert.ok(rows[1].includes(issueUrl(2)));
	assert.doesNotMatch(rows[3], /^(?:Session|[ \t·])/);
	for (const item of [prUrl(4), prUrl(5), issueUrl(3), issueUrl(4), "6 starting", "opaque"]) assert.ok(rows[3].includes(item), text);
	assert.equal(rows[4], "  extra  ", "opaque multiline third-party output stays intact");
	assert.ok(!text.includes(`${firstRepo} [⎇ main]`), text);
	const colored = await composeStatusLine(payload, { home, now, color: true, links: true });
	assert.equal(colored.split("\n").length, 5);
	assert.ok(colored.startsWith(`\x1b[1;38;2;219;234;254;48;2;30;64;115m ${first} [⎇ feat/a base?] \x1b[0m `));
	assert.equal(readFileSync(configPath, "utf8"), config);
	assert.equal(readFileSync(settingsPath, "utf8"), settings);
	for (const [entries, render] of [[prEntries, renderPr], [issueEntries, renderIssue]]) {
		assert.equal(render(payload, { home, ...plain }), entries(payload, { home, ...plain }).map((entry) => entry.text).join(" · "));
	}
	assert.equal(renderAgents(payload, { home, ...plain }), renderGroup(agentEntries(payload, { home }), { home, ...plain }));
	assert.equal(agentEntries(payload, { home }).find((entry) => entry.agentId === "a").counts.starting, 1);
	assert.equal(checkoutKey(first.toUpperCase()), process.platform === "win32" ? checkoutKey(first) : resolve(first.toUpperCase()));
	writeFileSync(configPath, JSON.stringify({ enabled: ["worktree-statusline", "pr-statusline"] }));
	const withoutIssuesOrAgents = await composeStatusLine(payload, { home, now, ...plain });
	assert.ok(!withoutIssuesOrAgents.includes("/issues/") && !withoutIssuesOrAgents.includes("starting") && !withoutIssuesOrAgents.includes("opaque"));
	writeFileSync(configPath, JSON.stringify({ enabled: ["worktree-statusline"] }));
	const localDirectory = join(home, "session-state", "local-only");
	mkdirSync(localDirectory, { recursive: true });
	writeFileSync(join(localDirectory, "events.jsonl"), JSON.stringify(event("session.start", { cwd: firstRepo })) + "\n");
	assert.equal(await composeStatusLine({ session_id: "local-only", cwd: firstRepo }, { home, ...plain }), "");
	assert.equal(await composeStatusLine({ session_id: "empty", cwd: root }, { home, ...plain }), "");
	const onlyPr = JSON.stringify({ enabled: ["pr-statusline"] });
	writeFileSync(configPath, onlyPr);
	const legacy = await composeStatusLine(payload, { home, now, ...plain });
	assert.ok(!legacy.includes("\n"), legacy);
	assert.equal(legacy, renderPr(payload, { home, ...plain }));
	assert.equal(readFileSync(configPath, "utf8"), onlyPr);
	ensurePluginStatuslineRegistered("worktree-statusline", join(repoRoot, "extensions", "worktree-statusline"), { home });
	assert.equal(readFileSync(join(home, "extensions", "worktree-statusline", "grouping.mjs"), "utf8"),
		readFileSync(join(repoRoot, "extensions", "worktree-statusline", "grouping.mjs"), "utf8"));
}));
