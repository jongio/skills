import { fixtureRequest } from "./github-fixtures.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { evaluatePollTick as native_evaluatePollTick, ghApiWithEtag, loadState, parseArgs } from "../scripts/ci-hound-daemon.mjs";

for (const failure of [
  { ok: false, stdout: "", stderr: "HTTP 401: Bad credentials" },
  { ok: false, stdout: "", stderr: "HTTP 503: Service unavailable" },
  { ok: false, stdout: "", stderr: "Request timed out" },
  { ok: true, stdout: "{broken", stderr: "" },
  { ok: true, stdout: "{}", stderr: "" },
]) {
  test(`failed current observations never report saved CI as green: ${failure.stderr || failure.stdout}`, async () => {
    const args = parseArgs(["once", "--repo", "fixture/repo"]);
    const state = loadState("");
    state.lastMainSha = "fixture-head";
    state.runs["1"] = {
      id: 1, name: "CI", event: "push", head_branch: "main", head_sha: "fixture-head",
      status: "completed", conclusion: "success",
    };
    const tick = await evaluatePollTick(args, state, () => failure);
    assert.ok(!tick.events.some((event) => /GREEN/.test(event.type)));
    assert.ok(tick.events.some((event) => event.type === "POLL_ERROR"));
    assert.equal(state.runs["1"].conclusion, "success", "keep diagnostic history");
  });
}

const evaluatePollTick = (...args) => { args[2] = fixtureRequest(args[2]); return native_evaluatePollTick(...args); };

test("a 304 after credential replacement cannot validate the previous identity's cache", async () => {
  const endpoint = "repos/fixture/repo/commits/main";
  const state = loadState("");
  state.cacheScope = "before";
  state.etags[endpoint] = { etag: '"before"', data: { sha: "old-observation" } };
  const request = async () => ({ ok: true, status: 304, cacheScope: "after", headers: {}, data: null });
  request.cacheScope = async () => "before";
  const result = await ghApiWithEtag(endpoint, state, request);
  assert.equal(result.fromCache, false);
  assert.equal(result.data, null);
  assert.ok(result.error);
});

for (const changeAt of ["inventory", "jobs", "page"]) {
test(`credential replacement during ${changeAt} cannot establish watched-run readiness`, async () => {
  const args = parseArgs(["once", "--repo", "fixture/repo", "--watch-run", "1"]);
  const state = loadState("");
  let scope = "before";
  const run = { id: 1, name: "CI", event: "push", head_branch: "main", head_sha: "head",
    status: "completed", conclusion: "success", updated_at: "current" };
  const request = async ({ endpoint }) => {
    if ((changeAt === "inventory" && endpoint.includes("?per_page=25")) ||
        (changeAt === "jobs" && endpoint.includes("/jobs?")) ||
        (changeAt === "page" && endpoint.includes("page=2"))) scope = "after";
    const job = (id) => ({ id, name: "Tests", status: "completed", conclusion: "success", steps: [] });
    const data = endpoint.includes("/commits/") ? { sha: "head" }
      : endpoint.includes("/jobs?") ? changeAt === "page"
        ? { jobs: endpoint.includes("page=2") ? [job(51)] : Array.from({ length: 50 }, (_, index) => job(index + 1)), total_count: 51 }
        : { jobs: [job(2)], total_count: 1 }
        : { workflow_runs: [run] };
    return { ok: true, status: 200, cacheScope: scope, headers: {}, data };
  };
  request.cacheScope = async () => scope;
  const tick = await native_evaluatePollTick(args, state, request);
  assert.ok(!tick.events.some((event) => /GREEN/.test(event.type)));
  assert.equal(tick.events[0].type, "POLL_ERROR");
});
}
