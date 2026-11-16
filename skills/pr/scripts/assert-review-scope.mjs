import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const reviewRubrics = new Map([
  ["critical-triage-and-declined-bot-thread-resolution", "critical-triage-anti-overengineering-and-bot-resolution"],
  ["review-scope-and-subtractive-cleanup", "supported-scope-and-subtractive-cleanup"],
  ["review-scope-preserves-sound-workspace", "review-scope-workspace-evidence"],
  ["review-scope-valid-comment-deferred", "review-scope-valid-comment-evidence"],
  ["review-scope-rejects-poor-implementation", "review-scope-poor-implementation-evidence"],
]);
export const reviewScopeCases = [...reviewRubrics.keys()];

export function assertReviewScopeTrials(records, { runs = 5, filtered = false } = {}) {
  const counts = new Map(reviewScopeCases.map((name) => [name, 0]));
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
    if (!details.some(({ name }) => name === reviewRubrics.get(record.stimulus))) {
      throw new Error(`${record.stimulus}: missing review rubric`);
    }
  }
  for (const [name, count] of counts) {
    if ((!filtered || count > 0) && count !== runs) {
      throw new Error(`${name}: expected ${runs} trials, received ${count}`);
    }
  }
  return [...counts.values()].reduce((sum, count) => sum + count, 0);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [file, option, ...extra] = process.argv.slice(2);
  if (!file || (option !== undefined && option !== "--filtered") || extra.length) {
    throw new Error("Usage: node assert-review-scope.mjs <results.jsonl> [--filtered]");
  }
  const text = await readFile(file, "utf8");
  const records = text.split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line));
  const count = assertReviewScopeTrials(records, { filtered: option === "--filtered" });
  console.log(count > 0
    ? `Review-scope checks passed for ${count} selected trials.`
    : "No review-scope trials were selected by this manual filter.");
}
