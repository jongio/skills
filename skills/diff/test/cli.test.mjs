import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import test from "node:test";

import {
  listSavedReviews,
  openSystemBrowser,
  parseCliArgs,
  runCli,
  validateLoopbackCapabilityUrl,
} from "../scripts/cli.mjs";

const CLI_SCRIPT_PATH = path.resolve(
  import.meta.dirname,
  "..",
  "scripts",
  "cli.mjs",
);

function makeTempDir(prefix) {
  return fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), prefix)),
  );
}

function createCaptureStream() {
  let text = "";
  const stream = new Writable({
    write(chunk, _enc, cb) {
      text += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      cb();
    },
  });
  return {
    stream,
    read: () => text,
  };
}

function createGitFixtureRepo(t) {
  const root = makeTempDir("diff-cli-git-");
  const copilotHome = makeTempDir("diff-cli-home-");
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(copilotHome, { recursive: true, force: true });
  });

  const git = (...args) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
    });

  git("init", "-b", "main");
  git("config", "user.name", "Example Reviewer");
  git("config", "user.email", "reviewer@example.com");
  git("config", "commit.gpgsign", "false");

  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "src", "service.ts"),
    "export function compute(x: number) {\n  return x + 1;\n}\n",
    "utf8",
  );
  git("add", ".");
  git("commit", "-m", "initial");

  git("checkout", "-b", "feat/cross-harness");
  fs.writeFileSync(
    path.join(root, "src", "service.ts"),
    "export function compute(x: number) {\n  return x * 2;\n}\n",
    "utf8",
  );

  return { root, copilotHome, git };
}

async function postPanelAction(panelUrl, action, input = {}) {
  const parsed = new URL(panelUrl);
  const cap = parsed.searchParams.get("capability");
  const actionUrl = `${parsed.origin}/action?capability=${encodeURIComponent(cap)}`;
  const res = await fetch(actionUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: parsed.origin,
    },
    body: JSON.stringify({ actionName: action, input }),
  });
  const body = await res.json();
  return { status: res.status, body };
}

test("validateLoopbackCapabilityUrl and openSystemBrowser enforce strict 127.0.0.1 capability URLs and shell:false", async () => {
  const validUrl =
    "http://127.0.0.1:54321/?capability=0123456789abcdef0123456789abcdef0123456789abcdef";
  assert.equal(validateLoopbackCapabilityUrl(validUrl), validUrl);

  for (const unsafeUrl of [
    "",
    "http://localhost:54321/?capability=0123456789abcdef0123456789abcdef",
    "https://127.0.0.1:54321/?capability=0123456789abcdef0123456789abcdef",
    "http://127.0.0.1:0/?capability=0123456789abcdef0123456789abcdef",
    "http://127.0.0.1:70000/?capability=0123456789abcdef0123456789abcdef",
    "http://127.0.0.1:54321/",
    "http://127.0.0.1:54321/?capability=short",
    "http://127.0.0.1:54321/?capability=0123456789abcdef0123456789abcdef&calc=1",
    "javascript:alert(1)",
    "file:///etc/passwd",
  ]) {
    assert.throws(
      () => validateLoopbackCapabilityUrl(unsafeUrl),
      /Invalid|Refusing/i,
      `Must reject unsafe browser URL: ${unsafeUrl}`,
    );
    assert.throws(
      () =>
        openSystemBrowser(unsafeUrl, {
          platform: "win32",
          spawnFn: () => {
            throw new Error("spawn must never be reached");
          },
        }),
      /Invalid|Refusing/i,
    );
  }

  const calls = [];
  const fakeSpawn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return {
      unref() {},
    };
  };
  const testEnv = {
    SystemRoot: "C:\\Windows",
    PATH: "/usr/bin",
    GH_TOKEN: "gho_test_token_value",
    GITHUB_TOKEN: "ghp_test_token_value",
    COPILOT_GH_ACCOUNT_github_2E_com_sample: "ghu_test_token_value",
  };

  await openSystemBrowser(validUrl, {
    platform: "win32",
    spawnFn: fakeSpawn,
    env: testEnv,
  });
  await openSystemBrowser(validUrl, {
    platform: "darwin",
    spawnFn: fakeSpawn,
    env: testEnv,
  });
  await openSystemBrowser(validUrl, {
    platform: "linux",
    spawnFn: fakeSpawn,
    env: testEnv,
  });

  assert.equal(calls.length, 3);
  assert.equal(calls[0].cmd, "C:\\Windows\\System32\\rundll32.exe");
  assert.deepEqual(calls[0].args, ["url.dll,FileProtocolHandler", validUrl]);
  assert.equal(calls[0].opts.shell, false);
  assert.equal(calls[0].opts.windowsHide, true);
  assert.equal(calls[0].opts.cwd, os.tmpdir());
  assert.equal(calls[0].opts.env.NoDefaultCurrentDirectoryInExePath, "1");
  assert.equal(calls[0].opts.env.GH_TOKEN, undefined);
  assert.equal(calls[0].opts.env.GITHUB_TOKEN, undefined);
  assert.equal(
    calls[0].opts.env.COPILOT_GH_ACCOUNT_github_2E_com_sample,
    undefined,
  );

  assert.equal(calls[1].cmd, "open");
  assert.deepEqual(calls[1].args, [validUrl]);
  assert.equal(calls[1].opts.shell, false);
  assert.equal(calls[1].opts.cwd, os.tmpdir());

  assert.equal(calls[2].cmd, "xdg-open");
  assert.deepEqual(calls[2].args, [validUrl]);
  assert.equal(calls[2].opts.shell, false);
  assert.equal(calls[2].opts.cwd, os.tmpdir());
});

