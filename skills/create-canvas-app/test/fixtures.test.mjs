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

const specPath = fileURLToPath(new URL("../evals/create-canvas-app/eval.yaml", import.meta.url));
const spec = await loadEvalSpec(specPath);

test("create-canvas-app eval scenarios enforce unique names, mandatory CI guards, and decisive weights", () => {
  assert.equal(spec.stimuli.length, 3);
  const allNames = spec.stimuli.flatMap((s) => s.graders.map((g) => g.name));
  assert.equal(new Set(allNames).size, allNames.length, "grader names must be globally unique");
  for (const name of allNames) {
    assert.match(name, /^[a-z0-9][a-z0-9-]{0,59}$/);
  }

  const weights = spec.scoring.weights;
  const threshold = spec.scoring.threshold;
  for (const stimulus of spec.stimuli) {
    const types = [...new Set(stimulus.graders.map((g) => g.type))];
    const total = types.reduce((sum, t) => sum + (weights[t] ?? 0), 0);
    const mandatory = stimulus.graders.filter((g) => /^(skill-invocation|diff-empty|tool-calls)/.test(g.name));
    assert.ok(mandatory.length >= 2, `${stimulus.name} must carry mandatory CI guards`);
    for (const mg of mandatory) {
      const scoreIfFailed = (total - weights[mg.type]) / total;
      assert.ok(scoreIfFailed < threshold, `${stimulus.name}:${mg.name} must be decisive`);
    }
    const judgeFour = (total - weights.prompt * 0.25) / total;
    assert.ok(judgeFour >= threshold, `${stimulus.name}: 4/5 prompt with passing guards must pass`);
  }
});

test("offline contract scenario blocks shell, canvas, and network calls", async () => {
  const offline = spec.stimuli.find((s) => s.name === "loopback-origin-and-sdk-isolation-audit");
  const toolGrader = offline.graders.find((g) => g.type === "tool-calls");
  const makeTraj = (toolName) => {
    const events = [
      { type: "turn_start", data: { turnId: "t1" } },
      { type: "tool_call", data: { toolCallId: "c1", toolName, arguments: {} } },
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
  for (const blocked of ["powershell", "open_canvas", "web_fetch", "create_pull_request"]) {
    const res = await gradeTrajectory(makeTraj(blocked), [toolGrader]);
    assert.equal(res.passed, false, `${blocked} must be blocked`);
  }
  const allowed = await gradeTrajectory(makeTraj("view"), [toolGrader]);
  assert.equal(allowed.passed, true);
});
