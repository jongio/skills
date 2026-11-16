import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { resolveTrustedExecutable } from "./diff-spec.mjs";
import { renderDiffHtml } from "./render-html.mjs";
import {
  MAX_COMMENTS_PER_REVIEW,
  getReviewFilePath,
  readReviewFile,
  resolveReviewsRoot,
  saveReviewRecord,
  validateCommentInput,
} from "./review-store.mjs";

export const MAX_REQUEST_BODY_BYTES = 64 * 1024;
export const MAX_URL_LENGTH = 2048;
export const MAX_BOOTSTRAP_HITS = 8;
export const DEFAULT_BOOT_TIMEOUT_MS = 10 * 60 * 1000;
export const DEFAULT_HEARTBEAT_TIMEOUT_MS = 90 * 1000;
export const DEFAULT_MAX_LIFETIME_MS = 30 * 60 * 1000;

const BOOTSTRAP_PATH_RE = /^\/s\/([a-f0-9]{64})$/;
const BOOTSTRAP_URL_RE = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/s\/[a-f0-9]{64}$/;
const COMMENT_ID_PATH_RE = /^\/api\/comments\/([A-Za-z0-9-]{8,64})$/;
const SESSION_COOKIE_PREFIX = "diff_session_";

function constantTimeEquals(expected, actual) {
  if (typeof expected !== "string" || typeof actual !== "string") return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(actual, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function getCookieCandidates(cookieHeader, targetName) {
  const values = [];
  if (typeof cookieHeader !== "string" || !cookieHeader || !targetName) return values;
  const parts = cookieHeader.split(";");
  const limit = Math.min(parts.length, 32);
  for (let i = 0; i < limit; i += 1) {
    const part = parts[i];
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    if (name === targetName) {
      values.push(part.slice(eq + 1).trim());
    }
  }
  return values;
}

function baseSecurityHeaders(cspValue) {
  return {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Content-Security-Policy": cspValue ?? "default-src 'none'; frame-ancestors 'none'",
  };
}

function sendJson(res, statusCode, data, extraHeaders = {}) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    ...baseSecurityHeaders(),
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body, "utf8"),
    ...extraHeaders,
  });
  res.end(body);
}

function sendText(res, statusCode, message, extraHeaders = {}) {
  const body = String(message);
  res.writeHead(statusCode, {
    ...baseSecurityHeaders(),
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(body, "utf8"),
    ...extraHeaders,
  });
  res.end(body);
}

function readBoundedJsonBody(req, maxBytes = MAX_REQUEST_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const contentType = String(req.headers["content-type"] ?? "").toLowerCase();
    if (!contentType.startsWith("application/json")) {
      const err = new Error("Content-Type must be application/json");
      err.statusCode = 415;
      reject(err);
      return;
    }

    const chunks = [];
    let total = 0;
    let settled = false;

    req.on("data", (chunk) => {
      if (settled) return;
      total += chunk.length;
      if (total > maxBytes) {
        settled = true;
        req.pause();
        const err = new Error(`Request body exceeds ${maxBytes} bytes`);
        err.statusCode = 413;
        err.closeConnection = true;
        reject(err);
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      if (settled) return;
      settled = true;
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          const err = new Error("JSON payload must be an object");
          err.statusCode = 400;
          reject(err);
          return;
        }
        resolve(parsed);
      } catch {
        const err = new Error("Malformed JSON request body");
        err.statusCode = 400;
        reject(err);
      }
    });

    req.on("error", (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

function resolveBrowserCommand(options = {}) {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const untrustedRoots = options.untrustedRoots ?? [process.cwd()];

  if (platform === "win32") {
    const systemRoot = env.SystemRoot || env.WINDIR || "C:\\Windows";
    if (!path.win32.isAbsolute(systemRoot)) {
      throw new Error("SystemRoot must be an absolute path");
    }
    const system32Dir = fs.realpathSync.native(path.win32.join(systemRoot, "System32"));
    if (!fs.statSync(system32Dir).isDirectory()) {
      throw new Error("Windows System32 directory is unavailable");
    }
    const rundll32Path = resolveTrustedExecutable(path.win32.join(system32Dir, "rundll32.exe"), {
      env,
      platform,
      untrustedRoots,
    });
    const urlDllPath = fs.realpathSync.native(path.win32.join(system32Dir, "url.dll"));
    if (!fs.statSync(urlDllPath).isFile()) {
      throw new Error("Windows url.dll handler is unavailable");
    }
    return {
      command: rundll32Path,
      buildArgs: (targetUrl) => [`${urlDllPath},FileProtocolHandler`, targetUrl],
      cwd: system32Dir,
    };
  }

  const safeCwd = os.homedir() || os.tmpdir();
  if (platform === "darwin") {
    const openPath = resolveTrustedExecutable("/usr/bin/open", {
      env,
      platform,
      untrustedRoots,
    });
    return {
      command: openPath,
      buildArgs: (targetUrl) => [targetUrl],
      cwd: safeCwd,
    };
  }

  const xdgOpenPath = resolveTrustedExecutable("xdg-open", {
    env,
    platform,
    untrustedRoots,
  });
  return {
    command: xdgOpenPath,
    buildArgs: (targetUrl) => [targetUrl],
    cwd: safeCwd,
  };
}

export function openUrlInBrowser(url, spawnFn = spawn, options = {}) {
  if (typeof url !== "string" || !BOOTSTRAP_URL_RE.test(url)) {
    throw new Error("Refusing to launch browser for non-loopback bootstrap URL");
  }
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1") {
    throw new Error("Browser launch URL must target http://127.0.0.1");
  }
  const portNum = Number.parseInt(parsed.port, 10);
  if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
    throw new Error("Invalid loopback port in browser launch URL");
  }

  let resolvedLauncher;
  try {
    resolvedLauncher = resolveBrowserCommand(options);
  } catch (err) {
    return Promise.resolve({ opened: false, error: err.message });
  }
  const command = resolvedLauncher.command;
  const args = resolvedLauncher.buildArgs(url);

  return new Promise((resolve) => {
    let settled = false;
    try {
      const child = spawnFn(command, args, {
        cwd: resolvedLauncher.cwd,
        detached: true,
        stdio: "ignore",
        shell: false,
        windowsHide: true,
        env: {
          ...process.env,
          NoDefaultCurrentDirectoryInExePath: "1",
        },
      });
      child.on("error", (err) => {
        if (!settled) {
          settled = true;
          resolve({ opened: false, error: err.message });
        }
      });
      child.unref();
      setImmediate(() => {
        if (!settled) {
          settled = true;
          resolve({ opened: true, error: null });
        }
      });
    } catch (err) {
      resolve({ opened: false, error: err.message });
    }
  });
}