test("parseCliArgs rejects leading-dash ref injection, unknown flags, conflicting options, and invalid domain IDs", () => {
  assert.throws(() => parseCliArgs(["--unknown-flag"]), /Unknown or unsafe option/);
  assert.throws(() => parseCliArgs(["-x"]), /Unknown or unsafe option/);
  assert.throws(() => parseCliArgs(["--spec", "-o"]), /must not start with '-'/);
  assert.throws(() => parseCliArgs(["--spec", "--output=/tmp/x"]), /must not start with '-'/);
  assert.throws(() => parseCliArgs(["--pr", "42", "--staged"]), /Conflicting PR and Git diff spec/);
  assert.throws(() => parseCliArgs(["--repo", "example-org/service", "--pr", "42", "--spec", "main..feat"]), /Conflicting PR and Git diff spec/);
  assert.throws(() => parseCliArgs(["pr", "--repo", "example-org/service"]), /Specify an explicit PR number/);
  assert.throws(() => parseCliArgs(["--account", "sample-user", "--staged"]), /Conflicting PR and Git diff spec/);
  assert.throws(() => parseCliArgs(["--account", "sample-user"]), /--account requires a pull request target/);
  assert.throws(() => parseCliArgs(["review", "--domain", "../escape"]), /Invalid --domain/);
  assert.throws(() => parseCliArgs(["review", "--domain", "default"]), /Invalid --domain/);
  assert.throws(() => parseCliArgs(["serve", "--domain", "pr__a__b__1"]), /only supported with review/);
  assert.throws(() => parseCliArgs(["list", "--status", "bogus"]), /Invalid --status/);
  assert.throws(() => parseCliArgs(["pr", "not-a-number"]), /Invalid PR number/);
  assert.throws(() => parseCliArgs(["list", "--no-open"]), /--no-open is only supported with 'serve'/);
  assert.throws(() => parseCliArgs(["review", "--print-url"]), /--print-url is only supported with 'serve'/);
  assert.throws(() => parseCliArgs(["address", "--domain", "pr__a__b__1", "--wait"]), /--wait is only supported with 'serve'/);
  assert.throws(() => parseCliArgs(["reopen", "--domain", "pr__a__b__1", "--focus", "src/a.ts"]), /--focus is only supported with 'serve'/);
  assert.throws(() => parseCliArgs(["list", "--idle-timeout-ms", "60000"]), /--idle-timeout-ms is only supported with 'serve'/);

  const parsed = parseCliArgs([
    "serve",
    "--staged",
    "--no-open",
    "--wait",
    "--json",
    "--",
    "src/a.ts",
  ]);
  assert.equal(parsed.command, "serve");
  assert.equal(parsed.spec, "--staged");
  assert.equal(parsed.noOpen, true);
  assert.equal(parsed.wait, true);
  assert.equal(parsed.json, true);
  assert.deepEqual(parsed.paths, ["src/a.ts"]);
});

