// canvas-kit/storage.mjs
//
// Durable JSON state helpers. State is keyed by a *domain id* (a stable logical
// identifier resolved from the open input), never by instanceId — per
// create-canvas/SKILL.md. Two scopes:
//   userStore      -> $COPILOT_HOME/extensions/<name>/artifacts/<file>   (per user, cross-session)
//   workspaceStore -> <session.workspacePath>/<file>                     (per session)

import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

function copilotHome() {
  return process.env.COPILOT_HOME || join(homedir(), ".copilot");
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
      await mkdir(dirname(file), { recursive: true });
      // Write to a temp sibling then atomically rename into place, so a crash or
      // interruption mid-write can never truncate the existing durable file.
      // rename(2) is atomic on the same filesystem.
      const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
      await rename(tmp, file);
    },
  };
}

/** Per-user, cross-session artifact store for a named extension. */
export function userStore(extensionName, fileName) {
  return makeStore(join(copilotHome(), "extensions", extensionName, "artifacts", fileName));
}

/** Per-session store rooted at the session workspace path. */
export function workspaceStore(workspacePath, fileName) {
  return makeStore(join(workspacePath, fileName));
}
