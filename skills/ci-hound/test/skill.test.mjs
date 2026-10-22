import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildOptimizationReport,
  evaluatePollTick,
  ghApiWithEtag,
  loadState,
  matchFlakePattern,
  parseArgs,
  parseHttpResponse,
  saveState,
  selectDeliverySkill,
} from "../scripts/ci-hound-daemon.mjs";

const skill = await readFile(new URL("../SKILL.md", import.meta.url), "utf8");

function disableAlertsForTest(t) {
  const prev = process.env.CI_HOUND_NO_ALERT;
  process.env.CI_HOUND_NO_ALERT = "1";
  t.after(() => {
    if (prev === undefined) {
      delete process.env.CI_HOUND_NO_ALERT;
    } else {
      process.env.CI_HOUND_NO_ALERT = prev;
    }
  });
}

test("portable skill frontmatter contains name, description, and version metadata", () => {
  const frontmatter = skill.match(/^---\n([\s\S]*?)\n---/);
  assert.ok(frontmatter);
  const keys = [...frontmatter[1].matchAll(/^([a-z][a-z-]*):/gm)].map((match) => match[1]);
  assert.deepEqual(keys, ["name", "description", "metadata"]);
  assert.match(frontmatter[1], /^name: ci-hound$/m);
  assert.match(frontmatter[1], /^  version: "[^"]+"$/m);
});

