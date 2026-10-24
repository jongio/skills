import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { CASE_IDS, REPORT_SCHEMA, harnessIdentity } from "../scripts/benchmark-statuslines.mjs";
import {
	compareReports, detectChanges, GIT_BUDGETS, isRelevantPath, resultVerdict, runComparison, validateReport,
} from "../scripts/compare-statusline-performance.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const baseRevision = "a".repeat(40);
const candidateRevision = "b".repeat(40);
const options = { baseRevision, candidateRevision };
const sample = (revision, values = {}, cases = CASE_IDS) => ({
	schema: REPORT_SCHEMA, revision, harnessId: harnessIdentity(), samples: 7,
	node: process.version, platform: process.platform, git: "git fixture",
	results: cases.map((id) => Object.hasOwn(GIT_BUDGETS, id) ? {
		id, gitCalls: values[id] ?? GIT_BUDGETS[id],
	} : {
		id, samples: 7, timingsMs: Array(7).fill(values[id] ?? 100),
		p50Ms: values[id] ?? 100, p95Ms: values[id] ?? 100,
	}),
});
const compare = (base, head) => compareReports(
	sample(baseRevision, { "pr-warm-20": base }), sample(candidateRevision, { "pr-warm-20": head }), options,
).find(({ id }) => id === "pr-warm-20");

test("median gate uses strict conjunction, handles zero, and leaves p95 diagnostic", () => {
	for (const [base, head, regression] of [
		[100, 125, false], [100, 125.01, true], [200, 240, false], [200, 240.01, true],
		[200, 230, false], [50, 70, false], [100, 50, false], [0, 0, false], [0, 25, false], [0, 26, true],
	]) assert.equal(compare(base, head).regression, regression, `${base} -> ${head}`);
	assert.equal(compare(0, 26).deltaPercent, null);
	const head = sample(candidateRevision);
	head.results[0].timingsMs[6] = head.results[0].p95Ms = 10000;
	assert.equal(compareReports(sample(baseRevision), head, options)[0].regression, false);
});

test("Git-call ceilings apply only to candidate and increases are rejected independently", () => {
	const base = sample(baseRevision, { "worktree-git-1": 8, "worktree-git-16": 68 });
	assert.ok(compareReports(base, sample(candidateRevision), options).every(({ regression }) => !regression));
	for (const [id, value] of [["worktree-git-1", 5], ["worktree-git-16", 20]]) {
		assert.ok(compareReports(base, sample(candidateRevision, { [id]: value }), options)
			.find((row) => row.id === id).regression);
	}
	assert.ok(compareReports(sample(baseRevision, { "worktree-git-1": 3 }), sample(candidateRevision), options)
		.find(({ id }) => id === "worktree-git-1").regression);
});

test("malformed and incompatible evidence fails closed", () => {
	const changes = [
		(report) => { report.schema = "old"; },
		(report) => { report.revision = candidateRevision; },
		(report) => { report.harnessId = "different"; },
		(report) => { report.platform = "different"; },
		(report) => { report.node = "different"; },
		(report) => { report.samples = 3; },
		(report) => { report.git = ""; },
		(report) => { report.results.pop(); },
		(report) => { report.results[1] = report.results[0]; },
		(report) => { report.results[0].timingsMs[0] = NaN; },
		(report) => { report.results[0].timingsMs[0] = -1; },
		(report) => { report.results[0].timingsMs.pop(); },
		(report) => { report.results[0].samples = 6; },
		(report) => { report.results[0].p50Ms = 1; },
		(report) => { report.results[0].p95Ms = Infinity; },
		(report) => { report.results.find(({ id }) => id === "worktree-git-1").gitCalls = 1.5; },
	];
	for (const change of changes) {
		const report = sample(baseRevision);
		change(report);
		assert.throws(() => validateReport(report, { revision: baseRevision }));
	}
	const head = sample(candidateRevision);
	head.git = "another Git";
	assert.throws(() => compareReports(sample(baseRevision), head, options), /Git versions differ/);
});

