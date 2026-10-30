import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { evaluateMultiRepoPollTick, parseArgs } from "../scripts/ci-hound-daemon.mjs";

test("a full-chunk stalled target cannot freeze completed peers or release stale green after recovery", async (t) => {
  const root = path.resolve(".chunk-fairness-fixtures");
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(path.join(root, "scope-"));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
    if (readdirSync(root).length === 0) rmSync(root, { recursive: true });
  });
  let now = 1_800_000_000_000;
  t.mock.method(Date, "now", () => now);
  const args = parseArgs(["watch", "--repos", "fixture/one,fixture/two", "--max-wait-sec", "1",
    "--config-file", path.join(dir, "config.json")]);
  let phase = 0, firstTargetPolls = 0;
  const request = async ({ endpoint }) => {
    const repo = endpoint.match(/^repos\/([^/]+\/[^/]+)/)[1];
    if (endpoint.includes("/commits/")) {
      if (repo === "fixture/one") firstTargetPolls += 1;
      if (repo === "fixture/two" && phase < 2) now += 1000;
      else now += 10;
      return { ok: true, status: 200, cacheScope: "fixture", headers: {}, data: { sha: `${repo}-head` } };
    }
    now += 10;
    const pending = repo === "fixture/one" && phase > 0;
    const data = endpoint.includes("/jobs?")
      ? { total_count: 1, jobs: [{ id: 1, name: "test", status: pending ? "in_progress" : "completed",
        conclusion: pending ? null : "success", steps: [] }] }
      : { workflow_runs: [{ id: 1, workflow_id: 1, name: "CI", event: "push", head_branch: "main",
        head_sha: `${repo}-head`, updated_at: String(phase),
        status: pending ? "in_progress" : "completed", conclusion: pending ? null : "success" }] };
    return { ok: true, status: 200, cacheScope: "fixture", headers: {}, data };
  };
  request.cacheScope = async () => "fixture";
  for (; phase < 2; phase += 1) {
    args.chunkDeadlineMs = now + 1000;
    const tick = await evaluateMultiRepoPollTick(args, {}, request);
    assert.equal(tick.chunkTimedOut, true);
    assert.equal(tick.events.some((event) => /GREEN$/.test(event.type)), false);
  }
  args.chunkDeadlineMs = now + 1000;
  const recovered = await evaluateMultiRepoPollTick(args, {}, request);
  assert.equal(firstTargetPolls, 2, "completed peers must be observed again after a target consumes a whole fresh chunk");
  assert.equal(recovered.events.some((event) => /GREEN$/.test(event.type)), false,
    "the first target became pending while its peer stalled; old green cannot authorize an action");
});
