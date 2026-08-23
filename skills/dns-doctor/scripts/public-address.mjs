#!/usr/bin/env node

/**
 * Validates that every supplied address is public unicast.
 *
 * The audit rule is set-wide: one unsafe answer rejects the whole hostname,
 * because accepting a safe-looking sibling is exactly what DNS rebinding
 * exploits. This ships as a script so shell recipes do not reimplement the
 * boundary, and so Windows does not need Python to run an audit.
 *
 * Exits 0 when the set is non-empty and every address is safe to contact.
 * Exits 1 otherwise, naming the first address that failed.
 */

import { isIP } from "node:net";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

function parts(address) {
  return address.split(".").map((value) => Number(value));
}

function unsafeIPv4Reason(address) {
  const [a, b, c] = parts(address);
  if (a === 0) return "unspecified";
  if (a === 10) return "private";
  if (a === 127) return "loopback";
  if (a === 100 && b >= 64 && b <= 127) return "carrier-grade NAT";
  if (a === 169 && b === 254) return "link-local or cloud metadata";
  if (a === 172 && b >= 16 && b <= 31) return "private";
  // Match the special-purpose registry at its real /24 boundaries. Rounding
  // these up to the enclosing /16 would refuse allocated space and make the
  // audit fail on legitimate public hosts.
  if (a === 192 && b === 0 && c === 0) return "IETF protocol assignment";
  if (a === 192 && b === 0 && c === 2) return "documentation";
  if (a === 192 && b === 168) return "private";
  if (a === 198 && (b === 18 || b === 19)) return "benchmarking";
  if (a === 198 && b === 51 && c === 100) return "documentation";
  if (a === 203 && b === 0 && c === 113) return "documentation";
  if (a >= 224) return "multicast or reserved";
  // Globally assigned unicast, so not a special-purpose block, but it is the
  // Azure host agent (wireserver) magic address and a live SSRF target for any
  // audit that runs from inside an Azure VM.
  if (address === "168.63.129.16") return "cloud platform host agent";
  return null;
}

function expand(address) {
  // A trailing dotted quad is legal IPv6 text (::ffff:8.8.8.8). Convert it to
  // two hex groups first, otherwise parseInt reads "8.8.8.8" as 0x8 and every
  // IPv4-mapped address lands on the wrong prefix.
  let value = address;
  const dotted = /:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(value);
  if (dotted) {
    const quad = dotted[1].split(".").map((part) => Number(part));
    if (quad.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
      return [Number.NaN];
    }
    const high = ((quad[0] << 8) | quad[1]).toString(16);
    const low = ((quad[2] << 8) | quad[3]).toString(16);
    value = `${value.slice(0, dotted.index)}:${high}:${low}`;
  }
  const [head, tail = ""] = value.split("::");
  const left = head ? head.split(":").filter(Boolean) : [];
  const right = tail ? tail.split(":").filter(Boolean) : [];
  const missing = 8 - left.length - right.length;
  const groups = value.includes("::")
    ? [...left, ...Array(Math.max(missing, 0)).fill("0"), ...right]
    : left;
  return groups.map((group) => Number.parseInt(group || "0", 16));
}

function unsafeIPv6Reason(address) {
  const value = address.toLowerCase().split("%")[0];
  if (value === "::" ) return "unspecified";
  if (value === "::1") return "loopback";
  const groups = expand(value);
  if (groups.length !== 8 || groups.some(Number.isNaN)) return "unparseable";
  const [first, second] = groups;
  // Everything inside ::/64 carries an embedded IPv4 address in its low 32
  // bits: the unspecified and loopback forms, IPv4-mapped (::ffff:a.b.c.d),
  // the deprecated IPv4-compatible form (::a.b.c.d), and the RFC 6052
  // IPv4-translated form (::ffff:0:a.b.c.d). Judge the whole block by the
  // embedded address, since ::ffff:a.b.c.d is the one form here that is a
  // legitimate alias for a reachable IPv4 host and has to survive the global
  // unicast gate below.
  if (groups.slice(0, 4).every((group) => group === 0)) {
    const embedded = `${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`;
    const embeddedReason = unsafeIPv4Reason(embedded);
    if (embeddedReason) return embeddedReason;
    if (groups[4] === 0 && groups[5] === 0xffff) return null;
    return "a reserved or deprecated IPv4-embedding form";
  }
  // Name the well-known reserved blocks explicitly so the audit report can say
  // why an address was refused rather than just that it was.
  if ((first & 0xfe00) === 0xfc00) return "unique local";
  if ((first & 0xffc0) === 0xfe80) return "link-local";
  if ((first & 0xffc0) === 0xfec0) return "site-local";
  if ((first & 0xff00) === 0xff00) return "multicast";
  if (first === 0x0064 && second === 0xff9b) return "NAT64";
  // 2000::/3 is the only range IANA has allocated as global unicast, so treat
  // it as an allowlist. A denylist here fails open: every unallocated block
  // (100::/64 discard-only, 3fff::/20 documentation, 5f00::/16 SRv6, and the
  // 0:0:0:ffff:0:0:a.b.c.d translated form that sits outside ::/64) would
  // otherwise fall through as public. The remaining rules below are
  // refinements inside the allocated range.
  if ((first & 0xe000) !== 0x2000) return "outside the allocated global unicast range";
  // 3fff::/20 is documentation space (RFC 9637). It sits inside 2000::/3, so
  // the gate above does not cover it.
  if ((first & 0xfff0) === 0x3ff0) return "documentation";
  if (first === 0x2002) return "6to4 transition";
  if (first === 0x2001) {
    // 2001::/23 is the IETF protocol assignments block (RFC 2928). Its named
    // sub-blocks must be tested before the /23 catch-all below, or they are
    // unreachable and report an inaccurate reason.
    if (second === 0x0db8) return "documentation";
    if (second === 0x0000) return "Teredo";
    if (second >= 0x0020 && second <= 0x002f) return "ORCHIDv2";
    if (second <= 0x01ff) return "IETF protocol assignments";
  }
  return null;
}

export function unsafeReason(address) {
  const version = isIP(address);
  if (version === 4) return unsafeIPv4Reason(address);
  if (version === 6) return unsafeIPv6Reason(address);
  return "not an IP address";
}

export function assertPublicUnicastSet(addresses) {
  if (!Array.isArray(addresses) || addresses.length === 0) {
    throw new Error("no addresses were supplied");
  }
  for (const address of addresses) {
    const reason = unsafeReason(address);
    if (reason) throw new Error(`${address} is ${reason}`);
  }
  return addresses;
}

const isDirect = process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isDirect) {
  try {
    const addresses = process.argv.slice(2);
    assertPublicUnicastSet(addresses);
    process.stdout.write(`${JSON.stringify({ status: "safe", addresses }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ status: "unsafe", error: error.message })}\n`);
    process.exitCode = 1;
  }
}
