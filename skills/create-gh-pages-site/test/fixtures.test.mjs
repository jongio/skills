import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
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

const evalDir = fileURLToPath(new URL("../evals/create-gh-pages-site/", import.meta.url));
const spec = await loadEvalSpec(path.join(evalDir, "eval.yaml"));

test("create-gh-pages-site eval scenarios stage existing fixtures and enforce decisive mandatory guards", () => {
  assert.equal(spec.stimuli.length, 5);
  const allNames = spec.stimuli.flatMap((s) => s.graders.map((g) => g.name));
  assert.equal(new Set(allNames).size, allNames.length, "grader names must be globally unique");

  const weights = spec.scoring.weights;
  const threshold = spec.scoring.threshold;
  for (const stimulus of spec.stimuli) {
    assert.ok(stimulus.environment?.files?.length > 0, `${stimulus.name} must stage fixtures`);
    for (const file of stimulus.environment.files) {
      assert.ok(existsSync(path.join(evalDir, file.src)), `missing fixture ${file.src}`);
    }
    const types = [...new Set(stimulus.graders.map((g) => g.type))];
    const total = types.reduce((sum, t) => sum + (weights[t] ?? 0), 0);
    const mandatory = stimulus.graders.filter((g) => /^(skill-invocation|diff-empty|tool-calls)/.test(g.name));
    assert.equal(mandatory.length, 2, `${stimulus.name} must carry skill-invocation and tool-calls guards`);
    for (const mg of mandatory) {
      assert.ok((total - weights[mg.type]) / total < threshold, `${stimulus.name}:${mg.name} must be decisive`);
    }
    assert.ok((total - weights.prompt * 0.25) / total >= threshold);
  }
});

test("remote-write tool-calls guard blocks gh repo/api and git push while allowing local generator", async () => {
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
  assert.equal((await gradeTrajectory(makeTraj("powershell", { command: "gh repo create octocat/hello-cli" }), [toolGrader])).passed, false);
  assert.equal((await gradeTrajectory(makeTraj("bash", { command: "git push origin main" }), [toolGrader])).passed, false);
  assert.equal((await gradeTrajectory(makeTraj("powershell", { command: "node scripts/new-site.mjs astro --dir . --force" }), [toolGrader])).passed, true);
});