test("serve --no-open redacts capability URL by default and exposes it only with --print-url", async (t) => {
  const { root, copilotHome } = createGitFixtureRepo(t);
  const env = { ...process.env, COPILOT_HOME: copilotHome };

  // 1. Default serve --no-open --json MUST NOT leak ?capability=
  const outDefault = createCaptureStream();
  const errDefault = createCaptureStream();
  const ac1 = new AbortController();
  let capturedReadyUrl = "";

  const runPromise1 = runCli(
    ["serve", "--cwd", root, "--no-open", "--json"],
    {
      env,
      stdout: outDefault.stream,
      stderr: errDefault.stream,
      abortSignal: ac1.signal,
      onReady: ({ url }) => {
        capturedReadyUrl = url;
        setTimeout(() => ac1.abort(), 30);
      },
    },
  );
  const res1 = await runPromise1;
  assert.match(capturedReadyUrl, /\?capability=[0-9a-f]{32,128}$/);
  assert.equal(res1.url, undefined);
  assert.doesNotMatch(outDefault.read(), /capability=/);
  assert.doesNotMatch(errDefault.read(), /capability=/);
  const parsedStdout1 = JSON.parse(outDefault.read().trim());
  assert.equal(parsedStdout1.ok, true);
  assert.equal(parsedStdout1.waiting, false);
  assert.equal(parsedStdout1.url, undefined);
  assert.equal(parsedStdout1.stats.fileCount, 1);

  // 2. With --print-url, URL IS included
  const outPrint = createCaptureStream();
  const ac2 = new AbortController();
  await runCli(
    ["serve", "--cwd", root, "--no-open", "--print-url", "--json"],
    {
      env,
      stdout: outPrint.stream,
      abortSignal: ac2.signal,
      onReady: () => setTimeout(() => ac2.abort(), 30),
    },
  );
  const parsedStdout2 = JSON.parse(outPrint.read().trim());
  assert.match(parsedStdout2.url, /^http:\/\/127\.0\.0\.1:\d+\/\?capability=[0-9a-f]{32,128}$/);
});

