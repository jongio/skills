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

function isBlockedIPv4(addr) {
  const [a, b, c] = addr.split(".").map(Number);
  if (a === 0 || a === 127 || a === 10) return true; // this-host / loopback / private
  if (a === 169 && b === 254) return true;           // link-local (incl. cloud IMDS)
  if (a === 172 && b >= 16 && b <= 31) return true;  // private
  if (a === 192 && b === 168) return true;           // private
  if (a === 192 && b === 0 && c === 0) return true;  // IETF protocol assignments
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking / overlay bridges
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true;                         // multicast / reserved / broadcast
  if (addr === "168.63.129.16") return true;         // Azure platform host agent
  return false;
}

function expandIPv6(address) {
  let value = address;
  const dotted = /:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(value);
  if (dotted) {
    const quad = dotted[1].split(".").map(Number);
    if (quad.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
      return null;
    }
    const high = ((quad[0] << 8) | quad[1]).toString(16);
    const low = ((quad[2] << 8) | quad[3]).toString(16);
    value = `${value.slice(0, dotted.index)}:${high}:${low}`;
  }
  const parts = value.split("::");
  if (parts.length > 2) return null;
  const [head, tail = ""] = parts;
  const left = head ? head.split(":").filter(Boolean) : [];
  const right = tail ? tail.split(":").filter(Boolean) : [];
  const missing = 8 - left.length - right.length;
  if (parts.length === 2 ? missing < 1 : left.length !== 8) return null;
  const groups = parts.length === 2
    ? [...left, ...Array(missing).fill("0"), ...right]
    : left;
  if (groups.some((g) => !/^[0-9a-f]{1,4}$/i.test(g))) return null;
  return groups.map((g) => parseInt(g, 16));
}

/**
 * True for addresses a server-side fetch should never reach: loopback,
 * link-local (incl. cloud metadata 169.254.169.254 and Azure host agent
 * 168.63.129.16), private/CGNAT ranges, and non-global-unicast or
 * IPv4-translating IPv6 prefixes (fe80::/10, fc00::/7, ::ffff:0:0/96,
 * 64:ff9b::/96, 2002::/16, Teredo).
 * @param {string} ip
 * @returns {boolean}
 */
export function isBlockedAddress(ip) {
  if (typeof ip !== "string" || !ip) return true;
  const clean = ip.toLowerCase().split("%")[0];
  if (isIP(clean) === 4) {
    return isBlockedIPv4(clean);
  }
  if (isIP(clean) !== 6) return true;
  if (clean === "::" || clean === "::1") return true;
  const groups = expandIPv6(clean);
  if (!groups) return true;
  const [first, second] = groups;
  // ::/64 carries embedded IPv4 in low 32 bits (::ffff:<v4>, ::<v4>, ::ffff:0:<v4>).
  // Permit only IPv4-mapped ::ffff:<v4> when the embedded IPv4 is itself public.
  if (groups.slice(0, 4).every((g) => g === 0)) {
    if (groups[4] !== 0 || groups[5] !== 0xffff) return true;
    const embedded = `${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`;
    return isBlockedIPv4(embedded);
  }
  if ((first & 0xfe00) === 0xfc00) return true; // unique local fc00::/7
  if ((first & 0xffc0) === 0xfe80) return true; // link-local fe80::/10 (fe80..febf)
  if ((first & 0xffc0) === 0xfec0) return true; // site-local fec0::/10
  if ((first & 0xff00) === 0xff00) return true; // multicast ff00::/8
  if (first === 0x0064 && (second === 0xff9b || second === 0xff9c)) return true; // NAT64
  if ((first & 0xe000) !== 0x2000) return true; // outside IANA global unicast 2000::/3
  if (first === 0x2002) return true;            // 6to4 transition
  if (first === 0x2001 && second === 0x0000) return true; // Teredo
  return false;
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
 * SSRF-guarded fetch with a mandatory timeout. Runs assertPublicUrl on the URL
 * and on EVERY redirect hop, so a chosen public host can't 30x-redirect the
 * request into loopback/metadata/private space. Returns the final Response as-is
 * (does NOT throw on a non-2xx status — the caller checks res.ok), so it is a
 * drop-in for a guarded fetch().
 *
 * Redirects are followed MANUALLY (redirect:"manual") rather than by fetch's
 * default redirect:"follow": the default would chase a 3xx Location without
 * re-running the guard, which silently undoes every check in this module. Here
 * each hop's target is re-validated before we connect to it.
 * @param {string} url
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=12000]     abort the WHOLE operation (all hops) after this many ms
 * @param {number} [opts.maxRedirects=5]      how many 3xx hops to follow before giving up
 * @param {object} [opts.headers]             request headers (merged as-is)
 * @param {RequestInit} [opts.rest]           any other fetch init (method, body, …)
 * @returns {Promise<Response>}
 */
export async function safeFetch(url, { timeoutMs = 12000, maxRedirects = 5, headers, ...rest } = {}) {
  // One timeout signal bounds the entire operation, redirects included, so a
  // chain of slow hops can't multiply the deadline.
  const signal = AbortSignal.timeout(timeoutMs);
  let current = url;
  for (let hop = 0; ; hop++) {
    await assertPublicUrl(current);
    const res = await fetch(current, {
      ...rest,
      headers: headers ?? {},
      redirect: "manual",
      signal,
    });
    if (res.status >= 300 && res.status < 400 && res.headers.has("location")) {
      if (hop >= maxRedirects) throw new Error("Too many redirects");
      const next = new URL(res.headers.get("location"), current).href;
      // Discard the redirect body so the connection can be freed before the next hop.
      try { await res.body?.cancel(); } catch { /* no body / already consumed */ }
      current = next;
      continue;
    }
    return res;
  }
}
