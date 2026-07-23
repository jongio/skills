/**
 * availability.mjs: "is this name actually free?" across every channel that
 * matters, returning one structured scorecard per name.
 *
 * Channels:
 *   - domains     RDAP (the structured successor to WHOIS). 404 = free.
 *   - github      api.github.com user/org namespace. 404 = free.
 *   - registries  npm / PyPI / crates.io / RubyGems / NuGet. 404 = free.
 *   - social      best-effort link-outs (platforms are hostile to bots, so we
 *                 surface a verify URL and never fake-confidently claim free).
 *   - trademark   famous-marks screen (confident collision) + search link-outs.
 *   - business    same famous-marks screen framed as company collision + links.
 *
 * Every request goes through `net.safeFetch` (allowlisted host, timeout, no
 * off-allowlist redirect following). The candidate name is slugified before it
 * touches any URL. `fetchImpl` is injectable so tests never hit the network.
 */

import { safeFetch, slugify, mapWithConcurrency } from './net.mjs';
import { matchFamousMark } from './marks.mjs';
import { lookup as dnsLookup, resolveNs as dnsResolveNs } from 'node:dns/promises';

// Launch TLDs, most useful first. `.dev` leads (the common launch TLD); `.com` is
// last because it is parked for essentially every candidate (low signal).
export const DEFAULT_TLDS = Object.freeze(['dev', 'io', 'ai', 'app', 'co', 'com']);

// TLDs whose registrant answers RDAP slowly and reports PARKED domains as available
// (Google Registry). For these, DNS NS-delegation is authoritative and RDAP is skipped.
export const GOOGLE_REGISTRY_TLDS = new Set(['dev', 'app', 'page']);

// TLDs that are almost always parked, so an "available" is rare and a "taken" is weak
// signal. Surfaced as a note, not a different status.
export const LOW_SIGNAL_TLDS = new Set(['com']);

const REGISTRY_DEFS = {
  npm: { host: 'registry.npmjs.org', url: (s) => `https://registry.npmjs.org/${s}` },
  pypi: { host: 'pypi.org', url: (s) => `https://pypi.org/pypi/${s}/json` },
  crates: { host: 'crates.io', url: (s) => `https://crates.io/api/v1/crates/${s}` },
  rubygems: { host: 'rubygems.org', url: (s) => `https://rubygems.org/api/v1/gems/${s}.json` },
  nuget: { host: 'api.nuget.org', url: (s) => `https://api.nuget.org/v3-flatcontainer/${s}/index.json` },
};

const SOCIAL_DEFS = {
  x: (s) => `https://x.com/${s}`,
  instagram: (s) => `https://instagram.com/${s}`,
  tiktok: (s) => `https://tiktok.com/@${s}`,
  youtube: (s) => `https://youtube.com/@${s}`,
  reddit: (s) => `https://reddit.com/user/${s}`,
  bluesky: (s) => `https://bsky.app/profile/${s}.bsky.social`,
  threads: (s) => `https://threads.net/@${s}`,
};

/** Pre-filled trademark / business search entry points for a name. */
export function referenceLinks(name) {
  const q = encodeURIComponent(name);
  return {
    uspto: 'https://tmsearch.uspto.gov/',
    euipo: 'https://www.tmdn.org/tmview/',
    wipo: 'https://branddb.wipo.int/',
    opencorporates: `https://opencorporates.com/companies?q=${q}`,
    websearch: `https://duckduckgo.com/?q=${q}+trademark+OR+company`,
  };
}

/** Map an HTTP result to an availability status. 404 = free; 2xx / redirect = taken. */
export function mapStatus(res) {
  const s = res.status;
  if (s === 404) return 'available';
  if (s >= 200 && s < 300) return 'taken';
  if (res.redirected) return 'taken'; // redirect to a canonical usually means it exists
  if (s === 0 || s === 429 || s === 403 || s === 401) return 'unknown'; // network/throttle/auth
  return 'unknown';
}

