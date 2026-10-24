import assert from "node:assert/strict";
import test from "node:test";
import { createPrWatchState, evaluatePrPollTick, parsePrWatchArgs } from "../scripts/pr-watch-daemon.mjs";

test("typed GraphQL quota failures preserve scheduler backoff even without rate-limit wording", async () => {
  const args = parsePrWatchArgs(["watch", "--repo", "fixture/repo", "--pr", "1"]);
  const tick = await evaluatePrPollTick(args, async () => ({
    ok: false, status: 200, rateLimited: true, error: "Quota exhausted",
    data: { errors: [{ type: "RATE_LIMITED", message: "Quota exhausted" }] },
    headers: { "retry-after": "90" },
  }), createPrWatchState());
  assert.equal(tick.events[0].type, "RATE_LIMITED");
  assert.ok(tick.nextIntervalSec >= 90);
});
