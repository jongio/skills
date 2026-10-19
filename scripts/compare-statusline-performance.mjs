import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CASE_IDS, REPORT_SCHEMA, harnessIdentity } from "./benchmark-statuslines.mjs";

export const GIT_BUDGETS = { "worktree-git-1": 4, "worktree-git-16": 19 };
export const SAMPLES = 7;
const harness = fileURLToPath(new URL("./benchmark-statuslines.mjs", import.meta.url));
const SHA = /^[0-9a-f]{40}$/;

function git(root, ...args) {
	const result = spawnSync("git", ["-C", root, ...args], {
		encoding: "utf8", windowsHide: true, timeout: 30000, maxBuffer: 8 * 1024 * 1024,
	});
	assert.ifError(result.error);
	assert.equal(result.status, 0, `Git failed: ${result.stderr}`);
	return result.stdout;
}

export function isRelevantPath(path) {
	const value = path.replaceAll("\\", "/");
	return /^extensions\/.+\.mjs$/.test(value) ||
		/^extensions\/(?:.*\/)?(?:copilot-extension|plugin)\.json$/.test(value) ||
		/^install-statusline\.(?:sh|ps1)$/.test(value) ||
		/^scripts\/(?:setup-statusline|benchmark-statuslines|compare-statusline-performance|statusline-performance-offline)\.mjs$/.test(value) ||
		value === "test/statusline-performance.test.mjs" ||
		value === ".github/workflows/statusline-performance.yml";
}

export function detectChanges({ root, baseSha, headSha, candidateSha }) {
	for (const sha of [baseSha, headSha, candidateSha]) {
		assert.match(sha ?? "", SHA, "Expected an exact commit SHA");
		assert.equal(git(root, "rev-parse", "--verify", `${sha}^{commit}`).trim(), sha);
	}
	const parents = git(root, "rev-list", "--parents", "-n", "1", candidateSha).trim().split(/\s+/);
	assert.deepEqual(parents, [candidateSha, baseSha, headSha], "Candidate must be the PR test-merge commit");
	const ancestor = git(root, "merge-base", baseSha, headSha).trim();
	const paths = new Set([
		...git(root, "diff", "--name-only", "-z", "--no-renames", baseSha, candidateSha, "--").split("\0"),
		...git(root, "diff", "--name-only", "-z", "--no-renames", ancestor, headSha, "--").split("\0"),
	].filter(Boolean));
	const relevant = [...paths].filter(isRelevantPath).sort();
	return { changed: relevant.length > 0, baseSha, headSha, candidateSha, relevant };
}

export function validateReport(report, { revision, cases = CASE_IDS, harnessId = harnessIdentity() }) {
	assert.equal(report?.schema, REPORT_SCHEMA, "Incompatible benchmark schema");
	assert.equal(report.revision, revision, "Wrong measured revision");
	assert.match(revision ?? "", SHA, "Invalid revision");
	assert.equal(report.harnessId, harnessId, "Different benchmark harness");
	assert.equal(report.samples, SAMPLES, "Expected seven samples");
	assert.equal(report.platform, process.platform, "Wrong measurement platform");
	assert.equal(report.node, process.version, "Wrong Node version");
	assert.ok(typeof report.git === "string" && report.git.length > 0, "Missing Git version");
	assert.ok(Array.isArray(report.results), "Missing benchmark results");
	assert.equal(report.results.length, cases.length, "Missing or extra benchmark cases");
	assert.deepEqual(new Set(report.results.map(({ id }) => id)), new Set(cases), "Mismatched benchmark cases");
	for (const row of report.results) {
		assert.ok(CASE_IDS.includes(row.id), "Unknown benchmark case");
		if (Object.hasOwn(GIT_BUDGETS, row.id)) {
			assert.ok(Number.isSafeInteger(row.gitCalls) && row.gitCalls >= 0, "Invalid Git-call count");
		} else {
			assert.equal(row.samples, SAMPLES);
			assert.ok(Array.isArray(row.timingsMs) && row.timingsMs.length === SAMPLES, "Missing raw samples");
			assert.ok(row.timingsMs.every((n) => Number.isFinite(n) && n >= 0), "Invalid timing sample");
			const sorted = [...row.timingsMs].sort((a, b) => a - b);
			assert.equal(row.p50Ms, sorted[Math.floor(SAMPLES / 2)], "Median does not match samples");
			assert.equal(row.p95Ms, sorted[Math.ceil(SAMPLES * 0.95) - 1], "p95 does not match samples");
		}
	}
	return report;
}

