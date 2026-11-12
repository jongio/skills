// canvas-kit/storage.mjs
//
// Durable JSON state helpers. State is keyed by a *domain id* (a stable logical
// identifier resolved from the open input), never by instanceId — per
// create-canvas/SKILL.md. Three tiers, matching the Canvas SDK storage model:
//   userStore      -> $COPILOT_HOME/extensions/<name>/artifacts/<file>   (per user, cross-session)
//   sessionStore   -> $COPILOT_HOME/session-state/<sessionId>/extensions/<name>/<file>  (per session, scratch)
//   workspaceStore -> <session.workspacePath>/<file>                     (rooted at the session workspace)
//
// Sandboxing: callers derive the <file> from a domain id that MUST be sanitized
// to a bare filename (the reference `fileFor` strips everything but
// [A-Za-z0-9._-]); the store never joins caller input as a path, so a domain id
// can't escape its extension's artifacts directory.

import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { readFile, writeFile, mkdir, rename, unlink } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";

function copilotHome() {
  return process.env.COPILOT_HOME || join(homedir(), ".copilot");
}

function assertSafeSegment(value, label) {
  if (
    typeof value !== "string" ||
    !value ||
    value === "." ||
    value === ".." ||
    !/^[A-Za-z0-9._-]+$/.test(value)
  ) {
    throw new Error(`storage: invalid ${label}`);
  }
  return value;
}

function withTrailingSep(dirPath) {
  return dirPath.endsWith(sep) ? dirPath : dirPath + sep;
}

function resolveConfinedPath(rootDir, relativeFile, label) {
  if (typeof relativeFile !== "string" || !relativeFile || relativeFile.includes("\0")) {
    throw new Error(`storage: invalid ${label}`);
  }
  const base = resolve(rootDir);
  const prefix = withTrailingSep(base);
  const target = resolve(base, relativeFile);
  if (target === base || !target.startsWith(prefix)) {
    throw new Error(`storage: ${label} escapes store root`);
  }
  return { base, target };
}

function assertFilesystemConfinedSync(base, target) {
  const rel = relative(base, target);
  const parts = rel.split(sep).filter(Boolean);
  if (parts.length === 0 || parts.some((p) => p === "." || p === "..")) {
    throw new Error("storage: target escapes store root");
  }
  let cursor = base;
  for (let i = 0; i < parts.length; i++) {
    cursor = join(cursor, parts[i]);
    let st;
    try {
      st = lstatSync(cursor);
    } catch (err) {
      if (err?.code === "ENOENT") break;
      throw err;
    }
    if (st.isSymbolicLink()) {
      throw new Error("storage: symlinked path inside store root is forbidden");
    }
    if (i < parts.length - 1 && !st.isDirectory()) {
      throw new Error("storage: ancestor in store path is not a directory");
    }
    if (i === parts.length - 1 && !st.isFile()) {
      throw new Error("storage: target is not a regular file");
    }
  }
  let realBase = null;
  try {
    realBase = realpathSync(base);
  } catch (err) {
    if (err?.code !== "ENOENT") throw err;
  }
  if (realBase !== null) {
    const realPrefix = withTrailingSep(realBase);
    const basePrefix = withTrailingSep(base);
    let probe = dirname(target);
    while (probe === base || probe.startsWith(basePrefix)) {
      try {
        const realProbe = realpathSync(probe);
        if (realProbe !== realBase && !realProbe.startsWith(realPrefix)) {
          throw new Error("storage: resolved directory escapes store root");
        }
        break;
      } catch (err) {
        if (err?.code !== "ENOENT") throw err;
        if (probe === base) break;
        const parent = dirname(probe);
        if (parent === probe) break;
        probe = parent;
      }
    }
  }
}

// Per-file write queue. Concurrent saves to the SAME durable file (an agent
// action and a UI action racing) must not overlap: on Windows two renames to the
// same destination collide with EPERM even with unique temp names. Chaining each
// save onto the previous one for that path serializes them (last enqueued wins),
// which is both correct (no interleaved writes) and portable.
const writeQueues = new Map(); // absolute file path -> tail Promise

