import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const localPkg = new URL("../package.json", import.meta.url);
const sharedPkg = new URL("../../../.github/tools/vally/package.json", import.meta.url);
const requireFrom = existsSync(new URL("../node_modules/@microsoft/vally/package.json", import.meta.url))
  ? localPkg
  : sharedPkg;
const require = createRequire(requireFrom);
const { computeMetrics, gradeTrajectory, loadEvalSpec } = await import(
  pathToFileURL(require.resolve("@microsoft/vally")).href
);

const specPath = fileURLToPath(new URL("../evals/create-skills-repo/eval.yaml", import.meta.url));
const spec = await loadEvalSpec(specPath);

test("create-skills-repo eval scenarios enforce unique names, mandatory CI guards, and decisive weights", () => {
  assert.equal(spec.stimuli.length, 3);
  const allNames = spec.stimuli.flatMap((s) => s.graders.map((g) => g.name));
  assert.equal(new Set(allNames).size, allNames.length, "grader names must be globally unique");

  const weights = spec.scoring.weights;
  const threshold = spec.scoring.threshold;
  for (const stimulus of spec.stimuli) {
    const types = [...new Set(stimulus.graders.map((g) => g.type))];
    const total = types.reduce((sum, t) => sum + (weights[t] ?? 0), 0);
    const mandatory = stimulus.graders.filter((g) => /^(skill-invocation|diff-empty|tool-calls)/.test(g.name));
    assert.ok(mandatory.length >= 2, `${stimulus.name} must carry mandatory CI guards`);
    for (const mg of mandatory) {
      assert.ok((total - weights[mg.type]) / total < threshold, `${stimulus.name}:${mg.name} must be decisive`);
    }
    assert.ok((total - weights.prompt * 0.25) / total >= threshold);
  }
});

test("create-without-catalog blocks git and gh execution while permitting node CLI scaffolding", async () => {
  const toolGrader = spec.stimuli[0].graders.find((g) => g.type === "tool-calls");
  const makeTraj = (toolName, argumentsObj = {}) => {
    const events = [
      { type: "turn_start", data: { turnId: "t1" } },
      { type: "tool_call", data: { toolCallId: "c1", toolName, arguments: argumentsObj } },
      { type: "tool_result", data: { toolCallId: "c1", toolName, result: "ok" } },
      { type: "turn_end", data: { turnId: "t1" } },
    ];
    return {
      id: `trial-${toolName}`,
      stimulus: { name: "test", prompt: "test" },
      events,
      metrics: computeMetrics(events),
      output: "done",
      workDir: process.cwd(),
      metadata: {},
      diff: "",
    };
  };
  assert.equal((await gradeTrajectory(makeTraj("powershell", { command: "gh repo create acme/acme-skills" }), [toolGrader])).passed, false);
  assert.equal((await gradeTrajectory(makeTraj("bash", { command: "git push origin main" }), [toolGrader])).passed, false);
  assert.equal((await gradeTrajectory(makeTraj("bash", { command: "git -C ./acme-skills push origin main" }), [toolGrader])).passed, false);
  assert.equal((await gradeTrajectory(makeTraj("powershell", { command: "git --git-dir=./acme-skills/.git commit -m init" }), [toolGrader])).passed, false);
  assert.equal((await gradeTrajectory(makeTraj("powershell", { command: "node scripts/cli.mjs create ./acme-skills --owner-login acme" }), [toolGrader])).passed, true);
});
