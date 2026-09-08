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

import { readFile, writeFile, mkdir, rename, unlink } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";

function copilotHome() {
  return process.env.COPILOT_HOME || join(homedir(), ".copilot");
}

// Per-file write queue. Concurrent saves to the SAME durable file (an agent
// action and a UI action racing) must not overlap: on Windows two renames to the
// same destination collide with EPERM even with unique temp names. Chaining each
// save onto the previous one for that path serializes them (last enqueued wins),
// which is both correct (no interleaved writes) and portable.
const writeQueues = new Map(); // absolute file path -> tail Promise

async function atomicWrite(file, data) {
  await mkdir(dirname(file), { recursive: true });
  // Write to a temp sibling then atomically rename into place, so a crash or
  // interruption mid-write can never truncate the existing durable file.
  // rename(2) is atomic on the same filesystem. The temp name mixes pid + time +
  // RANDOM bytes so two writers can never pick the same temp path.
  const tmp = `${file}.${process.pid}.${Date.now()}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  try {
    await rename(tmp, file);
  } catch (err) {
    // Windows can transiently EPERM/EACCES a rename when the destination is
    // briefly held (AV scanner, indexer). Retry once after a short beat; always
    // clean up our temp so a failed save leaves no orphaned *.tmp behind.
    if (err?.code === "EPERM" || err?.code === "EACCES") {
      await new Promise((r) => setTimeout(r, 25));
      try {
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

function makeStore(file) {
  return {
    file,
    async load(fallback = null) {
      try {
        return JSON.parse(await readFile(file, "utf8"));
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
      const run = prev.catch(() => {}).then(() => atomicWrite(file, data));
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
  return makeStore(join(copilotHome(), "extensions", extensionName, "artifacts", fileName));
}

/**
 * Per-session scratch store for a named extension, rooted under the session's
 * state directory. Use for state that should NOT outlive the session (drafts,
 * one-off working data). Pass the session id (e.g. from the SDK ctx).
 */
export function sessionStore(sessionId, extensionName, fileName) {
  // Reduce the session id to a single safe path segment. The charset filter keeps
  // "." (so dotted ids survive), so we must ALSO collapse any ".." run — otherwise
  // a session id of ".." would join to one level ABOVE session-state and escape the
  // per-session root. (sessionId is normally a trusted SDK value; this keeps the
  // sanitizer honest regardless.)
  const safeSession =
    String(sessionId)
      .replace(/[^A-Za-z0-9._-]/g, "_")
      .replace(/\.\.+/g, "_") || "default";
  return makeStore(join(copilotHome(), "session-state", safeSession, "extensions", extensionName, fileName));
}

/** Per-session store rooted at the session workspace path. */
export function workspaceStore(workspacePath, fileName) {
  return makeStore(join(workspacePath, fileName));
}
