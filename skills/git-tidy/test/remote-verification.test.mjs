import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import test from "node:test";

import { analyzeRepository, revalidateRepository } from "../scripts/triage.mjs";
import {
  GitBoundaryError,
  resolveExecutablePath,
  runBoundedProcess,
} from "../scripts/lib/git-process.mjs";
import {
  remoteVerificationFailureMessage,
  verifyRemoteBaseline,
} from "../scripts/lib/remote-verification.mjs";
import { validateMechanicalResult } from "../scripts/lib/result-schema.mjs";
import { createRepoFixture } from "./helpers/repo-fixture.mjs";
import { main as verifyRemoteMain } from "../scripts/verify-remote.mjs";

const approvedUrl = "https://github.com/owner/private.git";
const token = "fixture-only-not-a-real-token";
const authorization = `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
const gitPath = resolveExecutablePath("git");

function commandFailure(stderr) {
  return new GitBoundaryError("COMMAND_FAILED", "untrusted process error", {
    stderr: Buffer.from(stderr),
  });
}

function processResult(stdout = "", stderr = "") {
  return { exitCode: 0, stdout: Buffer.from(stdout), stderr: Buffer.from(stderr) };
}

function advertisement(oid, ref = "main") {
  return `ref: refs/heads/${ref}\tHEAD\n${oid}\tHEAD\n${oid}\trefs/heads/${ref}\n`;
}

function overrideEnvironment(t, values) {
  const previous = Object.fromEntries(
    Object.keys(values).map((key) => [key, process.env[key]]),
  );
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function mockRemote({ authError, authenticatedError, response, host, tokenOutput } = {}) {
  const calls = [];
  const runner = async (executable, args, options) => {
    calls.push({ executable, args, options: { ...options, env: { ...options.env } } });
    if (args[0] === "auth") {
      assert.deepEqual(args, ["auth", "token", "--hostname", host ?? "github.com", "--no-refresh"]);
      if (authError) throw authError;
      return processResult(tokenOutput ?? `${token}\r\n`);
    }
    if (args.includes("ls-remote")) {
      if (!options.env.GIT_CONFIG_VALUE_0) {
        throw commandFailure("fatal: could not read Username: terminal prompts disabled");
      }
      if (authenticatedError) throw authenticatedError;
      return processResult(response ?? advertisement("a".repeat(40)));
    }
    return processResult();
  };
  return { calls, runner, ghPath: process.execPath };
}

async function httpFixture(t, { anonymous = false, remoteUrl = approvedUrl } = {}) {
  const fixture = await createRepoFixture(`auth-http-${t.name.replace(/[^a-z0-9]/gu, "-")}`);
  const remoteRoot = await mkdtemp(path.join(tmpdir(), "git-tidy-auth-http-"));
  const remotePath = path.join(remoteRoot, "private.git");
  await fixture.write("tracked.txt", "initial\n");
  fixture.commit();
  fixture.git(["clone", "--quiet", "--bare", fixture.root, remotePath]);
  fixture.git(["remote", "add", "origin", remotePath]);
  fixture.git(["fetch", "--quiet", "origin", "+refs/heads/*:refs/remotes/origin/*"]);
  fixture.git(["remote", "set-head", "origin", "main"]);
  fixture.git(["remote", "set-url", "origin", remoteUrl]);

  const requests = [];
  const backendEnvironment = Object.fromEntries([
    "PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP",
  ].flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]]]));
  let redirect = null;
  const server = createServer(async (request, response) => {
    requests.push({ url: request.url, authorization: request.headers.authorization });
    if (!anonymous && request.headers.authorization !== authorization) {
      response.writeHead(401, { "WWW-Authenticate": 'Basic realm="fixture"' });
      response.end();
      return;
    }
    if (redirect) {
      response.writeHead(302, { Location: redirect });
      response.end();
      return;
    }
    try {
      const input = [];
      for await (const chunk of request) input.push(chunk);
      const url = new URL(request.url, "http://localhost");
      const result = await runBoundedProcess(gitPath, ["http-backend"], {
        cwd: remoteRoot,
        env: {
          ...backendEnvironment,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
          GIT_PROJECT_ROOT: remoteRoot,
          GIT_HTTP_EXPORT_ALL: "1",
          REQUEST_METHOD: request.method,
          PATH_INFO: url.pathname.replace(/^\/owner/u, ""),
          QUERY_STRING: url.search.slice(1),
          CONTENT_TYPE: request.headers["content-type"] ?? "",
          REMOTE_USER: anonymous ? "" : "fixture",
        },
        input: Buffer.concat(input),
      });
      const separator = result.stdout.indexOf("\r\n\r\n");
      assert.ok(separator >= 0);
      const headers = result.stdout.subarray(0, separator).toString("utf8");
      let status = 200;
      for (const header of headers.split("\r\n")) {
        const index = header.indexOf(":");
        const name = header.slice(0, index);
        const value = header.slice(index + 1).trim();
        if (name.toLowerCase() === "status") status = Number(value.split(" ")[0]);
        else response.setHeader(name, value);
      }
      response.writeHead(status);
      response.end(result.stdout.subarray(separator + 4));
    } catch (error) {
      response.writeHead(500);
      response.end(String(error));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const localUrl = `http://127.0.0.1:${server.address().port}/owner/private.git`;
  const calls = [];
  const roots = new Set();
  let authError = null;
  const runner = async (executable, args, options) => {
    calls.push({ executable, args, env: { ...options.env } });
    roots.add(options.cwd);
    if (args[0] === "auth") {
      if (authError) throw authError;
      return processResult(`${token}\n`);
    }
    assert.equal(options.env.GIT_CONFIG_GLOBAL, process.platform === "win32" ? "NUL" : "/dev/null");
    assert.equal(options.env.GIT_CONFIG_NOSYSTEM, "1");
    assert.equal(options.env.GIT_TERMINAL_PROMPT, "0");
    for (const key of ["GIT_ASKPASS", "GIT_EXEC_PATH", "GIT_TRACE", "GH_TOKEN"]) {
      assert.equal(options.env[key], undefined);
    }
    if (args.includes("fetch")) {
      for (const flag of [
        "--no-prune", "--no-tags", "--no-recurse-submodules", "--no-write-fetch-head",
      ]) assert.ok(args.includes(flag));
    }
    // Only the test transport is rewritten to loopback HTTP. Production accepts HTTPS.
    const env = { ...options.env };
    if (env.GIT_CONFIG_KEY_0) {
      assert.equal(env.GIT_CONFIG_KEY_0, `http.${remoteUrl}.extraHeader`);
      env.GIT_CONFIG_KEY_0 = `http.${localUrl}.extraHeader`;
    }
    const result = await runBoundedProcess(executable, [
      "-c", "protocol.http.allow=always",
      ...args.map((arg) => arg === remoteUrl ? localUrl : arg),
    ], { ...options, env });
    const repositoryIndex = args.indexOf("--git-dir");
    if (repositoryIndex >= 0) {
      const config = await readFile(path.join(args[repositoryIndex + 1], "config"), "utf8");
      assert.doesNotMatch(config, /Authorization|extraheader|fixture-only/iu);
    }
    return result;
  };
  t.after(async () => {
    await new Promise((resolve, reject) => server.close((error) =>
      error ? reject(error) : resolve()));
    await fixture.cleanup();
    await rm(remoteRoot, { recursive: true, force: true, maxRetries: 3 });
  });
  return {
    fixture, remotePath, requests, calls, roots, remoteUrl,
    options: { runner, ghPath: process.execPath, untrustedRoots: [fixture.root] },
    setRedirect: (url) => { redirect = url; },
    setAuthError: (error) => { authError = error; },
  };
}