const INTERNAL_SUFFIXES = ['.local', '.internal', '.localhost', '.lan', '.home', '.corp'];
const INTERNAL_NAMES = new Set(['localhost', 'metadata.google.internal']);

/** Lower-case a host and strip trailing dots (a trailing dot is a legal FQDN form). */
export function normalizeHost(host) {
  return String(host || '').toLowerCase().replace(/\.+$/, '');
}

/** True for an IPv4/IPv6 literal (RDAP registry servers are named, not IPs). */
function isIpLiteral(host) {
  if (host.includes(':')) return true; // IPv6
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true; // IPv4 dotted-decimal
  // Obfuscated IPv4 forms that still resolve to an address: dotted-octal
  // (0177.0.0.1), hex (0x7f.0.0.1), or a single 32-bit integer (2130706433). Any
  // host whose every label is purely numeric/hex is treated as an IP literal.
  if (host.split('.').every((label) => /^(0x[0-9a-f]+|\d+)$/.test(label))) return true;
  return false;
}

/**
 * Is this address in a private, loopback, link-local, or reserved range? Used to
 * defeat DNS-rebinding: a public hostname that resolves to an internal address.
 */
export function isPrivateAddress(ip) {
  if (!ip) return true;
  const addr = String(ip).toLowerCase().replace(/%.+$/, ''); // drop any zone id
  if (addr.includes(':')) {
    const hex = addr.replace(/:/g, '');
    if (addr === '::' || /^0*1$/.test(hex)) return true; // unspecified / loopback (::, ::1, expanded)
    if (/^fe[89a-f]/.test(addr)) return true; // fe80::/10 link-local + fec0::/10 site-local
    if (/^f[cd]/.test(addr)) return true; // fc00::/7 unique-local
    // IPv4-mapped, dotted (::ffff:127.0.0.1) or hex (::ffff:7f00:1)
    const mappedDotted = addr.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mappedDotted) return isPrivateAddress(mappedDotted[1]);
    const mappedHex = addr.match(/::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (mappedHex) {
      const hi = parseInt(mappedHex[1], 16);
      const lo = parseInt(mappedHex[2], 16);
      return isPrivateAddress(`${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`);
    }
    return false;
  }
  const parts = addr.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true; // link-local (incl. cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true; // multicast / reserved
  return false;
}

/**
 * Reject redirect targets that are not plausible public hostnames. Normalizes the
 * trailing dot first (so `localhost.` and `metadata.google.internal.` cannot slip
 * past), rejects every IP literal and known-internal name, and requires an FQDN.
 */
export function isPlausiblePublicHost(host) {
  const h = normalizeHost(host);
  if (!h) return false;
  if (isIpLiteral(h)) return false; // no IP literals (v4 or v6)
  if (!h.includes('.')) return false; // must be an FQDN
  if (INTERNAL_NAMES.has(h)) return false;
  for (const suffix of INTERNAL_SUFFIXES) {
    if (h.endsWith(suffix)) return false;
  }
  return true;
}

/** Resolve a host and require every address to be public (defeats DNS rebinding). */
async function hostResolvesPublic(host, resolver) {
  if (!resolver) return true; // resolver disabled -> rely on the syntactic guard
  try {
    const addrs = await resolver(host, { all: true });
    if (!addrs || !addrs.length) return false;
    return addrs.every((a) => !isPrivateAddress(a.address));
  } catch {
    return false; // cannot resolve -> treat as unsafe
  }
}