export function compareReports(baseline, candidate, { baseRevision, candidateRevision, cases = CASE_IDS } = {}) {
	validateReport(baseline, { revision: baseRevision, cases });
	validateReport(candidate, { revision: candidateRevision, cases });
	assert.equal(baseline.git, candidate.git, "Git versions differ");
	return cases.map((id) => {
		const base = baseline.results.find((row) => row.id === id);
		const head = candidate.results.find((row) => row.id === id);
		if (Object.hasOwn(GIT_BUDGETS, id)) {
			return {
				id, metric: "gitCalls", baseline: base.gitCalls, candidate: head.gitCalls,
				delta: head.gitCalls - base.gitCalls, budget: GIT_BUDGETS[id],
				regression: head.gitCalls > GIT_BUDGETS[id] || head.gitCalls > base.gitCalls,
			};
		}
		const delta = head.p50Ms - base.p50Ms;
		return {
			id, metric: "ms", baseline: base.p50Ms, candidate: head.p50Ms, delta,
			deltaPercent: base.p50Ms === 0 ? null : delta / base.p50Ms * 100,
			baselineP95: base.p95Ms, candidateP95: head.p95Ms,
			regression: delta > 25 && delta > base.p50Ms * 0.2,
		};
	});
}

export function executeBenchmark({ targetRoot, revision, cases, output }) {
	assert.equal(git(targetRoot, "rev-parse", "HEAD").trim(), revision, "Checkout is not the expected revision");
	const result = spawnSync(process.execPath, [
		harness, String(SAMPLES), "--target-root", resolve(targetRoot), "--cases", cases.join(","), "--output", output,
	], {
		stdio: ["ignore", "inherit", "inherit"], windowsHide: true, timeout: 600000,
		env: { ...process.env, CI: "true" },
	});
	assert.ifError(result.error);
	assert.equal(result.status, 0, `Benchmark process failed (${result.status ?? result.signal})`);
	return JSON.parse(readFileSync(output, "utf8"));
}