export async function startDiffReviewServer({
  diff,
  title,
  stats,
  reviewId,
  repoSlug,
  branchSlug,
  branch,
  diffSpec,
  baseSha,
  headSha,
  reviewsRoot,
  bootTimeoutMs = DEFAULT_BOOT_TIMEOUT_MS,
  heartbeatTimeoutMs = DEFAULT_HEARTBEAT_TIMEOUT_MS,
  maxLifetimeMs = DEFAULT_MAX_LIFETIME_MS,
  doneShutdownDelayMs = 250,
  onDone,
} = {}) {
  const rootDir = resolveReviewsRoot(reviewsRoot);
  const bootstrapToken = randomBytes(32).toString("hex");
  const sessionSecret = randomBytes(32).toString("hex");
  const csrfToken = randomBytes(32).toString("hex");

  const canonicalFiles = Array.isArray(stats?.files)
    ? stats.files.map((f) => String(f.canonicalPath ?? ""))
    : undefined;

  const review = {
    version: 1,
    reviewId,
    repoSlug,
    branchSlug,
    diffSpec,
    branch,
    baseSha,
    headSha,
    createdAt: new Date().toISOString(),
    closedAt: null,
    addressedAt: null,
    status: "draft",
    comments: [],
  };

  let reviewFilePath = getReviewFilePath({
    reviewsRoot: rootDir,
    repoSlug,
    branchSlug,
    reviewId,
  });

  // Preserve existing comments if re-opening an existing review for the exact same reviewId
  try {
    const existing = readReviewFile(rootDir, reviewFilePath);
    if (existing && Array.isArray(existing.comments) && existing.comments.length > 0) {
      review.comments = existing.comments;
      review.createdAt = existing.createdAt;
    }
  } catch {
    // Proceed with clean draft if existing file is absent or unreadable
  }

  const initialSave = saveReviewRecord(rootDir, review);
  reviewFilePath = initialSave.filePath;

  let persistError = null;
  const persistReview = () => {
    try {
      const saved = saveReviewRecord(rootDir, review);
      reviewFilePath = saved.filePath;
      persistError = null;
      return true;
    } catch (err) {
      persistError = err.message;
      return false;
    }
  };

  let mutationQueue = Promise.resolve();
  function runExclusiveMutation(task) {
    const next = mutationQueue.then(task, task);
    mutationQueue = next.then(() => undefined, () => undefined);
    return next;
  }

  let boundPort = 0;
  let sessionCookieName = "";
  let bootstrapHits = 0;
  let sessionActivated = false;
  let closed = false;
  let bootTimer = null;
  let heartbeatTimer = null;
  let lifetimeTimer = null;
  const sockets = new Set();

  let resolveClosed;
  const waitForClose = new Promise((resolve) => {
    resolveClosed = resolve;
  });

  function clearTimers() {
    if (bootTimer) { clearTimeout(bootTimer); bootTimer = null; }
    if (heartbeatTimer) { clearTimeout(heartbeatTimer); heartbeatTimer = null; }
    if (lifetimeTimer) { clearTimeout(lifetimeTimer); lifetimeTimer = null; }
  }

  function resetHeartbeatTimer() {
    if (closed || !sessionActivated) return;
    if (heartbeatTimer) clearTimeout(heartbeatTimer);
    heartbeatTimer = setTimeout(() => {
      void shutdown("heartbeat-timeout");
    }, heartbeatTimeoutMs);
    heartbeatTimer.unref?.();
  }

  async function shutdown(reason = "manual") {
    if (closed) return;
    closed = true;
    clearTimers();
    for (const sock of sockets) {
      try { sock.destroy(); } catch {}
    }
    sockets.clear();
    await new Promise((resolve) => {
      server.close(() => resolve());
    });
    resolveClosed({ reason, review, reviewFilePath, persistError });
  }

  function isAuthorizedMutation(req) {
    if (!sessionActivated) return false;
    const expectedOrigin = `http://127.0.0.1:${boundPort}`;
    const headerToken = req.headers["x-diff-token"];
    const tokenValue = Array.isArray(headerToken) ? headerToken[0] : headerToken;
    if (!constantTimeEquals(csrfToken, tokenValue)) return false;

    return req.headers.origin === expectedOrigin;
  }

  function isAuthorizedApiRead(req) {
    if (!sessionActivated) return false;
    const expectedOrigin = `http://127.0.0.1:${boundPort}`;
    const headerToken = req.headers["x-diff-token"];
    const tokenValue = Array.isArray(headerToken) ? headerToken[0] : headerToken;
    if (!constantTimeEquals(csrfToken, tokenValue)) return false;

    const originHeader = req.headers.origin;
    if (originHeader !== undefined && originHeader !== expectedOrigin) {
      return false;
    }
    return true;
  }

  function hasValidSessionCookie(req) {
    const candidates = getCookieCandidates(req.headers.cookie, sessionCookieName);
    return candidates.some((candidate) => constantTimeEquals(sessionSecret, candidate));
  }

  function sendViewerHtml(res, extraHeaders = {}) {
    const rendered = renderDiffHtml({
      diff,
      title,
      additions: stats?.additions,
      deletions: stats?.deletions,
      fileCount: stats?.fileCount,
      canonicalFiles,
      serveMode: true,
      csrfToken,
    });
    const bodyBytes = Buffer.from(rendered.html, "utf8");
    res.writeHead(200, {
      ...baseSecurityHeaders(rendered.headerCsp),
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": bodyBytes.length,
      ...extraHeaders,
    });
    res.end(bodyBytes);
  }

  const server = http.createServer(async (req, res) => {
    try {
      const expectedHost = `127.0.0.1:${boundPort}`;
      if (req.headers.host !== expectedHost) {
        sendText(res, 403, "Forbidden: invalid Host header");
        return;
      }

      const rawUrl = req.url ?? "/";
      if (rawUrl.length > MAX_URL_LENGTH) {
        sendText(res, 414, "URI Too Long");
        return;
      }

      const reqUrl = new URL(rawUrl, `http://${expectedHost}`);
      const pathname = reqUrl.pathname;
      const method = req.method ?? "GET";

      const bootMatch = pathname.match(BOOTSTRAP_PATH_RE);
      if (bootMatch && method === "GET") {
        if (
          bootstrapHits >= MAX_BOOTSTRAP_HITS ||
          reqUrl.search !== "" ||
          !constantTimeEquals(bootstrapToken, bootMatch[1])
        ) {
          sendText(res, 403, "Forbidden: invalid or exhausted session bootstrap token");
          return;
        }
        bootstrapHits += 1;
        sessionActivated = true;
        if (bootTimer) { clearTimeout(bootTimer); bootTimer = null; }
        resetHeartbeatTimer();

        sendViewerHtml(res, {
          "Set-Cookie": `${sessionCookieName}=${sessionSecret}; HttpOnly; SameSite=Lax; Path=/`,
        });
        return;
      }

      if (pathname === "/" && method === "GET") {
        if (!hasValidSessionCookie(req)) {
          sendText(res, 403, "Forbidden: active session required");
          return;
        }
        resetHeartbeatTimer();
        sendViewerHtml(res);
        return;
      }

      if (pathname === "/api/comments" && method === "GET") {
        if (!isAuthorizedApiRead(req)) {
          sendText(res, 403, "Forbidden: invalid CSRF or Origin header");
          return;
        }
        resetHeartbeatTimer();
        sendJson(res, 200, review.comments);
        return;
      }

      if (pathname === "/api/heartbeat" && method === "POST") {
        if (!isAuthorizedMutation(req)) {
          sendText(res, 403, "Forbidden: invalid CSRF or Origin header");
          return;
        }
        resetHeartbeatTimer();
        req.resume();
        sendJson(res, 200, { ok: true });
        return;
      }

      if (pathname === "/api/comments" && method === "POST") {
        if (!isAuthorizedMutation(req)) {
          sendText(res, 403, "Forbidden: invalid CSRF or Origin header");
          return;
        }
        resetHeartbeatTimer();
        const payload = await readBoundedJsonBody(req);
        const comment = validateCommentInput(payload);
        await runExclusiveMutation(async () => {
          if (review.status === "pending") {
            sendJson(res, 409, { error: "Review has already been submitted" });
            return;
          }
          if (review.comments.length >= MAX_COMMENTS_PER_REVIEW) {
            sendJson(res, 429, { error: `Maximum ${MAX_COMMENTS_PER_REVIEW} comments reached` });
            return;
          }
          review.comments.push(comment);
          if (!persistReview()) {
            review.comments.pop();
            sendJson(res, 500, { error: "Failed to persist review state" });
            return;
          }
          sendJson(res, 201, comment);
        });
        return;
      }

      const deleteMatch = pathname.match(COMMENT_ID_PATH_RE);
      if (deleteMatch && method === "DELETE") {
        if (!isAuthorizedMutation(req)) {
          sendText(res, 403, "Forbidden: invalid CSRF or Origin header");
          return;
        }
        resetHeartbeatTimer();
        const targetId = deleteMatch[1];
        await runExclusiveMutation(async () => {
          if (review.status === "pending") {
            sendJson(res, 409, { error: "Review has already been submitted" });
            return;
          }
          const prevComments = review.comments;
          review.comments = review.comments.filter((item) => item.id !== targetId);
          if (!persistReview()) {
            review.comments = prevComments;
            sendJson(res, 500, { error: "Failed to persist review state" });
            return;
          }
          sendJson(res, 200, review.comments);
        });
        return;
      }

      if (pathname === "/api/done" && method === "POST") {
        if (!isAuthorizedMutation(req)) {
          sendText(res, 403, "Forbidden: invalid CSRF or Origin header");
          return;
        }
        resetHeartbeatTimer();
        await readBoundedJsonBody(req);
        await runExclusiveMutation(async () => {
          const prevStatus = review.status;
          const prevClosedAt = review.closedAt;
          review.closedAt = new Date().toISOString();
          review.status = "pending";
          if (!persistReview()) {
            review.status = prevStatus;
            review.closedAt = prevClosedAt;
            sendJson(res, 500, { error: "Failed to persist review state" });
            return;
          }
          sendJson(res, 200, { status: "pending", commentCount: review.comments.length });
          if (typeof onDone === "function") {
            try { onDone({ review, reviewFilePath }); } catch {}
          }
          const doneTimer = setTimeout(() => {
            void shutdown("submitted");
          }, doneShutdownDelayMs);
          doneTimer.unref?.();
        });
        return;
      }

      sendText(res, 404, "Not Found");
    } catch (err) {
      const status = Number.isInteger(err?.statusCode) ? err.statusCode : 400;
      const extraHeaders = err?.closeConnection ? { Connection: "close" } : {};
      if (err?.closeConnection) {
        res.once("finish", () => {
          try { req.socket?.destroy(); } catch {}
        });
      }
      sendJson(res, status, { error: err?.message ?? "Request failed" }, extraHeaders);
    }
  });

  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 64;
  server.maxRequestsPerSocket = 100;

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      const addr = server.address();
      boundPort = typeof addr === "object" && addr ? addr.port : 0;
      sessionCookieName = `${SESSION_COOKIE_PREFIX}${boundPort}`;
      resolve();
    });
  });

  bootTimer = setTimeout(() => {
    if (!sessionActivated) {
      void shutdown("boot-timeout");
    }
  }, bootTimeoutMs);
  bootTimer.unref?.();

  lifetimeTimer = setTimeout(() => {
    void shutdown("max-lifetime");
  }, maxLifetimeMs);
  lifetimeTimer.unref?.();

  const bootstrapUrl = `http://127.0.0.1:${boundPort}/s/${bootstrapToken}`;
  const originUrl = `http://127.0.0.1:${boundPort}`;

  return {
    port: boundPort,
    originUrl,
    bootstrapUrl,
    reviewId,
    reviewFilePath,
    getReview: () => structuredClone(review),
    close: shutdown,
    waitForClose,
  };
}