test("skill includes workflow, go/pr routing, safety, and exit criteria", () => {
  assert.match(skill, /^## `go` vs `pr` Delivery Routing$/m);
  assert.match(skill, /^## Workflow$/m);
  assert.match(skill, /^## Safety$/m);
  assert.match(skill, /^## Exit Criteria$/m);
});

test("selectDeliverySkill routes new failures and optimizations to go and existing worktrees/PRs to pr", () => {
  assert.equal(selectDeliverySkill({ eventType: "JOB_FAILED" }), "go");
  assert.equal(selectDeliverySkill({ eventType: "WORKFLOW_FAILED" }), "go");
  assert.equal(selectDeliverySkill({ eventType: "OPTIMIZE" }), "go");
  assert.equal(selectDeliverySkill({ eventType: "JOB_FAILED", hasExistingPr: true }), "pr");
  assert.equal(selectDeliverySkill({ eventType: "OPTIMIZE", hasCommittedFixBranch: true }), "pr");
  assert.equal(selectDeliverySkill({ eventType: "OPTIMIZE", docsOrConfigOnlyStaged: true }), "pr");
  assert.equal(selectDeliverySkill({}), "pr");
});

test("parseArgs parses mode, repo, intervals, merge modes, flags, and watched run IDs", () => {
  const parsed = parseArgs([
    "--mode",
    "optimize",
    "--repo",
    "github/evals",
    "--branch",
    "main",
    "--state-file",
    "custom-state.json",
    "--active-interval",
    "10",
    "--idle-interval",
    "45",
    "--watch-run",
    "39823645716",
    "--wake-on-commit",
    "--no-wake-on-green",
    "--max-polls",
    "3",
    "--merge=auto",
  ]);
  assert.equal(parsed.mode, "optimize");
  assert.equal(parsed.repo, "github/evals");
  assert.equal(parsed.branch, "main");
  assert.ok(parsed.stateFile.endsWith("custom-state.json"));
  assert.equal(parsed.activeIntervalSec, 10);
  assert.equal(parsed.idleIntervalSec, 45);
  assert.deepEqual(parsed.watchRunIds, [39823645716]);
  assert.equal(parsed.wakeOnNewCommit, true);
  assert.equal(parsed.wakeOnAllGreen, false);
  assert.equal(parsed.maxPolls, 3);
  assert.equal(parsed.mergeMode, "auto");

  const defaultMerge = parseArgs(["watch", "--repo", "github/evals", "--merge", "approval"]);
  assert.equal(defaultMerge.mergeMode, "approval");

  assert.throws(() => parseArgs(["watch", "--repo", "github/evals", "--merge=invalid"]), /Invalid --merge mode/);
});

test("saveState and loadState round-trip state and recover from corrupted JSON", async (t) => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "ci-hound-state-"));
  t.after(() => rm(tempDir, { recursive: true, force: true }));
  const statePath = path.join(tempDir, "nested", "state.json");

  const initial = loadState(statePath);
  initial.repo = "github/evals";
  initial.lastMainSha = "deadbeef";
  saveState(statePath, initial);

  const reloaded = loadState(statePath);
  assert.equal(reloaded.repo, "github/evals");
  assert.equal(reloaded.lastMainSha, "deadbeef");

  await writeFile(statePath, "{corrupted json", "utf8");
  const recovered = loadState(statePath);
  assert.equal(recovered.repo, "");
  assert.equal(recovered.lastMainSha, "");
});

test("ghApiWithEtag caches 200 ETag responses, reuses 304 Not Modified, and falls back on HTTP/JSON errors", () => {
  const state = loadState("/nonexistent/state.json");
  let callCount = 0;
  const fakeExec = (ghArgs) => {
    callCount += 1;
    if (callCount === 1) {
      assert.ok(!ghArgs.includes('If-None-Match: "etag-1"'));
      return {
        ok: true,
        stdout: 'HTTP/2.0 200 OK\r\nETag: "etag-1"\r\n\r\n{"sha":"abc12345"}',
        stderr: "",
      };
    }
    if (callCount === 2) {
      assert.ok(ghArgs.includes('If-None-Match: "etag-1"'));
      return {
        ok: true,
        stdout: 'HTTP/2.0 304 Not Modified\r\nETag: "etag-1"\r\n\r\n',
        stderr: "",
      };
    }
    if (callCount === 3) {
      return {
        ok: false,
        stdout: "HTTP/2.0 502 Bad Gateway\r\n\r\n",
        stderr: "502 Bad Gateway",
      };
    }
    return {
      ok: true,
      stdout: "HTTP/2.0 200 OK\r\n\r\nnot-valid-json",
      stderr: "",
    };
  };

  const first = ghApiWithEtag("repos/github/evals/commits/main", state, fakeExec);
  assert.equal(first.fromCache, false);
  assert.equal(first.data.sha, "abc12345");

  const second = ghApiWithEtag("repos/github/evals/commits/main", state, fakeExec);
  assert.equal(second.fromCache, true);
  assert.equal(second.data.sha, "abc12345");
  assert.equal(state.metrics.cacheHits304, 1);

  const third = ghApiWithEtag("repos/github/evals/commits/main", state, fakeExec);
  assert.equal(third.fromCache, false);
  assert.equal(third.data.sha, "abc12345");
  assert.match(third.error, /502/);

  const fourth = ghApiWithEtag("repos/github/evals/commits/main", state, fakeExec);
  assert.equal(fourth.fromCache, false);
  assert.equal(fourth.data.sha, "abc12345");
  assert.ok(fourth.error);
});

test("evaluatePollTick detects instant job-level failure on active main run, harvests PR telemetry once, and skips unchanged completed runs", (t) => {
  disableAlertsForTest(t);
  const state = loadState("/nonexistent/state.json");
  const args = parseArgs(["watch", "--repo", "github/evals"]);
  let prJobsCalls = 0;

  const fakeExec = (ghArgs) => {
    const endpoint = ghArgs[2];
    if (endpoint === "repos/github/evals/commits/main") {
      return {
        ok: true,
        stdout: 'HTTP/2.0 200 OK\nETag: "sha-1"\n\n{"sha":"f62e3acbbc9a96e644864a3b1ed4ef6f8004d4e2"}',
        stderr: "",
      };
    }
    if (endpoint === "repos/github/evals/actions/runs?branch=main&per_page=20") {
      return {
        ok: true,
        stdout: `HTTP/2.0 200 OK\nETag: "branch-runs-1"\n\n${JSON.stringify({
          workflow_runs: [
            {
              id: 101,
              name: "CI",
              event: "push",
              head_branch: "main",
              head_sha: "f62e3acbbc9a96e644864a3b1ed4ef6f8004d4e2",
              pull_requests: [{ number: 301 }],
              status: "in_progress",
              conclusion: null,
              updated_at: "2026-10-22T17:00:00Z",
              html_url: "https://github.com/github/evals/actions/runs/101",
            },
          ],
        })}`,
        stderr: "",
      };
    }
    if (endpoint === "repos/github/evals/actions/runs?per_page=25") {
      return {
        ok: true,
        stdout: `HTTP/2.0 200 OK\nETag: "runs-1"\n\n${JSON.stringify({
          workflow_runs: [
            {
              id: 102,
              name: "CI",
              event: "pull_request",
              head_branch: "main",
              head_sha: "1111222233334444",
              status: "completed",
              conclusion: "failure",
              updated_at: "2026-10-22T16:50:00Z",
              html_url: "https://github.com/github/evals/actions/runs/102",
            },
          ],
        })}`,
        stderr: "",
      };
    }
    if (endpoint === "repos/github/evals/actions/runs/101/jobs?per_page=50") {
      return {
        ok: true,
        stdout: `HTTP/2.0 200 OK\n\n${JSON.stringify({
          jobs: [
            {
              id: 9001,
              name: "Portable checks (ubuntu-latest)",
              status: "completed",
              conclusion: "failure",
              created_at: "2026-10-22T16:55:00Z",
              started_at: "2026-10-22T16:55:05Z",
              completed_at: "2026-10-22T16:58:25Z",
              html_url: "https://github.com/github/evals/actions/runs/101/job/9001",
              steps: [],
            },
            {
              id: 9002,
              name: "Windows portable (unit)",
              status: "in_progress",
              conclusion: null,
              steps: [],
            },
          ],
        })}`,
        stderr: "",
      };
    }
    if (endpoint === "repos/github/evals/actions/runs/102/jobs?per_page=50") {
      prJobsCalls += 1;
      return {
        ok: true,
        stdout: `HTTP/2.0 200 OK\n\n${JSON.stringify({
          jobs: [
            {
              id: 9010,
              name: "Documentation contracts",
              status: "completed",
              conclusion: "failure",
              created_at: "2026-10-22T16:40:00Z",
              started_at: "2026-10-22T16:40:04Z",
              completed_at: "2026-10-22T16:45:04Z",
              html_url: "https://github.com/github/evals/actions/runs/102/job/9010",
              steps: [
                {
                  name: "Install dependencies with apt-get",
                  status: "completed",
                  conclusion: "failure",
                  started_at: "2026-10-22T16:40:10Z",
                  completed_at: "2026-10-22T16:45:04Z",
                },
              ],
            },
          ],
        })}`,
        stderr: "",
      };
    }
    throw new Error(`Unexpected endpoint: ${endpoint}`);
  };

  const tick = evaluatePollTick(args, state, fakeExec);
  assert.equal(tick.activeMainRuns, 1);
  assert.equal(tick.nextIntervalSec, 15);
  assert.equal(tick.events.length, 1);
  assert.equal(tick.events[0].type, "JOB_FAILED");
  assert.equal(tick.events[0].jobId, 9001);
  assert.equal(tick.events[0].deliverySkill, "go");
  assert.equal(tick.events[0].mergeMode, "approval");
  assert.equal(prJobsCalls, 1);

  // Second poll with identical updated_at on completed PR run 102 must skip re-fetching 102/jobs
  evaluatePollTick(args, state, fakeExec);
  assert.equal(prJobsCalls, 1);

  const report = buildOptimizationReport(state);
  assert.equal(report.slowJobs.length, 1);
  assert.equal(report.slowJobs[0].job, "Documentation contracts");
  assert.equal(report.slowJobs[0].avgDurationSec, 300);
  assert.equal(report.recentFailures.length, 1);
  assert.equal(report.recentFailures[0].matchedPattern?.id, "apt-mirror-timeout");

  // When watching an existing PR run (--watch-run 102) that failed, evaluatePollTick emits deliverySkill: "pr"
  const watchedPrState = loadState("/nonexistent/state.json");
  const watchedPrArgs = parseArgs(["watch", "--repo", "github/evals", "--watch-run", "102", "--merge=auto"]);
  const watchedPrTick = evaluatePollTick(watchedPrArgs, watchedPrState, fakeExec);
  const prFailureEvent = watchedPrTick.events.find((e) => e.runId === 102);
  assert.ok(prFailureEvent);
  assert.equal(prFailureEvent.type, "JOB_FAILED");
  assert.equal(prFailureEvent.deliverySkill, "pr");
  assert.equal(prFailureEvent.mergeMode, "auto");
  assert.ok(parseHttpResponse("plain body").status === 200);
  assert.ok(matchFlakePattern("write EPIPE")?.id === "epipe-stdin");
  assert.equal(matchFlakePattern(""), null);
  assert.equal(matchFlakePattern("ordinary assertion failure"), null);
});

test("evaluatePollTick handles search-index blips for tracked runs, NEW_MAIN_COMMIT, WORKFLOW_FAILED, and WATCHED_RUNS_GREEN", (t) => {
  disableAlertsForTest(t);
  const state = loadState("/nonexistent/state.json");
  state.lastMainSha = "oldsha0000000000000000000000000000000000";
  state.runs["555"] = {
    id: 555,
    name: "Release",
    event: "workflow_dispatch",
    head_branch: "main",
    head_sha: "newsha1111111111111111111111111111111111",
    status: "in_progress",
    conclusion: null,
    updated_at: "2026-10-22T17:00:00Z",
    html_url: "https://github.com/github/evals/actions/runs/555",
    telemetryRecorded: false,
    alertedFailure: false,
  };

  const commitArgs = parseArgs(["watch", "--repo", "github/evals", "--wake-on-commit", "--watch-run", "555"]);
  let run555Status = "completed";
  let run555Conclusion = "success";

  const fakeExec = (ghArgs) => {
    const endpoint = ghArgs[2];
    if (endpoint === "repos/github/evals/commits/main") {
      return {
        ok: true,
        stdout: 'HTTP/2.0 200 OK\n\n{"sha":"newsha1111111111111111111111111111111111"}',
        stderr: "",
      };
    }
    if (
      endpoint === "repos/github/evals/actions/runs?branch=main&per_page=20" ||
      endpoint === "repos/github/evals/actions/runs?per_page=25"
    ) {
      // Simulate a GitHub search-index blip returning empty workflow_runs
      return {
        ok: true,
        stdout: 'HTTP/2.0 200 OK\n\n{"workflow_runs":[]}',
        stderr: "",
      };
    }
    if (endpoint === "repos/github/evals/actions/runs/555") {
      return {
        ok: true,
        stdout: `HTTP/2.0 200 OK\n\n${JSON.stringify({
          id: 555,
          name: "Release",
          event: "workflow_dispatch",
          head_branch: "main",
          head_sha: "newsha1111111111111111111111111111111111",
          status: run555Status,
          conclusion: run555Conclusion,
          updated_at: "2026-10-22T17:10:00Z",
          html_url: "https://github.com/github/evals/actions/runs/555",
        })}`,
        stderr: "",
      };
    }
    if (endpoint === "repos/github/evals/actions/runs/555/jobs?per_page=50") {
      return {
        ok: true,
        stdout: 'HTTP/2.0 200 OK\n\n{"jobs":[]}',
        stderr: "",
      };
    }
    throw new Error(`Unexpected endpoint: ${endpoint}`);
  };

  const firstTick = evaluatePollTick(commitArgs, state, fakeExec);
  assert.equal(firstTick.events[0].type, "NEW_MAIN_COMMIT");
  assert.equal(firstTick.events[0].previousSha, "oldsha0000000000000000000000000000000000");

  // Next tick without commit change emits WATCHED_RUNS_GREEN
  const greenArgs = parseArgs(["watch", "--repo", "github/evals", "--watch-run", "555"]);
  const secondTick = evaluatePollTick(greenArgs, state, fakeExec);
  assert.equal(secondTick.events.length, 1);
  assert.equal(secondTick.events[0].type, "WATCHED_RUNS_GREEN");

  // Without --watch-run, emits ALL_GREEN for the branch head
  const allGreenArgs = parseArgs(["watch", "--repo", "github/evals"]);
  const thirdTick = evaluatePollTick(allGreenArgs, state, fakeExec);
  assert.equal(thirdTick.events.length, 1);
  assert.equal(thirdTick.events[0].type, "ALL_GREEN");

  // If workflow fails without individual job failure (e.g., startup/cancellation), emits WORKFLOW_FAILED
  state.runs["555"].status = "in_progress";
  state.runs["555"].alertedFailure = false;
  run555Status = "completed";
  run555Conclusion = "timed_out";
  const failedTick = evaluatePollTick(greenArgs, state, fakeExec);
  assert.equal(failedTick.events.length, 1);
  assert.equal(failedTick.events[0].type, "WORKFLOW_FAILED");
  assert.equal(failedTick.events[0].conclusion, "timed_out");
  assert.equal(failedTick.events[0].deliverySkill, "go");

  // With --existing-worktree on WORKFLOW_FAILED, emits deliverySkill: "pr"
  state.runs["555"].status = "in_progress";
  state.runs["555"].alertedFailure = false;
  const existingWorktreeArgs = parseArgs([
    "watch",
    "--repo",
    "github/evals",
    "--watch-run",
    "555",
    "--existing-worktree",
  ]);
  const existingWorktreeFailedTick = evaluatePollTick(existingWorktreeArgs, state, fakeExec);
  assert.equal(existingWorktreeFailedTick.events[0].type, "WORKFLOW_FAILED");
  assert.equal(existingWorktreeFailedTick.events[0].deliverySkill, "pr");

  // A watched non-PR run on another branch (e.g. release/1.x workflow_dispatch with pull_requests: []) still emits deliverySkill: "go"
  const releaseState = loadState("/nonexistent/state.json");
  const releaseArgs = parseArgs(["watch", "--repo", "github/evals", "--watch-run", "777"]);
  const releaseTick = evaluatePollTick(releaseArgs, releaseState, (ghArgs) => {
    const endpoint = ghArgs[2];
    if (endpoint === "repos/github/evals/commits/main") {
      return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"sha":"mainsha"}', stderr: "" };
    }
    if (endpoint.includes("/actions/runs?branch=") || endpoint.includes("/actions/runs?per_page=")) {
      return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"workflow_runs":[]}', stderr: "" };
    }
    if (endpoint === "repos/github/evals/actions/runs/777") {
      return {
        ok: true,
        stdout: `HTTP/2.0 200 OK\n\n${JSON.stringify({
          id: 777,
          name: "Release",
          event: "workflow_dispatch",
          head_branch: "release/1.x",
          head_sha: "relsha12345678",
          pull_requests: [],
          status: "completed",
          conclusion: "failure",
          updated_at: "2026-10-22T18:00:00Z",
          html_url: "https://github.com/github/evals/actions/runs/777",
        })}`,
        stderr: "",
      };
    }
    if (endpoint === "repos/github/evals/actions/runs/777/jobs?per_page=50") {
      return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"jobs":[]}', stderr: "" };
    }
    throw new Error(`Unexpected endpoint: ${endpoint}`);
  });
  assert.equal(releaseTick.events.length, 1);
  assert.equal(releaseTick.events[0].type, "WORKFLOW_FAILED");
  assert.equal(releaseTick.events[0].deliverySkill, "go");

  // A failed pull_request_target run sharing main's branch and SHA must not block ALL_GREEN for a passing main push run,
  // and a watched push run on a feature branch with associated pull_requests routes to "pr".
  const collisionState = loadState("/nonexistent/state.json");
  const collisionTick = evaluatePollTick(parseArgs(["watch", "--repo", "github/evals"]), collisionState, (ghArgs) => {
    const endpoint = ghArgs[2];
    if (endpoint === "repos/github/evals/commits/main") {
      return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"sha":"sharedsha"}', stderr: "" };
    }
    if (endpoint.includes("/actions/runs?branch=") || endpoint.includes("/actions/runs?per_page=")) {
      return {
        ok: true,
        stdout: `HTTP/2.0 200 OK\n\n${JSON.stringify({
          workflow_runs: [
            {
              id: 801,
              name: "CI",
              event: "push",
              head_branch: "main",
              head_sha: "sharedsha",
              status: "completed",
              conclusion: "success",
              updated_at: "2026-10-22T18:10:00Z",
              html_url: "https://github.com/github/evals/actions/runs/801",
            },
            {
              id: 802,
              name: "PR Check",
              event: "pull_request_target",
              head_branch: "main",
              head_sha: "sharedsha",
              status: "completed",
              conclusion: "failure",
              updated_at: "2026-10-22T18:10:00Z",
              html_url: "https://github.com/github/evals/actions/runs/802",
            },
          ],
        })}`,
        stderr: "",
      };
    }
    if (endpoint.includes("/jobs?per_page=50")) {
      return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"jobs":[]}', stderr: "" };
    }
    throw new Error(`Unexpected endpoint: ${endpoint}`);
  });
  assert.equal(collisionTick.events.length, 1);
  assert.equal(collisionTick.events[0].type, "ALL_GREEN");
  assert.equal(collisionTick.events[0].runs.length, 1);
  assert.equal(collisionTick.events[0].runs[0].id, 801);

  // Explicitly monitoring a PR source branch (--branch feat/fix) whose push run has pull_requests routes to "pr"
  const prBranchState = loadState("/nonexistent/state.json");
  const prBranchTick = evaluatePollTick(
    parseArgs(["watch", "--repo", "github/evals", "--branch", "feat/fix"]),
    prBranchState,
    (ghArgs) => {
      const endpoint = ghArgs[2];
      if (endpoint === "repos/github/evals/commits/feat/fix") {
        return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"sha":"featsha"}', stderr: "" };
      }
      if (endpoint.includes("/actions/runs?branch=") || endpoint.includes("/actions/runs?per_page=")) {
        return {
          ok: true,
          stdout: `HTTP/2.0 200 OK\n\n${JSON.stringify({
            workflow_runs: [
              {
                id: 901,
                name: "CI",
                event: "push",
                head_branch: "feat/fix",
                head_sha: "featsha",
                pull_requests: [{ number: 42, head: { ref: "feat/fix" }, base: { ref: "main" } }],
                status: "completed",
                conclusion: "failure",
                updated_at: "2026-10-22T18:20:00Z",
                html_url: "https://github.com/github/evals/actions/runs/901",
              },
            ],
          })}`,
          stderr: "",
        };
      }
      if (endpoint.includes("/jobs?per_page=50")) {
        return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"jobs":[]}', stderr: "" };
      }
      throw new Error(`Unexpected endpoint: ${endpoint}`);
    }
  );
  assert.equal(prBranchTick.events.length, 1);
  assert.equal(prBranchTick.events[0].type, "WORKFLOW_FAILED");
  assert.equal(prBranchTick.events[0].deliverySkill, "pr");
});