const escape = (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;")
	.replaceAll(">", "&gt;").replaceAll("|", "\\|").replace(/[\r\n]/g, " ");

export function summaryMarkdown(report) {
	let text = `## Statusline performance (${process.platform})\n\n`;
	if (report.error) return `${text}**FAIL:** ${escape(report.error)}\n`;
	text += `Base: \`${report.baseRevision}\`  Candidate: \`${report.candidateRevision}\`\n\n`;
	text += "Seven-sample medians; fail above both 20% and 25 ms after one reverse-order confirmation. p95 is diagnostic.\n\n";
	text += "| Case | Base | Candidate | Delta | p95 base / candidate | Outcome |\n|---|---:|---:|---:|---:|---|\n";
	for (const row of report.rows) {
		const format = (n) => row.metric === "ms" ? n.toFixed(2) : String(n);
		const percentile = row.metric === "ms" ? `${format(row.baselineP95)} / ${format(row.candidateP95)}` : "-";
		text += `| ${escape(row.id)} | ${format(row.baseline)} | ${format(row.candidate)} | ${format(row.delta)} | ${percentile} | ${row.outcome} |\n`;
	}
	return `${text}\n**${report.passed ? "PASS" : "FAIL"}**. Raw measurements and confirmation results are attached as JSON.\n`;
}

export async function runComparison({
	baselineRoot, candidateRoot, outputDir, baseRevision, candidateRevision, headRevision,
	runBenchmark = executeBenchmark, cases = CASE_IDS, summaryPath = process.env.GITHUB_STEP_SUMMARY,
}) {
	mkdirSync(outputDir, { recursive: true });
	for (const name of ["base", "candidate", "confirmation-base", "confirmation-candidate", "comparison"]) {
		rmSync(join(outputDir, `${name}.json`), { force: true });
	}
	const report = {
		schema: "statusline-performance-comparison/v1",
		baseRevision, candidateRevision, headRevision, passed: false, rounds: [],
	};
	const run = async (label, targetRoot, revision, ids) => {
		console.log(`[statusline-performance] ${label}: ${revision}, ${ids.length} cases`);
		const result = await runBenchmark({ targetRoot, revision, cases: ids, output: join(outputDir, `${label}.json`) });
		validateReport(result, { revision, cases: ids });
		writeFileSync(join(outputDir, `${label}.json`), `${JSON.stringify(result, null, 2)}\n`);
		return result;
	};
	try {
		for (const revision of [baseRevision, candidateRevision, headRevision]) {
			assert.match(revision ?? "", SHA, "Expected exact revision provenance");
		}
		const baseline = await run("base", baselineRoot, baseRevision, cases);
		const candidate = await run("candidate", candidateRoot, candidateRevision, cases);
		report.rows = compareReports(baseline, candidate, { baseRevision, candidateRevision, cases });
		report.rounds.push({ order: ["base", "candidate"], cases });
		const deterministicFailure = report.rows.some((row) => row.metric === "gitCalls" && row.regression);
		const suspects = report.rows.filter((row) => row.metric === "ms" && row.regression).map(({ id }) => id);
		let confirmation = [];
		if (!deterministicFailure && suspects.length) {
			const candidateCheck = await run("confirmation-candidate", candidateRoot, candidateRevision, suspects);
			const baseCheck = await run("confirmation-base", baselineRoot, baseRevision, suspects);
			confirmation = compareReports(baseCheck, candidateCheck, { baseRevision, candidateRevision, cases: suspects });
			report.rounds.push({ order: ["candidate", "base"], cases: suspects });
			report.confirmation = confirmation;
		}
		for (const row of report.rows) {
			row.outcome = !row.regression ? "pass" : row.metric === "gitCalls" ? "fail"
				: deterministicFailure ? "not confirmed (deterministic failure)"
					: confirmation.find(({ id }) => id === row.id)?.regression ? "fail (confirmed)" : "unstable";
		}
		report.passed = !report.rows.some((row) => row.outcome.startsWith("fail"));
	} catch (error) {
		report.error = String(error?.message ?? error).slice(0, 4000);
	}
	writeFileSync(join(outputDir, "comparison.json"), `${JSON.stringify(report, null, 2)}\n`);
	const markdown = summaryMarkdown(report);
	writeFileSync(join(outputDir, "summary.md"), markdown);
	if (summaryPath) appendFileSync(summaryPath, markdown);
	return report;
}

export function resultVerdict({ detection, changed, measurement }) {
	assert.equal(detection, "success", "Change detection did not succeed");
	assert.ok(["true", "false"].includes(changed), "Missing change decision");
	assert.equal(measurement, changed === "true" ? "success" : "skipped",
		"Required OS measurements did not succeed or skip as expected");
	return changed === "true" ? "PASS: Windows and Linux measurements passed." : "Not applicable: no statusline changes.";
}

async function main() {
	const args = process.argv.slice(2);
	if (args.length === 1 && args[0] === "--detect") {
		const detection = detectChanges({
			root: process.cwd(), baseSha: process.env.BASE_SHA, headSha: process.env.HEAD_SHA,
			candidateSha: process.env.CANDIDATE_SHA,
		});
		if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT,
			`changed=${detection.changed}\nbase=${detection.baseSha}\nhead=${detection.headSha}\ncandidate=${detection.candidateSha}\n`);
		const text = `## Statusline performance scope\n\n${detection.changed ? "Relevant changes detected." : "Not applicable: no statusline changes."}\n`;
		if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
		console.log(JSON.stringify(detection, null, 2));
		return;
	}
	if (args.length === 1 && args[0] === "--result") {
		const result = resultVerdict({
			detection: process.env.DETECTION_RESULT, changed: process.env.CHANGED,
			measurement: process.env.MEASUREMENT_RESULT,
		});
		if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Statusline performance result\n\n${result}\n`);
		console.log(result);
		return;
	}
	const names = {
		"--baseline-root": "baselineRoot", "--candidate-root": "candidateRoot", "--output-dir": "outputDir",
		"--base-sha": "baseRevision", "--candidate-sha": "candidateRevision", "--head-sha": "headRevision",
	};
	const options = {};
	for (let i = 0; i < args.length; i += 2) {
		assert.ok(names[args[i]] && args[i + 1] && !args[i + 1].startsWith("--"), `Invalid argument: ${args[i]}`);
		assert.ok(!Object.hasOwn(options, names[args[i]]), `Duplicate argument: ${args[i]}`);
		options[names[args[i]]] = args[i + 1];
	}
	for (const name of ["baselineRoot", "candidateRoot", "outputDir"]) assert.ok(options[name], `Missing ${name}`);
	options.baseRevision ??= git(options.baselineRoot, "rev-parse", "HEAD").trim();
	options.candidateRevision ??= git(options.candidateRoot, "rev-parse", "HEAD").trim();
	options.headRevision ??= options.candidateRevision;
	const result = await runComparison(options);
	console.log(result.passed ? "Statusline performance passed." : `Statusline performance failed: ${result.error ?? "regression"}`);
	if (!result.passed) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch((error) => {
		process.exitCode = 1;
		const message = String(error?.message ?? error);
		console.error(message);
		if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
			`## Statusline performance failure\n\n${escape(message)}\n`);
	});
}