async function atomicWrite(base, file, data) {
  assertFilesystemConfinedSync(base, file);
  await mkdir(dirname(file), { recursive: true });
  assertFilesystemConfinedSync(base, file);
  // Write to a temp sibling then atomically rename into place, so a crash or
  // interruption mid-write can never truncate the existing durable file.
  // rename(2) is atomic on the same filesystem. The temp name mixes pid + time +
  // RANDOM bytes so two writers can never pick the same temp path.
  const tmp = `${file}.${process.pid}.${Date.now()}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2), { encoding: "utf8", flag: "wx" });
  try {
    assertFilesystemConfinedSync(base, file);
    await rename(tmp, file);
  } catch (err) {
    // Windows can transiently EPERM/EACCES a rename when the destination is
    // briefly held (AV scanner, indexer). Retry once after a short beat; always
    // clean up our temp so a failed save leaves no orphaned *.tmp behind.
    if (err?.code === "EPERM" || err?.code === "EACCES") {
      await new Promise((r) => setTimeout(r, 25));
      try {
        assertFilesystemConfinedSync(base, file);
        await rename(tmp, file);
      } catch (err2) {
        await unlink(tmp).catch(() => {});
        throw err2;
      }
    } else {
      await unlink(tmp).catch(() => {});
      throw err;
    }
  }
}

async function readConfinedJson(base, file) {
  assertFilesystemConfinedSync(base, file);
  if (constants.O_NOFOLLOW) {
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const st = fstatSync(fd);
      if (!st.isFile()) {
        throw new Error("storage: target is not a regular file");
      }
      return JSON.parse(readFileSync(fd, "utf8"));
    } finally {
      closeSync(fd);
    }
  }
  const raw = await readFile(file, "utf8");
  assertFilesystemConfinedSync(base, file);
  return JSON.parse(raw);
}

function makeStore({ base, target: file }) {
  return {
    file,
    async load(fallback = null) {
      try {
        return await readConfinedJson(base, file);
      } catch (err) {
        // Only a genuinely absent file means "use the fallback". A transient
        // read/parse failure (EACCES, EIO, a half-written or corrupt file) must
        // NOT silently return the fallback — the caller would then treat the
        // domain as brand-new and the next save() would overwrite real durable
        // state with the empty initial state. Surface it instead so it can be
        // handled rather than silently destroying data.
        if (err?.code === "ENOENT") return fallback;
        throw err;
      }
    },
    async save(data) {
      // Serialize behind any in-flight save for this exact path (see writeQueues).
      const prev = writeQueues.get(file) ?? Promise.resolve();
      const run = prev.catch(() => {}).then(() => atomicWrite(base, file, data));
      writeQueues.set(file, run);
      try {
        await run;
      } finally {
        if (writeQueues.get(file) === run) writeQueues.delete(file);
      }
    },
  };
}

/** Per-user, cross-session artifact store for a named extension. */
export function userStore(extensionName, fileName) {
  const safeExt = assertSafeSegment(extensionName, "extensionName");
  const root = join(copilotHome(), "extensions", safeExt, "artifacts");
  return makeStore(resolveConfinedPath(root, fileName, "fileName"));
}

/**
 * Per-session scratch store for a named extension, rooted under the session's
 * state directory. Use for state that should NOT outlive the session (drafts,
 * one-off working data). Pass the session id (e.g. from the SDK ctx).
 */
export function sessionStore(sessionId, extensionName, fileName) {
  // Reduce the session id to a single safe path segment. The charset filter keeps
  // "." (so dotted ids survive), so we must ALSO collapse "." and any ".." run -
  // otherwise "." or ".." would collapse out of the per-session root.
  const cleaned = String(sessionId)
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/\.\.+/g, "_");
  const safeSession = !cleaned || cleaned === "." ? "default" : cleaned;
  const safeExt = assertSafeSegment(extensionName, "extensionName");
  const root = join(copilotHome(), "session-state", safeSession, "extensions", safeExt);
  return makeStore(resolveConfinedPath(root, fileName, "fileName"));
}

/** Per-session store rooted at the session workspace path. */
export function workspaceStore(workspacePath, fileName) {
  if (typeof workspacePath !== "string" || !workspacePath) {
    throw new Error("storage: workspacePath is required");
  }
  return makeStore(resolveConfinedPath(workspacePath, fileName, "fileName"));
}
