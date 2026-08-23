/**
 * Tests for the public unicast address boundary.
 *
 * The audit rule is set-wide: one unsafe answer rejects the entire hostname,
 * because selecting a safe-looking sibling from a mixed answer set is exactly
 * how DNS rebinding gets through.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { assertPublicUnicastSet, unsafeReason } from "../scripts/public-address.mjs";

const execFileAsync = promisify(execFile);
const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "public-address.mjs");

test("public unicast addresses are accepted", () => {
  for (const address of [
    "104.16.132.229",
    "20.109.151.31",
    "8.8.8.8",
    "2606:4700::6810:84e5",
    "2001:4860:4860::8888",
  ]) {
    assert.equal(unsafeReason(address), null, `${address} should be public unicast`);
  }
});

test("non-global IPv4 ranges are rejected with a reason", () => {
  const expected = {
    "0.0.0.0": "unspecified",
    "10.0.0.5": "private",
    "127.0.0.1": "loopback",
    "100.64.0.1": "carrier-grade NAT",
    "169.254.169.254": "link-local or cloud metadata",
    "172.16.0.1": "private",
    "192.168.1.1": "private",
    "198.18.0.1": "benchmarking",
    "203.0.113.1": "documentation",
    "224.0.0.1": "multicast or reserved",
  };
  for (const [address, reason] of Object.entries(expected)) {
    assert.equal(unsafeReason(address), reason, address);
  }
});

test("non-global IPv6 ranges, including transition prefixes, are rejected", () => {
  const expected = {
    "::1": "loopback",
    "fe80::1": "link-local",
    "fc00::1": "unique local",
    "fd00::1": "unique local",
    "fec0::1": "site-local",
    "ff02::1": "multicast",
    "2001:db8::1": "documentation",
    "2002::1": "6to4 transition",
    "64:ff9b::1": "NAT64",
  };
  for (const [address, reason] of Object.entries(expected)) {
    assert.equal(unsafeReason(address), reason, address);
  }
});

test("IPv4-mapped addresses are judged by the embedded address, not the prefix", () => {
  // A trailing dotted quad is legal IPv6 text. Reading it as hex would put
  // every mapped address on the wrong prefix, so both directions are asserted.
  assert.equal(unsafeReason("::ffff:8.8.8.8"), null);
  assert.equal(unsafeReason("::ffff:104.16.132.229"), null);
  assert.equal(unsafeReason("0:0:0:0:0:ffff:8.8.8.8"), null);
  assert.equal(unsafeReason("::ffff:10.0.0.1"), "private");
  assert.equal(unsafeReason("::ffff:127.0.0.1"), "loopback");
  assert.equal(unsafeReason("::ffff:169.254.169.254"), "link-local or cloud metadata");
  assert.equal(unsafeReason("::FFFF:169.254.169.254"), "link-local or cloud metadata");
  assert.equal(unsafeReason("::ffff:a9fe:a9fe"), "link-local or cloud metadata");
});

test("every IPv4-embedding prefix inside ::/64 is judged, not just the mapped form", () => {
  // Regression: requiring the first five groups to be zero let the RFC 6052
  // IPv4-translated form (::ffff:0:a.b.c.d) fall through as public while
  // embedding the cloud metadata address.
  assert.notEqual(unsafeReason("::ffff:0:169.254.169.254"), null);
  assert.notEqual(unsafeReason("::ffff:0:10.0.0.1"), null);
  // Even a public embedded address is refused through a reserved prefix,
  // because only ::ffff:a.b.c.d is an ordinary reachable alias.
  assert.match(unsafeReason("::ffff:0:8.8.8.8"), /reserved or deprecated/);
  assert.match(unsafeReason("::8.8.8.8"), /reserved or deprecated/);
});

test("the IPv6 boundary is an allowlist, so unallocated space fails closed", () => {
  // Regression: the boundary used to be a denylist ending in "allow", so every
  // address outside the enumerated prefixes was treated as public unicast.
  // 2000::/3 is the only IANA global unicast allocation, so anything else has
  // to be refused by construction rather than by enumeration.
  for (const address of [
    "100::1", // discard-only, RFC 6666
    "100:0:0:1::1", // dummy prefix, RFC 9780
    "5f00::1", // SRv6 SIDs
    "1::1",
    "4000::1",
    "8000::1",
    "fe00::1",
    "fbff::1",
  ]) {
    assert.notEqual(unsafeReason(address), null, `${address} is not globally reachable`);
  }

  // The translated form 0:0:0:ffff:0:0:a.b.c.d sits outside ::/64, so the
  // embedded-IPv4 branch never sees it. It reached the old fall-through allow
  // while carrying loopback and cloud metadata in its low 32 bits.
  assert.notEqual(unsafeReason("::ffff:0:0:127.0.0.1"), null);
  assert.notEqual(unsafeReason("0:0:0:ffff:0:0:a9fe:a9fe"), null);

  // Reserved blocks that sit inside 2000::/3 are not covered by the gate and
  // still need explicit rules.
  assert.equal(unsafeReason("3fff::1"), "documentation");
  assert.equal(unsafeReason("2001:20::1"), "ORCHIDv2");

  // The 2001::/23 IETF protocol assignments catch-all encloses the named
  // sub-blocks. Ordering it first made the specific rules unreachable and
  // mislabelled every address in them, so pin each reason independently.
  assert.equal(unsafeReason("2001::1"), "Teredo");
  assert.equal(unsafeReason("2001:db8::1"), "documentation");
  assert.equal(unsafeReason("2001:100::1"), "IETF protocol assignments");

  // Real global unicast has to keep working, or the audit refuses live hosts.
  for (const address of [
    "2606:4700:4700::1111",
    "2620:fe::fe",
    "2a00:1450:4001:81f::200e",
    "3000::1",
    "2001:200::1",
  ]) {
    assert.equal(unsafeReason(address), null, `${address} is public unicast`);
  }
});

test("special-purpose IPv4 rules match at their real prefix boundaries", () => {
  // These blocks are /24s. Widening them to the enclosing /16 would refuse
  // allocated space and break audits of legitimate public hosts.
  assert.equal(unsafeReason("192.0.0.192"), "IETF protocol assignment");
  assert.equal(unsafeReason("192.0.2.5"), "documentation");
  assert.equal(unsafeReason("198.51.100.7"), "documentation");
  assert.equal(unsafeReason("203.0.113.9"), "documentation");
  for (const address of ["192.0.1.5", "192.0.3.9", "198.51.101.5", "203.0.114.5"]) {
    assert.equal(unsafeReason(address), null, `${address} is allocated public space`);
  }

  // Globally assigned, but it is the Azure host agent and a live SSRF target
  // from inside an Azure VM.
  assert.equal(unsafeReason("168.63.129.16"), "cloud platform host agent");
  assert.equal(unsafeReason("168.63.129.17"), null);
});

test("values that are not IP addresses are rejected", () => {
  for (const value of ["", "not-an-ip", "example.com", "999.1.1.1", "::gggg"]) {
    assert.notEqual(unsafeReason(value), null, JSON.stringify(value));
  }
});

test("one unsafe answer rejects the whole set", () => {
  assert.deepEqual(
    assertPublicUnicastSet(["104.16.132.229", "2606:4700::1"]),
    ["104.16.132.229", "2606:4700::1"],
  );
  assert.throws(
    () => assertPublicUnicastSet(["104.16.132.229", "169.254.169.254"]),
    /169\.254\.169\.254 is link-local or cloud metadata/,
  );
  assert.throws(() => assertPublicUnicastSet([]), /no addresses/);
  assert.throws(() => assertPublicUnicastSet(null), /no addresses/);
});

test("the executable reports safe sets on stdout and unsafe sets on stderr", async () => {
  const safe = await execFileAsync(process.execPath, [SCRIPT, "104.16.132.229", "2606:4700::1"]);
  assert.equal(JSON.parse(safe.stdout).status, "safe");

  await assert.rejects(
    execFileAsync(process.execPath, [SCRIPT, "104.16.132.229", "169.254.169.254"]),
    (error) => {
      const failure = JSON.parse(error.stderr);
      assert.equal(error.code, 1);
      assert.equal(error.stdout, "");
      assert.equal(failure.status, "unsafe");
      assert.match(failure.error, /link-local or cloud metadata/);
      return true;
    },
  );
});