test("private verification authenticates every acquisition read without persistence", async (t) => {
  const remote = await httpFixture(t);
  const before = await remote.fixture.snapshot();
  const baseline = await verifyRemoteBaseline(approvedUrl, remote.options);
  assert.equal(baseline.state, "verified", baseline.failureCode);
  assert.equal(baseline.defaultOid, remote.fixture.oid());
  assert.equal(baseline.remoteId, createHash("sha256").update(approvedUrl).digest("hex"));
  assert.equal(Date.parse(baseline.validUntil) - Date.parse(baseline.verifiedAt), 300_000);
  assert.deepEqual(remote.requests.map(({ authorization: header }) => header), [
    undefined, authorization, authorization, authorization, authorization,
  ]);
  assert.equal(remote.calls.filter(({ args }) => args[0] === "auth").length, 1);
  const networkCalls = remote.calls.filter(({ args }) =>
    args.includes("ls-remote") || args.includes("fetch"));
  for (const { args, env } of networkCalls) {
    assert.ok(args.includes("credential.helper="));
    assert.ok(args.includes("protocol.allow=never"));
    assert.ok(args.includes("http.followRedirects=false"));
    assert.doesNotMatch(JSON.stringify(args), /fixture-only|Authorization|Basic/u);
    if (env.GIT_CONFIG_COUNT) {
      assert.equal(env.GIT_CONFIG_COUNT, "1");
      assert.equal(env.GIT_CONFIG_VALUE_0, `Authorization: ${authorization}`);
    }
  }
  assert.doesNotMatch(JSON.stringify(baseline), /fixture-only|Authorization|Basic/u);
  for (const root of remote.roots) assert.equal(existsSync(root), false);
  assert.deepEqual(await remote.fixture.snapshot(), before);
});

