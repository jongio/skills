import { fixtureRequest, parseGhApiArgs, parseHttpResponse } from "./github-fixtures.mjs";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  applySetupConfig,
  buildOptimizationReport,
  computeCiHoundPhase,
  computeNextPollIntervalSec,
  discoverOwnerRepos as native_discoverOwnerRepos,
  evaluateMultiRepoPollTick as native_evaluateMultiRepoPollTick,
  evaluatePollTick as native_evaluatePollTick,
  ghApiWithEtag as native_ghApiWithEtag,
  isValidRepoSlug,
  loadConfig,
  loadState,
  matchFlakePattern,
  parseArgs,
      pruneState,
  resolveTargetRepos as native_resolveTargetRepos,
  saveConfig,
  saveState,
  selectDeliverySkill,
} from "../scripts/ci-hound-daemon.mjs";

const discoverOwnerRepos = (...args) => { args[3] = fixtureRequest(args[3]); return native_discoverOwnerRepos(...args); };
const resolveTargetRepos = (...args) => { args[3] = fixtureRequest(args[3]); return native_resolveTargetRepos(...args); };
const ghApiWithEtag = (...args) => { args[2] = fixtureRequest(args[2]); return native_ghApiWithEtag(...args); };
const evaluatePollTick = (...args) => { args[2] = fixtureRequest(args[2]); return native_evaluatePollTick(...args); };
const evaluateMultiRepoPollTick = (...args) => { args[2] = fixtureRequest(args[2]); return native_evaluateMultiRepoPollTick(...args); };

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

test("portable skill frontmatter contains name, description, and version metadata", async () => {
  const frontmatter = skill.match(/^---\n([\s\S]*?)\n---/);
  assert.ok(frontmatter);
  const keys = [...frontmatter[1].matchAll(/^([a-z][a-z-]*):/gm)].map((match) => match[1]);
  assert.deepEqual(keys, ["name", "description", "metadata"]);
  assert.match(frontmatter[1], /^name: ci-hound$/m);
  assert.match(frontmatter[1], /^  version: "[^"]+"$/m);
});

