import { statuslineGitHub } from "./github-transport.mjs";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { withStateLock } from "./state-lock.mjs";
import { isDeepStrictEqual } from "node:util";

const pending = new Map();
function retryDeadline(headers, now) {
  const retryAfter = headers["retry-after"];
  const retrySeconds = /^\d+$/.test(String(retryAfter ?? "")) ? Number(retryAfter)
    : Math.max(0, (Date.parse(retryAfter) - now) / 1000) || 0;
  const resetSeconds = headers["x-ratelimit-remaining"] === "0" ? Number(headers["x-ratelimit-reset"]) - now / 1000 : 0;
  return now + Math.max(60, Number.isFinite(retrySeconds) ? retrySeconds : 0,
    Number.isFinite(resetSeconds) ? resetSeconds : 0) * 1000;
}

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
    try { scope = fetchStatus ? "injected" : await statuslineGitHub.cacheScope(host, { signal, target: item.url }); }
    catch (error) { results.set(item.url, error); continue; }
    const entry = read(home)[item.url];
    if (!force && entry?.scope === scope && entry.retryAt > now) {
      results.set(item.url, new Error(entry.lastError || "GitHub refresh is backing off"));
      continue;
    }
    const ttl = entry?.ttlMs ?? 45000;
    if (!force && item.checkedAt !== 0 && entry?.scope === scope && !entry.lastError &&
        entry.info && Number.isFinite(entry.checkedAt) && now - entry.checkedAt < ttl) {
      results.set(item.url, { info: entry.info, checkedAt: entry.checkedAt, fromCache: true });
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
                : kind === "pr" && module.summarizePrStatus(info)?.includes(module.OCTICONS.running) ? 20000 : 45000,
            };
            write(cache, home);
          });
          return { info, checkedAt: now, fromCache: false };
        } catch (error) {
          withStateLock(cacheFile, () => {
            const cache = read(home);
            if (cache[item.url]?.lease !== lease) return;
            cache[item.url] = { ...cache[item.url], scope, refreshingUntil: 0, lastError: error.message,
              retryAt: retryDeadline(error.response?.headers || {}, now) };
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
    if (!value) return undefined;
    return Object.defineProperties({ ...value.info }, {
      observedAt: { value: value.checkedAt },
      observedFromCache: { value: value.fromCache },
    });
  };
}

export function mergeObservations(current, previous, refreshed, { allowRemovals = false } = {}) {
  const key = (item) => item.url ?? item.id;
  const before = new Map(previous.map((item) => [key(item), item]));
  const after = new Map(refreshed.map((item) => [key(item), item]));
  const lifecycle = ["generation", "checkedAt", "status", "closedAt", "mergedAt", "mergedObservedAt", "prs",
    "mergedPrs", "settlementObservedAt", "settlementDismissed"];
  return current.flatMap((item) => {
    const old = before.get(key(item)), fresh = after.get(key(item));
    if (allowRemovals && old && !fresh && isDeepStrictEqual(item, old)) return [];
    if (!old || !fresh || lifecycle.some((field) => !isDeepStrictEqual(item[field], old[field]))) return item;
    const fields = [...new Set([...Object.keys(old), ...Object.keys(fresh)])]
      .filter((field) => !isDeepStrictEqual(old[field], fresh[field]));
    if (fields.some((field) => !isDeepStrictEqual(item[field], old[field]))) return item;
    const updated = { ...item };
    for (const field of fields) {
      if (Object.hasOwn(fresh, field)) updated[field] = fresh[field];
      else delete updated[field];
    }
    return updated;
  });
}

export function mergeRefreshState(current, initial, refreshed, list, now = Date.now()) {
  const previous = (initial?.[list] || []).filter((item) => list !== "issues" ||
    (current.explicitRevisions?.[item.url] || 0) === (initial?.explicitRevisions?.[item.url] || 0));
  const entries = mergeObservations(current[list], previous, refreshed[list], { allowRemovals: true });
  const ignored = new Set(current.ignored || []);
  const ignoredRevisions = { ...current.ignoredRevisions };
  for (const old of previous) {
    if (entries.some((item) => item.url === old.url) || refreshed[list].some((item) => item.url === old.url) ||
        !refreshed.ignored.includes(old.url)) continue;
    ignored.add(old.url);
    if (list === "prs") ignoredRevisions[old.url] = Math.max(ignoredRevisions[old.url] ?? 0,
      refreshed.ignoredRevisions?.[old.url] ?? old.generation ?? 0);
  }
  return {
    ...current, [list]: entries, ignored: [...ignored],
    ...(list === "prs" ? { ignoredRevisions } : {}),
    updatedAt: Math.max(Number.isFinite(current.updatedAt) ? current.updatedAt : 0, now),
  };
}

export async function refreshTracker(kind, sessionId, {
  home = process.env.COPILOT_HOME || join(homedir(), ".copilot"), now = Date.now(), force = false, signal,
} = {}) {
  const module = await import(kind === "pr" ? "./pr-statusline/tracker.mjs" : "./issue-statusline/tracker.mjs");
  const Tracker = kind === "pr" ? module.SessionTracker : module.IssueTracker;
  let initial = module.readState(sessionId, home);
  let tracker = new Tracker(sessionId, initial);
  const list = kind === "pr" ? "prs" : "issues";
  const failures = [];
  if (kind === "pr") {
    try {
      const workspace = readFileSync(join(home, "session-state", sessionId, "workspace.yaml"), "utf8");
      const repository = /^repository:\s*(\S+)/m.exec(workspace)?.[1];
      const branch = /^branch:\s*(\S+)/m.exec(workspace)?.[1];
      if (repository && branch && tracker.state.prs.some((pr) => !pr.simulated) &&
          !["main", "master", "HEAD"].includes(branch)) {
        const github = await import("./pr-statusline/github.mjs");
        const key = `branch:${tracker.host}/${repository}:${branch}`;
        const scope = await statuslineGitHub.cacheScope(tracker.host, { signal, target: key });
        const cache = github.readPrCache(home);
        if (!force && cache[key]?.scope === scope && cache[key].retryAt > now) {
          throw new Error(cache[key].lastError || "Branch discovery is backing off");
        }
        let data = cache[key]?.scope === scope && now - cache[key].checkedAt < 45000 ? cache[key].data : undefined;
        if (data === undefined) {
          try {
            data = await github.queryBranchPrWithGh(repository, branch, { host: tracker.host, signal });
          } catch (error) {
            signal?.throwIfAborted();
            withStateLock(join(home, "pr-statusline", "pr-cache.json"), () => {
              const current = github.readPrCache(home);
              current[key] = { ...(current[key]?.scope === scope ? current[key] : {}), scope,
                lastError: error.message, retryAt: retryDeadline(error.response?.headers || {}, now) };
              github.writePrCache(current, home);
            });
            throw error;
          }
          withStateLock(join(home, "pr-statusline", "pr-cache.json"), () => {
            github.writePrCache({ ...github.readPrCache(home), [key]: { data, scope: data.cacheScope || scope, checkedAt: now, ttlMs: 45000 } }, home);
          });
        }
        const synced = module.syncSession({ session_id: sessionId }, { home, now, fetchPrStatus: false }).state;
        if (synced) {
          initial = synced;
          tracker = new Tracker(sessionId, initial);
        }
      }
    } catch (error) {
      signal?.throwIfAborted();
      if (error.code !== "ENOENT") failures.push(`Branch discovery: ${error.message}`);
    }
  }
  const previous = initial ? structuredClone(initial) : tracker.snapshot();
  const fetch = await prefetchStatuses(kind, tracker.state[list], { home, now, force, signal });
  signal?.throwIfAborted();
  const refresh = kind === "pr" ? module.refreshTrackedPrStatuses : module.refreshTrackedIssueStatuses;
  refresh(tracker, { home, now, force, prefetched: true, [kind === "pr" ? "fetchPrStatus" : "fetchIssueStatus"]: fetch,
    onError: (error) => failures.push(error.message) });
  module.updateState(sessionId, (current) => {
    current ??= tracker.snapshot();
    if ((current.clearedAt || 0) !== (initial?.clearedAt || 0)) return current;
    return mergeRefreshState(current, previous, tracker.state, list, now);
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