test("public verification remains anonymous even without available credentials", async (t) => {
  const remote = await httpFixture(t, { anonymous: true });
  remote.setAuthError(commandFailure("credentials unavailable"));
  const baseline = await verifyRemoteBaseline(approvedUrl, remote.options);
  assert.equal(baseline.state, "verified", baseline.failureCode);
  assert.equal(remote.calls.some(({ args }) => args[0] === "auth"), false);
  assert.ok(remote.requests.every(({ authorization: header }) => header === undefined));
});

test("authenticated verification refuses redirects to another host", async (t) => {
  const remote = await httpFixture(t);
  let unapprovedRequests = 0;
  const unapproved = createServer((request, response) => {
    unapprovedRequests += 1;
    response.end();
  });
  await new Promise((resolve) => unapproved.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => unapproved.close(resolve)));
  remote.setRedirect(`http://localhost:${unapproved.address().port}/stolen`);
  const baseline = await verifyRemoteBaseline(approvedUrl, remote.options);
  assert.equal(baseline.state, "failed");
  assert.equal(unapprovedRequests, 0);
  assert.deepEqual(remote.requests.map(({ authorization: header }) => header), [
    undefined, authorization,
  ]);
});

test("credential lookup preserves Windows, explicit and XDG CLI configuration", async (t) => {
  overrideEnvironment(t, {
    GH_CONFIG_DIR: path.join(tmpdir(), "explicit-gh-config"),
    XDG_CONFIG_HOME: path.join(tmpdir(), "xdg-gh-config"),
    APPDATA: path.join(tmpdir(), "appdata"),
    LOCALAPPDATA: path.join(tmpdir(), "localappdata"),
    USERPROFILE: path.join(tmpdir(), "profile"),
    GH_HOST: "github.enterprise.example",
    GH_DEBUG: "api",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.extraHeader",
    GIT_CONFIG_VALUE_0: "hostile",
    GIT_ASKPASS: "hostile",
    GIT_EXEC_PATH: "hostile",
    GIT_TRACE: "1",
    GITHUB_ENTERPRISE_TOKEN: token,
  });
  const host = "github.enterprise.example";
  const mock = mockRemote({ host });
  const baseline = await verifyRemoteBaseline(`https://${host}/owner/private.git`, mock);
  assert.equal(baseline.state, "verified");
  const auth = mock.calls.find(({ args }) => args[0] === "auth");
  for (const key of ["GH_CONFIG_DIR", "XDG_CONFIG_HOME", "APPDATA", "LOCALAPPDATA", "USERPROFILE", "GITHUB_ENTERPRISE_TOKEN"]) {
    assert.equal(auth.options.env[key], process.env[key]);
  }
  assert.equal(auth.options.env.GH_PROMPT_DISABLED, "1");
  assert.equal(auth.options.env.GH_HOST, host);
  assert.equal(auth.options.env.GH_DEBUG, undefined);
  assert.equal(auth.options.env.GIT_CONFIG_COUNT, undefined);
  assert.equal(auth.options.env.GIT_ASKPASS, undefined);
  for (const call of mock.calls.filter(({ args }) => args[0] !== "auth")) {
    assert.equal(call.options.env.GITHUB_ENTERPRISE_TOKEN, undefined);
    assert.equal(call.options.env.GIT_EXEC_PATH, undefined);
    assert.equal(call.options.env.GIT_TRACE, undefined);
  }
});

