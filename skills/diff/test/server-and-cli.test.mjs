import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import test from "node:test";
import { runCli, sanitizeTerminalText } from "../scripts/diff.mjs";
import { openUrlInBrowser, startDiffReviewServer } from "../scripts/server.mjs";

function makeTempDir(prefix) {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function httpRequest({ port, method = "GET", reqPath = "/", headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        method,
        path: reqPath,
        headers,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    req.on("error", reject);
    if (body !== null) req.write(body);
    req.end();
  });
}

function captureIo() {
  let out = "";
  let err = "";
  const stdout = new Writable({
    write(chunk, _enc, cb) {
      out += chunk.toString();
      cb();
    },
  });
  const stderr = new Writable({
    write(chunk, _enc, cb) {
      err += chunk.toString();
      cb();
    },
  });
  return {
    stdout,
    stderr,
    getStdout: () => out,
    getStderr: () => err,
  };
}

test("server enforces loopback binding, Host validation, cookie bootstrap, CSRF headers, and body cap", async (t) => {
  const reviewsRoot = makeTempDir("diff-server-sec-");
  t.after(() => fs.rmSync(reviewsRoot, { recursive: true, force: true }));

  const srv = await startDiffReviewServer({
    diff: "diff --git a/src/app.js b/src/app.js\n--- a/src/app.js\n+++ b/src/app.js\n@@ -1 +1 @@\n-old\n+new\n",
    title: "sec-test",
    stats: { additions: 1, deletions: 1, fileCount: 1 },
    reviewId: "112233445566",
    repoSlug: "example-org__sec",
    branchSlug: "feat_sec",
    branch: "feat/sec",
    diffSpec: "default",
    baseSha: "aaaa",
    headSha: "bbbb",
    reviewsRoot,
  });
  t.after(async () => {
    await srv.close("test-cleanup");
  });

  // 1. DNS-rebinding Host header rejection
  const badHost = await httpRequest({
    port: srv.port,
    reqPath: "/",
    headers: { Host: `attacker.example:${srv.port}` },
  });
  assert.equal(badHost.statusCode, 403);

  // 2. Unauthenticated GET / rejected without session cookie
  const noCookie = await httpRequest({ port: srv.port, reqPath: "/" });
  assert.equal(noCookie.statusCode, 403);

  // 3. Invalid capability bootstrap token rejected
  const badBootstrap = await httpRequest({
    port: srv.port,
    reqPath: `/s/${"0".repeat(64)}`,
  });
  assert.equal(badBootstrap.statusCode, 403);

  // 4. Valid bootstrap sets HttpOnly; SameSite=Strict cookie and redirects to /
  const bootstrapPath = new URL(srv.bootstrapUrl).pathname;
  const goodBootstrap = await httpRequest({
    port: srv.port,
    reqPath: bootstrapPath,
  });
  assert.equal(goodBootstrap.statusCode, 302);
  assert.equal(goodBootstrap.headers.location, "/");
  const setCookie = goodBootstrap.headers["set-cookie"]?.[0] ?? "";
  assert.match(setCookie, new RegExp(`^diff_session_${srv.port}=`));
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  const cookieHeader = setCookie.split(";")[0];

  // 4b. Bootstrap token is strictly single-use
  const replayBootstrap = await httpRequest({
    port: srv.port,
    reqPath: bootstrapPath,
  });
  assert.equal(replayBootstrap.statusCode, 403);

  // 5. Authenticated GET / serves HTML and embeds per-session CSRF token
  const pageRes = await httpRequest({
    port: srv.port,
    reqPath: "/",
    headers: { Cookie: cookieHeader },
  });
  assert.equal(pageRes.statusCode, 200);
  assert.equal(pageRes.headers["x-content-type-options"], "nosniff");
  assert.match(pageRes.headers["cache-control"], /no-store/);
  const csrfMatch = pageRes.body.match(/var CSRF_TOKEN = "([a-f0-9]{64})"/);
  assert.ok(csrfMatch, "expected CSRF_TOKEN in rendered HTML");
  const csrfToken = csrfMatch[1];

  // 5b. GET /api/comments requires X-Diff-Token and blocks cross-port Sec-Fetch-Site
  const unauthCommentsGet = await httpRequest({
    port: srv.port,
    reqPath: "/api/comments",
    headers: { Cookie: cookieHeader },
  });
  assert.equal(unauthCommentsGet.statusCode, 403);

  const sameSitePortGet = await httpRequest({
    port: srv.port,
    reqPath: "/api/comments",
    headers: {
      Cookie: cookieHeader,
      "X-Diff-Token": csrfToken,
      "Sec-Fetch-Site": "same-site",
    },
  });
  assert.equal(sameSitePortGet.statusCode, 403);

  const validCommentsGet = await httpRequest({
    port: srv.port,
    reqPath: "/api/comments",
    headers: {
      Cookie: cookieHeader,
      "X-Diff-Token": csrfToken,
      "Sec-Fetch-Site": "same-origin",
    },
  });
  assert.equal(validCommentsGet.statusCode, 200);

  // 6. Cross-origin POST rejected even with valid cookie and CSRF token
  const crossOrigin = await httpRequest({
    port: srv.port,
    method: "POST",
    reqPath: "/api/comments",
    headers: {
      Cookie: cookieHeader,
      Origin: "https://evil.example",
      "Content-Type": "application/json",
      "X-Diff-Token": csrfToken,
    },
    body: JSON.stringify({ id: "comment-0001", file: "src/app.js", line: "1", side: "right", body: "hi" }),
  });
  assert.equal(crossOrigin.statusCode, 403);

  // 7. Sec-Fetch-Site: cross-site rejected even without Origin
  const crossFetchSite = await httpRequest({
    port: srv.port,
    method: "POST",
    reqPath: "/api/comments",
    headers: {
      Cookie: cookieHeader,
      "Sec-Fetch-Site": "cross-site",
      "Content-Type": "application/json",
      "X-Diff-Token": csrfToken,
    },
    body: JSON.stringify({ id: "comment-0001", file: "src/app.js", line: "1", side: "right", body: "hi" }),
  });
  assert.equal(crossFetchSite.statusCode, 403);

  // 8. Missing X-Diff-Token rejected (blocks plain HTML form CSRF)
  const missingToken = await httpRequest({
    port: srv.port,
    method: "POST",
    reqPath: "/api/comments",
    headers: {
      Cookie: cookieHeader,
      Origin: srv.originUrl,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ id: "comment-0001", file: "src/app.js", line: "1", side: "right", body: "hi" }),
  });
  assert.equal(missingToken.statusCode, 403);

  // 9. Oversized payload (> 64 KiB) rejected with 413
  const hugeBody = JSON.stringify({
    id: "comment-0001",
    file: "src/app.js",
    line: "1",
    side: "right",
    body: "x".repeat(70_000),
  });
  const tooLarge = await httpRequest({
    port: srv.port,
    method: "POST",
    reqPath: "/api/comments",
    headers: {
      Cookie: cookieHeader,
      Origin: srv.originUrl,
      "Content-Type": "application/json",
      "X-Diff-Token": csrfToken,
    },
    body: hugeBody,
  });
  assert.equal(tooLarge.statusCode, 413);

  // 10. Legitimate add, delete, re-add, and Submit Review (/api/done) lifecycle
  const addTemp = await httpRequest({
    port: srv.port,
    method: "POST",
    reqPath: "/api/comments",
    headers: {
      Cookie: cookieHeader,
      Origin: srv.originUrl,
      "Content-Type": "application/json",
      "X-Diff-Token": csrfToken,
    },
    body: JSON.stringify({
      id: "comment-temp01",
      file: "src/app.js",
      line: "1",
      side: "right",
      body: "Temporary note.",
    }),
  });
  assert.equal(addTemp.statusCode, 201);

  const delTemp = await httpRequest({
    port: srv.port,
    method: "DELETE",
    reqPath: "/api/comments/comment-temp01",
    headers: {
      Cookie: cookieHeader,
      Origin: srv.originUrl,
      "X-Diff-Token": csrfToken,
    },
  });
  assert.equal(delTemp.statusCode, 200);
  assert.equal(JSON.parse(delTemp.body).length, 0);

  const addRes = await httpRequest({
    port: srv.port,
    method: "POST",
    reqPath: "/api/comments",
    headers: {
      Cookie: cookieHeader,
      Origin: srv.originUrl,
      "Content-Type": "application/json",
      "X-Diff-Token": csrfToken,
    },
    body: JSON.stringify({
      id: "comment-final1",
      file: "src/app.js",
      line: "1",
      side: "right",
      body: "Check null input.",
    }),
  });
  assert.equal(addRes.statusCode, 201);

  const closeRes = await httpRequest({
    port: srv.port,
    method: "POST",
    reqPath: "/api/done",
    headers: {
      Cookie: cookieHeader,
      Origin: srv.originUrl,
      "Content-Type": "application/json",
      "X-Diff-Token": csrfToken,
    },
    body: "{}",
  });
  assert.equal(closeRes.statusCode, 200);
  const closeResult = await srv.waitForClose;
  assert.equal(closeResult.reason, "submitted");

  const persisted = JSON.parse(fs.readFileSync(srv.reviewFilePath, "utf8"));
  assert.equal(persisted.status, "pending");
  assert.equal(persisted.comments.length, 1);
  assert.equal(persisted.comments[0].body, "Check null input.");
});

