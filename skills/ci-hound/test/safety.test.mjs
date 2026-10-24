import { fixtureRequest } from "./github-fixtures.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { evaluatePollTick as native_evaluatePollTick, loadState, parseArgs } from "../scripts/ci-hound-daemon.mjs";

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