async function orchestrate(t, values) {
	const outputDir = mkdtempSync(join(tmpdir(), "statusline-comparison-test-"));
	t.after(() => rmSync(outputDir, { recursive: true, force: true }));
	const calls = [];
	const result = await runComparison({
		...options, headRevision: candidateRevision, baselineRoot: "base", candidateRoot: "candidate", outputDir,
		summaryPath: join(outputDir, "github-summary.md"),
		runBenchmark: async ({ revision, cases, output }) => {
			calls.push({ revision, cases, output });
			const value = values[calls.length - 1];
			if (value instanceof Error) throw value;
			return sample(revision, value, cases);
		},
	});
	assert.equal(JSON.parse(readFileSync(join(outputDir, "comparison.json"), "utf8")).passed, result.passed);
	assert.ok(existsSync(join(outputDir, "summary.md")));
	assert.match(readFileSync(join(outputDir, "github-summary.md"), "utf8"), /Statusline performance/);
	return { result, calls, outputDir };
}

test("timing confirmation runs affected cases once in candidate/base order and blocks persistence", async (t) => {
	const { result, calls } = await orchestrate(t, [
		{}, { "pr-warm-20": 200 }, { "pr-warm-20": 200 }, {},
	]);
	assert.equal(result.passed, false);
	assert.equal(calls.length, 4);
	assert.deepEqual(calls.map(({ revision }) => revision),
		[baseRevision, candidateRevision, candidateRevision, baseRevision]);
	assert.deepEqual(calls.slice(2).map(({ cases }) => cases), [["pr-warm-20"], ["pr-warm-20"]]);
	assert.equal(result.rows[0].outcome, "fail (confirmed)");
});

test("non-reproducing timings are unstable, not retried until green", async (t) => {
	const { result, calls } = await orchestrate(t, [{}, { "issue-cli": 200 }, {}, {}]);
	assert.equal(result.passed, true);
	assert.equal(calls.length, 4);
	assert.equal(result.rows.find(({ id }) => id === "issue-cli").outcome, "unstable");
});

test("successful comparisons need one round; deterministic failures and process errors never retry", async (t) => {
	assert.equal((await orchestrate(t, [{}, {}])).calls.length, 2);
	const deterministic = await orchestrate(t, [{}, { "worktree-git-1": 5, "pr-warm-20": 200 }]);
	assert.equal(deterministic.calls.length, 2);
	assert.equal(deterministic.result.passed, false);
	const failed = await orchestrate(t, [new Error("child process failed")]);
	assert.equal(failed.calls.length, 1);
	assert.equal(failed.result.passed, false);
	assert.match(failed.result.error, /child process failed/);
	const confirmationFailure = await orchestrate(t, [{}, { "pr-cold": 200 }, new Error("confirmation failed")]);
	assert.equal(confirmationFailure.calls.length, 3);
	assert.equal(confirmationFailure.result.passed, false);
});

test("scope includes runtime, setup, manifests and gate self-changes but ignores documentation/site", () => {
	for (const path of [
		"extensions/pr-statusline/render.mjs", "extensions/issue-statusline/test/a test.mjs",
		"extensions/subagent-statusline/copilot-extension.json", "extensions/worktree-statusline/compose.mjs",
		"extensions/plugin.json", "extensions/pr-statusline/extension.mjs",
		"scripts/setup-statusline.mjs", "scripts/benchmark-statuslines.mjs",
		"scripts/statusline-performance-offline.mjs", "scripts/compare-statusline-performance.mjs",
		"test/statusline-performance.test.mjs", ".github/workflows/statusline-performance.yml",
		"test/github-runtime.test.mjs", "runtime/github-client/client.mjs", "runtime/github-client/package-lock.json",
		"install-statusline.ps1", "install-statusline.sh",
	]) assert.ok(isRelevantPath(path), path);
	for (const path of [
		"README.md", "extensions/worktree-statusline/README.md", "extensions/pr-statusline/screenshot.png",
		"runtime/github-client/README.md",
		"site/src/pages/index.astro", "skills/eli5/SKILL.md", "scripts/unrelated.mjs",
	]) assert.equal(isRelevantPath(path), false, path);
});