test("existing gh sessions select only the approved host with explicit config", async (t) => {
  let ghPath;
  try {
    ghPath = resolveExecutablePath("gh");
  } catch {
    t.skip("GitHub CLI is not installed");
    return;
  }
  const root = await mkdtemp(path.join(tmpdir(), "git-tidy-gh-config-"));
  const config = path.join(root, "CLI config with spaces");
  await mkdir(config);
  const configContents = [
    "github.com:",
    `    oauth_token: ${token}`,
    "    user: fixture",
    "github.enterprise.example:",
    "    oauth_token: enterprise-fixture-token",
    "    user: fixture",
  ].join("\n");
  await writeFile(path.join(config, "hosts.yml"), configContents);
  overrideEnvironment(t, {
    GH_CONFIG_DIR: path.relative(process.cwd(), config),
    GH_TOKEN: undefined,
    GITHUB_TOKEN: undefined,
    GH_HOST: "another.enterprise.example",
    GH_ENTERPRISE_TOKEN: "unscoped-enterprise-fixture-token",
    GITHUB_ENTERPRISE_TOKEN: "unscoped-enterprise-fallback-token",
  });
  t.after(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });
  for (const [host, expectedToken] of [
    ["github.com", token],
    ["github.enterprise.example", "enterprise-fixture-token"],
    ["github.com.unapproved.example", null],
  ]) {
    let expectedHeader = null;
    let capturedToken = null;
    const baseline = await verifyRemoteBaseline(`https://${host}/owner/private.git`, {
      ghPath,
      runner: async (executable, args, options) => {
        if (args[0] === "auth") {
          assert.equal(options.env.GH_CONFIG_DIR, config);
          const result = await runBoundedProcess(executable, args, options);
          capturedToken = result.stdout.toString("utf8").trim();
          expectedHeader = `Authorization: Basic ${Buffer.from(`x-access-token:${capturedToken}`).toString("base64")}`;
          return result;
        }
        if (args.includes("ls-remote")) {
          if (!options.env.GIT_CONFIG_VALUE_0) {
            throw commandFailure("could not read Username: terminal prompts disabled");
          }
          assert.equal(options.env.GIT_CONFIG_VALUE_0, expectedHeader);
          return processResult(advertisement("a".repeat(40)));
        }
        return processResult();
      },
    });
    if (baseline.failureCode === "github-read-only-auth-unsupported") {
      assert.equal(capturedToken, null);
      t.diagnostic("Installed gh lacks --no-refresh; read-only compatibility failure verified.");
    } else {
      assert.equal(baseline.state, expectedToken ? "verified" : "failed", baseline.failureCode);
      assert.equal(capturedToken, expectedToken);
      if (!expectedToken) assert.equal(baseline.failureCode, "github-credentials-unavailable");
    }
  }
  assert.equal(await readFile(path.join(config, "hosts.yml"), "utf8"), configContents);
});

test("token lookup never retries a CLI that cannot disable credential refresh", async () => {
  const mock = mockRemote({
    authError: commandFailure("unknown flag: --no-refresh"),
  });
  const baseline = await verifyRemoteBaseline(approvedUrl, mock);
  assert.equal(baseline.failureCode, "github-read-only-auth-unsupported");
  assert.match(remoteVerificationFailureMessage(baseline.failureCode), /never retries without the flag/u);
  assert.equal(mock.calls.filter(({ args }) => args[0] === "auth").length, 1);
  assert.equal(mock.calls.some(({ args }) => args.includes("fetch")), false);
});