test("openUrlInBrowser uses shell:false and rejects non-loopback URLs", async () => {
  assert.throws(
    () => openUrlInBrowser("https://evil.example/payload"),
    /Refusing to launch browser for non-loopback/,
  );

  let captured = null;
  const fakeSpawn = (cmd, args, opts) => {
    captured = { cmd, args, opts };
    return {
      on() {},
      unref() {},
    };
  };

  const launchUrl = `http://127.0.0.1:4321/s/${"a".repeat(64)}`;
  const winRes = await openUrlInBrowser(launchUrl, fakeSpawn);
  assert.equal(winRes.opened, true);
  assert.equal(captured.opts.shell, false);
  assert.ok(path.isAbsolute(captured.cmd));
  assert.ok(path.isAbsolute(captured.opts.cwd));
  assert.ok(captured.args.includes(launchUrl));
});

test("CLI end-to-end: static snapshot, review resolve, review list, and review address", async (t) => {
  const repoDir = makeTempDir("diff-cli-e2e-repo-");
  const reviewsDir = makeTempDir("diff-cli-e2e-reviews-");
  const prevReviewsDir = process.env.DIFF_REVIEWS_DIR;
  process.env.DIFF_REVIEWS_DIR = reviewsDir;

  t.after(() => {
    if (prevReviewsDir === undefined) delete process.env.DIFF_REVIEWS_DIR;
    else process.env.DIFF_REVIEWS_DIR = prevReviewsDir;
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(reviewsDir, { recursive: true, force: true });
  });

  const git = (...args) =>
    execFileSync("git", args, { cwd: repoDir, encoding: "utf8", windowsHide: true });
  git("init", "-b", "main");
  git("config", "user.name", "Test Bot");
  git("config", "user.email", "test@example.invalid");
  git("remote", "add", "origin", "https://github.com/example-org/cli-demo.git");

  fs.writeFileSync(path.join(repoDir, "index.js"), "export const v = 1;\n", "utf8");
  git("add", "index.js");
  git("commit", "-m", "init");

  git("checkout", "-b", "feat/v2");
  fs.writeFileSync(path.join(repoDir, "index.js"), "export const v = 2;\nexport const extra = true;\n", "utf8");

  // 1. Static render via CLI
  const staticIo = captureIo();
  const staticCode = await runCli(["open", "--static", "--json", "--cwd", repoDir], staticIo);
  assert.equal(staticCode, 0);
  const staticJson = JSON.parse(staticIo.getStdout());
  assert.equal(staticJson.status, "static");
  assert.ok(fs.existsSync(staticJson.htmlFile));

  // 2. Serve via CLI (--no-open --json), submit 1 comment over HTTP, and verify CLI exits cleanly
  const serveIo = captureIo();
  const cliPromise = runCli(["open", "--no-open", "--json", "--cwd", repoDir], serveIo);

  // Poll until JSON bootstrap output is written
  const deadline = Date.now() + 5000;
  while (!serveIo.getStdout().trim() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
  }
  const serveInfo = JSON.parse(serveIo.getStdout());
  assert.equal(serveInfo.status, "serving");
  assert.equal(serveInfo.reviewId, staticJson.reviewId);

  const parsedUrl = new URL(serveInfo.url);
  const boot = await httpRequest({ port: Number(parsedUrl.port), reqPath: parsedUrl.pathname });
  const cookie = boot.headers["set-cookie"][0].split(";")[0];
  const page = await httpRequest({
    port: Number(parsedUrl.port),
    reqPath: "/",
    headers: { Cookie: cookie },
  });
  const csrf = page.body.match(/var CSRF_TOKEN = "([a-f0-9]{64})"/)[1];

  await httpRequest({
    port: Number(parsedUrl.port),
    method: "POST",
    reqPath: "/api/comments",
    headers: {
      Cookie: cookie,
      Origin: serveInfo.originUrl,
      "Content-Type": "application/json",
      "X-Diff-Token": csrf,
    },
    body: JSON.stringify({
      id: "comment-cli001",
      file: "index.js",
      line: "2",
      side: "right",
      body: "Verify export naming.",
    }),
  });
  await httpRequest({
    port: Number(parsedUrl.port),
    method: "POST",
    reqPath: "/api/done",
    headers: {
      Cookie: cookie,
      Origin: serveInfo.originUrl,
      "Content-Type": "application/json",
      "X-Diff-Token": csrf,
    },
    body: "{}",
  });

  const serveExitCode = await cliPromise;
  assert.equal(serveExitCode, 0);

  // 3. `review resolve` deterministically matches the current diff!
  const resolveIo = captureIo();
  assert.equal(await runCli(["review", "resolve", "--json", "--cwd", repoDir], resolveIo), 0);
  const resolved = JSON.parse(resolveIo.getStdout());
  assert.equal(resolved.status, "ok");
  assert.equal(resolved.reviewId, serveInfo.reviewId);
  assert.equal(resolved.comments.length, 1);
  assert.equal(resolved.comments[0].stale, false);

  // 4. `review list` returns pending review
  const listIo = captureIo();
  assert.equal(await runCli(["review", "list", "--json", "--cwd", repoDir], listIo), 0);
  const listed = JSON.parse(listIo.getStdout());
  assert.equal(listed.count, 1);

  // 5. `review address` transitions status to addressed
  const addrIo = captureIo();
  assert.equal(
    await runCli(["review", "address", serveInfo.reviewId.slice(0, 6), "--json", "--cwd", repoDir], addrIo),
    0,
  );
  const addressed = JSON.parse(addrIo.getStdout());
  assert.equal(addressed.status, "addressed");

  // Pending list is now empty, while --all has 1 addressed entry
  const listAfterIo = captureIo();
  await runCli(["review", "list", "--json", "--cwd", repoDir], listAfterIo);
  assert.equal(JSON.parse(listAfterIo.getStdout()).count, 0);

  const listAllIo = captureIo();
  await runCli(["review", "list", "--all", "--json", "--cwd", repoDir], listAllIo);
  assert.equal(JSON.parse(listAllIo.getStdout()).count, 1);
});

