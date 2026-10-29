import assert from "node:assert/strict";
import test from "node:test";
import { createPrWatchState, evaluatePrPollTick, parsePrWatchArgs, requestCopilotReview } from "../scripts/pr-watch-daemon.mjs";

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

for (const status of [200, 304]) {
test(`credential replacement between GraphQL and REST ${status} cannot establish merge readiness`, async () => {
  const head = "a".repeat(40);
  const args = parsePrWatchArgs(["watch", "--repo", "fixture/repo", "--pr", "1", "--head", head, "--no-copilot"]);
  const state = createPrWatchState();
  state.cacheScope = "before";
  state.etags[`repos/fixture/repo/actions/runs?head_sha=${head}&per_page=100`] = {
    etag: '"before"', data: { workflow_runs: [], total_count: 0 },
  };
  const pr = {
    state: "OPEN", headRefOid: head, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewDecision: "APPROVED",
    reviewRequests: { nodes: [] }, reviews: { nodes: [] }, reviewThreads: { nodes: [] }, comments: { nodes: [] },
    commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [
      { __typename: "CheckRun", name: "CI", status: "COMPLETED", conclusion: "SUCCESS" },
    ] } } } }] },
  };
  const tick = await evaluatePrPollTick(args, async (request) => request.kind === "graphql"
    ? { ok: true, status: 200, cacheScope: "before", headers: {}, data: { data: { repository: { pullRequest: pr } } } }
    : { ok: true, status, cacheScope: "after", headers: {},
      data: status === 200 ? { workflow_runs: [], total_count: 0 } : null }, state);
  assert.ok(!tick.events.some((event) => event.type === "PR_READY_TO_MERGE"));
  assert.equal(tick.events[0].type, "POLL_ERROR");
});
}

for (const transition of ["inventory", "revalidation", "before-mutation"]) {
test(`Copilot request refuses mixed credentials during ${transition}`, async () => {
  const head = "b".repeat(40);
  const args = parsePrWatchArgs(["request-copilot", "--repo", "fixture/repo", "--pr", "1", "--head", head]);
  let graphqlCalls = 0;
  let inventoryCalls = 0;
  let mutations = 0;
  let scope = "before";
  const request = async (input) => {
    if (input.kind === "graphql") {
      graphqlCalls++;
      if (transition === "revalidation" && graphqlCalls === 2) scope = "after";
      const result = { ok: true, cacheScope: scope, data: { data: { repository: { pullRequest: {
        state: "OPEN", headRefOid: head, headRefName: "feature", reviewRequests: { nodes: [] },
      } } } } };
      if (transition === "before-mutation" && graphqlCalls === 2) scope = "after";
      return result;
    }
    if (input.endpoint?.includes("/actions/runs?")) {
      inventoryCalls++;
      if (transition === "inventory" && inventoryCalls === 2) scope = "after";
      return { ok: true, cacheScope: scope, data: { workflow_runs: [], total_count: 0 } };
    }
    mutations++;
    return { ok: true };
  };
  request.cacheScope = async () => scope;
  const result = await requestCopilotReview(args, request);
  assert.equal(result.ok, false);
  assert.match(result.error, /credential scope changed/i);
  assert.equal(mutations, 0, "no cancellation or reviewer mutation may use mixed-scope evidence");
});
}
