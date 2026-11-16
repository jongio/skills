import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SESSION_ID_RE = /^[\w-]{1,128}$/;

export function providerEndpoint(sessionId, namespace = "copilot-diff") {
  if (typeof sessionId !== "string" || !SESSION_ID_RE.test(sessionId)) {
    throw new Error("Invalid Copilot session ID for diff provider lease");
  }
  const safeNamespace = String(namespace).replace(/[^A-Za-z0-9_-]/g, "") || "copilot-diff";
  const key = createHash("sha256").update(sessionId).digest("hex").slice(0, 24);
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\${safeNamespace}-${key}`;
  }
  if (process.platform === "linux") {
    return `\0${safeNamespace}-${key}`;
  }
  const homeRoot = resolve(process.env.COPILOT_HOME || join(homedir(), ".copilot"));
  const lockDir = join(homeRoot, "locks");
  const candidate = join(lockDir, `${safeNamespace}-${key}.sock`);
  if (Buffer.byteLength(candidate, "utf8") <= 96) {
    mkdirSync(lockDir, { recursive: true, mode: 0o700 });
    const st = lstatSync(lockDir);
    if (!st.isSymbolicLink() && st.isDirectory()) {
      try { chmodSync(lockDir, 0o700); } catch {}
      return candidate;
    }
  }
  return join(tmpdir(), `${safeNamespace}-${key}.sock`);
}

function canConnect(endpoint) {
  return new Promise((resolve) => {
    const socket = createConnection(endpoint);
    const finish = (alive) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(alive);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(250, () => finish(false));
  });
}

function listenExclusive(endpoint) {
  return new Promise((resolve, reject) => {
    const server = createServer((socket) => socket.end());
    server.once("error", reject);
    server.listen(endpoint, () => {
      server.removeListener("error", reject);
      if (process.platform !== "win32" && !endpoint.startsWith("\0")) {
        try { chmodSync(endpoint, 0o600); } catch {}
      }
      server.unref();
      resolve(server);
    });
  });
}

/**
 * Acquire an OS-owned per-session lease so duplicate extension entrypoints
 * (for example both the marketplace plugin and a standalone ~/.copilot/extensions
 * loader) never double-register the `diff` canvas in the same Copilot session.
 */
export function checkSession(ctx, activeSession) {
  if (!ctx?.sessionId || ctx.sessionId !== activeSession?.sessionId) {
    const err = new Error("Cross-session canvas access rejected");
    err.code = "wrong_session";
    throw err;
  }
}

export async function acquireProviderLease(sessionId, { namespace } = {}) {
  const endpoint = providerEndpoint(sessionId, namespace);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const server = await listenExclusive(endpoint);
      let released = false;
      const release = async () => {
        if (released) return;
        released = true;
        await new Promise((resolve) => server.close(() => resolve()));
        if (process.platform !== "win32" && !endpoint.startsWith("\0")) {
          await unlink(endpoint).catch(() => {});
        }
      };
      return {
        acquired: true,
        endpoint,
        release,
        close: release,
      };
    } catch (error) {
      if (error?.code !== "EADDRINUSE") throw error;
      if (process.platform === "win32" || endpoint.startsWith("\0")) {
        return { acquired: false, endpoint, async release() {}, async close() {} };
      }
      if (await canConnect(endpoint)) {
        return { acquired: false, endpoint, async release() {}, async close() {} };
      }
      if (attempt === 0) {
        await unlink(endpoint).catch(() => {});
        continue;
      }
      return { acquired: false, endpoint, async release() {}, async close() {} };
    }
  }
  return { acquired: false, endpoint, async release() {}, async close() {} };
}
