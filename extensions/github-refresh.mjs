import { statuslineGitHub } from "./github-transport.mjs";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { withStateLock } from "./state-lock.mjs";

const pending = new Map();
export async function prefetchStatuses(kind, items, {
  home, now = Date.now(), force = false, fetchStatus, signal,
} = {}) {
  const module = await import(kind === "pr" ? "./pr-statusline/github.mjs" : "./issue-statusline/github.mjs");
  const read = kind === "pr" ? module.readPrCache : module.readIssueCache;
  const write = kind === "pr" ? module.writePrCache : module.writeIssueCache;
  const query = fetchStatus || (kind === "pr" ? module.queryPrStatusWithGh : module.queryIssueStatusWithGh);
  const results = new Map();
  for (const item of items) {
    signal?.throwIfAborted();
    if (item.simulated) continue;
    const host = new URL(item.url).hostname;
    let scope;
    try { scope = fetchStatus ? "injected" : await statuslineGitHub.cacheScope(host, { signal }); }
    catch (error) { results.set(item.url, error); continue; }
    const entry = read(home)[item.url];
    if (!force && entry?.scope === scope && entry.retryAt > now) {
      results.set(item.url, new Error(entry.lastError || "GitHub refresh is backing off"));
      continue;
    }
    const ttl = entry?.ttlMs ?? 45000;
    if (!force && entry?.scope === scope && entry.info && now - entry.checkedAt < ttl) {
      results.set(item.url, entry.info);
      continue;
    }
    const key = `${home}\0${scope}\0${item.url}${force ? `\0${randomUUID()}` : ""}`;
    if (!pending.has(key)) {
      pending.set(key, (async () => {
        const lease = randomUUID();
        const cacheFile = join(home, `${kind === "pr" ? "pr" : "issue"}-statusline`, `${kind === "pr" ? "pr" : "issue"}-cache.json`);
        const acquired = withStateLock(cacheFile, () => {
          const cache = read(home);
          const previous = cache[item.url];
          if (!force && previous?.scope === scope && previous.refreshingUntil > now) return false;
          cache[item.url] = { ...(previous?.scope === scope ? previous : {}), scope, lease, refreshingUntil: now + 35000 };
          write(cache, home);
          return true;
        });
        if (!acquired) return undefined;
        try {
          signal?.throwIfAborted();
          const info = await query(item.url, { signal });
          if (!info || typeof info !== "object") throw new Error("GitHub returned no status.");
          const state = String(info.state || "").toUpperCase();
          withStateLock(cacheFile, () => {
            const cache = read(home);
            if (cache[item.url]?.lease !== lease) return;
            cache[item.url] = {
              info, scope: info.cacheScope || scope, checkedAt: now, refreshingUntil: 0,
              ttlMs: ["CLOSED", "MERGED", "NOT_FOUND"].includes(state) ? 120000
                : kind === "pr" && info.statusCheckRollup?.some((check) => ["QUEUED", "IN_PROGRESS"].includes(check.status)) ? 20000 : 45000,
            };
            write(cache, home);
          });
          return info;
        } catch (error) {
          withStateLock(cacheFile, () => {
            const cache = read(home);
            if (cache[item.url]?.lease !== lease) return;
            const headers = error.response?.headers || {};
            cache[item.url] = { ...cache[item.url], scope, refreshingUntil: 0, lastError: error.message,
              retryAt: now + Math.max(60, Number(headers["retry-after"]) || 0,
                headers["x-ratelimit-remaining"] === "0" ? Number(headers["x-ratelimit-reset"]) - now / 1000 : 0) * 1000 };
            write(cache, home);
          });
          return error;
        }


      })());
    }
    try { results.set(item.url, await pending.get(key)); }
    finally { pending.delete(key); }
  }
  return (url) => {
    const value = results.get(url);
    if (value instanceof Error) throw value;
    return value;
  };
}

