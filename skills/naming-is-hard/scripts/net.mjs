/**
 * net.mjs: the network security boundary for naming-is-hard.
 *
 * Every availability probe funnels through here. Two jobs:
 *
 *   1. `slugify` turns an untrusted candidate name into a strict
 *      `[a-z0-9-]` slug BEFORE it is ever interpolated into a URL, DNS query,
 *      or registry path. This closes SSRF and path-injection: a hostile name
 *      like `../`, `@evil.com`, or `foo/../../secret` cannot escape the slug.
 *
 *   2. `safeFetch` only contacts a fixed host allowlist, applies a timeout, and
 *      never auto-follows redirects to an off-allowlist host.
 *
 * No credentials are required. An optional GitHub token (read from the
 * environment by the caller) only raises a rate limit; it is never logged.
 */

export const USER_AGENT =
  'naming-is-hard/1.0 (+https://github.com/jongio/skills)';

/**
 * Hosts the engine is allowed to fetch. Anything not on this list throws in
 * `safeFetch`. Link-out-only destinations (USPTO, registrars, most social
 * sites) are deliberately absent: we render URLs for the user to click, we do
 * not fetch them.
 */
export const ALLOWED_HOSTS = Object.freeze([
  'rdap.org',
  'api.github.com',
  'registry.npmjs.org',
  'pypi.org',
  'crates.io',
  'rubygems.org',
  'api.nuget.org',
]);

const MAX_SLUG_LENGTH = 64;

/**
 * Sanitize an untrusted name into a safe slug: lowercase, ASCII `[a-z0-9-]`
 * only, no leading/trailing/double hyphens, length-capped. Returns `''` when
 * nothing safe survives (callers must treat empty as "unusable", never fetch).
 *
 * @param {unknown} name
 * @returns {string}
 */
export function slugify(name) {
  if (typeof name !== 'string') return '';
  return name
    .normalize('NFKD')
    // drop combining marks left by NFKD (é -> e)
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    // any run of non-[a-z0-9] becomes a single hyphen
    .replace(/[^a-z0-9]+/g, '-')
    // trim hyphens from the ends
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
    // slicing may have re-exposed a trailing hyphen
    .replace(/-+$/g, '');
}

/**
 * True when a name is safe to use in a request (produces a non-empty slug).
 * @param {unknown} name
 */
export function isUsableName(name) {
  return slugify(name).length > 0;
}

/**
 * Is this host on the allowlist? Exact match only (no suffix games).
 * @param {string} host
 * @param {readonly string[]} [allowlist]
 */
export function isAllowedHost(host, allowlist = ALLOWED_HOSTS) {
  return allowlist.includes(String(host).toLowerCase());
}

/**
 * @typedef {Object} SafeFetchResult
 * @property {number} status       HTTP status code (0 if the request never completed)
 * @property {boolean} ok          status in [200,299]
 * @property {boolean} redirected  status in [300,399]
 * @property {string} url          the requested URL
 * @property {Record<string,string>} headers  lower-cased response headers
 * @property {() => Promise<string>} text     lazy body reader
 */

/**
 * Fetch a URL under strict rules: allowlisted host, timeout, no off-allowlist
 * redirect following. Throws for a disallowed host or malformed URL; resolves
 * (never throws) for network/timeout failures so callers can degrade to
 * `unknown`: those come back as `{ status: 0, ok: false }`.
 *
 * @param {string} url
 * @param {Object} [opts]
 * @param {readonly string[]} [opts.allowlist]
 * @param {number} [opts.timeoutMs]
 * @param {typeof fetch} [opts.fetchImpl]  injectable for tests
 * @param {string} [opts.method]
 * @param {Record<string,string>} [opts.headers]
 * @returns {Promise<SafeFetchResult>}
 */
export async function safeFetch(url, opts = {}) {
  const {
    allowlist = ALLOWED_HOSTS,
    timeoutMs = 6000,
    fetchImpl = globalThis.fetch,
    method = 'GET',
    headers = {},
  } = opts;

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`safeFetch: malformed URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`safeFetch: refusing non-https URL: ${url}`);
  }
  if (!isAllowedHost(parsed.hostname, allowlist)) {
    throw new Error(`safeFetch: host not allowed: ${parsed.hostname}`);
  }
  if (typeof fetchImpl !== 'function') {
    throw new Error('safeFetch: no fetch implementation available');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(parsed.toString(), {
      method,
      redirect: 'manual', // never auto-follow to an off-allowlist host
      signal: controller.signal,
      headers: { 'user-agent': USER_AGENT, accept: 'application/json', ...headers },
    });
    const status = typeof res.status === 'number' ? res.status : 0;
    const outHeaders = normalizeHeaders(res.headers);
    return {
      status,
      ok: status >= 200 && status < 300,
      redirected: status >= 300 && status < 400,
      url: parsed.toString(),
      headers: outHeaders,
      text: () => (typeof res.text === 'function' ? res.text() : Promise.resolve('')),
    };
  } catch {
    // network error, timeout, abort: caller degrades to `unknown`
    return {
      status: 0,
      ok: false,
      redirected: false,
      url: parsed.toString(),
      headers: {},
      text: () => Promise.resolve(''),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run async tasks with a concurrency cap, preserving input order.
 * @template T,R
 * @param {readonly T[]} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<R>} worker
 * @returns {Promise<R[]>}
 */
export async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const size = Math.max(1, Math.min(limit, items.length || 1));
  const runners = Array.from({ length: size }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

/** @param {any} headers */
function normalizeHeaders(headers) {
  const out = {};
  if (headers && typeof headers.forEach === 'function') {
    headers.forEach((value, key) => {
      out[String(key).toLowerCase()] = value;
    });
  }
  return out;
}
