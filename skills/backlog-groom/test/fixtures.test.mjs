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

const root = new URL("../evals/backlog-groom/", import.meta.url);
const expected = [
  "multi-repo-sources", "issues-only", "missing-source", "merged-not-selected",
  "changed-head", "closure-and-parent", "view-populations", "ownership-and-dates",
  "shared-fields", "done-card", "serialization", "resume-and-pagination",
  "concurrent-view", "ui-blocked",
  "unattended-authority", "unattended-public-routing", "unattended-evidence",
  "unattended-recovery",
];
const spec = (await readFile(new URL("eval.yaml", root), "utf8")).replace(/\r\n/g, "\n");

test("every required synthetic scenario has one staged fixture and decisive rubric", async () => {
  const cases = spec.split(/^  - name: /m).slice(1);
  assert.deepEqual(cases.map((block) => block.split("\n")[0]), expected);
  const graders = [...spec.matchAll(/^        name: (.+)$/gm)].map(([, name]) => name);
  assert.equal(graders.length, expected.length * 3);
  assert.equal(new Set(graders).size, graders.length, "grader names must be globally unique");
  const files = (await readdir(new URL("fixtures/", root))).sort();
  assert.deepEqual(files, expected.map((name) => `${name}.md`).sort());
  for (const block of cases) {
    const name = block.split("\n")[0];
    assert.ok(block.includes(`src: fixtures/${name}.md`), name);
    assert.match(block, /dest: scenario\.md/);
    assert.match(block, /Read scenario\.md/);
    assert.match(block, /type: diff-empty/);
    assert.match(block, /type: diff-empty\n        name: diff-empty-/,
      `${name}: CI requires the diff-empty prefix for mandatory per-trial enforcement`);
    assert.match(block, /type: tool-calls\n        name: tool-calls-/,
      `${name}: CI requires the tool-calls prefix for mandatory per-trial enforcement`);
    assert.match(block, /type: prompt/);
    assert.match(block, /Score 1/i);
    assert.match(block, /rubric:/);
    const fixture = await readFile(new URL(`fixtures/${name}.md`, root), "utf8");
    assert.match(fixture, /Synthetic/);
    assert.match(fixture, /## Observations/);
    assert.match(fixture, /## Request/);
    assert.doesNotMatch(fixture, /C:\\Users\\|@[\w-]+/i);
    for (const [, owner] of fixture.matchAll(/\b([\w.-]+)\/[\w.-]+#\d+/g)) {
      assert.ok(["example-org", "sample-team"].includes(owner), "issue references must use synthetic owners");
    }
  }
});

test("all evals are bounded offline rehearsals, not claimed live integration tests", () => {
  assert.match(spec, /runs: 1/);
  assert.match(spec, /timeout: 5m/);
  assert.match(spec, /Offline synthetic/);
  assert.equal((spec.match(/No network or mutations/g) ?? []).length, expected.length);
  const weights = Object.fromEntries(
    [...spec.matchAll(/^    (prompt|diff-empty|tool-calls): ([\d.]+)$/gm)]
      .map(([, kind, value]) => [kind, Number(value)]),
  );
  assert.ok(Math.abs(weights.prompt + weights["diff-empty"] + weights["tool-calls"] - 1) < 1e-9);
  const threshold = Number(spec.match(/^  threshold: ([\d.]+)$/m)[1]);
  for (const kind of ["prompt", "diff-empty", "tool-calls"]) {
    assert.ok(1 - weights[kind] < threshold, `failing ${kind} must drop score below threshold`);
  }
  assert.ok(weights.prompt * 0.75 + weights["diff-empty"] + weights["tool-calls"] >= threshold);
});

test("offline tool-calls guard blocks shell and GitHub MCP calls while allowing local view", async () => {
  const loaded = await loadEvalSpec(fileURLToPath(new URL("eval.yaml", root)));
  const toolGrader = loaded.stimuli[0].graders.find((g) => g.type === "tool-calls");
  assert.ok(toolGrader);
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
  for (const blocked of ["powershell", "github-mcp-server-list_issues", "create_issue"]) {
    const res = await gradeTrajectory(makeTrajectory(blocked), [toolGrader]);
    assert.equal(res.passed, false, `${blocked} must be blocked`);
  }
  const allowed = await gradeTrajectory(makeTrajectory("view"), [toolGrader]);
  assert.equal(allowed.passed, true);
});