/**
 * Follow the RDAP redirect chain safely. `rdap.org` is an IANA-bootstrapped
 * redirector: it 302s to the authoritative registry RDAP server. Hop 0 is
 * constrained to the default host allowlist (which contains rdap.org). Every
 * later hop must clear TWO independent gates before it is fetched: a hardened
 * syntactic check (`isPlausiblePublicHost`, no IP literals / internal names /
 * trailing-dot tricks) AND a DNS check that every resolved address is public
 * (`hostResolvesPublic`, which reduces DNS-rebinding risk). The check-then-fetch
 * is not a fully pinned connect, so a resolve/connect TOCTOU window remains in
 * theory; it has no attacker-controlled trigger here because hop 0 is pinned to
 * `rdap.org` and only redirects to IANA registry servers (never attacker input).
 * Only then is that exact host permitted for the hop. The gates, not the per-hop
 * allowlist, are the security boundary. `opts.resolveHost` is injectable (tests);
 * pass `null` to disable DNS.
 */
async function rdapFetch(url, opts, maxHops = 3) {
  const resolver = opts.resolveHost === undefined ? dnsLookup : opts.resolveHost;
  let current = url;
  let followedRedirect = false;
  for (let hop = 0; hop < maxHops; hop++) {
    let rawHost;
    try {
      rawHost = new URL(current).hostname;
    } catch {
      return { status: 0, redirected: false, followedRedirect };
    }
    if (hop > 0) {
      if (!isPlausiblePublicHost(rawHost)) return { status: 0, redirected: false, followedRedirect };
      if (!(await hostResolvesPublic(rawHost, resolver))) return { status: 0, redirected: false, followedRedirect };
    }
    let res;
    try {
      res = await safeFetch(current, { ...opts, allowlist: hop === 0 ? undefined : [rawHost] });
    } catch {
      return { status: 0, redirected: false, followedRedirect }; // host rejected by safeFetch -> unknown
    }
    if (res.redirected && res.headers.location) {
      let loc;
      try {
        loc = new URL(res.headers.location, current).toString();
      } catch {
        return { ...res, followedRedirect };
      }
      if (new URL(loc).protocol !== 'https:') return { status: 0, redirected: false, followedRedirect };
      current = loc;
      followedRedirect = true;
      continue;
    }
    return { ...res, followedRedirect };
  }
  return { status: 0, redirected: false, followedRedirect }; // too many hops -> unknown
}

/**
 * Does this domain have NS delegation? This is the authoritative "is it registered"
 * signal: a registered domain (parked OR live) has NS records in the parent zone; an
 * unregistered one has none. More reliable than RDAP (which false-positives on parked
 * `.dev`) and than A-record resolution (parked domains often have NS but no A).
 * Returns `true` (registered), `false` (no delegation), or `null` (could not check).
 * `opts.resolveNs` is injectable for tests; pass `null` to disable.
 */
async function hasNsDelegation(domain, opts) {
  const resolver = opts.resolveNs === undefined ? dnsResolveNs : opts.resolveNs;
  if (!resolver) return null;
  try {
    const ns = await resolver(domain);
    return Array.isArray(ns) ? ns.length > 0 : Boolean(ns);
  } catch (err) {
    // Genuinely no delegation -> false (unregistered). Any OTHER error (timeout,
    // servfail, refused, network blip) is "could not determine" -> null, so the
    // caller degrades to `unknown` instead of a FALSE `available`.
    const code = err && err.code;
    if (code === 'ENOTFOUND' || code === 'ENODATA' || code === 'NXDOMAIN') return false;
    return null;
  }
}

/**
 * Check one domain. DNS NS-delegation is the primary signal; RDAP confirms the
 * "available" case for non-Google TLDs (where RDAP is fast and correct).
 *
 *   NS present                  -> taken (parked or live)
 *   NS absent, Google TLD       -> available (NS is authoritative; skip slow RDAP)
 *   NS absent, other TLD        -> confirm via RDAP (catches registered-but-not-yet
 *                                  -delegated), falling back to available if RDAP is
 *                                  inconclusive
 *   NS undetermined (error)     -> unknown (never guess available)
 */