test("refreshable CLI credentials are read without contacting a refresh endpoint", async (t) => {
  let ghPath;
  try {
    ghPath = resolveExecutablePath("gh");
  } catch {
    t.skip("GitHub CLI is not installed");
    return;
  }
  const root = await mkdtemp(path.join(tmpdir(), "git-tidy-gh-refresh-"));
  const configContents = [
    "refresh.enterprise.example:",
    "    user: fixture",
    "    users:",
    "        fixture:",
    "            refreshable_oauth_token:",
    `                access_token: ${token}`,
    "                refresh_token: fixture-only-refresh-token",
    "                expires_at: 2000-01-01T00:00:00Z",
    "                refresh_token_expires_at: 2099-01-01T00:00:00Z",
  ].join("\n");
  await writeFile(path.join(root, "hosts.yml"), configContents);
  overrideEnvironment(t, {
    GH_CONFIG_DIR: root,
    GH_TOKEN: undefined,
    GITHUB_TOKEN: undefined,
    GH_ENTERPRISE_TOKEN: undefined,
    GITHUB_ENTERPRISE_TOKEN: undefined,
  });
  let refreshRequests = 0;
  const proxy = createServer((request, response) => {
    refreshRequests += 1;
    response.writeHead(502);
    response.end();
  });
  proxy.on("connect", (request, socket) => {
    refreshRequests += 1;
    socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise((resolve) => proxy.close(resolve));
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });
  const mock = mockRemote({ host: "refresh.enterprise.example" });
  let capturedToken = null;
  const baseline = await verifyRemoteBaseline(
    "https://refresh.enterprise.example/owner/private.git",
    {
      ghPath,
      runner: async (executable, args, options) => {
        if (args[0] !== "auth") return mock.runner(executable, args, options);
        const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
        const result = await runBoundedProcess(executable, args, {
          ...options,
          env: {
            ...options.env,
            HTTPS_PROXY: proxyUrl,
            HTTP_PROXY: proxyUrl,
            NO_PROXY: "",
            XDG_STATE_HOME: root,
          },
        });
        capturedToken = result.stdout.toString("utf8").trim();
        return result;
      },
    },
  );
  assert.equal(refreshRequests, 0);
  assert.equal(await readFile(path.join(root, "hosts.yml"), "utf8"), configContents);
  if (baseline.failureCode === "github-read-only-auth-unsupported") {
    assert.equal(capturedToken, null);
    t.diagnostic("Installed gh lacks --no-refresh; read-only compatibility failure verified.");
  } else {
    assert.equal(baseline.state, "verified", baseline.failureCode);
    assert.equal(capturedToken, token);
  }
});

test("unsafe URLs and changed approval identity fail before any process or credentials", async () => {
  for (const url of [
    "https://user:password@github.com/owner/repo",
    "https://github.com/owner/repo?token=secret",
    "https://github.com/owner/repo#fragment",
    "https://github.com\\@unapproved.example/owner/repo",
    "https://github.com/owner/%2e%2e/repo",
    "https://github.com/owner/../other/repo",
    "https://github.com./owner/repo",
    "https://github.com:444/owner/repo",
    "http://github.com/owner/repo",
    "ssh://git@github.com/owner/repo",
    "ext::untrusted",
    "unknown::untrusted",
    "--upload-pack=untrusted",
  ]) {
    const mock = mockRemote();
    const baseline = await verifyRemoteBaseline(url, mock);
    assert.equal(baseline.failureCode, "remote-url-unsafe", url);
    assert.equal(mock.calls.length, 0);
  }
  const mock = mockRemote();
  const baseline = await verifyRemoteBaseline("https://unapproved.example/owner/repo", {
    ...mock,
    expectedRemoteId: createHash("sha256").update(approvedUrl).digest("hex"),
  });
  assert.equal(baseline.failureCode, "remote-url-mismatch");
  assert.equal(mock.calls.length, 0);
});