export function mergeObservations(current, previous, refreshed) {
  const key = (item) => item.url ?? item.id;
  const before = new Map(previous.map((item) => [key(item), item]));
  const after = new Map(refreshed.map((item) => [key(item), item]));
  return current.flatMap((item) => {
    const old = before.get(key(item)), fresh = after.get(key(item));
    if (old && !fresh && JSON.stringify(item) === JSON.stringify(old)) return [];
    if (!old || !fresh || JSON.stringify(item) !== JSON.stringify(old)) return item;
    return fresh;
  });
}

export async function refreshTracker(kind, sessionId, {
  home = process.env.COPILOT_HOME || join(homedir(), ".copilot"), now = Date.now(), force = false, signal,
} = {}) {
  const module = await import(kind === "pr" ? "./pr-statusline/tracker.mjs" : "./issue-statusline/tracker.mjs");
  const Tracker = kind === "pr" ? module.SessionTracker : module.IssueTracker;
  let initial = module.readState(sessionId, home);
  let tracker = new Tracker(sessionId, initial);
  const list = kind === "pr" ? "prs" : "issues";
  if (kind === "pr") {
    try {
      const workspace = readFileSync(join(home, "session-state", sessionId, "workspace.yaml"), "utf8");
      const repository = /^repository:\s*(\S+)/m.exec(workspace)?.[1];
      const branch = /^branch:\s*(\S+)/m.exec(workspace)?.[1];
      if (repository && branch && !["main", "master", "HEAD"].includes(branch)) {
        const github = await import("./pr-statusline/github.mjs");
        const scope = await statuslineGitHub.cacheScope(tracker.host);
        const key = `branch:${tracker.host}/${repository}:${branch}`;
        const cache = github.readPrCache(home);
        let data = cache[key]?.scope === scope && now - cache[key].checkedAt < 45000 ? cache[key].data : undefined;
        if (data === undefined) {
          data = await github.queryBranchPrWithGh(repository, branch, { host: tracker.host, signal });
          withStateLock(join(home, "pr-statusline", "pr-cache.json"), () => {
            github.writePrCache({ ...github.readPrCache(home), [key]: { data, scope, checkedAt: now, ttlMs: 45000 } }, home);
          });
        }
        const synced = module.syncSession({ session_id: sessionId }, { home, now, fetchPrStatus: false }).state;
        if (synced) {
          initial = synced;
          tracker = new Tracker(sessionId, initial);
        }
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  const previous = structuredClone(initial?.[list] || []);
  const fetch = await prefetchStatuses(kind, tracker.state[list], { home, now, force, signal });
  signal?.throwIfAborted();
  const failures = [];
  const refresh = kind === "pr" ? module.refreshTrackedPrStatuses : module.refreshTrackedIssueStatuses;
  refresh(tracker, { home, now, force, prefetched: true, [kind === "pr" ? "fetchPrStatus" : "fetchIssueStatus"]: fetch,
    onError: (error) => failures.push(error.message) });
  module.updateState(sessionId, (current) => {
    current ??= tracker.snapshot();
    if ((current.clearedAt || 0) !== (initial?.clearedAt || 0)) return current;
    const entries = mergeObservations(current[list], previous, tracker.state[list]);
    for (const item of tracker.state[list]) {
      if (!previous.some((old) => old.url === item.url) && !entries.some((old) => old.url === item.url) &&
          !current.ignored?.includes(item.url)) entries.push(item);
    }
    return { ...current, [list]: entries, updatedAt: now };
  }, home);
  return failures;
}

export function startIssueRefresh(session, { home, interval = 15000, report = console.error } = {}) {
  let busy = false;
  let stopped = false;
  const controller = new AbortController();
  const poll = async () => {
    if (busy || stopped) return;
    busy = true;
    try { await refreshTracker("issue", session.sessionId, { home, signal: controller.signal }); }
    catch (error) { report(`[issue-statusline] ${error.message}`); }
    finally { busy = false; }
  };
  const timer = setInterval(poll, interval);
  timer.unref();
  void poll();
  return () => { stopped = true; controller.abort(); clearInterval(timer); };
}