export async function checkDomain(slug, tld, opts = {}) {
  const t = String(tld).toLowerCase().replace(/[^a-z0-9-]/g, ''); // TLDs are [a-z0-9-]
  if (!t) return 'unknown';
  const domain = `${slug}.${t}`;
  const nsPresent = await hasNsDelegation(domain, opts);
  if (nsPresent === true) return 'taken';
  if (GOOGLE_REGISTRY_TLDS.has(t)) {
    return nsPresent === false ? 'available' : 'unknown';
  }
  // Non-Google TLD: confirm the NS-absent case with RDAP.
  const res = await rdapFetch(`https://rdap.org/domain/${domain}`, { timeoutMs: 10000, ...opts });
  if (res.followedRedirect) return mapStatus(res); // authoritative registry answer
  if (res.status >= 200 && res.status < 400) return mapStatus(res); // rare direct answer
  // rdap.org gave a direct 404 (it has no RDAP for this TLD): NS is the authority.
  if (res.status === 404 && nsPresent === false) return 'available';
  // timeout / inconclusive: do not guess.
  return 'unknown';
}

/** Check the configured TLDs for a slug. */
export async function checkDomains(slug, opts = {}) {
  const tlds = opts.tlds || DEFAULT_TLDS;
  const results = await mapWithConcurrency(tlds, opts.concurrency || 4, async (tld) => [
    tld,
    await checkDomain(slug, tld, opts),
  ]);
  return Object.fromEntries(results);
}

/** Check whether a GitHub org/user handle is free. */
export async function checkGithubHandle(slug, opts = {}) {
  const headers = {};
  const token = opts.githubToken;
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await safeFetch(`https://api.github.com/users/${slug}`, {
    ...opts,
    headers,
  });
  return mapStatus(res);
}

/** Check whether a specific `owner/repo` exists (optional; needs an owner). */
export async function checkGithubRepo(owner, slug, opts = {}) {
  const o = slugify(owner);
  if (!o) return 'unknown';
  const headers = {};
  if (opts.githubToken) headers.authorization = `Bearer ${opts.githubToken}`;
  const res = await safeFetch(`https://api.github.com/repos/${o}/${slug}`, {
    ...opts,
    headers,
  });
  return mapStatus(res);
}

export async function checkGithub(slug, opts = {}) {
  const out = { org: await checkGithubHandle(slug, opts) };
  if (opts.owner) out.repo = await checkGithubRepo(opts.owner, slug, opts);
  return out;
}

/** Check one package registry. For npm, a "taken" is inspected for a reclaimed tombstone. */
export async function checkRegistry(slug, registry, opts = {}) {
  const def = REGISTRY_DEFS[registry];
  if (!def) return 'unknown';
  const res = await safeFetch(def.url(slug), opts);
  const status = mapStatus(res);
  if (registry === 'npm' && status === 'taken') {
    // A 200 with zero versions / an unpublished marker is a reclaimed tombstone: still
    // taken, but blocked from reuse (a package unpublished years ago leaves a tombstone).
    try {
      const doc = JSON.parse(await res.text());
      const versionCount = doc && doc.versions ? Object.keys(doc.versions).length : 0;
      const unpublished = Boolean(doc && doc.time && doc.time.unpublished);
      if (versionCount === 0 || unpublished) {
        return { status: 'taken', tombstone: true, note: 'reclaimed npm tombstone (blocked from reuse)' };
      }
    } catch {
      /* body unavailable or unparseable -> plain taken */
    }
  }
  return status;
}

/** Check the configured registries for a slug. */
export async function checkRegistries(slug, opts = {}) {
  const names = opts.registries || Object.keys(REGISTRY_DEFS);
  const results = await mapWithConcurrency(names, opts.concurrency || 4, async (r) => [
    r,
    await checkRegistry(slug, r, opts),
  ]);
  return Object.fromEntries(results);
}

/**
 * When a bare handle/org/domain is taken, propose decorated forms that are commonly
 * free (a `<name>hq` or `get<name>` org, for example). The agent can then screen these.
 */
