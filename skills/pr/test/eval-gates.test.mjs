import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { assertReviewScopeTrials, reviewScopeCases } from "../scripts/assert-review-scope.mjs";

const trial = (stimulus) => ({
  type: "trial-result",
  stimulus,
  gradeResult: { details: [
    { name: "skill-invocation", passed: true },
    { name: "diff-empty-workspace", passed: true },
    { name: "tool-calls-local-checks", passed: true },
    { name: {
      "critical-triage-and-declined-bot-thread-resolution": "critical-triage-anti-overengineering-and-bot-resolution",
      "review-scope-and-subtractive-cleanup": "supported-scope-and-subtractive-cleanup",
      "review-scope-preserves-sound-workspace": "review-scope-workspace-evidence",
      "review-scope-valid-comment-deferred": "review-scope-valid-comment-evidence",
      "review-scope-rejects-poor-implementation": "review-scope-poor-implementation-evidence",
    }[stimulus], passed: true },
  ] },
});
const passing = () => reviewScopeCases.flatMap((name) => Array.from({ length: 5 }, () => trial(name)));

test("a failed review-scope rubric cannot hide behind a passing aggregate", () => {
  const records = passing();
  records.push({ type: "run-summary", passed: true, evals: [{ overallScore: 0.99, threshold: 0.85 }] });
  assert.equal(assertReviewScopeTrials(records), reviewScopeCases.length * 5);
  for (const name of reviewScopeCases) {
    const failed = structuredClone(records);
    failed.find((record) => record.stimulus === name).gradeResult.details.at(-1).passed = false;
    assert.throws(() => assertReviewScopeTrials(failed), /review-scope trials cannot be averaged/);
  }
});

test("workspace edits and absent grading or trial evidence fail closed", () => {
  const records = passing();
  records.at(-1).gradeResult.details[1].passed = false;
  assert.throws(() => assertReviewScopeTrials(records), /diff-empty-workspace failed/);
  assert.throws(() => assertReviewScopeTrials(passing().slice(1)), /expected 5 trials, received 4/);
  assert.throws(() => assertReviewScopeTrials([]), /expected 5 trials, received 0/);
  for (const details of [undefined, [], [{ name: "review-rubric", passed: true }]]) {
    const missing = passing();
    missing[0].gradeResult.details = details;
    assert.throws(() => assertReviewScopeTrials(missing), /missing/);
  }
  const missingRubric = passing();
  missingRubric[0].gradeResult.details.at(-1).name = "unrelated-passing-check";
  assert.throws(() => assertReviewScopeTrials(missingRubric), /missing review rubric/);
});

test("manual filters may omit cases but never forgive failures in selected trials", () => {
  assert.equal(assertReviewScopeTrials([], { filtered: true }), 0);
  const selected = passing().filter((record) => record.stimulus === reviewScopeCases[0]);
  assert.equal(assertReviewScopeTrials(selected, { filtered: true }), 5);
  selected[0].gradeResult.details.at(-1).passed = false;
  assert.throws(() => assertReviewScopeTrials(selected, { filtered: true }), /cannot be averaged/);
});

test("the CI command reports selected trials and exits unsuccessfully for a failed rubric", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pr-review-gate-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "results.jsonl");
  const script = fileURLToPath(new URL("../scripts/assert-review-scope.mjs", import.meta.url));
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const run = (...args) => execFileSync(process.execPath, [script, ...args], {
    env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30000,
  });
  const records = passing();
  await writeFile(file, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
  assert.match(run(file), /passed for 25 selected trials/);
  records[0].gradeResult.details.at(-1).passed = false;
  await writeFile(file, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
  assert.throws(() => run(file), (error) =>
    error.status === 1 && /review-scope trials cannot be averaged/.test(error.stderr));
  await writeFile(file, "");
  assert.match(run(file, "--filtered"), /No review-scope trials were selected/);
  assert.throws(() => run(file, "--unknown"), (error) =>
    error.status === 1 && /Usage:/.test(error.stderr));
});

test("the canonical suite and CI both retain blocking review-scope checks", async () => {
  const spec = await readFile(new URL("../evals/pr/eval.yaml", import.meta.url), "utf8");
  const workflow = await readFile(new URL("../../../.github/workflows/skill-eval.yml", import.meta.url), "utf8");
  const cases = [...spec.matchAll(/^  - name: (.+)$/gm)].map(([, name]) => name)
    .filter((name) => name.startsWith("review-scope-") || name.startsWith("critical-triage-"));
  assert.deepEqual(cases, reviewScopeCases);
  const step = workflow.split("      - name: Assert PR review-scope trials\n")[1]?.split("\n      - name:")[0];
  assert.ok(step);
  assert.match(step, /if: matrix\.skill_id == 'pr'/);
  assert.match(step, /node scripts\/assert-review-scope\.mjs "\$summary"/);
  assert.match(step, /EVAL_FILTER: \$\{\{ inputs\.filter_tag \}\}/);
  assert.match(step, /--filtered/);
  assert.match(workflow, /--runs 5\b/);
});

test("the workspace fixture satisfies the unchanged contract before a trial", () => {
  const directory = fileURLToPath(new URL("../evals/pr/fixtures/review-scope/", import.meta.url));
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const output = execFileSync(process.execPath, ["--test", "report.test.mjs"], {
    cwd: directory, env, encoding: "utf8", timeout: 30000,
  });
  assert.match(output, /\btests 2\b/);
});

test("the valid out-of-scope comment describes a real defect", async () => {
  const { historicalScore } = await import("../evals/pr/fixtures/review-scope/history.mjs");
  const groups = [{ score: 0, trials: 1 }, { score: 1, trials: 9 }];
  assert.equal(historicalScore(groups), 0.5);
  assert.equal(groups.reduce((sum, group) => sum + group.score * group.trials, 0) /
    groups.reduce((sum, group) => sum + group.trials, 0), 0.9);
});

test("the poor implementation reproduces false verdicts and model-only stale caching", async () => {
  const { readRun, renderReport } = await import("../evals/pr/fixtures/review-scope/poor-report.mjs");
  const mixed = readRun({ model: "mixed-model", groups: [
    { name: "alpha", passed: true, model: "mixed-model" },
    { name: "beta", passed: false, model: "mixed-model" },
  ] });
  assert.equal(renderReport(mixed), "# Evals: Ship\n");
  const failed = readRun({ model: "reused-model", groups: [
    { name: "alpha", passed: false, model: "reused-model" },
  ] });
  const passed = readRun({ model: "reused-model", groups: [
    { name: "beta", passed: true, model: "reused-model" },
  ] });
  assert.match(renderReport(failed), /^# Evals: No ship\n/);
  assert.equal(renderReport(passed), renderReport(failed));
  assert.equal(renderReport(failed).match(/<summary>Run details<\/summary>/g).length, 2);
});