test("subprocess serve --no-open --print-url --wait --json resolves on Submit Review and shuts down HTTP server", async (t) => {
  const { root, copilotHome } = createGitFixtureRepo(t);
  const env = { ...process.env, COPILOT_HOME: copilotHome };

  const child = spawn(
    process.execPath,
    [
      CLI_SCRIPT_PATH,
      "serve",
      "--cwd",
      root,
      "--no-open",
      "--print-url",
      "--wait",
      "--json",
    ],
    {
      cwd: root,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  t.after(() => {
    child.stdout.destroy();
    child.stderr.destroy();
    if (child.exitCode === null) {
      child.kill();
    }
  });

  let stdoutText = "";
  let stderrText = "";
  let resolveReadyUrl;
  const readyUrlPromise = new Promise((resolve, reject) => {
    resolveReadyUrl = resolve;
    child.once("error", reject);
  });

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdoutText += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderrText += chunk;
    const match = stderrText.match(/DIFF_VIEWER_URL=(\S+)/);
    if (match) {
      resolveReadyUrl(match[1]);
    }
  });

  const panelUrl = await readyUrlPromise;
  validateLoopbackCapabilityUrl(panelUrl);

  // Post inline comment + submit_review from simulated browser client
  const addRes = await postPanelAction(panelUrl, "add_comment", {
    file: "src/service.ts",
    line: 2,
    side: "right",
    body: "Guard against integer overflow when doubling x",
  });
  assert.equal(addRes.status, 200);
  assert.equal(addRes.body.ok, true);

  const submitRes = await postPanelAction(panelUrl, "submit_review", {
    notifyAgent: true,
  });
  assert.equal(submitRes.status, 200);
  assert.equal(submitRes.body.ok, true);
  assert.equal(submitRes.body.result.status, "pending");
  assert.equal(submitRes.body.result.notifiedAgent, false);

  const exitCode = await new Promise((resolve, reject) => {
    child.once("exit", (code) => resolve(code));
    child.once("error", reject);
  });
  assert.equal(exitCode, 0);

  const result = JSON.parse(stdoutText.trim());
  assert.equal(result.ok, true);
  assert.equal(result.submitted, true);
  assert.equal(result.status, "pending");
  assert.equal(result.commentCount, 1);
  assert.equal(result.comments[0].file, "src/service.ts");
  assert.equal(result.comments[0].stale, false);
  assert.match(result.comments[0].body, /integer overflow/);

  // Verify the loopback server actually closed after Submit Review
  await assert.rejects(() => fetch(panelUrl));

  // Now exercise list -> live stale reconciliation in review -> address -> reopen --clear-comments!
  const listOut = createCaptureStream();
  const listed = await runCli(["list", "--status", "pending", "--json"], {
    env,
    stdout: listOut.stream,
  });
  assert.equal(listed.reviews.length, 1);
  const domainId = listed.reviews[0].domain;
  assert.equal(listed.reviews[0].commentCount, 1);
  assert.equal(listed.reviews[0].status, "pending");

  // Modify line 2 in src/service.ts so the comment anchor becomes stale: true on live review!
  fs.writeFileSync(
    path.join(root, "src", "service.ts"),
    "export function compute(x: number) {\n  return x * 10;\n}\n",
    "utf8",
  );

  const reviewLiveOut = createCaptureStream();
  const liveReview = await runCli(
    ["review", "--cwd", root, "--domain", domainId, "--json"],
    { env, stdout: reviewLiveOut.stream },
  );
  assert.equal(liveReview.ok, true);
  assert.equal(liveReview.status, "pending");
  assert.equal(liveReview.comments.length, 1);
  assert.equal(
    liveReview.comments[0].stale,
    true,
    "cli.mjs review --cwd <repo> --domain <id> must reconcile stale: true against live hunks",
  );

  // Querying --domain from an unrelated non-git folder still reads the durable review record cleanly
  const externalDir = makeTempDir("diff-cli-nongit-");
  t.after(() => fs.rmSync(externalDir, { recursive: true, force: true }));
  const reviewOfflineOut = createCaptureStream();
  const offlineReview = await runCli(
    ["review", "--cwd", externalDir, "--domain", domainId, "--json"],
    { env, stdout: reviewOfflineOut.stream },
  );
  assert.equal(offlineReview.ok, true);
  assert.equal(offlineReview.commentCount, 1);
  assert.equal(offlineReview.status, "pending");

  // Mark addressed via CLI (works even from externalDir!)
  const addrOut = createCaptureStream();
  const addrRes = await runCli(
    ["address", "--cwd", externalDir, "--domain", domainId, "--json"],
    { env, stdout: addrOut.stream },
  );
  assert.equal(addrRes.ok, true);
  assert.equal(addrRes.status, "addressed");

  // Reopening inside the repository after offline 'address' must preserve 'addressed'
  // (offline address clears the stale pre-fix diffFingerprint rather than auto-reopening)
  const postAddrLive = await runCli(
    ["review", "--cwd", root, "--domain", domainId, "--json"],
    { env, stdout: createCaptureStream().stream },
  );
  assert.equal(postAddrLive.status, "addressed");

  const listPendingAfter = await runCli(
    ["list", "--status", "pending", "--json"],
    { env, stdout: createCaptureStream().stream },
  );
  assert.equal(listPendingAfter.reviews.length, 0);

  // Reopen with --clear-comments
  const reopenOut = createCaptureStream();
  const reopenRes = await runCli(
    [
      "reopen",
      "--clear-comments",
      "--cwd",
      externalDir,
      "--domain",
      domainId,
      "--json",
    ],
    { env, stdout: reopenOut.stream },
  );
  assert.equal(reopenRes.ok, true);
  assert.equal(reopenRes.status, "draft");
  assert.equal(reopenRes.commentCount, 0);
  assert.equal(reopenRes.clearedComments, true);
});

