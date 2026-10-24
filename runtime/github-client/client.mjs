import { Octokit } from "@octokit/core";
import { EnvHttpProxyAgent, fetch as httpFetch } from "undici";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
export { createEventWriter } from "./events.mjs";

export async function runGh(args, { signal, timeout = 5000, env = process.env } = {}) {
  return new Promise((resolve) => {
    execFile("gh", args, {
      encoding: "utf8", windowsHide: true, timeout, signal, env, maxBuffer: 1024 * 1024,
    }, (error, stdout, stderr) => resolve({
      ok: !error, stdout: stdout || "", stderr: stderr || error?.message || "",
    }));
  });
}

export function githubHost(value = process.env.GH_HOST || "github.com") {
  const host = String(value).toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[0-9]+)?$/.test(host)) {
    throw new Error("Invalid GitHub hostname");
  }
  return host;
}

export function apiBaseUrl(host) {
  return host === "github.com" ? "https://api.github.com"
    : host.endsWith(".ghe.com") ? `https://api.${host}` : `https://${host}/api/v3`;
}

export function httpDetails(response) {
  const headers = response?.headers || {};
  const numeric = (name) => /^\d+$/.test(String(headers[name] ?? "")) ? Number(headers[name]) : null;
  const retry = headers["retry-after"];
  return {
    status: response?.status ?? 0,
    etag: headers.etag || "",
    rateLimitRemaining: numeric("x-ratelimit-remaining"),
    rateLimitReset: numeric("x-ratelimit-reset"),
    retryAfterSec: retry == null ? null : /^\d+$/.test(String(retry))
      ? Number(retry) : Math.max(1, Math.ceil((Date.parse(retry) - Date.now()) / 1000)) || null,
  };
}

