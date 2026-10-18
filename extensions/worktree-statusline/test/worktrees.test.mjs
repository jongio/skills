import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { composeStatusLine } from "../compose.mjs";
import { checkoutKey, gitContext, sessionDirectory } from "../tracker.mjs";
import { parseWorktrees, resolveLinkedCheckouts } from "../worktrees.mjs";
import { configureStatuslines } from "../../../scripts/setup-statusline.mjs";
import { SessionTracker, writeState as writePrState } from "../../pr-statusline/tracker.mjs";
import { OCTICONS } from "../../pr-statusline/github.mjs";
import { SubagentTracker, writeState as writeAgentState } from "../../subagent-statusline/tracker.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const remote = "https://github.com/example/widget";
const plain = { color: false, links: false, nerdFont: false };
const event = (type, data, agentId) => ({ type, data, agentId });
const pr = (number, branch, repository = remote) => ({
	url: `https://github.com/example/widget/pull/${number}`, headRefName: branch, headRepositoryUrl: repository,
});

async function fixture(run) {
	const root = mkdtempSync(join(tmpdir(), "linked-checkout-test-"));
	try {
		await run(root);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

function git(cwd, ...args) {
	const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 10000, windowsHide: true });
	assert.ifError(result.error);
	assert.equal(result.status, 0, result.stderr);
}

function repository(root, name, url = remote) {
	const directory = join(root, name);
	mkdirSync(directory);
	git(directory, "init", "--initial-branch=main");
	git(directory, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
		"-c", `core.hooksPath=${join(root, "no-hooks")}`, "commit", "--allow-empty", "-m", "fixture");
	git(directory, "remote", "add", "origin", url);
	return directory;
}

function worktree(repository, root, name, branch = `feat/${name}`) {
	const directory = join(root, name);
	git(repository, "worktree", "add", "-b", branch, directory);
	return directory;
}

test("porcelain inventory reads full branches and literal paths, excluding detached, bare and prunable entries", () => {
	const path = join(tmpdir(), "literal space ; $name");
	const entry = (root, ...fields) => [`worktree ${root}`, ...fields, "", ""].join("\0");
	assert.deepEqual(parseWorktrees(
		entry(path, "HEAD 123", "branch refs/heads/feat/full/branch", "locked keep") +
		entry(join(path, "gone"), "branch refs/heads/feat/gone", "prunable missing") +
		entry(join(path, "detached"), "HEAD 123", "detached") +
		entry(join(path, "bare"), "bare"),
	), [{ root: path, branch: "feat/full/branch" }]);
	assert.deepEqual(parseWorktrees("worktree relative\0branch refs/heads/main\0\0"), []);
});

test("unobserved tracked PR checkout is discovered without historical or unrelated rows, retaining unpublished focus and working agents", async () => fixture(async (root) => {
	const main = repository(root, "main");
	const focus = worktree(main, root, "unpublished");
	const linked = worktree(main, root, "linked", "feat/exact/full-branch");
	const irrelevant = worktree(main, root, "irrelevant");
	const oldAgent = worktree(main, root, "old-agent");
	const working = worktree(main, root, "working-agent");
	const settled = worktree(main, root, "settled-agent");
	const other = repository(root, "different-repository", "https://github.com/example/other");
	git(other, "switch", "-c", "feat/exact/full-branch");
	const home = join(root, "home");
	configureStatuslines({ home, repoRoot, enabled: ["worktree-statusline", "pr-statusline", "subagent-statusline"] });
	const directory = join(home, "session-state", "discovery");
	mkdirSync(directory, { recursive: true });
	const transcript = join(directory, "events.jsonl");
	writeFileSync(transcript, [
		event("session.start", { cwd: main }),
		event("session.context_changed", { cwd: other }),
		event("session.context_changed", { cwd: focus }),
		event("session.context_changed", { cwd: oldAgent }, "worker"),
		event("session.context_changed", { cwd: working }, "worker"),
		event("session.context_changed", { cwd: settled }, "done"),
	].map(JSON.stringify).join("\n") + "\n");
	const now = Date.now();
	const prs = new SessionTracker("discovery");
	prs.add(pr(1, "feat/exact/full-branch").url);
	Object.assign(prs.state.prs[0], pr(1, "feat/exact/full-branch"), {
		status: `${OCTICONS.pass} 1/1 ${OCTICONS.approved} 0/0 ${OCTICONS.comment} 0/0`, checkedAt: now,
	});
	prs.state.transcriptOffset = statSync(transcript).size;
	prs.state.status = "Waiting on you";
	writePrState(prs.snapshot(), home);
	const agents = new SubagentTracker("discovery");
	agents.ensureAgent("worker");
	agents.ensureAgent("done").status = "completed";
	agents.transcriptOffset = statSync(transcript).size;
	writeAgentState(agents.snapshot(), home);
	const payload = { session_id: "discovery", cwd: root };
	const before = sessionDirectory(payload, { home }).directories;
	const statePath = join(home, "pr-statusline", "discovery.json");
	const prState = readFileSync(statePath, "utf8");
	for (const color of [false, true]) {
		const output = await composeStatusLine(payload, { home, now, color, links: color, nerdFont: false });
		assert.ok(output.includes(`${focus} [⎇ feat/unpublished]`), output);
		assert.ok(output.includes(`${working} [⎇ feat/working-agent]`), output);
		const row = output.split("\n").find((line) => line.includes(linked));
		const label = `${linked} [⎇ feat/exact/full-branch]`;
		assert.ok(row, output);
		assert.ok(color ? row.startsWith(`\x1b[1;38;2;219;234;254;48;2;30;64;115m ${label} \x1b[0m `) : row.startsWith(`${label} · `), row);
		assert.ok(row.includes("example/widget#1"), row);
		for (const hidden of [`${main} [`, irrelevant, other, oldAgent, settled]) assert.ok(!output.includes(hidden), output);
	}
	assert.deepEqual(sessionDirectory(payload, { home }).directories, before, "inventory discovery must not invent transcript visits");
	assert.ok(!before.includes(linked));
	assert.equal(readFileSync(statePath, "utf8"), prState, "checkout resolution must not rewrite tracked PR ownership or metadata");
	const local = await composeStatusLine({ ...payload, cwd: linked }, { home, now, ...plain });
	assert.ok(!local.includes(`${linked} [`), local);
	assert.ok(local.includes(pr(1).url), local);
	const configPath = join(home, "statusline-config.json");
	writeFileSync(configPath, JSON.stringify({ enabled: ["worktree-statusline"] }));
	const noItems = await composeStatusLine(payload, { home, now, ...plain });
	assert.ok(noItems.includes(`${main} [⎇ main]`) && noItems.includes(focus), noItems);
	assert.ok(!noItems.includes(linked), "standalone checkout mode must not enumerate unrelated inventory");
}));