test("bare 'pr' positional resolves current branch PR via gh pr view --json number and listSavedReviews skips symlinks", async (t) => {
  const copilotHome = makeTempDir("diff-cli-pr-home-");
  const fakeCwd = makeTempDir("diff-cli-pr-cwd-");
  t.after(() => {
    fs.rmSync(copilotHome, { recursive: true, force: true });
    fs.rmSync(fakeCwd, { recursive: true, force: true });
  });

  const env = { ...process.env, COPILOT_HOME: copilotHome };
  const samplePatch = [
    "diff --git a/README.md b/README.md",
    "index 1111111..2222222 100644",
    "--- a/README.md",
    "+++ b/README.md",
    "@@ -1,1 +1,2 @@",
    " # Demo",
    "+Cross harness PR",
  ].join("\n");

  const execCalls = [];
  const fakeExec = async (cmd, args) => {
    execCalls.push({ cmd, args });
    if (cmd === "git" && args.includes("--show-toplevel")) {
      return `${fakeCwd}\n`;
    }
    if (cmd === "gh" && args[0] === "pr" && args[1] === "view" && args.includes("number")) {
      return JSON.stringify({
        number: 42,
        title: "Cross-harness PR",
        headRefName: "feat/xh",
        baseRefName: "main",
        url: "https://github.com/example-org/service/pull/42",
      });
    }
    if (cmd === "gh" && args[0] === "pr" && args[1] === "diff") {
      return samplePatch;
    }
    throw new Error(`Unexpected command: ${cmd} ${args.join(" ")}`);
  };

  const out = createCaptureStream();
  const ac = new AbortController();
  let browserOpenedUrl = "";

  await runCli(["pr", "--cwd", fakeCwd, "--json"], {
    env,
    execFn: fakeExec,
    stdout: out.stream,
    abortSignal: ac.signal,
    openBrowser: async (url) => {
      browserOpenedUrl = validateLoopbackCapabilityUrl(url);
      setTimeout(() => ac.abort(), 20);
      return { launched: true };
    },
  });

  assert.match(browserOpenedUrl, /^http:\/\/127\.0\.0\.1:\d+\/\?capability=[0-9a-f]{32,128}$/);
  const parsed = JSON.parse(out.read().trim());
  assert.equal(parsed.ok, true);
  assert.equal(parsed.url, undefined);
  assert.match(parsed.title, /#42/);

  // Verify listSavedReviews skips symlinked JSON files safely
  const artifactsDir = path.join(copilotHome, "extensions", "diff", "artifacts");
  fs.mkdirSync(artifactsDir, { recursive: true });
  fs.writeFileSync(
    path.join(artifactsDir, "pr__example-org__service__42.json"),
    JSON.stringify({
      domain: "pr__example-org__service__42",
      source: {
        mode: "pr",
        repo: "example-org/service",
        pr: 42,
        account: "sample_emu",
        paths: [],
      },
      title: "example-org/service#42",
      status: "pending",
      comments: [{ id: "1", file: "README.md", line: 2, side: "right", body: "ok" }],
      updatedAt: "2026-04-19T12:00:00.000Z",
    }),
    "utf8",
  );
  const offlinePrAddr = await runCli(
    ["address", "--cwd", fakeCwd, "--domain", "pr__example-org__service__42", "--json"],
    {
      env,
      execFn: async () => {
        throw new Error("offline");
      },
      stdout: createCaptureStream().stream,
    },
  );
  assert.equal(offlinePrAddr.status, "addressed");
  const persistedAfterOfflineAddr = JSON.parse(
    fs.readFileSync(
      path.join(artifactsDir, "pr__example-org__service__42.json"),
      "utf8",
    ),
  );
  assert.equal(
    persistedAfterOfflineAddr.source?.account,
    "sample_emu",
    "Offline address --domain on a PR review must preserve saved source.account",
  );
  const outsideSecret = path.join(fakeCwd, "secret.json");
  fs.writeFileSync(
    outsideSecret,
    JSON.stringify({
      domain: "pr__secret__leak__1",
      title: "should-not-be-read",
      status: "pending",
      comments: [],
    }),
    "utf8",
  );
  let symlinkCreated = false;
  try {
    fs.symlinkSync(
      outsideSecret,
      path.join(artifactsDir, "pr__secret__leak__1.json"),
    );
    symlinkCreated = true;
  } catch {
    // Windows without Developer Mode symlink privilege skips file symlink creation
  }

  const saved = listSavedReviews({ env });
  assert.equal(saved.length, 1);
  assert.equal(saved[0].domain, "pr__example-org__service__42");
  if (symlinkCreated) {
    assert.equal(
      saved.some((r) => r.domain === "pr__secret__leak__1"),
      false,
      "Symlinked artifact files must be skipped",
    );
  }
});

test("serve --wait awaits slow saveState completion and HTTP response before shutting down", async (t) => {
  const { root, copilotHome } = createGitFixtureRepo(t);
  const env = { ...process.env, COPILOT_HOME: copilotHome };
  const savedDocs = [];
  const memoryDocs = new Map();

  const slowStoreFactory = (safeFile) => ({
    async load() {
      return memoryDocs.get(safeFile) ?? null;
    },
    async save(doc) {
      await new Promise((r) => setTimeout(r, 320));
      memoryDocs.set(safeFile, doc);
      savedDocs.push(doc);
    },
  });

  let readyUrl = "";
  let submitHttpResponse = null;
  const out = createCaptureStream();

  const waitPromise = runCli(
    ["serve", "--cwd", root, "--no-open", "--wait", "--json"],
    {
      env,
      storeFactory: slowStoreFactory,
      settleMs: 50,
      stdout: out.stream,
      onReady: ({ url }) => {
        readyUrl = url;
        void (async () => {
          await postPanelAction(url, "add_comment", {
            file: "src/service.ts",
            line: 2,
            side: "right",
            body: "Persist before exit",
          });
          submitHttpResponse = await postPanelAction(url, "submit_review", {
            notifyAgent: true,
          });
        })();
      },
    },
  );

  const result = await waitPromise;
  assert.ok(readyUrl);
  assert.equal(result.ok, true);
  assert.equal(result.submitted, true);
  assert.equal(result.status, "pending");
  assert.equal(result.commentCount, 1);
  assert.ok(submitHttpResponse, "POST /action submit_review response must complete before server closes");
  assert.equal(submitHttpResponse.status, 200);
  assert.equal(submitHttpResponse.body.ok, true);
  assert.equal(
    savedDocs.at(-1)?.status,
    "pending",
    "Durable pending state must finish saving before serve --wait resolves",
  );
});

test("CLI entry point emits structured JSON errors to stdout with --json and plain errors to stderr otherwise", async () => {
  const runSubprocess = (args) =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [CLI_SCRIPT_PATH, ...args], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      let stdoutText = "";
      let stderrText = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (c) => {
        stdoutText += c;
      });
      child.stderr.on("data", (c) => {
        stderrText += c;
      });
      child.on("error", reject);
      child.on("close", (code) => {
        resolve({ code, stdout: stdoutText, stderr: stderrText });
      });
    });

  const jsonErr = await runSubprocess(["list", "--no-open", "--json"]);
  assert.equal(jsonErr.code, 1);
  assert.equal(jsonErr.stderr, "");
  const parsedErr = JSON.parse(jsonErr.stdout.trim());
  assert.equal(parsedErr.ok, false);
  assert.match(parsedErr.error, /--no-open is only supported with 'serve'/);

  const plainErr = await runSubprocess(["review", "--wait"]);
  assert.equal(plainErr.code, 1);
  assert.equal(plainErr.stdout, "");
  assert.match(plainErr.stderr, /diff error: --wait is only supported with 'serve'/);

  // Pathspec "--json" after "--" must NOT trigger JSON mode
  const pathAfterDashErr = await runSubprocess(["list", "--no-open", "--", "--json"]);
  assert.equal(pathAfterDashErr.code, 1);
  assert.equal(pathAfterDashErr.stdout, "");
  assert.match(pathAfterDashErr.stderr, /diff error:/);
});


