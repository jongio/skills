import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const reviewCases = new Map([
  ["critical-triage-and-declined-bot-thread-resolution", {
    rubric: "critical-triage-anti-overengineering-and-bot-resolution",
    tags: { scenario: "critical-review-triage", cost: "low" },
  }],
  ["review-scope-and-subtractive-cleanup", {
    rubric: "supported-scope-and-subtractive-cleanup",
    tags: { scenario: "review-scope", cost: "low" },
  }],
  ["review-scope-preserves-sound-workspace", {
    rubric: "review-scope-workspace-evidence",
    tags: { scenario: "review-scope-workspace", ci: "review-scope", cost: "low" },
  }],
  ["review-scope-valid-comment-deferred", {
    rubric: "review-scope-valid-comment-evidence",
    tags: { scenario: "valid-out-of-scope-comment", ci: "review-scope", cost: "low" },
  }],
  ["review-scope-rejects-poor-implementation", {
    rubric: "review-scope-poor-implementation-evidence",
    tags: { scenario: "poor-submitted-implementation", ci: "review-scope", cost: "low" },
  }],
]);
export const reviewScopeCases = [...reviewCases.keys()];

export function assertReviewScopeTrials(records, { runs = 5, filter = "" } = {}) {
  const expression = filter.match(/^([a-z][a-z0-9_-]*)(!?=)([a-z0-9_-]+(?:,[a-z0-9_-]+)*)$/);
  if (filter && !expression) throw new Error("Expected one key=values or key!=values tag filter");
  const selected = [...reviewCases].filter(([, { tags }]) => {
    if (!expression) return true;
    const [, key, operator, rawValues] = expression;
    const matches = rawValues.split(",").includes(tags[key]);
    return operator === "=" ? matches : !matches;
  });
  const counts = new Map(selected.map(([name]) => [name, 0]));
  for (const record of records) {
    if (record.type !== "trial-result" || !counts.has(record.stimulus)) continue;
    counts.set(record.stimulus, counts.get(record.stimulus) + 1);
    const details = record.gradeResult?.details;
    if (!Array.isArray(details) || details.length === 0 || details.some((grade) => typeof grade?.name !== "string" || !grade.name)) {
      throw new Error(`${record.stimulus}: missing grading evidence`);
    }
    for (const grade of details) {
      if (grade.passed !== true) {
        throw new Error(`${record.stimulus}: ${grade.name} failed; review-scope trials cannot be averaged`);
      }
    }
    for (const prefix of ["skill-invocation", "diff-empty", "tool-calls"]) {
      if (!details.some(({ name }) => name?.startsWith(prefix))) {
        throw new Error(`${record.stimulus}: missing ${prefix} guard`);
      }
    }
    if (!details.some(({ name }) => name === reviewCases.get(record.stimulus).rubric)) {
      throw new Error(`${record.stimulus}: missing review rubric`);
    }
  }
  for (const [name, count] of counts) {
    if (count !== runs) {
      throw new Error(`${name}: expected ${runs} trials, received ${count}`);
    }
  }
  return [...counts.values()].reduce((sum, count) => sum + count, 0);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [file, option, filter, ...extra] = process.argv.slice(2);
  if (!file || (option !== undefined && (option !== "--filter" || !filter)) || extra.length) {
    throw new Error("Usage: node assert-review-scope.mjs <results.jsonl> [--filter <key=values>]");
  }
  const text = await readFile(file, "utf8");
  const records = text.split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line));
  const count = assertReviewScopeTrials(records, { filter });
  console.log(count > 0
    ? `Review-scope checks passed for ${count} selected trials.`
    : "No review-scope trials were selected by this manual filter.");
}