function command(cwd, ...args) {
	const result = spawnSync("git", ["-C", cwd, ...args], {
		encoding: "utf8", timeout: 30000, windowsHide: true,
		env: { ...process.env, GIT_CONFIG_COUNT: "2", GIT_CONFIG_KEY_0: "user.name", GIT_CONFIG_VALUE_0: "Fixture",
			GIT_CONFIG_KEY_1: "user.email", GIT_CONFIG_VALUE_1: "fixture@example.invalid" },
	});
	assert.ifError(result.error);
	assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
	return result.stdout.trim();
}

function fixture(t) {
	const directory = mkdtempSync(join(tmpdir(), "statusline-git-test-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	command(directory, "init", "--initial-branch=main");
	command(directory, "config", "core.hooksPath", join(directory, "no-hooks"));
	const commit = () => {
		command(directory, "add", ".");
		command(directory, "commit", "--allow-empty", "-m", "fixture");
		return command(directory, "rev-parse", "HEAD");
	};
	return { directory, commit };
}

test("NUL-delimited Git detection handles renames/removals/spaces and excludes base-only drift", (t) => {
	const { directory, commit } = fixture(t);
	mkdirSync(join(directory, "extensions", "pr-statusline"), { recursive: true });
	writeFileSync(join(directory, "extensions", "pr-statusline", "a space.mjs"), "original");
	commit();
	command(directory, "branch", "contributor");
	mkdirSync(join(directory, "extensions", "issue-statusline"));
	writeFileSync(join(directory, "extensions", "issue-statusline", "base-only.mjs"), "base");
	const baseSha = commit();
	command(directory, "checkout", "contributor");
	command(directory, "mv", "extensions/pr-statusline/a space.mjs", "unrelated.txt");
	const headSha = commit();
	command(directory, "checkout", "main");
	command(directory, "merge", "--no-ff", "contributor", "-m", "merge");
	const candidateSha = command(directory, "rev-parse", "HEAD");
	const result = detectChanges({ root: directory, baseSha, headSha, candidateSha });
	assert.equal(result.changed, true);
	assert.deepEqual(result.relevant, ["extensions/pr-statusline/a space.mjs"]);
	assert.throws(() => detectChanges({ root: directory, baseSha: "f".repeat(40), headSha, candidateSha }));
	assert.throws(() => detectChanges({ root: directory, baseSha, headSha, candidateSha: headSha }), /test-merge/);
});

test("an unrelated PR produces an explicit no-op", (t) => {
	const { directory, commit } = fixture(t);
	const baseSha = commit();
	command(directory, "checkout", "-b", "contributor");
	writeFileSync(join(directory, "README.md"), "documentation");
	const headSha = commit();
	command(directory, "checkout", "main");
	command(directory, "merge", "--no-ff", "contributor", "-m", "merge");
	const candidateSha = command(directory, "rev-parse", "HEAD");
	const result = detectChanges({ root: directory, baseSha, headSha, candidateSha });
	assert.equal(result.changed, false);
	assert.match(resultVerdict({ detection: "success", changed: "false", measurement: "skipped" }), /Not applicable/);
	const output = join(directory, "outputs.txt");
	const summary = join(directory, "summary.md");
	const cli = spawnSync(process.execPath, [join(root, "scripts", "compare-statusline-performance.mjs"), "--detect"], {
		cwd: directory, encoding: "utf8", timeout: 30000, windowsHide: true,
		env: { ...process.env, BASE_SHA: baseSha, HEAD_SHA: headSha, CANDIDATE_SHA: candidateSha,
			GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary },
	});
	assert.equal(cli.status, 0, cli.stderr);
	assert.match(readFileSync(output, "utf8"), /^changed=false\n/);
	assert.match(readFileSync(summary, "utf8"), /Not applicable/);
});

test("contributor-side gate changes remain relevant even when merge resolution drops them", (t) => {
	const { directory, commit } = fixture(t);
	const baseSha = commit();
	command(directory, "checkout", "-b", "contributor");
	mkdirSync(join(directory, "scripts"));
	writeFileSync(join(directory, "scripts", "compare-statusline-performance.mjs"), "gate change");
	const headSha = commit();
	command(directory, "checkout", "main");
	command(directory, "merge", "--no-ff", "-s", "ours", "contributor", "-m", "merge");
	const candidateSha = command(directory, "rev-parse", "HEAD");
	assert.deepEqual(detectChanges({ root: directory, baseSha, headSha, candidateSha }).relevant,
		["scripts/compare-statusline-performance.mjs"]);
});

test("final result rejects failed/cancelled/missing detection or required OS jobs", () => {
	assert.match(resultVerdict({ detection: "success", changed: "true", measurement: "success" }), /Windows and Linux/);
	for (const detection of ["failure", "cancelled", "skipped", undefined]) {
		assert.throws(() => resultVerdict({ detection, changed: "false", measurement: "skipped" }));
	}
	for (const measurement of ["failure", "cancelled", "skipped", undefined]) {
		assert.throws(() => resultVerdict({ detection: "success", changed: "true", measurement }));
	}
	assert.throws(() => resultVerdict({ detection: "success", measurement: "success" }));
});

test("final result CLI blocks cancelled measurements and publishes its failure summary", (t) => {
	const directory = mkdtempSync(join(tmpdir(), "statusline-result-test-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const summary = join(directory, "summary.md");
	const result = spawnSync(process.execPath, [join(root, "scripts", "compare-statusline-performance.mjs"), "--result"], {
		encoding: "utf8", timeout: 10000, windowsHide: true,
		env: { ...process.env, DETECTION_RESULT: "success", CHANGED: "true",
			MEASUREMENT_RESULT: "cancelled", GITHUB_STEP_SUMMARY: summary },
	});
	assert.equal(result.status, 1);
	assert.match(readFileSync(summary, "utf8"), /Statusline performance failure/);
	assert.match(readFileSync(summary, "utf8"), /Required OS measurements did not succeed/);
});

test("common harness targets a checkout without its own benchmark, propagates failures, and cleans fixtures", { timeout: 60000 }, (t) => {
	const { directory, commit } = fixture(t);
	cpSync(join(root, "extensions"), join(directory, "extensions"), {
		recursive: true, filter: (path) => !/[/\\](?:test|screenshots)(?:[/\\]|$)/.test(path),
	});
	mkdirSync(join(directory, "scripts"));
	cpSync(join(root, "scripts", "setup-statusline.mjs"), join(directory, "scripts", "setup-statusline.mjs"));
	const revision = commit();
	assert.equal(existsSync(join(directory, "scripts", "benchmark-statuslines.mjs")), false);
	const harness = join(root, "scripts", "benchmark-statuslines.mjs");
	const output = join(directory, "metrics.json");
	const before = readdirSync(tmpdir()).filter((name) => name.startsWith("statusline-perf-")).sort();
	const run = () => spawnSync(process.execPath, [
		harness, "7", "--target-root", directory, "--cases", "pr-warm-20", "--output", output,
	], { encoding: "utf8", timeout: 30000, windowsHide: true });
	const success = run();
	assert.equal(success.status, 0, success.stderr);
	validateReport(JSON.parse(readFileSync(output, "utf8")), { revision, cases: ["pr-warm-20"] });
	writeFileSync(join(directory, "extensions", "pr-statusline", "render.mjs"),
		'export function render() { throw new Error("target runtime sentinel"); }\n');
	const failure = run();
	assert.notEqual(failure.status, 0);
	assert.match(failure.stderr, /target runtime sentinel/);
	assert.deepEqual(readdirSync(tmpdir()).filter((name) => name.startsWith("statusline-perf-")).sort(), before);
});

test("offline guard blocks direct, executable-path and caught GitHub commands in fresh processes", () => {
	const guard = new URL("../scripts/statusline-performance-offline.mjs", import.meta.url).href;
	const quotedCommand = JSON.stringify(`"${join(tmpdir(), "missing gh fixture", "gh.exe")}" api user`);
	for (const code of [
		'import { spawnSync } from "node:child_process"; spawnSync("gh", ["api", "user"]);',
		'import { execSync } from "node:child_process"; execSync("gh api user");',
		'import { execFileSync } from "node:child_process"; execFileSync("gh.exe", ["api", "user"]);',
		'import { spawnSync } from "node:child_process"; spawnSync("cmd.exe", ["/c", "gh api user"]);',
		`import { execSync } from "node:child_process"; execSync(${quotedCommand});`,
		`import { spawnSync } from "node:child_process"; import { assertOffline } from ${JSON.stringify(guard)}; try { spawnSync("gh", []); } catch {} assertOffline();`,
	]) {
		const result = spawnSync(process.execPath, ["--import", guard, "--input-type=module", "-e", code],
			{ encoding: "utf8", timeout: 10000, windowsHide: true });
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /benchmark (?:forbids|blocked)/);
	}
});

test("Git-backed fixtures work when the temporary directory is a filesystem alias", { timeout: 60000 }, (t) => {
	const directory = mkdtempSync(join(tmpdir(), "statusline-temp-alias-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const target = join(directory, "actual temporary directory");
	const alias = join(directory, "temp-alias");
	mkdirSync(target);
	symlinkSync(target, alias, "junction");
	const { NODE_TEST_CONTEXT: _parentTestContext, ...env } = process.env;
	const result = spawnSync(process.execPath, [
		"--test", "--test-reporter=tap", "--test-name-pattern", "one render shares checkout reads|nested directories share|repositories without a first commit",
		join(root, "extensions", "worktree-statusline", "test", "performance.test.mjs"),
		join(root, "extensions", "worktree-statusline", "test", "smoke.test.mjs"),
	], {
		encoding: "utf8", timeout: 45000, windowsHide: true,
		env: { ...env, TEMP: alias, TMP: alias, TMPDIR: alias },
	});
	assert.ifError(result.error);
	assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
	assert.match(result.stdout, /^# tests 3\r?$/m);
	assert.match(result.stdout, /^# pass 3\r?$/m);
});

test("workflow keeps a stable gate, two OS targets, exact revisions and explicit metric uploads", () => {
	const workflow = readFileSync(join(root, ".github", "workflows", "statusline-performance.yml"), "utf8");
	assert.match(workflow, /on:\s*\n  pull_request:\s*\n/);
	assert.doesNotMatch(workflow, /\bpaths(?:-ignore)?:/);
	assert.match(workflow, /os: \[ubuntu-latest, windows-latest\]/);
	assert.match(workflow, /fail-fast: false/);
	assert.match(workflow, /name: Statusline performance result/);
	assert.match(workflow, /result:\s*\n\s+name: Statusline performance result\s*\n\s+if: \$\{\{ always\(\) \}\}/);
	assert.match(workflow, /needs: \[detect, measure\]/);
	assert.match(workflow, /BASE_SHA: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/);
	assert.match(workflow, /HEAD_SHA: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/);
	assert.match(workflow, /CANDIDATE_SHA: \$\{\{ github\.sha \}\}/);
	assert.ok(workflow.indexOf("Statusline correctness") < workflow.indexOf("Compare identical workloads"));
	assert.match(workflow, /run: node --test --test-concurrency=1 "extensions\/\*-statusline\/test\/\*\.test\.mjs" "extensions\/daemon-notifications\/test\/\*\.test\.mjs" test\/statusline-performance\.test\.mjs test\/distribution-manifests\.test\.mjs test\/github-runtime\.test\.mjs/);
	assert.match(workflow, /retention-days: 3/);
	assert.match(workflow, /if-no-files-found: warn/);
	for (const file of ["base", "candidate", "confirmation-base", "confirmation-candidate", "comparison"]) {
		assert.ok(workflow.includes(`/statusline-performance/${file}.json`));
	}
	assert.doesNotMatch(workflow, /(?:npm|pnpm) (?:install|ci)|actions\/cache|pull_request_target/);
});
