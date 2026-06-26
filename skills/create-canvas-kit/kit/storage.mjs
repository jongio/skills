// canvas-kit/storage.mjs
//
// Durable JSON state helpers. State is keyed by a *domain id* (a stable logical
// identifier resolved from the open input), never by instanceId — per
// create-canvas/SKILL.md. Two scopes:
//   userStore      -> $COPILOT_HOME/extensions/<name>/artifacts/<file>   (per user, cross-session)
//   workspaceStore -> <session.workspacePath>/<file>                     (per session)

import { readFile, writeFile, mkdir } from "node:fs/promises";
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
      } catch {
        return fallback;
      }
    },
    async save(data) {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify(data, null, 2), "utf8");
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