test("authentication errors are actionable and never save raw credentials or diagnostics", async () => {
  for (const [failure, expected] of [
    [commandFailure(`stderr ${token} ${authorization}`), "github-credentials-unavailable"],
    [new GitBoundaryError("TIMEOUT", token), "github-auth-timeout"],
    [new GitBoundaryError("CANCELLED", token), "cancelled"],
    [new GitBoundaryError("OUTPUT_LIMIT", token), "github-credentials-unavailable"],
  ]) {
    const mock = mockRemote({ authError: failure });
    const baseline = await verifyRemoteBaseline(approvedUrl, mock);
    assert.equal(baseline.failureCode, expected);
    assert.doesNotMatch(JSON.stringify(baseline), /fixture-only|Basic/u);
    assert.ok(remoteVerificationFailureMessage(expected).length > 40);
    assert.equal(mock.calls.filter(({ args }) => args[0] === "auth").length, 1);
  }
  const unavailable = await verifyRemoteBaseline(approvedUrl, {
    ...mockRemote(), ghPath: path.join(tmpdir(), "missing-trusted-gh.exe"),
  });
  assert.equal(unavailable.failureCode, "github-cli-unavailable");
  const rejected = await verifyRemoteBaseline(approvedUrl, mockRemote({
    authenticatedError: commandFailure(`Authentication failed ${token} ${authorization}`),
  }));
  assert.equal(rejected.failureCode, "github-authentication-failed");
  assert.match(remoteVerificationFailureMessage(rejected.failureCode), /read permission.*SSO/u);
  const reflected = await verifyRemoteBaseline(approvedUrl, mockRemote({
    response: advertisement("a".repeat(40), token),
  }));
  assert.equal(reflected.failureCode, "remote-response-unsafe");
  assert.doesNotMatch(JSON.stringify(reflected), /fixture-only/u);
  for (const tokenOutput of ["", "token\ninjected-header", "token\rheader", "x".repeat(16_385)]) {
    const invalid = await verifyRemoteBaseline(approvedUrl, mockRemote({ tokenOutput }));
    assert.equal(invalid.failureCode, "github-credentials-invalid");
  }
});

