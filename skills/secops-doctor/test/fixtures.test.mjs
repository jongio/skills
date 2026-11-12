import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
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

const root = new URL("../evals/secops-doctor/", import.meta.url);
const expected = [
  "public-visibility-neutral-framing",
  "cloudflare-edge-and-container-config",
  "workflow-and-boundary-remediation",
];
const spec = (await readFile(new URL("eval.yaml", root), "utf8")).replace(/\r\n/g, "\n");

test("every synthetic secops-doctor scenario has a staged fixture, mandatory CI guard prefixes, and decisive rubric", async () => {
  const cases = spec.split(/^  - name: /m).slice(1);
  assert.deepEqual(
    cases.map((block) => block.split("\n")[0]),
    expected,
  );
  const graders = [...spec.matchAll(/^        name: (.+)$/gm)].map(([, name]) => name);
  assert.equal(graders.length, expected.length * 4);
  assert.equal(new Set(graders).size, graders.length, "grader names must be globally unique");

  const files = (await readdir(new URL("fixtures/", root))).sort();
  assert.deepEqual(files, expected.map((name) => `${name}.md`).sort());

  for (const block of cases) {
    const name = block.split("\n")[0];
    assert.ok(block.includes(`src: fixtures/${name}.md`), name);
    assert.match(block, /dest: scenario\.md/);
    assert.match(block, /Read scenario\.md/);
    assert.match(
      block,
      new RegExp(`type: diff-empty\\n        name: diff-empty-${name}`),
      `${name}: CI requires the diff-empty- prefix for mandatory per-trial enforcement`,
    );
    assert.match(
      block,
      new RegExp(`type: skill-invocation\\n        name: skill-invocation-${name}`),
      `${name}: CI requires the skill-invocation- prefix for mandatory per-trial enforcement`,
    );
    assert.match(
      block,
      new RegExp(`type: tool-calls\\n        name: tool-calls-${name}`),
      `${name}: CI requires the tool-calls- prefix for mandatory per-trial enforcement`,
    );
    assert.match(block, /type: prompt/);
    assert.match(block, /Score 5 only if/);
    assert.match(block, /Score 1/);
    assert.match(block, /rubric:/);

    const fixture = await readFile(new URL(`fixtures/${name}.md`, root), "utf8");
    assert.match(fixture, /^# Synthetic scenario:/);
    assert.match(fixture, /^## Observations$/m);
    assert.match(fixture, /^## Request$/m);
    assert.doesNotMatch(fixture, /C:\\Users\\|\/Users\/|jongio/i);
  }
});

test("scoring weights are decisive in both directions across all declared grader types", () => {
  assert.match(spec, /runs: 1/);
  assert.match(spec, /timeout: 5m/);
  assert.match(spec, /Offline synthetic/);

  const weights = Object.fromEntries(
    [...spec.matchAll(/^    (prompt|diff-empty|skill-invocation|tool-calls): ([\d.]+)$/gm)].map(
      ([, kind, value]) => [kind, Number(value)],
    ),
  );
  const threshold = Number(spec.match(/^  threshold: ([\d.]+)$/m)[1]);
  const totalWeight =
    weights.prompt +
    weights["diff-empty"] +
    weights["skill-invocation"] +
    weights["tool-calls"];

  for (const failedType of ["prompt", "diff-empty", "skill-invocation", "tool-calls"]) {
    const remainingWeight = totalWeight - weights[failedType];
    const normalizedScore = remainingWeight / totalWeight;
    assert.ok(
      normalizedScore < threshold,
      `failing ${failedType} must fail the trial (got ${normalizedScore} >= ${threshold})`,
    );
  }

  const passingJudgeFourScore =
    (weights["diff-empty"] * 1.0 +
      weights["skill-invocation"] * 1.0 +
      weights["tool-calls"] * 1.0 +
      weights.prompt * 0.75) /
    totalWeight;
  assert.ok(
    passingJudgeFourScore >= threshold,
    `4/5 prompt + passing guards must pass threshold (got ${passingJudgeFourScore} < ${threshold})`,
  );
});

test("offline tool-calls guard blocks direct GitHub MCP and shell calls while allowing local file reads", async () => {
  const loaded = await loadEvalSpec(fileURLToPath(new URL("eval.yaml", root)));
  const toolGrader = loaded.stimuli[0].graders.find((g) => g.type === "tool-calls");
  assert.ok(toolGrader, "expected a tool-calls guard");

  const makeTrajectory = (toolName) => {
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

  for (const blockedTool of [
    "github-mcp-server-get_file_contents",
    "github-mcp-server-actions_get",
    "powershell",
    "create_pull_request",
  ]) {
    const res = await gradeTrajectory(makeTrajectory(blockedTool), [toolGrader]);
    assert.equal(res.passed, false, `${blockedTool} must fail the offline tool-calls guard`);
  }

  const allowedRes = await gradeTrajectory(makeTrajectory("view"), [toolGrader]);
  assert.equal(allowedRes.passed, true, "local view tool must be permitted");
});