test("one cached inventory serves multiple PRs, with live fork verification, ambiguity and unavailable fallback", async () => fixture(async (root) => {
	const main = repository(root, "main");
	const first = worktree(main, root, "first");
	const second = worktree(main, root, "second");
	const irrelevant = worktree(main, root, "unrelated");
	const home = join(root, "home");
	const known = [{ ...gitContext(main), remainingGitDirectories: 4 }];
	const prs = [pr(1, "feat/first"), pr(2, "feat/second")];
	let inventories = 0;
	const run = (command, args, options) => {
		if (args.includes("worktree") && args.includes("list")) inventories++;
		return spawnSync(command, args, options);
	};
	const options = { home, now: 1000, run };
	const payload = { session_id: "cache" };
	assert.deepEqual(resolveLinkedCheckouts(payload, known, prs, options).map((context) => context.root).sort(), [first, second].sort());
	assert.equal(inventories, 1, "multiple PRs in a repository must share one inventory subprocess");
	assert.equal(resolveLinkedCheckouts(payload, known, prs, { ...options, now: 1001 }).length, 2);
	assert.equal(inventories, 1, "warm inventory must be reused");
	assert.ok(!resolveLinkedCheckouts(payload, known, prs, { ...options, now: 1002 }).some((context) => context.root === irrelevant));
	assert.equal(resolveLinkedCheckouts(payload, known, [pr(3, "feat/first", "https://github.com/example/fork")], options).length, 0);
	assert.equal(inventories, 1, "unknown head repositories must not trigger inventory reads");
	git(main, "config", "extensions.worktreeConfig", "true");
	git(first, "config", "--worktree", "remote.origin.url", "https://github.com/example/fork");
	assert.equal(resolveLinkedCheckouts(payload, known, [prs[0]], { ...options, now: 1003 }).length, 0, "a candidate's actual origin must match the PR head repository");
	git(first, "config", "--worktree", "remote.origin.url", remote);
	const duplicate = join(root, "duplicate");
	git(main, "worktree", "add", "--force", duplicate, "feat/first");
	assert.equal(resolveLinkedCheckouts(payload, known, [prs[0]], { ...options, now: 31001 }).length, 0, "multiple exact branch checkouts are ambiguous");
	assert.equal(inventories, 2, "expired inventory must refresh");
	assert.equal(resolveLinkedCheckouts({ session_id: "unavailable" }, known, prs, {
		home, now: 32000, run: () => ({ status: 1, stderr: "unavailable" }),
	}).length, 0);
}));

test("repository inventory and checkout verification share the remaining per-tick Git budget and rotate", async () => fixture(async (home) => {
	const checkouts = [];
	const prs = [];
	const contexts = new Map();
	for (let i = 0; i < 6; i++) {
		const root = join(home, `repo-${i}`);
		const target = join(home, `target-${i}`);
		mkdirSync(root);
		mkdirSync(target);
		const context = { root, commonDir: checkoutKey(join(root, ".git")), branch: "main", remoteUrls: [`https://github.com/example/repo-${i}`], remainingGitDirectories: 4 };
		checkouts.push(context);
		prs.push(pr(i + 1, "feat/target", context.remoteUrls[0]));
		contexts.set(root, { ...context, target });
		contexts.set(target, { ...context, root: target, branch: "feat/target" });
	}
	let inventories = 0;
	let verifications = 0;
	const run = (_command, args) => {
		const context = contexts.get(args[1]);
		if (args[2] === "worktree") {
			inventories++;
			return { status: 0, stdout: `worktree ${context.target}\0branch refs/heads/feat/target\0\0` };
		}
		if (args[2] === "rev-parse") {
			verifications++;
			return { status: 0, stdout: `${context.root}\n${context.commonDir}\n${join(context.root, ".git")}\n` };
		}
		if (args[2] === "symbolic-ref") return { status: 0, stdout: context.branch };
		if (args[2] === "status") return { status: 0, stdout: "" };
		return { status: 0, stdout: context.remoteUrls[0] };
	};
	let found = [];
	for (let tick = 0; tick < 3; tick++) {
		inventories = 0;
		verifications = 0;
		found = resolveLinkedCheckouts({ session_id: "budget" }, checkouts, prs, { home, now: 1000 + tick, run });
		assert.ok(inventories <= 2);
		assert.ok(inventories + verifications <= 4, "inventory reads must not bypass the checkout refresh budget");
	}
	assert.equal(found.length, 6, "later repositories and candidates must not starve behind the first batch");
}));