export function createGitHubClient({
  host: configuredHost, baseUrl, env = process.env, run = runGh, fetch: suppliedFetch,
  timeoutMs = 30000, secondaryAccounts = false,
} = {}) {
  const host = githubHost(configuredHost || env.GH_HOST || "github.com");
  const base = new URL(baseUrl || apiBaseUrl(host));
  const enterprise = host !== "github.com" && !host.endsWith(".ghe.com");
  const environmentHost = githubHost(env.GH_HOST || "github.com");
  const publicTokenHost = environmentHost.endsWith(".ghe.com") ? environmentHost : "github.com";
  const explicitToken = ((enterprise
    ? !env.GH_HOST || host === environmentHost ? env.GH_ENTERPRISE_TOKEN || env.GITHUB_ENTERPRISE_TOKEN : ""
    : host === publicTokenHost ? env.GH_TOKEN || env.GITHUB_TOKEN : "") || "").trim();
  const credentialEnv = { ...env };
  for (const name of ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"]) delete credentialEnv[name];
  let credential;
  let resolving;
  let dispatcher;
  let closed = false;
  const clients = new Map();
  const targetCredentials = new Map();
  const identity = (token) => createHash("sha256").update(`${host}\0${token}`).digest("hex");
  const resolveCredential = async (signal, user, refresh = false) => {
    if (explicitToken && !user) return { token: explicitToken, source: "environment" };
    if (!refresh && !user && credential) return credential;
    if (!user && resolving) return resolving;
    const pending = (async () => {
      const result = await run(["auth", "token", "--hostname", host, ...(user ? ["--user", user] : [])], { signal, env: credentialEnv });
      const token = result.ok ? result.stdout.trim() : "";
      if (!token) throw new Error(`GitHub authentication required for ${host}; sign in with gh or configure a token.`);
      const value = { token, source: "gh", ...(user ? { user } : {}) };
      if (!user) credential = value;
      return value;
    })();
    if (!user) resolving = pending;
    try { return await pending; } finally { if (!user) resolving = null; }
  };
  const credentialsForTarget = async (target, signal) => {
    const primary = await resolveCredential(signal);
    const primaryScope = identity(primary.token);
    const selected = targetCredentials.get(target);
    return { auth: selected?.primaryScope === primaryScope ? selected.auth : primary, primaryScope };
  };
  const transport = suppliedFetch || (async (url, options) => {
    dispatcher ??= new EnvHttpProxyAgent({
      httpProxy: env.http_proxy || env.HTTP_PROXY,
      httpsProxy: env.https_proxy || env.HTTPS_PROXY,
      noProxy: env.no_proxy || env.NO_PROXY || "",
    });
    for (let redirects = 0; redirects <= 3; redirects++) {
      const response = await httpFetch(url, { ...options, dispatcher, redirect: "manual" });
      const location = response.headers.get("location");
      if (![301, 302, 303, 307, 308].includes(response.status) || !location) return response;
      await response.body?.cancel();
      const next = new URL(location, url);
      if (!["GET", "HEAD"].includes(options.method || "GET") || next.origin !== base.origin ||
          next.username || next.password || redirects === 3 ||
          base.pathname !== "/" && !next.pathname.startsWith(`${base.pathname.replace(/\/$/, "")}/`)) {
        throw new Error("GitHub redirect refused: only bounded same-host read redirects are permitted");
      }
      url = next.href;
    }
  });
  const octokit = (auth) => {
    const scope = identity(auth.token);
    if (!clients.has(scope)) clients.set(scope, new Octokit({
      auth: auth.token, baseUrl: base.href.replace(/\/$/, ""),
      userAgent: "jongio-skills-monitor", request: { fetch: transport },
    }));
    return clients.get(scope);
  };
  const active = new Set();
  async function request(input, options = {}) {
    if (closed) throw new Error("GitHub client is closed");
    const control = new AbortController();
    active.add(control);
    const timer = setTimeout(() => control.abort(new Error("GitHub request deadline exceeded")), timeoutMs);
    const signal = options.signal ? AbortSignal.any([control.signal, options.signal]) : control.signal;
    const graphql = input.kind === "graphql";
    const method = graphql ? "POST" : (input.method || "GET").toUpperCase();
    // Enterprise GraphQL is a sibling of the REST /api/v3 endpoint.
    const graphqlPath = `${base.pathname.replace(/\/api\/v3\/?$/, "/api").replace(/\/$/, "")}/graphql`;
    const endpoint = graphql ? graphqlPath : input.endpoint;
    const url = new URL(endpoint, `${base.href.replace(/\/$/, "")}/`);
    if (url.origin !== base.origin || url.username || url.password ||
        (!graphql && base.pathname !== "/" && !url.pathname.startsWith(`${base.pathname.replace(/\/$/, "")}/`))) {
      clearTimeout(timer);
      active.delete(control);
      throw new Error("GitHub request must remain on its configured API host");
    }
    const queryStart = String(input.query || "").replace(/^(?:\s|#[^\n]*(?:\n|$))*/, "");
    const safe = graphql ? /^(?:query\b|\{)/.test(queryStart) : method === "GET" || method === "HEAD";
    const target = secondaryAccounts && safe && typeof options.target === "string" &&
      options.target.length <= 2048 ? options.target : undefined;
    let auth;
    let primaryScope;
    let refreshed = false;
    let retried = false;
    let fallbackAccounts;
    const requestHeaders = { ...input.headers };
    if (Object.keys(requestHeaders).some((key) => /^(?:authorization|proxy-authorization|host)$/i.test(key))) {
      clearTimeout(timer);
      active.delete(control);
      throw new Error("GitHub authentication and host headers cannot be overridden");
    }
    try {
      while (true) {
        signal.throwIfAborted();
        if (!auth) ({ auth, primaryScope } = await credentialsForTarget(target, signal));
        let response;
        try {
          response = await octokit(auth).request({
            method, url: url.href,
            headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", ...requestHeaders },
            ...(graphql ? { data: { query: input.query, variables: input.variables || {} } }
              : input.body !== undefined ? { data: input.body } : {}),
            request: { signal },
          });
        } catch (error) {
          response = { status: error.status || 0, headers: error.response?.headers || {},
            data: error.response?.data, error: error.message };
        }
        const meta = httpDetails(response);
        const errors = Array.isArray(response.data?.errors) ? response.data.errors : [];
        const message = errors.map((e) => e.message).join("; ") || response.error || "";
        const rateLimited = meta.status === 429 || errors.some((e) => e.type === "RATE_LIMITED") ||
          (meta.status === 403 && (meta.rateLimitRemaining === 0 || meta.retryAfterSec !== null || /rate limit/i.test(message)));
        if (meta.status === 401 && safe && auth.source === "gh" && !refreshed && !signal.aborted) {
          refreshed = true;
          if (!auth.user) {
            credential = undefined;
            targetCredentials.clear();
          }
          targetCredentials.delete(target);
          clients.clear();
          auth = await resolveCredential(signal, auth.user, true);
          if (!auth.user) primaryScope = identity(auth.token);
          for (const key of Object.keys(requestHeaders)) {
            if (key.toLowerCase() === "if-none-match") delete requestHeaders[key];
          }
          continue;
        }
        if (safe && !rateLimited && !retried && !signal.aborted &&
            (meta.status === 0 || meta.status >= 500)) {
          retried = true;
          continue;
        }
        if (secondaryAccounts && !explicitToken && safe && /Could not resolve to a Repository/i.test(message)) {
          targetCredentials.delete(target);
          if (!fallbackAccounts) {
            const status = await run(["auth", "status", "--hostname", host, "--json", "hosts"], { signal, env: credentialEnv });
            try { fallbackAccounts = JSON.parse(status.stdout)?.hosts?.[host]?.filter((a) => !a.active).map((a) => a.login).filter((user) => user && user !== auth.user) || []; }
            catch { fallbackAccounts = []; }
          }
          const user = fallbackAccounts.shift();
          if (user) {
            auth = await resolveCredential(signal, user, true);
            for (const key of Object.keys(requestHeaders)) {
              if (key.toLowerCase() === "if-none-match") delete requestHeaders[key];
            }
            continue;
          }
        }
        // Octokit throws for a conditional 304 as well as actual HTTP failures.
        const ok = (meta.status === 304 || meta.status >= 200 && meta.status < 300 && !response.error) &&
          errors.length === 0 && !signal.aborted;
        if (ok && target && auth.user) {
          targetCredentials.delete(target);
          targetCredentials.set(target, { auth, primaryScope });
          for (const key of [...targetCredentials.keys()].slice(0, -128)) targetCredentials.delete(key);
        }
        return {
          ok, status: meta.status, headers: response.headers, data: response.data,
          cacheScope: identity(auth.token), rateLimited, budget: graphql ? "graphql" : "rest",
          error: ok ? null : signal.aborted ? "GitHub request cancelled or deadline exceeded"
            : String(message || `GitHub HTTP ${meta.status}`).replaceAll(auth.token, "[redacted]").slice(0, 1024),
        };
      }
    } catch (error) {
      return { ok: false, status: 0, headers: {}, data: null, cacheScope: auth ? identity(auth.token) : "",
        error: signal.aborted ? "GitHub request cancelled or deadline exceeded" : error.message };
    } finally {
      clearTimeout(timer);
      active.delete(control);
    }
  }
  return {
    host, request,
    async cacheScope({ signal, target } = {}) {
      const deadline = AbortSignal.timeout(5000);
      const { auth } = await credentialsForTarget(target, signal ? AbortSignal.any([signal, deadline]) : deadline);
      return identity(auth.token);
    },
    async close() {
      closed = true;
      for (const control of active) control.abort();
      await dispatcher?.close();
      clients.clear();
      targetCredentials.clear();
    },
  };
}