export function suggestHandleVariants(name) {
  const s = slugify(name);
  if (!s) return [];
  const out = new Set([
    `get${s}`, `${s}hq`, `${s}dev`, `${s}app`, `${s}labs`, `${s}io`, `use${s}`, `try${s}`,
  ]);
  out.delete(s);
  return [...out];
}

/**
 * Social handles: best-effort link-outs. Platforms block automated checks and
 * return soft-404s, so we deliberately do NOT scrape. Each entry is `unknown`
 * with a verify URL the user clicks. Honest by design.
 */
export function socialChannels(slug, opts = {}) {
  const platforms = opts.social || Object.keys(SOCIAL_DEFS);
  const out = {};
  for (const p of platforms) {
    const build = SOCIAL_DEFS[p];
    if (!build) continue;
    out[p] = { status: 'unknown', bestEffort: true, url: build(slug), note: 'verify manually' };
  }
  return out;
}

/**
 * Trademark + business channels from the famous-marks screen.
 *
 * A CONFIDENT hit (exact / compact / whole-word) is a collision that drives the
 * Deal Breaker verdict. A NEAR-MISS (one character off) is only a soft caution:
 * plenty of legitimately distinct real words sit one edit from a brand
 * ("Strive" vs "Stripe", "Slick" vs "Slack"), so a near-miss must never nuke a
 * name to Deal Breaker. It surfaces as a note for the user (and the agent's live
 * web search) to judge. Anything else is `unknown` (no legal clearance claimed).
 */
export function markChannels(name) {
  const m = matchFamousMark(name);
  const links = referenceLinks(name);
  if (m.hit && m.matchType !== 'near-miss') {
    const collision = {
      status: 'collision',
      famous: true,
      mark: m.mark,
      category: m.category,
      matchType: m.matchType,
      reason: m.reason,
      links,
    };
    return { trademark: collision, business: { ...collision } };
  }
  if (m.hit && m.matchType === 'near-miss') {
    const caution = {
      status: 'caution',
      famous: false,
      near: m.mark,
      category: m.category,
      matchType: 'near-miss',
      note: `${m.reason} Distinct enough to use, but worth a manual check.`,
      links,
    };
    return { trademark: { ...caution }, business: { ...caution } };
  }
  const open = { status: 'unknown', famous: false, note: 'no obvious collision; not legal clearance', links };
  return { trademark: { ...open }, business: { ...open } };
}

/**
 * Full availability scan for a name -> one scorecard.
 * @param {string} name
 * @param {Object} [opts]
 * @param {typeof fetch} [opts.fetchImpl] injected for tests
 * @param {string} [opts.githubToken]
 * @param {string[]} [opts.tlds]
 * @param {string[]} [opts.registries]
 * @param {string[]} [opts.social]
 * @param {string} [opts.owner] to also check owner/repo
 */
export async function check(name, opts = {}) {
  const slug = slugify(name);
  if (!slug) {
    return { name, slug: '', error: 'unusable-name', channels: {}, notes: [] };
  }
  const [domains, github, registries] = await Promise.all([
    checkDomains(slug, opts),
    checkGithub(slug, opts),
    checkRegistries(slug, opts),
  ]);
  const social = socialChannels(slug, opts);
  const { trademark, business } = markChannels(name);
  const notes = [];
  const npm = registries.npm;
  if (npm && typeof npm === 'object' && npm.note) notes.push(`npm: ${npm.note}`);
  for (const tld of LOW_SIGNAL_TLDS) {
    if (domains[tld] === 'available') {
      notes.push(`.${tld} shows available but is parked for nearly every name; low-signal.`);
    }
  }
  return {
    name,
    slug,
    checkedAt: new Date().toISOString(),
    channels: { trademark, business, domains, github, registries, social },
    notes,
  };
}

/** Check several names with bounded concurrency. */
export async function checkMany(names, opts = {}) {
  return mapWithConcurrency(names, opts.nameConcurrency || 3, (n) => check(n, opts));
}