test("re-opening a review preserves saved comments and sanitizeTerminalText strips escape codes", async (t) => {
  const reviewsRoot = makeTempDir("diff-reopen-sec-");
  t.after(() => fs.rmSync(reviewsRoot, { recursive: true, force: true }));

  const commonOpts = {
    diff: "diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1 +1 @@\n-old\n+new\n",
    title: "reopen-test",
    stats: { additions: 1, deletions: 1, fileCount: 1, files: [{ canonicalPath: "a.js" }] },
    reviewId: "abcdef012345",
    repoSlug: "example-org__reopen",
    branchSlug: "feat_reopen",
    branch: "feat/reopen",
    diffSpec: "default",
    baseSha: "1111",
    headSha: "2222",
    reviewsRoot,
  };

  const firstSrv = await startDiffReviewServer(commonOpts);
  const boot1 = await httpRequest({ port: firstSrv.port, reqPath: new URL(firstSrv.bootstrapUrl).pathname });
  const cookie1 = boot1.headers["set-cookie"][0].split(";")[0];
  const page1 = await httpRequest({ port: firstSrv.port, reqPath: "/", headers: { Cookie: cookie1 } });
  const csrf1 = page1.body.match(/var CSRF_TOKEN = "([a-f0-9]{64})"/)[1];

  const savedRes = await httpRequest({
    port: firstSrv.port,
    method: "POST",
    reqPath: "/api/comments",
    headers: {
      Cookie: cookie1,
      Origin: firstSrv.originUrl,
      "Content-Type": "application/json",
      "X-Diff-Token": csrf1,
    },
    body: JSON.stringify({ id: "comment-keep01", file: "a.js", line: "1", side: "right", body: "Retained note" }),
  });
  assert.equal(savedRes.statusCode, 201);
  await firstSrv.close("manual-stop");

  const secondSrv = await startDiffReviewServer(commonOpts);
  t.after(async () => {
    await secondSrv.close("cleanup");
  });
  assert.equal(secondSrv.getReview().comments.length, 1);
  assert.equal(secondSrv.getReview().comments[0].body, "Retained note");

  assert.equal(
    sanitizeTerminalText("feat/\u001b[31mred\u001b]52;c;ZXY=\u0007\r\nnext"),
    "feat/red next",
  );
});
