import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { Writable } from "node:stream";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(new URL("../.github/tools/vally/package.json", import.meta.url));
const YAML = require("yaml");
const {
  computeMetrics,
  EvalJsonlReporter,
  gradeTrajectory,
  loadEvalSpec,
  normalizeScore,
  resolveGradePass,
} = await import(pathToFileURL(require.resolve("@microsoft/vally")).href);

async function collectEvalYamlFiles(dir, out = []) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules" || entry.name === "vally-results") {
      continue;
    }
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectEvalYamlFiles(fullPath, out);
    } else if (
      entry.name === "eval.yaml" ||
      entry.name.endsWith(".eval.yaml") ||
      entry.name === ".vally.yaml"
    ) {
      out.push(fullPath);
    }
  }
  return out;
}

test("all eval.yaml and .vally.yaml files parse under copilot-evals maxAliasCount: 0 without YAML anchors or aliases", async () => {
  const repoRoot = fileURLToPath(new URL("..", import.meta.url));
  const yamlFiles = await collectEvalYamlFiles(repoRoot);
  assert.ok(yamlFiles.length >= 50, `expected at least 50 eval/vally YAML files, found ${yamlFiles.length}`);

  for (const file of yamlFiles) {
    const rel = path.relative(repoRoot, file);
    const source = await readFile(file, "utf8");
    const doc = YAML.parseDocument(source, { uniqueKeys: true });
    assert.equal(doc.errors.length, 0, `${rel} has YAML errors: ${doc.errors.map((e) => e.message).join("; ")}`);
    assert.equal(doc.warnings.length, 0, `${rel} has YAML warnings: ${doc.warnings.map((w) => w.message).join("; ")}`);

    let anchorOrAliasNodes = 0;
    YAML.visit(doc, {
      Node(_key, node) {
        if (YAML.isAlias(node) || node.anchor) {
          anchorOrAliasNodes++;
        }
      },
    });
    assert.equal(anchorOrAliasNodes, 0, `${rel} must not contain YAML anchors (&) or aliases (*)`);
    assert.doesNotThrow(() => doc.toJS({ maxAliasCount: 0 }), `${rel} failed maxAliasCount: 0`);

    if (file.endsWith("eval.yaml")) {
      const spec = await loadEvalSpec(file);
      assert.ok(Array.isArray(spec.stimuli) && spec.stimuli.length > 0, `${rel} must define stimuli`);
    }
  }
});

test("migrated agent environments still stage every fixture block", async () => {
  for (const [skill, count] of [["create-gh-pages-site", 5], ["deps-doctor", 11]]) {
    const path = new URL(`../skills/${skill}/evals/${skill}/eval.yaml`, import.meta.url);
    const source = await readFile(path, "utf8");
    assert.doesNotMatch(source, /^\s+environment:/m, skill);
    assert.equal(source.match(/^    agent_environment:/gm).length, count, skill);
    const spec = await loadEvalSpec(fileURLToPath(path));
    const environments = spec.stimuli.filter((stimulus) => stimulus.environment);
    assert.equal(environments.length, count, skill);
    for (const stimulus of environments) {
      assert.ok(stimulus.environment.files.length > 0, stimulus.name);
    }
  }
});

function trajectory(diff) {
  return {
    id: "compatibility-trial",
    stimulus: { name: "compatibility", prompt: "Return done without edits." },
    events: [],
    metrics: computeMetrics([]),
    output: "done",
    workDir: process.cwd(),
    metadata: {},
    diff,
  };
}

test("Vally preserves graded safety failures under equal-weight scoring", async () => {
  const graders = [
    { name: "correct-output", type: "output-contains", config: { value: "done" } },
    { name: "matching-output", type: "output-matches", config: { pattern: "^done$" } },
    { name: "diff-empty-safety", type: "diff-empty" },
  ];
  const weights = { "output-contains": 1 / 3, "output-matches": 1 / 3, "diff-empty": 1 / 3 };
  const changed = await gradeTrajectory(trajectory("+unexpected change"), graders, { weights });
  assert.equal(changed.passed, false);
  assert.ok(Math.abs(changed.score - 2 / 3) < 1e-10);
  assert.equal(resolveGradePass(changed, 0.75), false);
  assert.equal(changed.details.find((result) => result.name === "diff-empty-safety").passed, false);

  const unchanged = await gradeTrajectory(trajectory(""), graders, { weights });
  assert.equal(unchanged.passed, true);
  assert.equal(unchanged.score, 1);
  assert.equal(resolveGradePass(unchanged, 0.75), true);
  assert.equal(normalizeScore(4, "scale_1_5"), 0.75);
});

test("Vally JSONL preserves trial guards and CI run-summary fields", async () => {
  let output = "";
  const stream = new Writable({
    write(chunk, encoding, callback) {
      output += chunk.toString();
      callback();
    },
  });
  const reporter = new EvalJsonlReporter({ stream });
  await reporter.onRunStart({ runId: "compatibility-run", workers: 1, evals: [], totalItems: 1 });
  const grade = {
    passed: false,
    score: 0,
    details: [{ name: "diff-empty-safety", kind: "code", passed: false, score: 0, evidence: "changed" }],
  };
  await reporter.onTrialResult({
    item: {
      id: "trial-1",
      evalName: "compatibility",
      evalFilePath: "eval.yaml",
      variant: "default",
      stimulus: { name: "compatibility" },
    },
    result: { status: "failed", durationMs: 1, grade, trajectory: trajectory("+change") },
  });
  await reporter.onRunComplete({
    passed: false,
    hadExecutionErrors: false,
    evals: [{
      evalName: "compatibility",
      evalFilePath: "eval.yaml",
      variant: "default",
      passed: false,
      scoringApplied: true,
      overallScore: 0,
      threshold: 0.75,
      stimuliRun: 1,
      stimuliTotal: 1,
      durationMs: 1,
    }],
  }, {});
  const records = output.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(records.length, 2);
  assert.equal(records[0].type, "trial-result");
  assert.equal(records[0].stimulus, "compatibility");
  assert.deepEqual(records[0].gradeResult.details, grade.details);
  assert.equal(records[1].type, "run-summary");
  assert.equal(records[1].passed, false);
  assert.equal(records[1].hadExecutionErrors, false);
  assert.equal(records[1].evals[0].scoringApplied, true);
  assert.equal(records[1].evals[0].overallScore, 0);
  assert.equal(records[1].evals[0].threshold, 0.75);
});
