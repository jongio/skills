import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { commandDirectory, describeSessionDirectory, gitContext, sessionContexts, sessionDirectory, WorktreeTracker } from "../tracker.mjs";
import { render } from "../render.mjs";
import { composeStatusLine, ensurePluginStatuslineRegistered, parseQuickSetupTokens, runInteractiveStatuslinePicker } from "../compose.mjs";
import { configureStatuslines, EXTENSION_CATALOG, parseStatuslineArgs } from "../../../scripts/setup-statusline.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const event = (type, data = {}, agentId) => ({ type, data, ...(agentId ? { agentId } : {}) });
const start = (id, command, extra = {}) => event("tool.execution_start", {
	toolCallId: id, toolName: "powershell", arguments: { command, ...extra },
});
const complete = (id, success = true, exitCode) => event("tool.execution_complete", {
	toolCallId: id, success, result: { structuredContent: { exitCode } },
});
const plain = { color: false, links: false, nerdFont: false };
const pill = (content) => `\x1b[1;38;2;219;234;254;48;2;30;64;115m ${content} \x1b[0m`;

function fixture(run) {
	const root = mkdtempSync(join(tmpdir(), "worktree-statusline-test-"));
	try {
		return run(root);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

function transcript(home, id, events) {
	const directory = join(home, "session-state", id);
	mkdirSync(directory, { recursive: true });
	const path = join(directory, "events.jsonl");
	writeFileSync(path, events.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
	return path;
}

function git(cwd, ...args) {
	const result = spawnSync("git", ["-C", cwd, ...args], {
		encoding: "utf8", timeout: 10000, maxBuffer: 128 * 1024, windowsHide: true,
	});
	assert.ifError(result.error);
	assert.equal(result.status, 0, result.stderr);
	return result.stdout.trim();
}

function checkout(root) {
	const repository = join(root, "repo");
	mkdirSync(repository);
	git(repository, "init", "--initial-branch=main");
	git(repository, "-c", "user.name=Statusline Test", "-c", "user.email=statusline@example.invalid",
		"-c", "core.hooksPath=" + join(root, "no-hooks"), "commit", "--allow-empty", "-m", "fixture");
	return repository;
}

test("literal directory parsing supports Windows, POSIX, quoting, relative paths and git -C", () => {
	assert.equal(commandDirectory('Set-Location -LiteralPath "C:\\work tree"; git status', "C:\\source"), "C:\\work tree");
	assert.equal(commandDirectory("cd /d C:\\work && git status", "C:\\source"), "C:\\work");
	assert.equal(commandDirectory("cd ..\\work && git status", "C:\\code\\source"), "C:\\code\\work");
	assert.equal(commandDirectory("cd '../work tree' && git status", "/code/source"), "/code/work tree");
	assert.equal(commandDirectory('git --no-pager -C "/code/work" status', "/code/source"), "/code/work");
	assert.equal(commandDirectory("Set-Location $target; git status", "C:\\source"), null);
	assert.equal(commandDirectory('Write-Output "cd /somewhere"', "/code/source"), null);
});

test("only completed successful root shell work changes directory; stale completions cannot steal focus", () => {
	const tracker = new WorktreeTracker();
	tracker.observe(event("session.start", { context: { cwd: "/code/source" } }));
	tracker.observe(start("pending", "cd /code/new && git status"));
	assert.equal(tracker.cwd, "/code/source");
	tracker.observe(complete("pending", false));
	assert.equal(tracker.cwd, "/code/source");
	tracker.observe(start("exit", "cd /code/fail && git status"));
	tracker.observe(complete("exit", true, 1));
	assert.equal(tracker.cwd, "/code/source");
	tracker.observe({ ...start("agent", "cd /code/agent"), agentId: "child" });
	tracker.observe({ ...complete("agent"), agentId: "child" });
	assert.equal(tracker.cwd, "/code/source");
	assert.ok(tracker.directories.has("/code/agent"));
	assert.ok(!tracker.directories.has("/code/fail"));
	assert.ok(!tracker.directories.has("/code/new"));
	tracker.observe(start("slow", "cd /code/slow"));
	tracker.observe(start("fast", "git status", { cwd: "/code/fast" }));
	tracker.observe(complete("fast"));
	tracker.observe(complete("slow"));
	assert.equal(tracker.cwd, "/code/fast");
	tracker.observe(start("old", "cd /code/old"));
	tracker.observe(event("session.context_changed", { cwd: "/code/authoritative" }));
	tracker.observe(complete("old"));
	assert.equal(tracker.cwd, "/code/authoritative");
	tracker.observe(start("workdir", "git status", { workdir: "/code/other" }));
	tracker.observe(complete("workdir"));
	assert.equal(tracker.cwd, "/code/other");
	tracker.observe(event("session.resume", { context: { cwd: "/code/resumed" } }));
	assert.equal(tracker.cwd, "/code/resumed");
});

test("incremental replay preserves pending calls, ignores stale payload cwd and waits for complete JSONL", () => fixture((home) => {
	const path = transcript(home, "session", [
		event("session.start", { context: { cwd: "/code/source" } }),
		start("switch", "cd /code/work"),
	]);
	const payload = { session_id: "session", cwd: "/old/launch", transcript_path: dirname(path) };
	assert.equal(sessionDirectory(payload, { home }).cwd, "/code/source");
	const before = JSON.parse(readFileSync(join(home, "worktree-statusline", "session.json"), "utf8"));
	const line = JSON.stringify(complete("switch"));
	appendFileSync(path, line);
	assert.equal(sessionDirectory(payload, { home }).cwd, "/code/source");
	appendFileSync(path, "\n");
	assert.equal(sessionDirectory(payload, { home }).cwd, "/code/work");
	const after = JSON.parse(readFileSync(join(home, "worktree-statusline", "session.json"), "utf8"));
	assert.ok(after.offset > before.offset);
	assert.equal(sessionDirectory(payload, { home }).cwd, "/code/work");
	assert.equal(readFileSync(join(home, "worktree-statusline", "session.json"), "utf8"), JSON.stringify(after));
	writeFileSync(path, JSON.stringify(event("session.start", { context: { cwd: "/reset" } })) + "\n");
	assert.equal(sessionDirectory(payload, { home }).cwd, "/reset");
	assert.equal(sessionDirectory({ session_id: "other", cwd: "/other" }, { home }).cwd, "/other");
	assert.throws(() => sessionDirectory({ session_id: "../escape" }, { home }), /valid session_id/);
	assert.throws(() => sessionDirectory({ session_id: 1 }, { home }), /valid session_id/);
}));

test("large transcripts replay within bounded reads and never report caught-up prematurely", () => fixture((home) => {
	const path = transcript(home, "large", [event("session.start", { context: { cwd: "/initial" } })]);
	const filler = JSON.stringify(event("assistant.message", { content: "x".repeat(1000) })) + "\n";
	appendFileSync(path, filler.repeat(5000));
	appendFileSync(path, JSON.stringify(event("session.context_changed", { cwd: "/latest" })) + "\n");
	const payload = { session_id: "large" };
	assert.equal(render(payload, { home, color: true, links: true }), pill("branch/worktree syncing session"));
	assert.deepEqual(sessionDirectory(payload, { home }), { cwd: "/latest", directories: ["/initial", "/latest"], catchingUp: false, agentDirectories: {} });
}));

test("oversized records do not stall replay; malformed records do not hide later context", () => fixture((home) => {
	const path = transcript(home, "oversized", [event("session.start", { context: { cwd: "/initial" } })]);
	appendFileSync(path, "x".repeat(9 * 1024 * 1024) + "\n");
	appendFileSync(path, '{"type":"session.context_changed",bad}\n');
	appendFileSync(path, JSON.stringify(event("session.context_changed", { cwd: "/latest" })) + "\n");
	let state;
	for (let i = 0; i < 5; i++) {
		state = sessionDirectory({ session_id: "oversized" }, { home });
		if (!state.catchingUp) break;
	}
	assert.deepEqual(state, { cwd: "/latest", directories: ["/initial", "/latest"], catchingUp: false, agentDirectories: {} });
}));

test("subagent relative directories are isolated from root and other agents", () => {
	const tracker = new WorktreeTracker();
	tracker.observe(event("session.start", { context: { cwd: "/root" } }));
	tracker.observe({ ...start("a", "cd /agents/a"), agentId: "a" });
	tracker.observe(complete("a"));
	tracker.observe({ ...start("b", "cd /agents/b"), agentId: "b" });
	tracker.observe(complete("b"));
	tracker.observe({ ...start("nested", "cd nested"), agentId: "a" });
	tracker.observe(complete("nested"));
	assert.equal(tracker.cwd, "/root");
	assert.deepEqual([...tracker.directories], ["/root", "/agents/a", "/agents/b", "/agents/a/nested"]);
	assert.equal(tracker.agentCwds.get("b").cwd, "/agents/b");
});

test("version-one caches replay the transcript to recover every checkout", () => fixture((home) => {
	const path = transcript(home, "migration", [
		event("session.start", { context: { cwd: "/first" } }),
		start("other", "cd /second"),
		complete("other"),
	]);
	sessionDirectory({ session_id: "migration" }, { home });
	const cachePath = join(home, "worktree-statusline", "migration.json");
	const cache = JSON.parse(readFileSync(cachePath, "utf8"));
	cache.version = 1;
	delete cache.directories;
	writeFileSync(cachePath, JSON.stringify(cache));
	assert.deepEqual(sessionDirectory({ session_id: "migration" }, { home }).directories, ["/first", "/second"]);
	assert.equal(JSON.parse(readFileSync(cachePath, "utf8")).version, 3);
	assert.ok(existsSync(path));
}));

test("malformed caches recover from the transcript with an explicit diagnostic", (t) => fixture((home) => {
	transcript(home, "corrupt", [
		event("session.start", { context: { cwd: "/first" } }),
		start("other", "cd /second"),
		complete("other"),
	]);
	sessionDirectory({ session_id: "corrupt" }, { home });
	const cachePath = join(home, "worktree-statusline", "corrupt.json");
	writeFileSync(cachePath, '{"version":2,');
	const diagnostic = t.mock.method(console, "error", () => {});
	assert.deepEqual(sessionDirectory({ session_id: "corrupt" }, { home }).directories, ["/first", "/second"]);
	assert.equal(diagnostic.mock.callCount(), 1);
	assert.match(diagnostic.mock.calls[0].arguments[0], /Rebuilding malformed session cache/);
	assert.equal(JSON.parse(readFileSync(cachePath, "utf8")).version, 3);
}));

test("repositories without a first commit still expose their branch", () => fixture((root) => {
	const repository = join(root, "empty-repo");
	mkdirSync(repository);
	git(repository, "init", "--initial-branch=main");
	assert.equal(gitContext(repository).branch, "main");
	const home = join(root, "home");
	transcript(home, "unborn", [event("session.start", { context: { cwd: repository } })]);
	assert.equal(render({ session_id: "unborn", cwd: root }, { home, ...plain }), `${repository} [main]`);
	assert.equal(render({ session_id: "unborn", cwd: repository }, { home, ...plain }), "");
}));

test("live branch, linked worktree, detached HEAD and non-Git directory detection", () => fixture((root) => {
	const repository = checkout(root);
	assert.equal(gitContext(repository).branch, "main");
	assert.equal(gitContext(repository).worktree, false);
	const subdirectory = join(repository, "nested");
	mkdirSync(subdirectory);
	assert.equal(gitContext(subdirectory).worktree, false);
	assert.equal(gitContext(subdirectory).branch, "main");
	const worktree = join(root, "work tree");
	git(repository, "worktree", "add", "-b", "feat/work", worktree);
	assert.equal(gitContext(worktree).branch, "feat/work");
	assert.equal(gitContext(worktree).worktree, true);
	git(worktree, "switch", "-c", "feat/switched");
	assert.equal(gitContext(worktree).branch, "feat/switched");
	git(worktree, "checkout", "--detach");
	assert.match(gitContext(worktree).branch, /^detached@[a-f0-9]+$/);
	assert.equal(gitContext(root), null);
	assert.equal(gitContext(null), null);
	assert.throws(() => gitContext(repository, { run: () => ({ error: new Error("timed out") }) }), /timed out/);
	assert.throws(() => gitContext(repository, { run: () => ({ status: 1, stderr: "permission denied" }) }), /permission denied/);
}));

test("a separate Git directory is not misclassified as a linked worktree", () => fixture((root) => {
	const repository = checkout(root);
	git(repository, "init", "--separate-git-dir=" + join(root, "git-storage"));
	assert.equal(gitContext(repository).worktree, false);
	assert.equal(gitContext(repository).branch, "main");
}));

test("end-to-end rendering follows session checkout and preserves unknown renderers on an unlabeled fallback row", async () => {
	const root = mkdtempSync(join(tmpdir(), "worktree-statusline-render-"));
	try {
		const repository = checkout(root);
		const target = join(root, "active-worktree");
		git(repository, "worktree", "add", "-b", "feat/active", target);
		const home = join(root, "home");
		const path = transcript(home, "live", [event("session.start", { context: { cwd: repository } })]);
		const payload = { session_id: "live", cwd: repository };
		assert.equal(render(payload, { home, ...plain }), "", "hide work confined to Copilot's current checkout");
		appendFileSync(path, [start("switch", `Set-Location '${target}'; git status`), complete("switch")]
			.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
		assert.equal(render(payload, { home, ...plain }), `${target} [feat/active]`);
		git(target, "switch", "-c", "feat/new");
		assert.equal(render(payload, { home, ...plain }), `${target} [feat/new]`);
		const colored = render(payload, { home, color: true, links: true, nerdFont: true });
		assert.equal(colored.split("\n").length, 1);
		assert.doesNotMatch(colored, /\x1b\]8;/, "worktree pills must not enable terminal hyperlink underlining");
		assert.equal(colored, pill(`${target} [feat/new]`), "the external checkout has padding inside its background, without a colon separator");
		assert.equal(render({ cwd: root }, { home, ...plain }), "");
		const result = configureStatuslines({ enabled: ["worktree-statusline"], home, repoRoot });
		assert.deepEqual(result.enabled, ["worktree-statusline"]);
		assert.ok(existsSync(join(home, "extensions", "worktree-statusline", "tracker.mjs")));
		assert.equal(await composeStatusLine(payload, { home, ...plain }), `${target} [feat/new]`);
		assert.equal(await composeStatusLine(payload, { home, color: true, links: true }), colored, "composition preserves padding and never adds worktree hyperlinks");
		const sibling = join(home, "extensions", "sibling");
		mkdirSync(sibling, { recursive: true });
		writeFileSync(join(sibling, "render.mjs"), 'export const render = () => "PR #42";\n');
		writeFileSync(join(home, "statusline-config.json"), JSON.stringify({ enabled: ["sibling", "worktree-statusline"] }));
		assert.equal(await composeStatusLine(payload, { home, ...plain }), `${target} [feat/new]\nPR #42`);
		for (const [name, label] of [["pr-statusline", "PR"], ["issue-statusline", "Issue"], ["subagent-statusline", "Agent"]]) {
			const directory = join(home, "extensions", name);
			mkdirSync(directory, { recursive: true });
			writeFileSync(join(directory, "render.mjs"), `export const render = () => ${JSON.stringify(label)};\n`);
		}
		writeFileSync(join(home, "statusline-config.json"), JSON.stringify({
			enabled: ["pr-statusline", "issue-statusline", "subagent-statusline", "worktree-statusline"],
		}));
		assert.equal(await composeStatusLine(payload, { home, ...plain }), `${target} [feat/new]\nPR \u00b7 Issue \u00b7 Agent`);
		assert.equal(await composeStatusLine(payload, { home, color: true, links: true }), `${colored}\nPR Issue Agent`);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("multiple root and subagent worktrees render once each, with current branches and padded non-link pills", () => fixture((root) => {
	const repository = checkout(root);
	const first = join(root, "first-worktree");
	const second = join(root, "second-worktree");
	const unrelated = join(root, "unrelated-worktree");
	git(repository, "worktree", "add", "-b", "feat/first", first);
	git(repository, "worktree", "add", "-b", "feat/second", second);
	git(repository, "worktree", "add", "-b", "feat/unrelated", unrelated);
	const nested = join(first, "nested");
	mkdirSync(nested);
	const home = join(root, "home");
	const path = transcript(home, "multiple", [
		event("session.start", { context: { cwd: repository } }),
		start("first", `cd '${first}'`),
		complete("first"),
		{ ...start("second", `cd '${second}'`), agentId: "child" },
		complete("second"),
		{ ...start("nested", `cd '${nested}'`), agentId: "other-child" },
		complete("nested"),
		start("failed", `cd '${unrelated}'`),
		complete("failed", false),
	]);
	const payload = { session_id: "multiple", cwd: unrelated };
	const expected = `${first} [feat/first] | ${repository} [main] | ${second} [feat/second]`;
	assert.equal(render(payload, { home, ...plain }), expected);
	assert.equal(render({ ...payload, cwd: repository }, { home, ...plain }), `${first} [feat/first] | ${second} [feat/second]`, "show all external worktrees while hiding Copilot's checkout");
	assert.equal(render({ ...payload, cwd: nested }, { home, ...plain }), `${repository} [main] | ${second} [feat/second]`, "nested working directories resolve to the same checkout root");
	assert.equal(render({ session_id: "multiple" }, { home, ...plain }), expected, "do not guess Copilot's working directory when the payload omits it");
	if (process.platform === "win32") {
		assert.equal(render({ ...payload, cwd: repository.toUpperCase() }, { home, ...plain }), `${first} [feat/first] | ${second} [feat/second]`, "Windows path casing must not create a redundant pill");
	}
	assert.equal(sessionContexts(payload, { home }).contexts.length, 3);
	assert.equal(describeSessionDirectory(payload, { home }), expected.replaceAll(" | ", "\n"));
	const colored = render(payload, { home, links: true, color: true });
	assert.equal(colored, `${pill(`${first} [feat/first]`)} ${pill(`${repository} [main]`)} ${pill(`${second} [feat/second]`)}`);
	assert.doesNotMatch(colored, /\x1b\]8;/);
	assert.equal(colored.split("\n").length, 1);
	assert.ok(!colored.includes(unrelated));
	git(second, "switch", "-c", "feat/updated");
	assert.ok(render(payload, { home, ...plain }).includes(`${second} [feat/updated]`));
	assert.ok(!render(payload, { home, ...plain }).includes("[feat/second]"));
	// A removed checkout no longer renders, but another session never inherits this list.
	git(repository, "worktree", "remove", second);
	assert.ok(!render(payload, { home, ...plain }).includes(second));
	assert.equal(render({ session_id: "different", cwd: repository }, { home, ...plain }), "");
	appendFileSync(path, JSON.stringify(event("session.context_changed", { cwd: repository })) + "\n");
	assert.ok(render(payload, { home, ...plain }).startsWith(`${repository} [main]`));
}));

test("full checkout paths are not shortened or truncated", () => fixture((root) => {
	const deep = join(root, "x".repeat(Math.max(1, 161 - root.length)));
	mkdirSync(deep);
	const repository = checkout(deep);
	assert.ok(repository.length > 160);
	const home = join(root, "home");
	transcript(home, "long-path", [event("session.start", { context: { cwd: repository } })]);
	assert.equal(render({ session_id: "long-path", cwd: root }, { home, ...plain }), `${repository} [main]`);
}));

test("local-only sessions hide in plain and colored output, including subdirectories and changed branches", () => fixture((root) => {
	const repository = checkout(root);
	const nested = join(repository, "nested");
	mkdirSync(nested);
	const home = join(root, "home");
	transcript(home, "local", [
		event("session.start", { context: { cwd: repository } }),
		{ ...start("nested", `cd '${nested}'`), agentId: "child" },
		complete("nested"),
	]);
	const payload = { session_id: "local", cwd: repository };
	assert.equal(render(payload, { home, ...plain }), "");
	assert.equal(render(payload, { home, color: true }), "");
	assert.equal(render({ ...payload, cwd: nested }, { home, ...plain }), "");
	git(repository, "switch", "-c", "feat/local");
	assert.equal(render(payload, { home, ...plain }), "");
	assert.equal(describeSessionDirectory(payload, { home }), `${repository} [feat/local]`, "the inspection command still lists local session checkouts");
	assert.equal(render({ cwd: repository }, { home, ...plain }), "", "no transcript and no external work means no pill");
}));

test("setup, plugin registration, picker and compositor mirrors expose the fourth statusline", async () => {
	assert.deepEqual(parseStatuslineArgs(["--worktrees"]), ["worktree-statusline"]);
	assert.ok(parseStatuslineArgs(["--all"]).includes("worktree-statusline"));
	assert.ok(!parseStatuslineArgs(["--no-worktrees"]).includes("worktree-statusline"));
	assert.deepEqual(parseQuickSetupTokens("branch worktrees"), ["worktree-statusline"]);
	const canonical = readFileSync(join(repoRoot, "extensions", "pr-statusline", "compose.mjs"), "utf8");
	for (const item of EXTENSION_CATALOG) {
		assert.equal(readFileSync(join(repoRoot, "extensions", item.id, "compose.mjs"), "utf8"), canonical);
		for (const file of item.files) assert.ok(existsSync(join(repoRoot, "extensions", item.id, file)), `${item.id}/${file}`);
	}
	const home = mkdtempSync(join(tmpdir(), "worktree-statusline-setup-"));
	try {
		ensurePluginStatuslineRegistered("pr-statusline", join(repoRoot, "extensions", "pr-statusline"), { home, includeSiblings: true });
		assert.ok(existsSync(join(home, "extensions", "worktree-statusline", "render.mjs")));
		const result = await runInteractiveStatuslinePicker({
			capabilities: { ui: { elicitation: true } },
			ui: { elicitation: async (form) => {
				assert.ok(form.requestedSchema.properties.worktrees);
				return { action: "accept", content: { prs: false, issues: false, subagents: false, worktrees: true } };
			} },
			log: async () => {},
		}, { home });
		assert.deepEqual(result.enabled, ["worktree-statusline"]);
		assert.equal(JSON.parse(readFileSync(join(home, "settings.json"), "utf8")).footer.showCustom, true);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});