test("CLI authentication diagnostics never print URL credentials", async () => {
  const output = [];
  const errors = [];
  const capture = (chunks) => new Writable({
    write(chunk, encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  await verifyRemoteMain({
    input: Readable.from([JSON.stringify({ remoteUrl: `https://user:${token}@github.com/owner/repo` })]),
    output: capture(output),
    errorOutput: capture(errors),
  });
  assert.equal(JSON.parse(Buffer.concat(output).toString()).failureCode, "remote-url-unsafe");
  assert.match(Buffer.concat(errors).toString(), /credential-free HTTPS/u);
  assert.doesNotMatch(Buffer.concat([...output, ...errors]).toString(), /fixture-only/u);
});

test("network failures do not trigger credential lookup", async () => {
  let authCalls = 0;
  const baseline = await verifyRemoteBaseline(approvedUrl, {
    ghPath: process.execPath,
    runner: async (executable, args) => {
      if (args[0] === "auth") authCalls += 1;
      if (args.includes("ls-remote")) throw commandFailure("Could not resolve host");
      return processResult();
    },
  });
  assert.equal(baseline.failureCode, "command-failed");
  assert.equal(authCalls, 0);
});

test("hostile repository and inherited Git configuration stay ignored", async (t) => {
  const remote = await httpFixture(t);
  const marker = path.join(remote.fixture.root, "hostile-executed");
  const hostile = `!echo hostile > "${marker}"`;
  for (const [key, value] of [
    ["credential.helper", hostile],
    ["core.hooksPath", remote.fixture.root],
    ["core.fsmonitor", hostile],
    ["remote.origin.uploadpack", hostile],
    ["protocol.https.allow", "never"],
    ["url.ext::hostile.insteadOf", "https://github.com/"],
    ["http.extraHeader", "Authorization: hostile"],
  ]) remote.fixture.git(["config", "--local", key, value]);
  const global = await remote.fixture.write("hostile.gitconfig", [
    "[credential]", `helper = ${hostile}`,
    "[protocol \"https\"]", "allow = never",
    "[url \"ext::hostile\"]", "insteadOf = https://github.com/",
  ].join("\n"));
  overrideEnvironment(t, {
    GIT_CONFIG_GLOBAL: global, GIT_CONFIG_SYSTEM: global,
    GIT_CONFIG: global, GIT_DIR: path.join(remote.fixture.root, ".git"),
    GIT_WORK_TREE: remote.fixture.root, GIT_EXEC_PATH: remote.fixture.root,
    GIT_ASKPASS: hostile, GIT_TRACE: "1",
  });
  const baseline = await verifyRemoteBaseline(approvedUrl, remote.options);
  assert.equal(baseline.state, "verified", baseline.failureCode);
  assert.equal(existsSync(marker), false);
});

test("authenticated revalidation preserves approvals drift freshness and last copies", async (t) => {
  const remote = await httpFixture(t);
  remote.fixture.git(["branch", "topic"]);
  const before = await remote.fixture.snapshot();
  const baseline = await verifyRemoteBaseline(approvedUrl, remote.options);
  assert.equal(baseline.state, "verified", baseline.failureCode);
  const analyzed = await analyzeRepository(remote.fixture.root, {
    executionMode: "verified", remoteBaseline: baseline, githubEnabled: false,
  });
  const topic = analyzed.workItems.flatMap(({ carriers }) => carriers).find(
    ({ displayName }) => displayName === "refs/heads/topic",
  );
  const options = {
    ...remote.options, remoteUrl: approvedUrl,
    approvalClass: "local-branch-deletion", githubEnabled: false,
  };
  const preview = await revalidateRepository(remote.fixture.root, analyzed, [topic.id], options);
  assert.ok(preview.actionPlan);
  assert.equal(preview.actionPlan.approvalRevalidated, false);
  const approvedPlan = {
    planId: preview.actionPlan.planId, approvalClass: preview.actionPlan.approvalClass,
  };
  const approved = await revalidateRepository(remote.fixture.root, analyzed, [topic.id], {
    ...options, approvedPlan,
  });
  assert.equal(approved.actionPlan.approvalRevalidated, true);
  assert.equal(approved.actionPlan.authorized, false);
  assert.equal(remote.calls.filter(({ args }) => args[0] === "auth").length, 3);
  const validation = validateMechanicalResult(analyzed);
  assert.equal(validation.valid, true, JSON.stringify(validation));
  const changedUrl = await revalidateRepository(remote.fixture.root, analyzed, [topic.id], {
    ...options, remoteUrl: "https://unapproved.example/owner/repo",
  });
  assert.equal(changedUrl.actionPlan, null);
  assert.match(JSON.stringify(changedUrl.drift), /previously approved remote identity/u);
  assert.equal(remote.calls.filter(({ args }) => args[0] === "auth").length, 3);

  remote.setAuthError(commandFailure(`unavailable ${token}`));
  const missing = await revalidateRepository(remote.fixture.root, analyzed, [topic.id], options);
  assert.equal(missing.actionPlan, null);
  assert.match(JSON.stringify(missing.drift), /gh auth status.*GH_CONFIG_DIR/u);
  assert.doesNotMatch(JSON.stringify(missing), /fixture-only/u);
  remote.setAuthError(null);
  const lastCopy = await revalidateRepository(remote.fixture.root, analyzed, [
    topic.id, analyzed.workItems.flatMap(({ carriers }) => carriers).find(
      ({ displayName }) => displayName === "refs/heads/main",
    ).id,
  ], options);
  assert.equal(lastCopy.actionPlan, null);
  assert.ok(lastCopy.drift.some(({ code }) => code === "last-copy-drift" || code === "carrier-ineligible"));
  const approvalDrift = await revalidateRepository(remote.fixture.root, analyzed, [topic.id], {
    ...options, approvedPlan: { ...approvedPlan, planId: "0".repeat(64) },
  });
  assert.equal(approvalDrift.actionPlan, null);
  assert.ok(approvalDrift.drift.some(({ code }) => code === "approval-plan-drift"));
  const callsBeforeStale = remote.calls.length;
  const stale = await revalidateRepository(remote.fixture.root, analyzed, [topic.id], {
    ...options, now: new Date(Date.parse(baseline.validUntil) + 1),
  });
  assert.equal(stale.actionPlan, null);
  assert.equal(remote.calls.length, callsBeforeStale);
  assert.ok(stale.drift.some(({ code }) => code === "remote-baseline-not-fresh"));
  assert.deepEqual(await remote.fixture.snapshot(), before);

  await remote.fixture.write("tracked.txt", "remote advanced\n");
  remote.fixture.commit();
  remote.fixture.git(["--git-dir", remote.remotePath, "fetch", "--quiet", remote.fixture.root, "main:refs/heads/main"]);
  const oidDrift = await revalidateRepository(remote.fixture.root, analyzed, [topic.id], options);
  assert.equal(oidDrift.actionPlan, null);
  assert.ok(oidDrift.drift.some(({ code }) => code === "remote-baseline-drift"));
});