test("skill includes workflow, setup, go/pr routing, safety, and exit criteria", async () => {
  assert.match(skill, /^## Multi-Repository Setup \(`\/ci-hound setup`\)$/m);
  assert.match(skill, /^## `go` vs `pr` Delivery Routing$/m);
  assert.match(skill, /^## Workflow$/m);
  assert.match(skill, /^## Safety$/m);
  assert.match(skill, /^## Exit Criteria$/m);
});

test("setup config, owner repo discovery, and multi-repo polling resolve and isolate repositories", async (t) => {
  disableAlertsForTest(t);
  const tempDir = await mkdtemp(path.join(tmpdir(), "ci-hound-setup-"));
  t.after(() => rm(tempDir, { recursive: true, force: true }));
  const configFile = path.join(tempDir, "config.json");

  assert.equal(isValidRepoSlug("jongio/skills"), true);
  assert.equal(isValidRepoSlug("invalid-slug"), false);
  assert.equal(isValidRepoSlug("../escape"), false);
  assert.throws(() => parseArgs(["setup", "--repos", "bad-slug"]), /Invalid repository slug/);
  assert.throws(() => parseArgs(["setup", "--visibility", "secret"]), /Invalid --visibility/);
  assert.throws(() => parseArgs(["setup", "--owner", "bad/owner"]), /Invalid --owner/);

  const setupArgs = parseArgs([
    "setup",
    "--config-file",
    configFile,
    "--all-my-repos",
    "--visibility=private",
    "--add-repo",
    "github/evals",
    "--merge=auto",
  ]);
  const saved = applySetupConfig(setupArgs, loadConfig(configFile));
  saveConfig(configFile, saved);
  const reloaded = loadConfig(configFile);
  assert.equal(reloaded.owner, "@me");
  assert.equal(reloaded.visibility, "private");
  assert.deepEqual(reloaded.repos, ["github/evals"]);
  assert.equal(reloaded.mergeMode, "auto");

  // Incremental add/remove without --merge preserves existing mergeMode
  const modified = applySetupConfig(
    parseArgs(["setup", "--add-repo", "jongio/skills", "--remove-repo", "github/evals"]),
    reloaded
  );
  assert.deepEqual(modified.repos, ["jongio/skills"]);
  assert.equal(modified.mergeMode, "auto");

  // Replacing repos with an explicit --repos list clears inherited owner and visibility filters
  const replaced = applySetupConfig(parseArgs(["setup", "--repos", "acme/one"]), modified);
  assert.deepEqual(replaced.repos, ["acme/one"]);
  assert.equal(replaced.owner, "");
  assert.equal(replaced.visibility, "");

  const discoveryState = loadState("/nonexistent/discovery.json");
  const page1Repos = Array.from({ length: 100 }, (_, idx) => ({
    full_name: `jongio/archived-${idx}`,
    owner: { login: "jongio" },
    private: true,
    archived: true,
    disabled: false,
  }));
  const discovered = await discoverOwnerRepos("@me", "private", discoveryState, (ghArgs) => {
    const endpoint = ghArgs[2];
    if (endpoint === "user/repos?affiliation=owner&visibility=private&per_page=100&page=1") {
      return {
        ok: true,
        stdout: `HTTP/2.0 200 OK\nETag: "p1"\n\n${JSON.stringify(page1Repos)}`,
        stderr: "",
      };
    }
    if (endpoint === "user/repos?affiliation=owner&visibility=private&per_page=100&page=2") {
      return {
        ok: true,
        stdout: `HTTP/2.0 200 OK\nETag: "p2"\n\n${JSON.stringify([
          { full_name: "jongio/private-page2", owner: { login: "jongio" }, private: true, archived: false, disabled: false },
          { full_name: "jongio/public-one", owner: { login: "jongio" }, private: false, archived: false, disabled: false },
        ])}`,
        stderr: "",
      };
    }
    throw new Error(`Unexpected discovery endpoint: ${endpoint}`);
  });
  assert.deepEqual(discovered, ["jongio/private-page2"]);
  assert.ok(discoveryState.etags["user/repos?affiliation=owner&visibility=private&per_page=100&page=1"]);
  assert.ok(discoveryState.etags["user/repos?affiliation=owner&visibility=private&per_page=100&page=2"]);

  // Named owner discovery finds private repos via authenticated user/repos and public repos via users/<owner>/repos
  const namedOwnerDiscovered = await discoverOwnerRepos("jongio", "private", loadState("/nonexistent/d2.json"), (ghArgs) => {
    assert.equal(
      ghArgs[2],
      "user/repos?affiliation=owner,organization_member,collaborator&visibility=private&per_page=100&page=1"
    );
    return {
      ok: true,
      stdout: `HTTP/2.0 200 OK\n\n${JSON.stringify([
        { full_name: "jongio/secret-repo", owner: { login: "jongio" }, private: true, archived: false, disabled: false },
        { full_name: "other/secret-repo", owner: { login: "other" }, private: true, archived: false, disabled: false },
      ])}`,
      stderr: "",
    };
  });
  assert.deepEqual(namedOwnerDiscovered, ["jongio/secret-repo"]);

  // Case-insensitive repository normalization deduplicates mixed-case spellings across config, discovery, and --watch-run
  const mixedCaseArgs = parseArgs(["watch", "--repo", "Acme/Project", "--watch-run", "acme/project:99"]);
  assert.deepEqual(mixedCaseArgs.explicitRepos, ["acme/project"]);
  assert.deepEqual(mixedCaseArgs.watchRunsByRepo, { "acme/project": [99] });
  const mixedResolved = await resolveTargetRepos(
    parseArgs(["watch"]),
    { repos: ["Jongio/Private-One"], owner: "@me", visibility: "private", branch: "main", mergeMode: "approval", worktreeRoot: "" },
    loadState("/nonexistent/d-case.json"),
    () => ({
      ok: true,
      stdout: `HTTP/2.0 200 OK\n\n${JSON.stringify([
        { full_name: "jongio/private-one", owner: { login: "jongio" }, private: true, archived: false, disabled: false },
      ])}`,
      stderr: "",
    })
  );
  assert.deepEqual(mixedResolved, ["jongio/private-one"]);

  // Uncached discovery error throws instead of silently returning a partial/empty watchlist
  await assert.rejects(
    async () =>
      await discoverOwnerRepos("@me", "private", loadState("/nonexistent/d-err.json"), () => ({
        ok: false,
        stdout: "HTTP/2.0 403 Forbidden\n\n",
        stderr: "HTTP 403",
      })),
    /403/
  );

  // Empty configured owner scope must return [] and NOT fall back to current git checkout
  const emptyOwnerConfig = { repos: [], owner: "jongio", visibility: "private", branch: "main", mergeMode: "approval", worktreeRoot: "" };
  const emptyResolved = await resolveTargetRepos(
    parseArgs(["watch"]),
    emptyOwnerConfig,
    loadState("/nonexistent/d3.json"),
    () => ({ ok: true, stdout: "HTTP/2.0 200 OK\n\n[]", stderr: "" })
  );
  assert.deepEqual(emptyResolved, []);

  // Rejects explicit --state-file when multiple target repositories resolve
  await assert.rejects(
    async () =>
      await evaluateMultiRepoPollTick(
        parseArgs(["watch", "--config-file", configFile, "--state-file", path.join(tempDir, "shared.json")]),
        reloaded,
        (ghArgs) => {
          if (ghArgs[2].startsWith("user/repos?")) {
            return {
              ok: true,
              stdout: `HTTP/2.0 200 OK\n\n${JSON.stringify([
                { full_name: "jongio/private-one", owner: { login: "jongio" }, private: true, archived: false, disabled: false },
              ])}`,
              stderr: "",
            };
          }
          throw new Error("Should not poll any repository when --state-file is shared across multiple repos");
        }
      ),
    /Cannot use a single --state-file when monitoring multiple repositories/
  );

  // Rejects unqualified --watch-run when multiple target repositories resolve
  await assert.rejects(
    async () =>
      await evaluateMultiRepoPollTick(
        parseArgs(["watch", "--config-file", configFile, "--watch-run", "12345"]),
        reloaded,
        (ghArgs) => {
          if (ghArgs[2].startsWith("user/repos?")) {
            return {
              ok: true,
              stdout: `HTTP/2.0 200 OK\n\n${JSON.stringify([
                { full_name: "jongio/private-one", owner: { login: "jongio" }, private: true, archived: false, disabled: false },
              ])}`,
              stderr: "",
            };
          }
          throw new Error("Should not poll any repository when unqualified --watch-run is ambiguous");
        }
      ),
    /Unqualified --watch-run requires a single target repository/
  );
  assert.throws(() => parseArgs(["watch", "--watch-run", "bad:id"]), /Invalid --watch-run/);
  await assert.rejects(
    async () =>
      await evaluateMultiRepoPollTick(
        parseArgs(["watch", "--repo", "acme/one", "--watch-run", "acme/two:99"]),
        reloaded,
        () => ({ ok: true, stdout: "[]", stderr: "" })
      ),
    /Watched run repository "acme\/two" is not in the explicit/
  );
  const multiHeaderParsed = parseHttpResponse(
    'HTTP/1.1 100 Continue\r\n\r\nHTTP/2.0 200 OK\r\nETag: "e-final"\r\n\r\n{"ok":true}'
  );
  assert.equal(multiHeaderParsed.status, 200);
  assert.equal(multiHeaderParsed.etag, '"e-final"');
  assert.equal(multiHeaderParsed.bodyText, '{"ok":true}');

  const watchArgs = parseArgs(["watch", "--config-file", configFile]);
  const multiTick = await evaluateMultiRepoPollTick(watchArgs, reloaded, (ghArgs) => {
    const endpoint = ghArgs[2];
    if (endpoint === "user/repos?affiliation=owner&visibility=private&per_page=100&page=1") {
      return {
        ok: true,
        stdout: `HTTP/2.0 200 OK\n\n${JSON.stringify([
          { full_name: "jongio/private-one", owner: { login: "jongio" }, private: true, archived: false, disabled: false },
        ])}`,
        stderr: "",
      };
    }
    if (endpoint.startsWith("repos/") && endpoint.endsWith("/commits/main")) {
      return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"sha":"sha123"}', stderr: "" };
    }
    if (endpoint === "repos/jongio/private-one/actions/runs?branch=main&per_page=20") {
      return {
        ok: true,
        stdout: `HTTP/2.0 200 OK\n\n${JSON.stringify({
          workflow_runs: [
            {
              id: 7001,
              name: "CI",
              event: "push",
              head_branch: "main",
              head_sha: "sha123",
              status: "completed",
              conclusion: "failure",
              updated_at: "2026-10-22T19:00:00Z",
              html_url: "https://github.com/jongio/private-one/actions/runs/7001",
            },
          ],
        })}`,
        stderr: "",
      };
    }
    if (endpoint.includes("/actions/runs")) {
      return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"workflow_runs":[],"jobs":[]}', stderr: "" };
    }
    throw new Error(`Unexpected endpoint: ${endpoint}`);
  });

  assert.deepEqual(multiTick.repos, ["github/evals", "jongio/private-one"]);
  assert.equal(multiTick.events.length, 1);
  assert.equal(multiTick.events[0].repo, "jongio/private-one");
  assert.equal(multiTick.events[0].type, "WORKFLOW_FAILED");
  assert.equal(multiTick.events[0].deliverySkill, "go");
  assert.equal(multiTick.events[0].mergeMode, "auto");

  // Supports repository-qualified --watch-run <owner/repo>:<runId> across multiple repositories
  // and scopes --existing-worktree only to the repository with watched runs
  const qualifiedWatchArgs = parseArgs([
    "watch",
    "--config-file",
    configFile,
    "--watch-run",
    "github/evals:9999",
    "--existing-worktree",
  ]);
  const qualifiedTick = await evaluateMultiRepoPollTick(qualifiedWatchArgs, reloaded, (ghArgs) => {
    const endpoint = ghArgs[2];
    if (endpoint.startsWith("user/repos?")) {
      return {
        ok: true,
        stdout: `HTTP/2.0 200 OK\n\n${JSON.stringify([
          { full_name: "jongio/private-one", owner: { login: "jongio" }, private: true, archived: false, disabled: false },
          { full_name: "jongio/private-two", owner: { login: "jongio" }, private: true, archived: false, disabled: false },
        ])}`,
        stderr: "",
      };
    }
    if (endpoint.startsWith("repos/") && endpoint.endsWith("/commits/main")) {
      return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"sha":"sha123"}', stderr: "" };
    }
    if (endpoint === "repos/jongio/private-two/actions/runs?branch=main&per_page=20") {
      return {
        ok: true,
        stdout: `HTTP/2.0 200 OK\n\n${JSON.stringify({
          workflow_runs: [
            {
              id: 7002,
              name: "CI",
              event: "push",
              head_branch: "main",
              head_sha: "sha123",
              status: "completed",
              conclusion: "failure",
              updated_at: "2026-10-22T19:05:00Z",
              html_url: "https://github.com/jongio/private-two/actions/runs/7002",
            },
          ],
        })}`,
        stderr: "",
      };
    }
    if (endpoint === "repos/github/evals/actions/runs/9999") {
      return {
        ok: true,
        stdout: `HTTP/2.0 200 OK\n\n${JSON.stringify({
          id: 9999,
          name: "Release",
          event: "workflow_dispatch",
          head_branch: "main",
          head_sha: "sha123",
          status: "completed",
          conclusion: "success",
          updated_at: "2026-10-22T19:05:00Z",
          html_url: "https://github.com/github/evals/actions/runs/9999",
        })}`,
        stderr: "",
      };
    }
    if (endpoint.includes("/actions/runs")) {
      return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"workflow_runs":[],"jobs":[]}', stderr: "" };
    }
    throw new Error(`Unexpected endpoint: ${endpoint}`);
  });
  assert.equal(qualifiedTick.events.length, 2);
  const evalsWatchedEvent = qualifiedTick.events.find((e) => e.repo === "github/evals");
  const unrelatedFailEvent = qualifiedTick.events.find((e) => e.repo === "jongio/private-two");
  assert.equal(evalsWatchedEvent.type, "WATCHED_RUNS_GREEN");
  assert.deepEqual(evalsWatchedEvent.watchRunIds, [9999]);
  assert.equal(unrelatedFailEvent.type, "WORKFLOW_FAILED");
  assert.equal(
    unrelatedFailEvent.deliverySkill,
    "go",
    "--existing-worktree must not leak to repositories without watched runs"
  );

  const cleared = applySetupConfig(parseArgs(["setup", "--clear-repos"]), reloaded);
  assert.deepEqual(cleared.repos, []);
  assert.equal(cleared.owner, "");
  assert.deepEqual(await resolveTargetRepos(parseArgs(["watch", "--repo", "github/evals"]), cleared, discoveryState), [
    "github/evals",
  ]);
});

test("selectDeliverySkill routes new failures and optimizations to go and existing worktrees/PRs to pr", async () => {
  assert.equal(selectDeliverySkill({ eventType: "JOB_FAILED" }), "go");
  assert.equal(selectDeliverySkill({ eventType: "WORKFLOW_FAILED" }), "go");
  assert.equal(selectDeliverySkill({ eventType: "OPTIMIZE" }), "go");
  assert.equal(selectDeliverySkill({ eventType: "JOB_FAILED", hasExistingPr: true }), "pr");
  assert.equal(selectDeliverySkill({ eventType: "OPTIMIZE", hasCommittedFixBranch: true }), "pr");
  assert.equal(selectDeliverySkill({ eventType: "OPTIMIZE", docsOrConfigOnlyStaged: true }), "pr");
  assert.equal(selectDeliverySkill({}), "pr");
});

test("parseArgs parses mode, repo, intervals, merge modes, flags, and watched run IDs", async () => {
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

test("ghApiWithEtag caches 200 ETag responses, reuses 304 Not Modified, and falls back on HTTP/JSON errors", async () => {
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

  const first = await ghApiWithEtag("repos/github/evals/commits/main", state, fakeExec);
  assert.equal(first.fromCache, false);
  assert.equal(first.data.sha, "abc12345");

  const second = await ghApiWithEtag("repos/github/evals/commits/main", state, fakeExec);
  assert.equal(second.fromCache, true);
  assert.equal(second.data.sha, "abc12345");
  assert.equal(state.metrics.cacheHits304, 1);

  const third = await ghApiWithEtag("repos/github/evals/commits/main", state, fakeExec);
  assert.equal(third.fromCache, false);
  assert.equal(third.data.sha, "abc12345");
  assert.match(third.error, /502/);

  const fourth = await ghApiWithEtag("repos/github/evals/commits/main", state, fakeExec);
  assert.equal(fourth.fromCache, false);
  assert.equal(fourth.data.sha, "abc12345");
  assert.ok(fourth.error);
});

test("evaluatePollTick detects instant job-level failure on active main run, harvests PR telemetry once, and skips unchanged completed runs", async (t) => {
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
              head_repository: { id: 1000 },
              pull_requests: [
                {
                  number: 301,
                  head: { ref: "main", repo: { id: 2000 } },
                  base: { ref: "main", repo: { id: 1000 } },
                },
              ],
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

  const tick = await evaluatePollTick(args, state, fakeExec);
  assert.equal(tick.activeMainRuns, 1);
  assert.equal(tick.nextIntervalSec, 15);
  assert.equal(tick.events.length, 1);
  assert.equal(tick.events[0].type, "JOB_FAILED");
  assert.equal(tick.events[0].jobId, 9001);
  assert.equal(tick.events[0].deliverySkill, "go");
  assert.equal(tick.events[0].mergeMode, "approval");
  assert.equal(prJobsCalls, 1);

  // Second poll with identical updated_at on completed PR run 102 must skip re-fetching 102/jobs
  await evaluatePollTick(args, state, fakeExec);
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
  const watchedPrTick = await evaluatePollTick(watchedPrArgs, watchedPrState, fakeExec);
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

test("evaluatePollTick handles search-index blips for tracked runs, NEW_MAIN_COMMIT, WORKFLOW_FAILED, and WATCHED_RUNS_GREEN", async (t) => {
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

  const firstTick = await evaluatePollTick(commitArgs, state, fakeExec);
  assert.equal(firstTick.events[0].type, "NEW_MAIN_COMMIT");
  assert.equal(firstTick.events[0].previousSha, "oldsha0000000000000000000000000000000000");

  // Next tick without commit change emits WATCHED_RUNS_GREEN
  const greenArgs = parseArgs(["watch", "--repo", "github/evals", "--watch-run", "555"]);
  const secondTick = await evaluatePollTick(greenArgs, state, fakeExec);
  assert.equal(secondTick.events.length, 1);
  assert.equal(secondTick.events[0].type, "WATCHED_RUNS_GREEN");

  // Without --watch-run, emits ALL_GREEN for the branch head
  const allGreenArgs = parseArgs(["watch", "--repo", "github/evals"]);
  const thirdTick = await evaluatePollTick(allGreenArgs, state, fakeExec);
  assert.equal(thirdTick.events.length, 1);
  assert.equal(thirdTick.events[0].type, "ALL_GREEN");

  // If workflow fails without individual job failure (e.g., startup/cancellation), emits WORKFLOW_FAILED
  state.runs["555"].status = "in_progress";
  state.runs["555"].alertedFailure = false;
  run555Status = "completed";
  run555Conclusion = "timed_out";
  const failedTick = await evaluatePollTick(greenArgs, state, fakeExec);
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
  const existingWorktreeFailedTick = await evaluatePollTick(existingWorktreeArgs, state, fakeExec);
  assert.equal(existingWorktreeFailedTick.events[0].type, "WORKFLOW_FAILED");
  assert.equal(existingWorktreeFailedTick.events[0].deliverySkill, "pr");

  // A watched non-PR run on another branch (e.g. release/1.x workflow_dispatch with pull_requests: []) still emits deliverySkill: "go"
  const releaseState = loadState("/nonexistent/state.json");
  const releaseArgs = parseArgs(["watch", "--repo", "github/evals", "--watch-run", "777"]);
  const releaseTick = await evaluatePollTick(releaseArgs, releaseState, (ghArgs) => {
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
  const collisionTick = await evaluatePollTick(parseArgs(["watch", "--repo", "github/evals"]), collisionState, (ghArgs) => {
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
  const prBranchTick = await evaluatePollTick(
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
                head_repository: { id: 1000 },
                pull_requests: [
                  {
                    number: 42,
                    head: { ref: "feat/fix", repo: { id: 1000 } },
                    base: { ref: "main", repo: { id: 1000 } },
                  },
                ],
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

test("pruneState, rate-limit headers, and parseGhApiArgs bound state size and back off under rate pressure", async () => {
  // 1. parseGhApiArgs parses REST (-i, -H, -X) and GraphQL (-F typed, -f raw) requests for keep-alive execution
  const restReq = parseGhApiArgs([
    "api",
    "-i",
    "repos/github/evals/actions/runs?per_page=25",
    "-H",
    'If-None-Match: "etag-1"',
  ]);
  assert.deepEqual(restReq, {
    url: "https://api.github.com/repos/github/evals/actions/runs?per_page=25",
    method: "GET",
    includeHeaders: true,
    headers: { "If-None-Match": '"etag-1"' },
    body: undefined,
  });

  const gqlReq = parseGhApiArgs([
    "api",
    "graphql",
    "-F",
    "owner=jongio",
    "-F",
    "name=skills",
    "-F",
    "pr=178",
    "-f",
    "query=query($pr: Int!) { node }",
  ]);
  assert.equal(gqlReq.url, "https://api.github.com/graphql");
  assert.equal(gqlReq.method, "POST");
  assert.deepEqual(JSON.parse(gqlReq.body), {
    query: "query($pr: Int!) { node }",
    variables: { owner: "jongio", name: "skills", pr: 178 },
  });

  // 2. pruneState removes completed run jobs payloads from state.etags, retains active main runs and protected watched runs,
  // and evicts stale unrefreshed non-main/PR active runs beyond maxRuns
  const bloatedState = loadState("/nonexistent/state.json");
  bloatedState.branch = "main";
  bloatedState.runs["99"] = {
    id: 99,
    head_branch: "feat/old-pr",
    event: "pull_request",
    status: "in_progress",
    telemetryRecorded: false,
  };
  bloatedState.runs["100"] = { id: 100, status: "completed", telemetryRecorded: true };
  bloatedState.runs["101"] = {
    id: 101,
    head_branch: "main",
    event: "push",
    status: "in_progress",
    telemetryRecorded: false,
  };
  bloatedState.etags["repos/o/r/actions/runs/100/jobs?per_page=50"] = {
    etag: '"e100"',
    data: { jobs: [{ id: 1 }] },
    updatedAt: "2026-10-23T01:00:00Z",
  };
  bloatedState.etags["repos/o/r/actions/runs/101/jobs?per_page=50"] = {
    etag: '"e101"',
    data: { jobs: [{ id: 2 }] },
    updatedAt: "2026-10-23T01:05:00Z",
  };
  pruneState(bloatedState, { maxRuns: 50, maxEtags: 50 });
  assert.equal(bloatedState.etags["repos/o/r/actions/runs/100/jobs?per_page=50"], undefined);
  assert.ok(bloatedState.etags["repos/o/r/actions/runs/101/jobs?per_page=50"]);

  // Protected watched run IDs and active main runs are never evicted, while stale PR in_progress run 99 is evicted,
  // and orphaned runs/<id>/jobs ETag entries for evicted runs (like 98 and 200) are also deleted!
  bloatedState.etags["repos/o/r/actions/runs/98/jobs?per_page=50"] = {
    etag: '"e98-orphaned"',
    data: { jobs: [{ id: 98 }] },
    updatedAt: "2026-10-23T01:00:00Z",
  };
  for (let id = 200; id < 210; id += 1) {
    bloatedState.runs[String(id)] = { id, status: "completed", telemetryRecorded: false };
    bloatedState.etags[`repos/o/r/actions/runs/${id}/jobs?per_page=50`] = {
      etag: `"e${id}"`,
      data: { jobs: [{ id }] },
      updatedAt: "2026-10-23T01:00:00Z",
    };
  }
  pruneState(bloatedState, { maxRuns: 3, maxEtags: 50, protectedRunIds: [100] });
  assert.ok(bloatedState.runs["100"]);
  assert.ok(bloatedState.runs["101"]);
  assert.equal(bloatedState.runs["99"], undefined);
  assert.equal(bloatedState.etags["repos/o/r/actions/runs/98/jobs?per_page=50"], undefined);
  assert.equal(bloatedState.etags["repos/o/r/actions/runs/200/jobs?per_page=50"], undefined);

  // computeCiHoundPhase summarizes active runs and job counts for live watch streaming
  const phaseInfo = computeCiHoundPhase({
    repo: "github/evals",
    branch: "main",
    sha: "c9af6f7baca34995",
    activeRuns: [
      {
        id: 39974417712,
        name: "Release",
        completedJobsCount: 13,
        totalJobsCount: 20,
        inProgressJobs: ["Retained artifacts (macos-15, VS Code minimum) [Verify installed bytes]"],
      },
    ],
  });
  assert.equal(phaseInfo.phase, "main:running:c9af6f7b:39974417712:13/20");
  assert.match(phaseInfo.summary, /Release \(13\/20 jobs passed; active: Retained artifacts/);

  // 3. Rate-limit headers and 429/403 secondary rate limits trigger interval backoff and preserve cached data
  const rlState = loadState("/nonexistent/state.json");
  rlState.etags["repos/o/r/commits/main"] = {
    etag: '"cached-sha"',
    data: { sha: "abc12345" },
    updatedAt: "2026-10-23T01:00:00Z",
  };
  const rlRes = await ghApiWithEtag("repos/o/r/commits/main", rlState, () => ({
    ok: false,
    stdout:
      "HTTP/2.0 429 Too Many Requests\r\nx-ratelimit-remaining: 12\r\nretry-after: 90\r\n\r\n{\"message\":\"You have exceeded a secondary rate limit\"}",
    stderr: "HTTP 429",
  }));
  assert.equal(rlRes.rateLimited, true);
  assert.equal(rlRes.fromCache, true);
  assert.deepEqual(rlRes.data, { sha: "abc12345" });
  assert.equal(rlState.metrics.rateLimitRemaining, 12);
  assert.equal(rlState.metrics.retryAfterSec, 90);

  const pollArgs = parseArgs(["watch", "--repo", "o/r"]);
  assert.equal(computeNextPollIntervalSec(pollArgs, 1, rlState.metrics), 90);
  assert.equal(
    computeNextPollIntervalSec(pollArgs, 0, { rateLimitRemaining: 200, retryAfterSec: null }),
    120
  );

  // 4. Primary rate-limit 403 with X-RateLimit-Remaining: 0 and X-RateLimit-Reset (no Retry-After) backs off until reset
  const futureReset = Math.floor(Date.now() / 1000) + 600;
  const resetState = loadState("/nonexistent/state.json");
  const resetRes = await ghApiWithEtag("repos/o/r/commits/main", resetState, () => ({
    ok: false,
    stdout: `HTTP/2.0 403 Forbidden\r\nx-ratelimit-remaining: 0\r\nx-ratelimit-reset: ${futureReset}\r\n\r\n{"message":"API rate limit exceeded"}`,
    stderr: "HTTP 403",
  }));
  assert.equal(resetRes.rateLimited, true);
  assert.ok(resetState.metrics.retryAfterSec >= 590);
  assert.ok(computeNextPollIntervalSec(pollArgs, 1, resetState.metrics) >= 590);

  // 5. evaluatePollTick stops further requests and defers ALL_GREEN when rate-limited
  const deferState = loadState("/nonexistent/state.json");
  deferState.lastMainSha = "sha1";
  deferState.runs["500"] = {
    id: 500,
    name: "CI",
    event: "push",
    head_branch: "main",
    head_sha: "sha1",
    status: "completed",
    conclusion: "success",
  };
  let callsDuringCooldown = 0;
  const deferTick = await evaluatePollTick(pollArgs, deferState, () => {
    callsDuringCooldown += 1;
    return {
      ok: false,
      stdout: "HTTP/2.0 429 Too Many Requests\r\nretry-after: 75\r\n\r\n{}",
      stderr: "HTTP 429",
    };
  });
  assert.equal(callsDuringCooldown, 1);
  assert.equal(deferTick.rateLimited, true);
  assert.equal(deferTick.events.length, 1);
  assert.equal(deferTick.events[0].type, "RATE_LIMITED");
  assert.equal(deferTick.nextIntervalSec, 75);
});
