import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { checkoutDivergence, checkoutLabel, gitContext } from "../tracker.mjs";
import { render, renderEntries, resolveCheckoutEntries } from "../render.mjs";
import { composeStatusLine } from "../compose.mjs";
import { configureStatuslines } from "../../../scripts/setup-statusline.mjs";
import { SessionTracker, readState, writeState } from "../../pr-statusline/tracker.mjs";
import { prContextFields, queryBranchPrWithGh, queryPrStatusWithGh, refreshTrackedPrStatuses, writePrCache } from "../../pr-statusline/github.mjs";

const widget = "https://github.com/example/widget";
const fork = "https://github.com/example/widget-fork";
const url = `${widget}/pull/1`;
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const plain = { color: false, links: false, nerdFont: false };
const identity = ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid"];

async function fixture(run) {
	const root = realpathSync.native(mkdtempSync(join(tmpdir(), "checkout-divergence-")));
	try { await run(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

function git(cwd, ...args) {
	const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 10000, windowsHide: true });
	assert.ifError(result.error);
	assert.equal(result.status, 0, result.stderr);
	return result.stdout.trim();
}

function repository(root) {
	const cwd = join(root, "widget ; literal");
	mkdirSync(cwd);
	git(cwd, "init", "--initial-branch=feat/login");
	writeFileSync(join(cwd, "tracked.txt"), "fixture\n");
	git(cwd, "add", ".");
	git(cwd, ...identity, "-c", `core.hooksPath=${join(root, "no-hooks")}`, "commit", "-m", "fixture");
	git(cwd, "remote", "add", "origin", widget);
	return cwd;
}

function child(cwd, parent, message) {
	const tree = git(cwd, "rev-parse", `${parent}^{tree}`);
	return git(cwd, ...identity, "commit-tree", tree, "-p", parent, "-m", message);
}

function tracked(cwd, branch, commit) {
	git(cwd, "update-ref", `refs/remotes/origin/${branch}`, commit);
	git(cwd, "config", "branch.feat/login.remote", "origin");
	git(cwd, "config", "branch.feat/login.merge", `refs/heads/${branch}`);
}

function checkedRun(calls) {
	return (command, args, options) => {
		assert.equal(command, "git");
		assert.ok(["rev-parse", "symbolic-ref", "config", "status", "rev-list", "worktree"].includes(args[2]), args.join(" "));
		assert.equal(options.timeout, 1500);
		assert.ok(options.maxBuffer <= 256 * 1024);
		assert.equal(options.env.GIT_OPTIONAL_LOCKS, "0");
		assert.equal(options.env.GIT_TERMINAL_PROMPT, "0");
		if (args[2] !== "worktree") assert.equal(options.env.GIT_NO_LAZY_FETCH, "1");
		if (args[2] === "rev-list") {
			assert.equal(options.maxBuffer, 64 * 1024);
			assert.deepEqual(args.slice(2, 5), ["rev-list", "--left-right", "--count"]);
			assert.equal(args.at(-1), "--");
			assert.match(args[5], /^HEAD\.\.\.refs\/(?:heads|remotes)\//);
		}
		calls.push(args);
		return spawnSync(command, args, options);
	};
}

function label(cwd, prs = [], options = {}) {
	const context = { ...gitContext(cwd, options), root: cwd };
	return checkoutLabel({ ...context, divergence: checkoutDivergence(context, prs, options) });
}

test("local refs give exact up-to-date, ahead, behind and diverged upstream counts plus default-base missing commits", async () => fixture((root) => {
	const cwd = repository(root);
	const initial = git(cwd, "rev-parse", "HEAD");
	tracked(cwd, "feat/login", initial);
	git(cwd, "update-ref", "refs/remotes/origin/main", initial);
	git(cwd, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
	assert.equal(label(cwd), `${cwd} [⎇ feat/login]`, "zero counts must be invisible");
	const remoteOne = child(cwd, initial, "remote one");
	const remoteTwo = child(cwd, remoteOne, "remote two");
	tracked(cwd, "feat/login", remoteTwo);
	assert.equal(label(cwd), `${cwd} [⎇ feat/login origin/feat/login↓2]`);
	tracked(cwd, "feat/login", initial);
	const local = child(cwd, initial, "local one");
	git(cwd, "update-ref", "refs/heads/feat/login", local);
	assert.equal(label(cwd), `${cwd} [⎇ feat/login origin/feat/login↑1]`);
	tracked(cwd, "feat/login", remoteTwo);
	const baseOne = child(cwd, initial, "base one");
	const baseTwo = child(cwd, baseOne, "base two");
	const baseThree = child(cwd, baseTwo, "base three");
	git(cwd, "update-ref", "refs/remotes/origin/main", baseThree);
	writeFileSync(join(cwd, "tracked.txt"), "staged\n");
	git(cwd, "add", "tracked.txt");
	writeFileSync(join(cwd, "tracked.txt"), "unstaged\n");
	writeFileSync(join(cwd, "new.txt"), "untracked\n");
	const expected = `${cwd} [⎇ feat/login*+% origin/feat/login↑1↓2 origin/main↓3]`;
	const calls = [];
	assert.equal(label(cwd, [], { run: checkedRun(calls) }), expected);
	assert.equal(calls.filter((args) => args[2] === "config").length, 1, "configuration is read once as a batch");
	assert.equal(calls.filter((args) => args[2] === "rev-list").length, 2);
	assert.equal(calls.length, 7, "four context reads, one default symref and two graph comparisons");
	git(cwd, "config", "branch.feat/login.merge", "refs/heads/main");
	const duplicateCalls = [];
	assert.equal(label(cwd, [], { run: checkedRun(duplicateCalls) }),
		`${cwd} [⎇ feat/login*+% origin/main↑1↓3]`, "identical upstream and base must not duplicate a target");
	assert.equal(duplicateCalls.filter((args) => args[2] === "rev-list").length, 1);
}));

test("branch changes, detached HEAD, unborn HEAD and local upstreams retain truthful labels", async () => fixture((root) => {
	const cwd = repository(root);
	const initial = git(cwd, "rev-parse", "HEAD");
	tracked(cwd, "feat/login", child(cwd, initial, "remote"));
	git(cwd, "update-ref", "refs/remotes/origin/main", child(cwd, initial, "default"));
	git(cwd, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
	assert.match(label(cwd), /origin\/feat\/login↓1 origin\/main↓1/);
	git(cwd, "switch", "-c", "feat/changed");
	assert.equal(label(cwd), `${cwd} [⎇ feat/changed origin/main↓1]`, "unconfigured upstream is not guessed");
	git(cwd, "config", "branch.feat/changed.remote", ".");
	git(cwd, "config", "branch.feat/changed.merge", "refs/heads/feat/login");
	git(cwd, "update-ref", "refs/heads/feat/login", child(cwd, initial, "local upstream"));
	assert.equal(label(cwd), `${cwd} [⎇ feat/changed feat/login↓1 origin/main↓1]`);
	git(cwd, "config", "branch.null.remote", "origin");
	git(cwd, "config", "branch.null.merge", "refs/heads/feat/login");
	git(cwd, "checkout", "--detach", initial);
	assert.match(label(cwd), /\[⎇ detached@[a-f0-9]+ origin\/main↓1\]$/);
	git(cwd, "switch", "--orphan", "feat/unborn");
	git(cwd, "config", "branch.feat/unborn.remote", "origin");
	git(cwd, "config", "branch.feat/unborn.merge", "refs/heads/feat/login");
	assert.equal(label(cwd), `${cwd} [⎇ feat/unborn origin/feat/login? origin/main?]`);
}));

test("missing local upstream and PR-base refs are unavailable without assuming a default branch", async () => fixture((root) => {
	const cwd = repository(root);
	assert.equal(label(cwd), `${cwd} [⎇ feat/login]`, "a remote URL alone does not establish a default branch");
	git(cwd, "config", "branch.feat/login.remote", "origin");
	git(cwd, "config", "branch.feat/login.merge", "refs/heads/gone");
	assert.equal(label(cwd), `${cwd} [⎇ feat/login origin/gone?]`);
	assert.equal(label(cwd, [targetPr()]), `${cwd} [⎇ feat/login origin/gone? origin/release?]`);
}));

test("PR base overrides default using the base repository's unique remote and configured fetch mapping", async () => fixture((root) => {
	const cwd = repository(root);
	const initial = git(cwd, "rev-parse", "HEAD");
	git(cwd, "remote", "set-url", "origin", fork);
	git(cwd, "remote", "add", "target", widget);
	git(cwd, "update-ref", "refs/remotes/origin/release", initial);
	git(cwd, "update-ref", "refs/remotes/target/release", child(cwd, initial, "target base"));
	const pr = { url, headRefName: "feat/login", headRepositoryUrl: fork, baseRefName: "release", baseRepositoryUrl: widget };
	const calls = [];
	assert.equal(label(cwd, [pr], { run: checkedRun(calls) }), `${cwd} [⎇ feat/login target/release↓1]`);
	assert.equal(calls.filter((args) => args[2] === "rev-list").length, 1);
	assert.equal(calls.filter((args) => args[2] === "symbolic-ref").length, 1, "only branch detection runs, not a default-base lookup");
	git(cwd, "config", "remote.target.fetch", "+refs/heads/*:refs/remotes/review/*");
	git(cwd, "update-ref", "refs/remotes/review/release", child(cwd, initial, "mapped base"));
	assert.equal(label(cwd, [pr]), `${cwd} [⎇ feat/login review/release↓1]`);
	git(cwd, "remote", "add", "duplicate", widget);
	assert.equal(label(cwd, [pr]), `${cwd} [⎇ feat/login release?]`, "multiple target remotes must not select one arbitrarily");
	git(cwd, "remote", "set-url", "duplicate", "https://github.com/example/other");
	const conflicting = { ...pr, url: `${widget}/pull/2`, baseRefName: "other" };
	assert.equal(label(cwd, [pr, conflicting]), `${cwd} [⎇ feat/login base?]`);
	assert.equal(label(cwd, [{ ...pr, baseRepositoryUrl: "https://github.com/example/unconfigured" }]),
		`${cwd} [⎇ feat/login release?]`, "fork origin must never stand in for an unconfigured target repository");
	assert.equal(label(cwd, [{ ...pr, baseRepositoryUrl: null }]), `${cwd} [⎇ feat/login base?]`);
	assert.equal(label(cwd, [pr, { ...pr }]), `${cwd} [⎇ feat/login review/release↓1]`, "identical explicit targets are unambiguous");
	const wrongHead = { ...pr, headRepositoryUrl: "https://github.com/example/other" };
	assert.equal(label(cwd, [wrongHead]), `${cwd} [⎇ feat/login]`, "same branch text alone must not associate a PR");
}));

const context = () => ({
	root: "widget", branch: "feat/login", remoteUrls: [widget],
	remotes: [{ name: "origin", urls: [widget], fetch: ["+refs/heads/*:refs/remotes/origin/*"] }],
	upstream: { remotes: ["origin"], merges: ["refs/heads/feat/login"] },
});
const targetPr = (fields = {}) => ({
	url, headRefName: "feat/login", headRepositoryUrl: widget, baseRefName: "release", baseRepositoryUrl: widget, ...fields,
});

test("graph failures, malformed counts, missing refs and missing defaults have explicit unavailable policies", () => {
	for (const result of [
		{ error: new Error("timeout"), status: null },
		{ error: new Error("maxBuffer exceeded"), status: null },
		{ status: 128, stdout: "" },
		{ status: 0, stdout: "not counts" },
		{ status: 0, stdout: "9007199254740992 1" },
		{ status: 0, stdout: "-1 2" },
	]) {
		const calls = [];
		const divergence = checkoutDivergence(context(), [targetPr()], { run: (_command, args, options) => {
			calls.push(args);
			assert.equal(options.timeout, 1500);
			assert.equal(options.maxBuffer, 64 * 1024);
			assert.equal(options.env.GIT_NO_LAZY_FETCH, "1");
			return result;
		} });
		assert.equal(checkoutLabel({ ...context(), divergence }), "widget [⎇ feat/login origin/feat/login? origin/release?]");
		assert.equal(calls.length, 2);
		assert.ok(calls.every((args) => args[2] === "rev-list"), "a PR base must not trigger default discovery");
	}
	const thrown = checkoutDivergence(context(), [targetPr()], { run: () => { throw new Error("spawn failed"); } });
	assert.equal(thrown.upstream.ahead, null);
	assert.equal(thrown.base.behind, null);
	const noUpstream = { ...context(), upstream: { remotes: [], merges: [] } };
	assert.equal(checkoutDivergence(noUpstream, [], { run: () => ({ status: 1 }) }).base, null, "absent remote HEAD means no known base");
	assert.equal(checkoutDivergence(noUpstream, [], { run: () => ({ error: new Error("timeout") }) }).base.target, "origin/HEAD");
	assert.equal(checkoutDivergence(noUpstream, [], { run: () => ({ status: 0, stdout: "refs/remotes/other/main" }) }).base.behind, null);
	assert.equal(checkoutDivergence({ ...noUpstream, remotes: [] }, [], { run: () => assert.fail("no known targets") }).base, null);
	const missing = { ...context(), remotes: [] };
	assert.equal(checkoutDivergence(missing, [targetPr()], { run: () => assert.fail("unresolvable targets") }).upstream.target, "origin/feat/login");
	const partial = { ...context(), upstream: { remotes: ["origin"], merges: [] } };
	assert.equal(checkoutDivergence(partial, [targetPr()], { run: () => ({ status: 0, stdout: "0 0" }) }).upstream.target, "upstream");
});

test("unsafe or ambiguous ref mappings never reach revision arguments and terminal labels are sanitized", () => {
	for (const fetch of [
		[], ["+refs/heads/*:refs/remotes/origin/*", "+refs/heads/*:refs/remotes/other/*"],
		["^refs/heads/private", "+refs/heads/*:refs/remotes/origin/*"],
		["+refs/heads/*:refs/remotes/origin/*:extra"],
		["+refs/heads/*:refs/remotes/origin/../*"],
		["+refs/heads/feat/login*login:refs/remotes/origin/feature*copy"],
	]) {
		const value = context();
		value.remotes[0].fetch = fetch;
		const result = checkoutDivergence(value, [targetPr()], { run: () => assert.fail("ambiguous refs must not be queried") });
		assert.equal(result.upstream.ahead, null);
		assert.equal(result.base.behind, null);
	}
	for (const branch of ["release...HEAD", "release^{commit}", "release:other", "-bad", "release\n\x1b\u202e"]) {
		const value = { ...context(), upstream: { remotes: [], merges: [] } };
		const result = checkoutDivergence(value, [targetPr({ baseRefName: branch })], { run: () => assert.fail("unsafe target") });
		assert.equal(result.base.behind, null);
		assert.doesNotMatch(checkoutLabel({ ...value, divergence: result }), /[\x00-\x1f\u202e]/);
	}
	assert.equal(checkoutLabel({ root: "widget\x1b", branch: "feat/login\u202e", dirty: "*+%",
		divergence: { upstream: { target: "origin/feat/login\x07\u2028", ahead: 1, behind: 2 },
			base: { target: "origin/main\u2066", ahead: 5, behind: 3 } } }),
		"widget [⎇ feat/login*+% origin/feat/login↑1↓2 origin/main↓3]");
	const exact = context();
	exact.remotes[0].fetch = ["+refs/heads/release:refs/remotes/target/release", "+refs/heads/feat/login:refs/remotes/target/feat/login"];
	const result = checkoutDivergence(exact, [targetPr()], { run: () => ({ status: 0, stdout: "3\t2\n" }) });
	assert.equal(result.upstream.target, "target/feat/login");
	assert.equal(result.base.target, "target/release");
	const collision = { ...context(), upstream: { remotes: [], merges: [] } };
	collision.remotes.push({ name: "fork", urls: [fork], fetch: ["+refs/heads/*:refs/remotes/origin/*"] });
	const ambiguous = checkoutDivergence(collision, [targetPr()], { run: () => assert.fail("overlapping remote destinations") });
	assert.equal(ambiguous.base.target, "origin/release");
	assert.equal(ambiguous.base.behind, null, "a fork ref must not be attributed to the target repository");
	const fallback = checkoutDivergence(collision, [], { run: (_command, args) => {
		assert.equal(args[2], "symbolic-ref", "an ambiguous default must not be compared");
		return { status: 0, stdout: "refs/remotes/origin/main" };
	} });
	assert.equal(fallback.base.target, "origin/HEAD");
	assert.equal(fallback.base.behind, null);
});

test("standalone and deferred rendering retain plain/color padding, hiding and horizontal composition", async () => fixture(async (root) => {
	const cwd = repository(root);
	const initial = git(cwd, "rev-parse", "HEAD");
	tracked(cwd, "feat/login", child(cwd, initial, "upstream"));
	git(cwd, "update-ref", "refs/remotes/origin/main", child(cwd, initial, "base"));
	git(cwd, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
	const home = join(root, "home");
	const directory = join(home, "session-state", "render");
	mkdirSync(directory, { recursive: true });
	writeFileSync(join(directory, "events.jsonl"), JSON.stringify({ type: "session.start", data: { cwd } }) + "\n");
	const payload = { session_id: "render", cwd: root };
	const expected = `${cwd} [⎇ feat/login origin/feat/login↓1 origin/main↓1]`;
	for (const color of [false, true]) {
		const output = color ? `\x1b[1;38;2;219;234;254;48;2;30;64;115m ${expected} \x1b[0m` : expected;
		assert.equal(render(payload, { home, color }), output);
		const calls = [];
		const options = { home, color, run: checkedRun(calls), deferCheckoutDivergence: true };
		const entries = renderEntries(payload, options);
		assert.equal(calls.filter((args) => args[2] === "rev-list").length, 0);
		const resolved = resolveCheckoutEntries(payload, entries, [], options);
		assert.equal(resolved[0].text, output);
		assert.equal(calls.filter((args) => args[2] === "rev-list").length, 2);
		assert.doesNotMatch(output, /\x1b\]8;|]:/);
		assert.equal(render({ ...payload, cwd }, { home, color }), "");
	}
	configureStatuslines({ home, repoRoot, enabled: ["worktree-statusline"] });
	assert.equal(await composeStatusLine(payload, { home, ...plain }), expected);
	const legacy = join(home, "extensions", "legacy");
	mkdirSync(legacy);
	writeFileSync(join(legacy, "render.mjs"), 'export const render = () => "opaque";\n');
	writeFileSync(join(home, "statusline-config.json"), JSON.stringify({ enabled: ["worktree-statusline", "legacy"] }));
	assert.equal(await composeStatusLine(payload, { home, ...plain }), `${expected}\nopaque`);
}));

test("cached checkout rows cannot spend graph queries outside the rotating sixteen-directory budget", async () => fixture((home) => {
	const directory = join(home, "session-state", "budget");
	mkdirSync(directory, { recursive: true });
	const paths = Array.from({ length: 20 }, (_, i) => join(home, `widget-${i}`));
	for (const cwd of paths) mkdirSync(cwd);
	writeFileSync(join(directory, "events.jsonl"), paths.map((cwd) =>
		JSON.stringify({ type: "session.context_changed", data: { cwd } })).join("\n") + "\n");
	const calls = [];
	const run = (_command, args) => {
		calls.push(args);
		const cwd = args[1];
		if (args[2] === "config") return { status: 0, stdout:
			`remote.origin.url\n${widget}\0remote.origin.fetch\n+refs/heads/*:refs/remotes/origin/*\0branch.main.remote\norigin\0branch.main.merge\nrefs/heads/main\0` };
		if (args[2] === "symbolic-ref") return { status: 0, stdout: args.at(-1) === "HEAD" ? "main" : "refs/remotes/origin/main" };
		if (args[2] === "status") return { status: 0, stdout: "" };
		if (args[2] === "rev-list") return { status: 0, stdout: "0 1" };
		return { status: 0, stdout: `${cwd}\n${join(cwd, ".git")}\n${join(cwd, ".git")}\n` };
	};
	const payload = { session_id: "budget" };
	renderEntries(payload, { home, run, ...plain });
	calls.length = 0;
	const entries = renderEntries(payload, { home, run, ...plain });
	assert.equal(entries.length, 20, "cached rows remain visible");
	assert.equal(entries.filter((entry) => entry.gitRefreshed).length, 16);
	assert.equal(calls.filter((args) => args[2] === "rev-list").length, 16, "equal upstream/base refs share one comparison");
	const graphRoots = new Set(calls.filter((args) => args[2] === "rev-list").map((args) => resolve(args[1])));
	for (const entry of entries.filter((entry) => !entry.gitRefreshed)) {
		assert.ok(!graphRoots.has(entry.root));
		assert.equal(entry.divergence.upstream.ahead, null);
		assert.equal(entry.divergence.base.behind, null);
	}
}));

test("late linked checkouts receive PR-base enrichment once without repeating full Git context", async () => fixture(async (root) => {
	const cwd = repository(root);
	const initial = git(cwd, "rev-parse", "HEAD");
	git(cwd, "remote", "set-url", "origin", fork);
	git(cwd, "remote", "add", "target", widget);
	const linked = join(root, "linked");
	git(cwd, "worktree", "add", "-b", "feat/linked", linked);
	git(cwd, "update-ref", "refs/remotes/target/release", child(cwd, initial, "release"));
	const home = join(root, "home");
	const payload = { session_id: "linked", cwd };
	const calls = [];
	const options = { home, ...plain, run: checkedRun(calls), deferCheckoutDivergence: true, reserveGitDirectories: 4 };
	const pr = targetPr({ headRefName: "feat/linked", headRepositoryUrl: fork });
	const entries = renderEntries(payload, options);
	const resolved = resolveCheckoutEntries(payload, entries, [pr], options);
	const row = resolved.find((entry) => entry.root === linked);
	assert.equal(row.text, `${linked} [⎇ feat/linked target/release↓1]`);
	assert.equal(calls.filter((args) => resolve(args[1]) === linked && args[2] === "rev-parse").length, 1);
	assert.equal(calls.filter((args) => args[2] === "rev-list").length, 1);
	assert.equal(calls.filter((args) => resolve(args[1]) === linked && args[2] === "symbolic-ref").length, 1);
	assert.equal(resolved.find((entry) => entry.root === cwd).text, "", "own checkout stays hidden");
	configureStatuslines({ home, repoRoot, enabled: ["worktree-statusline", "pr-statusline"] });
	const tracker = new SessionTracker(payload.session_id);
	tracker.add(url);
	refreshTrackedPrStatuses(tracker, { home, now: 1000, fetchPrStatus: () => ({ ...pr, state: "OPEN" }) });
	writeState(tracker.snapshot(), home);
	const output = await composeStatusLine(payload, { home, ...plain, now: 1001 });
	assert.ok(output.startsWith(`${row.text} · `), output);
	assert.ok(output.includes(url), output);
	assert.ok(!output.includes(`${cwd} [`), output);
}));

test("both GraphQL queries normalize and persist explicit PR base metadata through fresh shared caches", async () => fixture((home) => {
	const raw = { state: "OPEN", headRefName: "feat/login", headRepository: { url: fork },
		baseRefName: "release", baseRepository: { url: widget } };
	const queries = [];
	const run = (args) => {
		const query = args.find((arg) => arg.startsWith("query="));
		queries.push(query);
		assert.match(query, /\bbaseRefName\b/);
		assert.match(query, /baseRepository\{url\}/);
		const repository = args.includes("number=1") ? { pullRequest: raw } : { pullRequests: { nodes: [raw] } };
		return { status: 0, stdout: JSON.stringify({ data: { repository } }) };
	};
	for (const info of [queryPrStatusWithGh(url, { run }), queryBranchPrWithGh("example/widget", "feat/login", { run })]) {
		assert.deepEqual(prContextFields(info), {
			headRefName: "feat/login", headRepositoryUrl: fork, baseRefName: "release", baseRepositoryUrl: widget,
		});
		const tracker = new SessionTracker("metadata");
		tracker.add(url);
		assert.equal(refreshTrackedPrStatuses(tracker, { home, now: 1000, fetchPrStatus: () => info }), true);
		writeState(tracker.snapshot(), home);
		assert.deepEqual(prContextFields(readState("metadata", home).prs[0]), prContextFields(info));
		assert.equal(readState("metadata", home).mergeStateVersion, 1);
		const older = new SessionTracker("older");
		older.add(url);
		Object.assign(older.state.prs[0], { status: tracker.state.prs[0].status, checkedAt: 1000 });
		writePrCache({ [url]: { checkedAt: 1000, info } }, home);
		refreshTrackedPrStatuses(older, { home, now: 1001 });
		assert.equal(older.state.prs[0].baseRefName, "release");
		older.state.prs[0].baseRefName = "newer";
		older.state.prs[0].checkedAt = 1002;
		refreshTrackedPrStatuses(older, { home, now: 1003 });
		assert.equal(older.state.prs[0].baseRefName, "newer");
	}
	assert.equal(queries.length, 2);
	assert.deepEqual(prContextFields({ baseRefName: 7, baseRepository: null }), { baseRefName: null, baseRepositoryUrl: null });
	const composers = ["worktree", "pr", "issue", "subagent"].map((name) =>
		readFileSync(join(repoRoot, "extensions", `${name}-statusline`, "compose.mjs")));
	assert.ok(composers.every((value) => value.equals(composers[0])), "all four composers must stay byte-identical");
}));
