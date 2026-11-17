import assert from "node:assert/strict";
import test from "node:test";
import { readRun, renderReport } from "./report.mjs";

test("a failing group keeps a mixed-result run from shipping", () => {
  const run = readRun({ model: "sample-model", groups: [
    { name: "alpha", passed: true, model: "sample-model" },
    { name: "beta", passed: false, model: "sample-model" },
  ] });
  assert.equal(renderReport(run),
    "# Evals: No ship\n\n<details><summary>Run details</summary>\n\n| Group | Result |\n| --- | --- |\n| alpha | passed |\n| beta | failed |\n\n</details>\n");
});

test("all passing groups ship and malformed or mixed-model records are rejected", () => {
  const run = readRun({ model: "sample-model", groups: [
    { name: "alpha", passed: true, model: "sample-model" },
  ] });
  assert.match(renderReport(run), /^# Evals: Ship\n/);
  assert.throws(() => readRun({ model: "sample-model" }), TypeError);
  assert.throws(() => readRun({ model: "sample-model", groups: [
    { name: "alpha", passed: true, model: "different-model" },
  ] }), TypeError);
});
