import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertOffline } from "./statusline-performance-offline.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const offlineGuard = new URL("./statusline-performance-offline.mjs", import.meta.url);
const plain = { color: false, links: false, nerdFont: false };
export const REPORT_SCHEMA = "statusline-performance/v1";
export const CASE_IDS = [
	"pr-warm-20", "issue-warm-20", "subagent-warm-20",
	"pr-warm-200", "issue-warm-200", "subagent-warm-200",
	"worktree-warm-1", "worktree-git-1", "worktree-warm-16", "worktree-git-16",
	"pr-cold", "issue-cold", "subagent-cold", "worktree-cold", "combined-warm",
	"pr-cli", "issue-cli", "subagent-cli", "worktree-cli", "combined-cli",
];

export function harnessIdentity() {
	const hash = createHash("sha256");
	for (const file of [fileURLToPath(import.meta.url), fileURLToPath(offlineGuard)]) hash.update(readFileSync(file));
	return hash.digest("hex");
}

export async function benchmarkStatuslines({ samples = 7, targetRoot = repoRoot, cases = CASE_IDS } = {}) {
	assert.ok(Number.isSafeInteger(samples) && samples >= 3, "samples must be an integer >= 3");
	assert.ok(cases.length > 0 && new Set(cases).size === cases.length && cases.every((id) => CASE_IDS.includes(id)),
		"cases must be unique known case IDs");
	targetRoot = resolve(targetRoot);
	const load = (file) => import(pathToFileURL(join(targetRoot, ...file.split("/"))).href);
	const [
		{ configureStatuslines }, { SessionTracker, writeState: writePrState },
		{ OCTICONS, summarizePrStatus, writePrCache }, { IssueTracker, writeState: writeIssueState },
		{ summarizeIssueStatus, writeIssueCache }, { SubagentTracker, writeState: writeAgentState },
		{ render: renderPr }, { render: renderIssue }, { render: renderAgent }, { render: renderWorktree },
		{ composeStatusLine }, { sessionDirectory },
	] = await Promise.all([
		"scripts/setup-statusline.mjs", "extensions/pr-statusline/tracker.mjs",
		"extensions/pr-statusline/github.mjs", "extensions/issue-statusline/tracker.mjs",
		"extensions/issue-statusline/github.mjs", "extensions/subagent-statusline/tracker.mjs",
		"extensions/pr-statusline/render.mjs", "extensions/issue-statusline/render.mjs",
		"extensions/subagent-statusline/render.mjs", "extensions/worktree-statusline/render.mjs",
		"extensions/worktree-statusline/compose.mjs", "extensions/worktree-statusline/tracker.mjs",
	].map(load));
	const root = mkdtempSync(join(tmpdir(), "statusline-perf-"));
	const results = [];
	const git = (cwd, ...args) => {
		const result = spawnSync("git", ["-C", cwd, ...args], {
			encoding: "utf8", windowsHide: true, timeout: 10000,
		});
		assert.ifError(result.error);
		assert.equal(result.status, 0, result.stderr);
		return result.stdout.trim();
	};
	const measure = async (id, name, run, { before = () => {}, verify = () => {} } = {}) => {
		if (!cases.includes(id)) return;
		if (process.env.CI === "true") console.error(`[statusline-performance] measuring ${id}`);
		await before();
		verify(await run());
		assertOffline();
		const timings = [];
		for (let i = 0; i < samples; i++) {
			await before();
			const start = performance.now();
			const output = await run();
			timings.push(performance.now() - start);
			verify(output);
			assertOffline();
		}
		const sorted = [...timings].sort((a, b) => a - b);
		results.push({
			id, name, samples, timingsMs: timings, p50Ms: sorted[Math.floor(samples / 2)],
			p95Ms: sorted[Math.ceil(samples * 0.95) - 1],
		});
	};
	try {
		const checkout = join(root, "checkout");
		mkdirSync(checkout);
		git(checkout, "init", "--initial-branch=main");
		git(checkout, "remote", "add", "origin", "https://github.com/perf-fixture/project.git");
		git(checkout, "-c", "user.name=Performance Fixture", "-c", "user.email=perf@example.invalid",
			"-c", `core.hooksPath=${join(root, "no-hooks")}`, "commit", "--allow-empty", "-m", "fixture");
		let now = Date.now();
		const home = join(root, "home");
		configureStatuslines({ home, repoRoot: targetRoot });
		const sessionId = "benchmark";
		const transcriptDir = join(home, "session-state", sessionId);
		mkdirSync(transcriptDir, { recursive: true });
		const transcript = join(transcriptDir, "events.jsonl");
		const payload = { session_id: sessionId, transcript_path: transcript, cwd: checkout };
		const options = { ...plain, home, now };
		const events = [JSON.stringify({ type: "session.start", data: { context: {
			cwd: checkout, repository: "perf-fixture/project",
		} } })];
		for (let i = 0; i < 2000; i++) events.push(JSON.stringify({
			type: "assistant.message", data: { content: "fixture ".repeat(64) },
		}));
		writeFileSync(transcript, events.join("\n") + "\n");
		const transcriptOffset = statSync(transcript).size;
		const seed = (count) => {
			now = Date.now();
			options.now = now;
			const prs = new SessionTracker(sessionId);
			const issues = new IssueTracker(sessionId);
			const agents = new SubagentTracker(sessionId);
			const prCache = {};
			const issueCache = {};
			for (let number = 1; number <= count; number++) {
				const prUrl = `https://github.com/perf-fixture/project/pull/${number}`;
				prs.add(prUrl, false, { root: true });
				const prInfo = {
					state: "OPEN", title: `PR ${number}`, headRefName: "main", baseRefName: "main",
					headRepositoryUrl: "https://github.com/perf-fixture/project",
					baseRepositoryUrl: "https://github.com/perf-fixture/project",
					statusCheckRollup: [], reviewDecision: "APPROVED", reviewThreads: { nodes: [] },
				};
				Object.assign(prs.state.prs.at(-1), {
					...prInfo, status: summarizePrStatus(prInfo), checkedAt: now,
				});
				prCache[prUrl] = { info: prInfo, checkedAt: now, ttlMs: 86400000 };
				const issueUrl = `https://github.com/perf-fixture/project/issues/${number}`;
				issues.add(issueUrl);
				const issueInfo = { state: "OPEN", title: `Issue ${number}`, comments: { totalCount: 0 } };
				Object.assign(issues.state.issues.at(-1), {
					status: summarizeIssueStatus(issueInfo), checkedAt: now,
				});
				issueCache[issueUrl] = { info: issueInfo, checkedAt: now, ttlMs: 86400000 };
				agents.ensureAgent(`agent-${number}`, { name: "developer" });
				agents.linkPr(`agent-${number}`, prUrl);
			}
			prs.state.transcriptOffset = transcriptOffset;
			issues.state.transcriptOffset = transcriptOffset;
			agents.transcriptOffset = transcriptOffset;
			writePrState(prs.snapshot(), home);
			writeIssueState(issues.snapshot(), home);
			writeAgentState(agents.snapshot(), home);
			writePrCache(prCache, home);
			writeIssueCache(issueCache, home);
		};
		for (const count of [20, 200]) {
			seed(count);
			assert.ok(readFileSync(join(home, "pr-statusline", `${sessionId}.json`), "utf8").includes(OCTICONS.approved));
			await measure(`pr-warm-${count}`, `pr warm (${count})`, () => renderPr(payload, options), {
				verify: (output) => assert.ok(output.includes(`project#${count}`)),
			});
			await measure(`issue-warm-${count}`, `issue warm (${count})`, () => renderIssue(payload, options), {
				verify: (output) => assert.ok(output.includes(`project#${count}`)),
			});
			await measure(`subagent-warm-${count}`, `subagent warm (${count})`, () => renderAgent(payload, options), {
				verify: (output) => assert.ok(output.includes(`${count} in PR`)),
			});
		}
		seed(20);
		sessionDirectory(payload, { home });
		await measure("worktree-warm-1", "worktree warm (1 directory)", () => renderWorktree(payload, options));
		let gitCalls = 0;
		if (cases.includes("worktree-git-1")) {
			renderWorktree(payload, {
				...options, run: (...args) => { gitCalls++; return spawnSync(...args); },
			});
			results.push({ id: "worktree-git-1", name: "worktree git subprocesses (1 directory)", gitCalls });
		}
		const worktreeStatePath = join(home, "worktree-statusline", `${sessionId}.json`);
		const worktreeState = JSON.parse(readFileSync(worktreeStatePath, "utf8"));
		for (let i = 0; i < 15; i++) {
			const directory = join(checkout, `directory-${i}`);
			mkdirSync(directory);
			worktreeState.directories.push(directory);
		}
		writeFileSync(worktreeStatePath, JSON.stringify(worktreeState));
		await measure("worktree-warm-16", "worktree warm (16 directories, 1 checkout)", () => renderWorktree(payload, options));
		gitCalls = 0;
		if (cases.includes("worktree-git-16")) {
			renderWorktree(payload, {
				...options, run: (...args) => { gitCalls++; return spawnSync(...args); },
			});
			results.push({ id: "worktree-git-16", name: "worktree git subprocesses (16 directories, 1 checkout)", gitCalls });
		}
		worktreeState.directories = [checkout];
		writeFileSync(worktreeStatePath, JSON.stringify(worktreeState));
		for (const [name, render, stateDir, extra] of [
			["pr", renderPr, "pr-statusline", { fetchPrStatus: false }],
			["issue", renderIssue, "issue-statusline", { fetchIssueStatus: false }],
			["subagent", renderAgent, "subagent-statusline", {}],
			["worktree", renderWorktree, "worktree-statusline", {}],
		]) {
			const stateFile = join(home, stateDir, `${sessionId}.json`);
			await measure(`${name}-cold`, `${name} cold replay (${transcriptOffset} bytes)`,
				() => render(payload, { ...options, ...extra }),
				{ before: () => rmSync(stateFile, { force: true }) });
		}
		seed(20);
		await measure("combined-warm", "combined warm (20 PRs, issues, agents)", () => composeStatusLine(payload, options), {
			verify: (output) => assert.ok(output.includes("20 in PR")),
		});
		for (const name of ["pr", "issue", "subagent", "worktree", "combined"]) {
			const script = name === "combined"
				? join(home, "statusline-compose.mjs")
				: join(targetRoot, "extensions", `${name}-statusline`, "render.mjs");
			await measure(`${name}-cli`, `${name} CLI (cached state, includes Node startup)`, () => {
				const result = spawnSync(process.execPath, ["--import", offlineGuard.href, script, "--plain"], {
					input: JSON.stringify(payload), encoding: "utf8", windowsHide: true, timeout: 30000,
					env: { ...process.env, COPILOT_HOME: home, NO_COLOR: "1" },
				});
				assert.ifError(result.error);
				assert.equal(result.status, 0, result.stderr);
				return result.stdout;
			}, { before: () => seed(20) });
		}
		assertOffline();
		return {
			schema: REPORT_SCHEMA, harnessId: harnessIdentity(),
			revision: git(targetRoot, "rev-parse", "HEAD"),
			git: git(targetRoot, "--version"), node: process.version, platform: process.platform, samples,
			conditions: "Isolated synthetic session, local Git fixture, cached GitHub data; no live network.",
			results,
		};
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const args = process.argv.slice(2);
	const options = {};
	let output;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--target-root") options.targetRoot = args[++i];
		else if (arg === "--cases") options.cases = args[++i]?.split(",");
		else if (arg === "--output") output = args[++i];
		else if (/^\d+$/.test(arg) && options.samples === undefined) options.samples = Number(arg);
		else throw new Error(`Unknown benchmark argument: ${arg}`);
		if (arg.startsWith("--") && !args[i]) throw new Error(`Missing value for ${arg}`);
	}
	benchmarkStatuslines(options).then((result) => {
		const json = `${JSON.stringify(result, null, 2)}\n`;
		if (output) writeFileSync(output, json);
		else process.stdout.write(json);
	}).catch((error) => {
		console.error(error);
		process.exitCode = 1;
	});
}
