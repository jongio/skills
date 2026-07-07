// canvas-kit/github-store.mjs
//
// A SHARED, multi-writer durable store backed by a file in a GitHub repository.
// Where userStore/sessionStore/workspaceStore (storage.mjs) persist to local disk
// — private to one machine — githubStore persists the same JSON to a file in a
// repo via the Contents API, so every collaborator who can push to that repo edits
// ONE shared document. GitHub is the backing store AND the access-control layer
// (invite collaborators to a private repo); there is no server to run.
//
// It exposes the same { load, save } shape the runtime's loadState/saveState
// expect, plus poll() for cheap change-detection so a canvas can pull other
// people's edits live (wire it to server.mjs's syncState + syncIntervalMs).
//
// Concurrency: every write carries the blob sha it read (optimistic lock). A
// concurrent commit makes the PUT 409; save() re-reads to refresh the sha and
// retries. The default policy is last-writer-wins for the whole document; pass a
// merge(remoteState, myState) to resolve conflicts field-by-field instead (e.g.
// union a board's concerns by id). Reads use an ETag If-None-Match so an unchanged
// poll is a cheap 304 with no body.
//
// Token: resolved once from opts.token (string | async () => string), then
// GH_TOKEN / GITHUB_TOKEN, then `gh auth token`. Needs the `repo` scope for a
// private repo. The token is only ever sent as an Authorization header — never
// logged, never written to the repo.

import { execFile } from "node:child_process";

const API = "https://api.github.com";
const UA = "canvas-kit-github-store";

// Resolve a GitHub token lazily and memoize it. A 401 (expired/rotated) clears the
// cache via invalidate() so the next call re-resolves.
function makeTokenResolver(tokenOpt) {
  let cached = null;
  async function fromGhCli() {
    return new Promise((resolve) => {
      execFile("gh", ["auth", "token"], { windowsHide: true }, (err, stdout) => {
        resolve(err ? null : String(stdout).trim() || null);
      });
    });
  }
  return {
    async get() {
      if (cached) return cached;
      let t = null;
      if (typeof tokenOpt === "function") t = await tokenOpt();
      else if (typeof tokenOpt === "string" && tokenOpt) t = tokenOpt;
      if (!t) t = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || null;
      if (!t) t = await fromGhCli();
      if (!t) throw new Error("githubStore: no GitHub token (set GH_TOKEN or run `gh auth login`)");
      cached = t;
      return cached;
    },
    invalidate() { cached = null; },
  };
}

function encodePath(path) {
  // Keep the slashes as path separators in the Contents API URL; encode each
  // segment so spaces / unicode in a filename can't break the request.
  return String(path).split("/").filter(Boolean).map(encodeURIComponent).join("/");
}

/**
 * A GitHub-repo-backed durable store: one JSON file, many writers.
 * @param {object} opts
 * @param {string} opts.owner    repo owner (user or org)
 * @param {string} opts.repo     repo name
 * @param {string} opts.path     path to the JSON file in the repo (e.g. "state/board.json")
 * @param {string} [opts.branch="main"]
 * @param {string|(()=>Promise<string>|string)} [opts.token]  token or async resolver
 * @param {(remote:any,mine:any)=>any} [opts.merge]  conflict resolver (default: last-writer-wins)
 * @param {(state:any)=>string} [opts.message]  commit message from the state (default: a timestamp)
 * @param {string} [opts.apiBase=API]
 * @returns {{file:string, load:(fallback?:any)=>Promise<any>, poll:()=>Promise<{changed:boolean,state?:any}>, save:(state:any)=>Promise<void>}}
 */
export function githubStore(opts) {
  const { owner, repo, path, branch = "main", token, merge, message, apiBase = API } = opts ?? {};
  if (!owner || !repo || !path) throw new Error("githubStore: owner, repo and path are required");

  const tok = makeTokenResolver(token);
  const contentsUrl = `${apiBase}/repos/${owner}/${repo}/contents/${encodePath(path)}`;
  const label = `${owner}/${repo}:${path}`;

  let sha = null;      // last-seen blob sha — sent on write as the optimistic lock
  let etag = null;     // last-seen ETag — sent on poll as If-None-Match
  let lastText = null; // last-seen decoded content — guards against no-op broadcasts

  async function api(url, init = {}, allow = []) {
    const t = await tok.get();
    const res = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${t}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": UA,
        ...(init.headers ?? {}),
      },
    });
    // An expired token surfaces as 401 — drop the memoized token so a retry can
    // re-resolve (e.g. after `gh auth refresh`), then surface the failure.
    if (res.status === 401) { tok.invalidate(); }
    // ok, or an expected status the caller handles (404 fresh-file, 304 unchanged,
    // 409 write conflict), pass through; anything else is a hard error.
    if (res.ok || allow.includes(res.status)) return res;
    const body = await res.text().catch(() => "");
    throw new Error(`githubStore ${label}: ${init.method ?? "GET"} ${res.status} ${body.slice(0, 200)}`);
  }

  function decode(json) {
    // Contents API returns base64 (wrapped at 60 cols); Buffer handles the newlines.
    return Buffer.from(json.content ?? "", "base64").toString("utf8");
  }

  async function load(fallback = null) {
    const res = await api(`${contentsUrl}?ref=${encodeURIComponent(branch)}`, {}, [404]);
    if (res.status === 404) { sha = null; etag = null; lastText = null; return fallback; }
    const json = await res.json();
    sha = json.sha ?? null;
    etag = res.headers.get("etag");
    const text = decode(json);
    lastText = text;
    return text.trim() ? JSON.parse(text) : fallback;
  }

  async function poll() {
    const headers = etag ? { "If-None-Match": etag } : {};
    const res = await api(`${contentsUrl}?ref=${encodeURIComponent(branch)}`, { headers }, [304, 404]);
    if (res.status === 304) return { changed: false };
    if (res.status === 404) {
      if (sha === null && lastText === null) return { changed: false };
      sha = null; etag = null; lastText = null;
      return { changed: true, state: null };
    }
    const json = await res.json();
    const text = decode(json);
    sha = json.sha ?? null;
    etag = res.headers.get("etag");
    if (text === lastText) return { changed: false };
    lastText = text;
    return { changed: true, state: text.trim() ? JSON.parse(text) : null };
  }

  async function save(state) {
    let toWrite = state;
    for (let attempt = 0; ; attempt++) {
      const text = JSON.stringify(toWrite, null, 2);
      const body = {
        message: (message ? message(toWrite) : `Update ${path}`) || `Update ${path}`,
        content: Buffer.from(text, "utf8").toString("base64"),
        branch,
        ...(sha ? { sha } : {}),
      };
      const res = await api(contentsUrl, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }, [409, 404]);
      if (res.ok) {
        const json = await res.json();
        sha = json.content?.sha ?? null;
        etag = null;       // PUT's ETag isn't the content GET's — force a fresh poll baseline
        lastText = text;   // our own write must not read back as a change
        return;
      }
      // 409 (or a 404 if the file/branch vanished): the sha we held is stale.
      // Re-read to refresh sha, optionally merge the remote with our intended
      // write, and retry. Bounded so a persistent conflict fails loudly.
      if ((res.status === 409 || res.status === 404) && attempt < 3) {
        const remote = await load(null);
        toWrite = merge ? merge(remote, state) : state; // default: last-writer-wins
        continue;
      }
      const errBody = await res.text().catch(() => "");
      throw new Error(`githubStore ${label}: save failed ${res.status} ${errBody.slice(0, 200)}`);
    }
  }

  return { file: label, load, poll, save };
}
