// canvas-kit/net.mjs
//
// Server-side network safety for canvases that fetch external data. A canvas
// action runs on the loopback runtime with the app's network reach, so a
// caller-influenced URL is an SSRF risk: it could target cloud metadata
// (169.254.169.254), loopback, or the private network. This module is the kit's
// sanctioned egress primitive — validate a URL, then fetch it with a hard
// timeout — so every data canvas guards the same way instead of re-inlining the
// check. SERVER-ONLY (uses node:dns / node:net): import it from the SDK-free
// canvas.mjs, never from the browser view.
//
// Defense-in-depth, not a guarantee: a determined attacker could DNS-rebind
// between the resolve check and the connect. For a canvas pointed at a source
// you choose this is adequate; treat any fetched content as untrusted and render
// it as TEXT (never innerHTML).

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * True for addresses a server-side fetch should never reach: loopback,
 * link-local (incl. cloud metadata 169.254.169.254), and private/CGNAT ranges.
 * @param {string} ip
 * @returns {boolean}
 */
export function isBlockedAddress(ip) {
  const lower = ip.toLowerCase();
  // Decode an IPv4-mapped/compatible IPv6 literal down to its embedded IPv4 so
  // the IPv4 range checks apply. Covers BOTH the dotted tail (::ffff:127.0.0.1)
  // and the HEX tail that `new URL()` normalizes literals to (::ffff:7f00:1) —
  // without the decode, `[::ffff:127.0.0.1]` reaches loopback and
  // `[::ffff:a9fe:a9fe]` reaches cloud metadata. Only matches when the high bits
  // are all zero (leading "::"), so a normal public v6 (e.g. 2001:db8::7f00:1) is
  // never misread as IPv4.
  const addr = embeddedIPv4(lower) ?? ip;
  if (isIP(addr) === 4) {
    const [a, b] = addr.split(".").map(Number);
    if (a === 0 || a === 127 || a === 10) return true;     // this-host / loopback / private
    if (a === 169 && b === 254) return true;               // link-local (incl. cloud IMDS)
    if (a === 172 && b >= 16 && b <= 31) return true;      // private
    if (a === 192 && b === 168) return true;               // private
    if (a === 100 && b >= 64 && b <= 127) return true;     // CGNAT
    return false;
  }
  return lower === "::1" || lower === "::" || lower.startsWith("fe80") || lower.startsWith("fc") || lower.startsWith("fd");
}

// Decode an IPv4-mapped/compatible IPv6 literal (all-zero high groups, i.e. a
// leading "::", optionally "::ffff:") to its dotted IPv4; else null. Accepts the
// dotted tail (127.0.0.1) and the two-hex-group tail (7f00:1) that URL
// normalization produces. Anchored on "::" so it can't misread a public v6.
function embeddedIPv4(addr) {
  const m = addr.match(/^::(?:ffff:)?((?:\d{1,3}\.){3}\d{1,3}|[0-9a-f]{1,4}:[0-9a-f]{1,4})$/);
  if (!m) return null;
  const tail = m[1];
  if (tail.includes(".")) return isIP(tail) === 4 ? tail : null;
  const [h1, h2] = tail.split(":");
  const hi = parseInt(h1, 16), lo = parseInt(h2, 16);
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

/**
 * Allow only http/https to a PUBLIC host. Rejects every address the hostname
 * resolves to, so a public name can't be pointed at an internal IP. Throws on a
 * blocked/invalid URL; resolves to void when the URL is safe to fetch.
 * @param {string} url
 */
export async function assertPublicUrl(url) {
  let u;
  try { u = new URL(url); } catch { throw new Error("Invalid source URL"); }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error("Blocked URL protocol: " + u.protocol);
  }
  let host = u.hostname;
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1); // IPv6 brackets
  if (host.toLowerCase() === "localhost") throw new Error("Blocked host: localhost");
  const addrs = isIP(host) ? [host] : (await lookup(host, { all: true })).map((r) => r.address);
  if (!addrs.length) throw new Error("Could not resolve host: " + host);
  for (const ip of addrs) {
    if (isBlockedAddress(ip)) throw new Error("Blocked private/loopback address: " + ip);
  }
}

/**
 * SSRF-guarded fetch with a mandatory timeout. Runs assertPublicUrl(url) first,
 * then fetch() with an AbortSignal.timeout so a slow upstream can't hang the
 * panel. Returns the Response as-is (does NOT throw on a non-2xx status — the
 * caller checks res.ok), so it is a drop-in for a guarded fetch().
 * @param {string} url
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=12000]  abort the request after this many ms
 * @param {object} [opts.headers]          request headers (merged as-is)
 * @param {RequestInit} [opts.rest]        any other fetch init (method, body, …)
 * @returns {Promise<Response>}
 */
export async function safeFetch(url, { timeoutMs = 12000, headers, ...rest } = {}) {
  await assertPublicUrl(url);
  return fetch(url, {
    ...rest,
    headers: headers ?? {},
    signal: AbortSignal.timeout(timeoutMs),
  });
}
