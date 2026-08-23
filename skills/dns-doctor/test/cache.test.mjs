import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix, resolve, sep, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import {
  CACHE_SCHEMA_VERSION,
  MAX_CACHE_BYTES,
  cachePathForDomain,
  loadBaseline,
  loadSnapshotFile,
  normalizeDomain,
  renameWithRetry,
  sanitizeSnapshot,
  saveBaseline,
} from "../scripts/cache-store.mjs";
import { DELTA_CLASSIFICATIONS, classifyDelta } from "../scripts/cache-delta.mjs";
import { main } from "../scripts/cache.mjs";
import {
  compareText,
  equivalent,
  stableJson,
  stableKey,
  stableValue,
} from "../scripts/stable-json.mjs";

const execFileAsync = promisify(execFile);
const SCRIPT = fileURLToPath(new URL("../scripts/cache.mjs", import.meta.url));

function snapshot(overrides = {}) {
  return {
    schemaVersion: CACHE_SCHEMA_VERSION,
    domain: "example.com",
    generatedAt: "2026-08-18T18:00:00Z",
    scope: ["security", "records"],
    intent: {
      canonicalWebHost: "example.com",
      redirectOnlyHosts: ["www.example.com"],
      mailMode: "send-and-receive",
      providers: ["Microsoft 365", "Cloudflare"],
      knownDkimSelectors: ["selector2", "selector1"],
    },
    checks: {
      "DEL-01": {
        state: "Verified",
        health: "Healthy",
        observed: ["ns2.example.net", "ns1.example.net"],
        sourceKinds: ["authoritative", "parent"],
        observedAt: "2026-08-18T18:00:00Z",
      },
      "SEC-01": {
        state: "Verified",
        health: "Unhealthy",
        observed: [{ algorithm: 13, signed: false }],
        sourceKinds: ["authoritative"],
        observedAt: "2026-08-18T18:00:00Z",
      },
    },
    findings: {
      "SEC-01:dnssec-unsigned": {
        severity: "Medium",
        status: "open",
        owner: "DNS",
        summary: "DNSSEC is not deployed",
      },
    },
    remediation: {
      "SEC-01:dnssec-unsigned": {
        state: "not-started",
        lastActionAt: null,
      },
    },
    ...overrides,
  };
}

async function temporaryDirectory() {
  return mkdtemp(join(tmpdir(), "dns-doctor-cache-"));
}

test("normalizeDomain returns a lowercase IDNA A-label and rejects unsafe targets", () => {
  assert.equal(CACHE_SCHEMA_VERSION, 1);
  assert.equal(MAX_CACHE_BYTES, 1_048_576);
  assert.equal(normalizeDomain("Example.COM."), "example.com");
  assert.equal(normalizeDomain("faß.de"), "xn--fa-hia.de");
  for (const invalid of [
    " example.com",
    "example.com ",
    "localhost",
    "127.0.0.1",
    "-bad.com",
    "bad..com",
    "a.com?x=1",
    "a.com#fragment",
    "a.com/path",
    "a.com\\other.test",
    "a\u202E.com",
  ]) {
    assert.throws(() => normalizeDomain(invalid), /domain/);
  }
});

test("cachePathForDomain uses each platform cache convention", () => {
  assert.equal(
    cachePathForDomain("EXAMPLE.com", {
      platform: "win32",
      env: { LOCALAPPDATA: "C:\\Local" },
      home: "C:\\Users\\Test",
    }),
    win32.join("C:\\Local", "dns-doctor", "cache", "example.com.json"),
  );
  assert.equal(
    cachePathForDomain("example.com", { platform: "darwin", env: {}, home: "/Users/test" }),
    posix.join("/Users/test", "Library", "Caches", "dns-doctor", "example.com.json"),
  );
  assert.equal(
    cachePathForDomain("example.com", {
      platform: "linux",
      env: { XDG_CACHE_HOME: "/cache" },
      home: "/home/test",
    }),
    posix.join("/cache", "dns-doctor", "example.com.json"),
  );
  assert.throws(
    () => cachePathForDomain("example.com", { platform: "linux", cacheRoot: "relative" }),
    /absolute path/,
  );
});

test("stable JSON helpers provide deterministic compact and persisted forms", () => {
  const value = { z: [{ b: 2, a: 1 }], a: true };
  const normalized = { a: true, z: [{ a: 1, b: 2 }] };

  assert.equal(compareText("a", "b"), -1);
  assert.equal(compareText("a", "a"), 0);
  assert.equal(compareText("b", "a"), 1);
  assert.deepEqual(stableValue(value), normalized);
  assert.equal(stableKey(value), JSON.stringify(normalized));
  assert.equal(stableJson(value), `${JSON.stringify(normalized, null, 2)}\n`);
  assert.equal(equivalent(value, normalized), true);
  assert.equal(equivalent(value, { ...normalized, a: false }), false);
});

test("sanitizeSnapshot strips unknown fields, sorts set-like arrays, and canonicalizes timestamps", () => {
  const sanitized = sanitizeSnapshot({
    ...snapshot(),
    ignored: "not persisted",
    generatedAt: "2026-08-18T18:00:00+00:00",
    intent: { ...snapshot().intent, ignored: "not persisted" },
  }, "example.com");
  assert.equal(sanitized.ignored, undefined);
  assert.equal(sanitized.intent.ignored, undefined);
  assert.equal(sanitized.generatedAt, "2026-08-18T18:00:00.000Z");
  assert.deepEqual(sanitized.scope, ["records", "security"]);
  assert.deepEqual(sanitized.intent.providers, ["Cloudflare", "Microsoft 365"]);
  assert.deepEqual(sanitized.intent.knownDkimSelectors, ["selector1", "selector2"]);
  assert.deepEqual(
    sanitizeSnapshot(snapshot({
      intent: {
        ...snapshot().intent,
        redirectOnlyHosts: ["WWW.example.com", "www.example.com"],
      },
    })).intent.redirectOnlyHosts,
    ["www.example.com"],
  );
});

test("sanitizeSnapshot rejects domain, schema, enum, timestamp, and prototype-key violations", () => {
  assert.throws(() => sanitizeSnapshot(snapshot({ schemaVersion: 2 })), /schema version/);
  assert.throws(() => sanitizeSnapshot(snapshot({ domain: "other.com" }), "example.com"), /mismatch/);
  assert.throws(
    () => sanitizeSnapshot(snapshot({
      checks: { "SEC-01": { ...snapshot().checks["SEC-01"], state: "Trusted" } },
    })),
    /unsupported value/,
  );
  assert.throws(() => sanitizeSnapshot(snapshot({ generatedAt: "yesterday" })), /timestamp/);
  assert.throws(
    () => sanitizeSnapshot(snapshot({ generatedAt: "2026-02-31T18:00:00Z" })),
    /calendar date/,
  );
  assert.throws(
    () => sanitizeSnapshot(snapshot({
      generatedAt: "2026-08-18T17:59:59Z",
    })),
    /cannot be later/,
  );
  assert.throws(
    () => sanitizeSnapshot(snapshot({
      checks: {
        "SEC-01": {
          ...snapshot().checks["SEC-01"],
          observed: ["Authorization: Bearer secret"],
        },
      },
    })),
    /credential or session material/,
  );
  assert.throws(
    () => sanitizeSnapshot(snapshot({
      checks: {
        "SEC-01": {
          ...snapshot().checks["SEC-01"],
          observed: [{ api_key: "REDACTED_TEST_VALUE" }],
        },
      },
    })),
    /credential or session material/,
  );
  assert.throws(
    () => sanitizeSnapshot(snapshot({
      checks: {
        "SEC-01": {
          ...snapshot().checks["SEC-01"],
          observed: "not-an-array",
        },
      },
    })),
    /bounded array/,
  );
  assert.throws(
    () => sanitizeSnapshot(snapshot({
      checks: {
        "SEC-01": {
          ...snapshot().checks["SEC-01"],
          observed: Array.from({ length: 101 }, () => "value"),
        },
      },
    })),
    /bounded array/,
  );
  assert.throws(
    () => sanitizeSnapshot(snapshot({
      findings: {
        "SEC-01:empty-summary": {
          severity: "Low",
          status: "open",
          owner: "DNS",
          summary: "",
        },
      },
    })),
    /non-empty bounded string/,
  );
  assert.throws(
    () => sanitizeSnapshot(snapshot({ checks: JSON.parse('{"__proto__":{"state":"Verified"}}') })),
    /invalid key/,
  );
  assert.throws(() => sanitizeSnapshot(null), /must be an object/);
  assert.throws(
    () => sanitizeSnapshot(snapshot({ scope: Array.from({ length: 101 }, () => "records") })),
    /bounded array/,
  );
  assert.throws(
    () => sanitizeSnapshot(snapshot({
      checks: {
        "SEC-01": {
          ...snapshot().checks["SEC-01"],
          observed: [[[[[["too deep"]]]]]],
        },
      },
    })),
    /maximum nesting depth/,
  );
  assert.throws(
    () => sanitizeSnapshot(snapshot({
      checks: {
        "SEC-01": {
          ...snapshot().checks["SEC-01"],
          observed: [{ "set-cookie": "sessionid=REDACTED_TEST_VALUE" }],
        },
      },
    })),
    /credential or session material/,
  );
});

test("sanitizeSnapshot rejects poisoned timestamps, bare secret values, and unprefixed finding keys", () => {
  const observedWith = (value) => ({
    checks: {
      "SEC-01": { ...snapshot().checks["SEC-01"], observed: [value] },
    },
  });

  // A far-future baseline would make every current observation look stale and
  // silently downgrade new findings to "Not reverified".
  assert.throws(
    () => sanitizeSnapshot(snapshot({ generatedAt: "2099-01-01T00:00:00Z" })),
    /too far in the future/,
  );

  // Secret values that do not label themselves as secrets.
  for (const secret of [
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJSRURBQ1RFRCJ9.REDACTED_TEST_SIGNATURE",
    "ghp_REDACTEDTESTVALUE0000000000000000",
    "AKIAREDACTEDTEST0000",
    "sk-proj-REDACTEDTESTVALUE00000000000",
    "Basic REDACTEDTESTVALUE00000",
  ]) {
    assert.throws(
      () => sanitizeSnapshot(snapshot(observedWith(secret))),
      /credential or session material/,
      `expected ${secret.slice(0, 12)} to be rejected`,
    );
  }

  // Key anchoring: these were reachable before the pattern used substrings.
  for (const key of ["x-authorization", "cookies"]) {
    assert.throws(
      () => sanitizeSnapshot(snapshot(observedWith({ [key]: "value" }))),
      /credential or session material/,
      `expected ${key} to be rejected`,
    );
  }

  // The delta engine resolves a finding to its check by the colon prefix.
  assert.throws(
    () => sanitizeSnapshot(snapshot({
      findings: {
        "dnssec-unsigned": {
          severity: "Low",
          status: "open",
          owner: "DNS",
          summary: "unprefixed",
        },
      },
    })),
    /must be named <checkId>:<slug>/,
  );

  // An untrusted schemaVersion must never be echoed back verbatim.
  assert.throws(
    () => sanitizeSnapshot({ ...snapshot(), schemaVersion: `${"A".repeat(5000)}` }),
    (error) => error.message.length < 80 && !error.message.includes("AAAA"),
  );
});

test("loadBaseline reports missing, persists deterministic JSON, and loads the sanitized baseline", async () => {
  const root = await temporaryDirectory();
  try {
    const options = { cacheRoot: root };
    assert.equal((await loadBaseline("example.com", options)).status, "missing");
    const saved = await saveBaseline("example.com", snapshot(), options);
    assert.equal(saved.status, "created");
    const firstText = await readFile(saved.path, "utf8");
    const updated = await saveBaseline("example.com", snapshot(), options);
    assert.equal(updated.status, "updated");
    assert.equal(await readFile(saved.path, "utf8"), firstText);
    const loaded = await loadBaseline("example.com", options);
    assert.equal(loaded.status, "found");
    assert.equal(loaded.baseline.domain, "example.com");
    assert.deepEqual(
      (await readdir(root)).filter((name) => name.endsWith(".tmp")),
      [],
    );
    if (process.platform !== "win32") {
      assert.equal((await lstat(saved.path)).mode & 0o777, 0o600);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("saveBaseline serializes concurrent writes and leaves one valid baseline", async () => {
  const root = await temporaryDirectory();
  try {
    const options = { cacheRoot: root };
    const writes = Array.from({ length: 12 }, (_, index) =>
      saveBaseline("example.com", snapshot({
        generatedAt: `2026-08-18T18:00:${String(index).padStart(2, "0")}Z`,
      }), options),
    );
    await Promise.all(writes);
    const loaded = await loadBaseline("example.com", options);
    assert.equal(loaded.status, "found");
    assert.equal(loaded.baseline.generatedAt, "2026-08-18T18:00:11.000Z");
    assert.deepEqual(
      (await readdir(root)).filter((name) => name.endsWith(".tmp")),
      [],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("saveBaseline rejects oversized snapshots without replacing the baseline", async () => {
  const root = await temporaryDirectory();
  const options = { cacheRoot: root };
  try {
    await saveBaseline("example.com", snapshot(), options);
    const checks = Object.fromEntries(
      Array.from({ length: 300 }, (_, index) => [
        `LARGE-${index}`,
        {
          state: "Verified",
          health: "Healthy",
          observed: ["x".repeat(4096)],
          sourceKinds: ["authoritative"],
          observedAt: "2026-08-18T18:00:00Z",
        },
      ]),
    );
    await assert.rejects(
      saveBaseline("example.com", snapshot({ checks }), options),
      /snapshot exceeds/,
    );
    const loaded = await loadBaseline("example.com", options);
    assert.equal(loaded.status, "found");
    assert.deepEqual(Object.keys(loaded.baseline.checks), ["DEL-01", "SEC-01"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("renameWithRetry retries transient Windows-style rename failures with bounded backoff", async () => {
  let attempts = 0;
  const delays = [];
  await renameWithRetry(
    "source",
    "destination",
    async () => {
      attempts++;
      if (attempts < 4) {
        const error = new Error("temporarily locked");
        error.code = attempts === 2 ? "EBUSY" : "EPERM";
        throw error;
      }
    },
    async (milliseconds) => delays.push(milliseconds),
  );
  assert.equal(attempts, 4);
  assert.deepEqual(delays, [25, 50, 100]);

  attempts = 0;
  await assert.rejects(
    renameWithRetry("source", "destination", async () => {
      attempts++;
      const error = new Error("I/O failure");
      error.code = "EIO";
      throw error;
    }),
    /I\/O failure/,
  );
  assert.equal(attempts, 1);

  attempts = 0;
  await assert.rejects(
    renameWithRetry(
      "source",
      "destination",
      async () => {
        attempts++;
        const error = new Error("still locked");
        error.code = "EACCES";
        throw error;
      },
      async () => {},
    ),
    /still locked/,
  );
  assert.equal(attempts, 5);
});

test("saveBaseline removes temporary files after a rename failure", async () => {
  const root = await temporaryDirectory();
  try {
    await assert.rejects(
      saveBaseline("example.com", snapshot(), {
        cacheRoot: root,
        renameFile: async () => {
          const error = new Error("rename failed");
          error.code = "EIO";
          throw error;
        },
      }),
      /rename failed/,
    );
    assert.deepEqual(
      (await readdir(root)).filter((name) => name.endsWith(".tmp")),
      [],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("loadSnapshotFile validates regular bounded input and domain binding", async () => {
  const root = await temporaryDirectory();
  const input = join(root, "snapshot.json");
  try {
    await writeFile(input, JSON.stringify(snapshot()), "utf8");
    assert.equal((await loadSnapshotFile(input, "example.com")).domain, "example.com");
    await assert.rejects(loadSnapshotFile(input, "other.com"), /mismatch/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("loadBaseline reports corrupt and oversized cache files without replacing them", async () => {
  const root = await temporaryDirectory();
  try {
    const options = { cacheRoot: root };
    const path = cachePathForDomain("example.com", options);
    await writeFile(path, "{not json", "utf8");
    const corrupt = await loadBaseline("example.com", options);
    assert.equal(corrupt.status, "invalid");
    assert.match(corrupt.error, /JSON/);
    assert.equal(await readFile(path, "utf8"), "{not json");

    await writeFile(path, Buffer.alloc(MAX_CACHE_BYTES + 1));
    const oversized = await loadBaseline("example.com", options);
    assert.equal(oversized.status, "invalid");
    assert.match(oversized.error, /exceeds/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("load and save reject a symbolic-link cache path", async (context) => {
  const root = await temporaryDirectory();
  const target = join(root, "target.json");
  const path = cachePathForDomain("example.com", { cacheRoot: root });
  try {
    await writeFile(target, JSON.stringify(snapshot()), "utf8");
    try {
      await symlink(target, path, "file");
    } catch (error) {
      if (error.code === "EPERM") {
        context.skip("symbolic links require elevated Windows privileges");
        return;
      }
      throw error;
    }
    const loaded = await loadBaseline("example.com", { cacheRoot: root });
    assert.equal(loaded.status, "invalid");
    assert.match(loaded.error, /symbolic link|reparse point/);
    await assert.rejects(
      saveBaseline("example.com", snapshot(), { cacheRoot: root }),
      /symbolic link|reparse point/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("save rejects a cache root that resolves through a directory link", async (context) => {
  const root = await temporaryDirectory();
  const target = join(root, "target");
  const linkedRoot = join(root, "linked");
  try {
    await mkdir(target);
    try {
      await symlink(target, linkedRoot, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (error.code === "EPERM") {
        context.skip("directory links require elevated Windows privileges");
        return;
      }
      throw error;
    }
    await assert.rejects(
      saveBaseline("example.com", snapshot(), { cacheRoot: linkedRoot }),
      /symbolic link|reparse point/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("load rejects a cache file reached through a directory link", async (context) => {
  const root = await temporaryDirectory();
  const target = join(root, "target");
  const linkedRoot = join(root, "linked");
  try {
    await mkdir(target);
    await writeFile(
      cachePathForDomain("example.com", { cacheRoot: target }),
      JSON.stringify(snapshot()),
      "utf8",
    );
    try {
      await symlink(target, linkedRoot, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (error.code === "EPERM") {
        context.skip("directory links require elevated Windows privileges");
        return;
      }
      throw error;
    }
    const loaded = await loadBaseline("example.com", { cacheRoot: linkedRoot });
    assert.equal(loaded.status, "invalid");
    assert.match(loaded.error, /symbolic link|reparse point/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("saveBaseline surfaces cache-directory failures", async () => {
  const root = await temporaryDirectory();
  const blockedRoot = join(root, "not-a-directory");
  try {
    await writeFile(blockedRoot, "file", "utf8");
    await assert.rejects(
      saveBaseline("example.com", snapshot(), { cacheRoot: blockedRoot }),
      /EEXIST|ENOTDIR/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("classifyDelta emits added, changed, resolved, unchanged, and not-reverified states", () => {
  assert.deepEqual(DELTA_CLASSIFICATIONS, [
    "Added",
    "Changed",
    "Resolved",
    "Unchanged",
    "Not reverified",
  ]);
  const before = snapshot({
    checks: {
      ...snapshot().checks,
      "MAIL-01": {
        state: "Verified",
        health: "Healthy",
        observed: ["v=spf1 -all"],
        sourceKinds: ["authoritative"],
        observedAt: "2026-08-18T18:00:00Z",
      },
      "WEB-01": {
        state: "Verified",
        health: "Healthy",
        observed: [200],
        sourceKinds: ["endpoint"],
        observedAt: "2026-08-18T18:00:00Z",
      },
      "STALE-01": {
        state: "Verified",
        health: "Healthy",
        observed: ["copied"],
        sourceKinds: ["authoritative"],
        observedAt: "2026-08-18T18:00:00Z",
      },
    },
    findings: {
      ...snapshot().findings,
      "WEB-01:old-finding": {
        severity: "Low",
        status: "open",
        owner: "hosting",
        summary: "Old finding",
      },
    },
    remediation: {
      ...snapshot().remediation,
      "MAIL-01:spf-update": {
        state: "planned",
        lastActionAt: null,
      },
      "DEL-01:unchanged": {
        state: "verified",
        lastActionAt: "2026-08-18T17:00:00Z",
      },
    },
  });

  const after = snapshot({
    generatedAt: "2026-08-19T18:00:00Z",
    scope: ["records"],
    checks: {
      "DEL-01": { ...snapshot().checks["DEL-01"], observedAt: "2026-08-19T18:00:00Z" },
      "SEC-01": {
        ...snapshot().checks["SEC-01"],
        health: "Healthy",
        observed: [{ algorithm: 13, signed: true }],
        observedAt: "2026-08-19T18:00:00Z",
      },
      "WEB-01": {
        ...before.checks["WEB-01"],
        observedAt: "2026-08-19T18:00:00Z",
      },
      "STALE-01": {
        ...before.checks["STALE-01"],
      },
      "STALE-NEW-01": {
        state: "Verified",
        health: "Healthy",
        observed: ["copied"],
        sourceKinds: ["authoritative"],
        observedAt: "2026-08-18T18:00:00Z",
      },
      "CAA-01": {
        state: "Verified",
        health: "Healthy",
        observed: ["0 issue letsencrypt.org"],
        sourceKinds: ["authoritative"],
        observedAt: "2026-08-19T18:00:00Z",
      },
    },
    findings: {
      "CAA-01:new-finding": {
        severity: "Low",
        status: "open",
        owner: "DNS",
        summary: "New finding",
      },
      "SEC-01:dnssec-unsigned": {
        ...snapshot().findings["SEC-01:dnssec-unsigned"],
        status: "resolved",
      },
      "STALE-01:carried-forward": {
        severity: "Low",
        status: "open",
        owner: "DNS",
        summary: "Carried forward without current evidence",
      },
    },
    remediation: {
      "SEC-01:dnssec-unsigned": {
        state: "verified",
        lastActionAt: "2026-08-19T17:00:00Z",
      },
      "DEL-01:unchanged": {
        state: "verified",
        lastActionAt: "2026-08-18T17:00:00Z",
      },
      "CAA-01:new": {
        state: "planned",
        lastActionAt: null,
      },
    },
  });

  const delta = classifyDelta(before, after);
  const states = new Set(delta.items.map((item) => item.classification));
  assert.deepEqual(
    states,
    new Set(["Added", "Changed", "Resolved", "Unchanged", "Not reverified"]),
  );
  assert.equal(
    delta.items.find((item) => item.key === "SEC-01:dnssec-unsigned" && item.kind === "finding")
      .classification,
    "Resolved",
  );
  assert.equal(
    delta.items.find((item) => item.key === "MAIL-01").classification,
    "Not reverified",
  );
  assert.equal(
    delta.items.find((item) => item.key === "STALE-01").classification,
    "Not reverified",
  );
  assert.equal(
    delta.items.find((item) => item.key === "STALE-NEW-01").classification,
    "Not reverified",
  );
  assert.equal(
    delta.items.find((item) => item.key === "STALE-01:carried-forward").classification,
    "Not reverified",
  );
  assert.equal(
    delta.items.find(
      (item) => item.key === "SEC-01:dnssec-unsigned" && item.kind === "remediation",
    ).classification,
    "Changed",
  );
  assert.equal(
    delta.items.find(
      (item) => item.key === "MAIL-01:spf-update" && item.kind === "remediation",
    ).classification,
    "Not reverified",
  );
  assert.equal(
    delta.items.find(
      (item) => item.key === "DEL-01:unchanged" && item.kind === "remediation",
    ).classification,
    "Unchanged",
  );
  assert.equal(
    delta.items.find(
      (item) => item.key === "CAA-01:new" && item.kind === "remediation",
    ).classification,
    "Added",
  );
  assert.equal(
    delta.items.find((item) => item.kind === "scope").classification,
    "Changed",
  );
  assert.equal(
    delta.items.find((item) => item.key === "DEL-01").classification,
    "Unchanged",
  );
});

test("classifyDelta refuses to call an unverified check Unchanged", () => {
  // A check the audit could not confirm still records a current observedAt.
  // Reporting rules define Unchanged as "fresh evidence matched the cache", so
  // letting that timestamp alone establish freshness would assert a control was
  // confirmed when nothing was actually observed.
  const unverified = {
    state: "Not verified",
    health: "Not verified",
    observed: [],
    sourceKinds: [],
  };
  const before = snapshot({
    generatedAt: "2026-08-18T18:00:00Z",
    checks: { "GAP-01": { ...unverified, observedAt: "2026-08-18T18:00:00Z" } },
    findings: {},
    remediation: {},
  });
  const after = snapshot({
    generatedAt: "2026-08-19T18:00:00Z",
    checks: { "GAP-01": { ...unverified, observedAt: "2026-08-19T18:00:00Z" } },
    findings: {},
    remediation: {},
  });

  const classification = classifyDelta(before, after).items.find(
    (item) => item.key === "GAP-01",
  ).classification;

  assert.equal(classification, "Not reverified");
});

test("classifyDelta canonicalizes set evidence but preserves sequence order", () => {
  const before = snapshot({
    checks: {
      "SET-01": {
        state: "Verified",
        health: "Healthy",
        evidenceOrder: "set",
        observed: ["b", "a", "a"],
        sourceKinds: ["authoritative"],
        observedAt: "2026-08-18T18:00:00Z",
      },
      "SEQ-01": {
        state: "Verified",
        health: "Healthy",
        evidenceOrder: "sequence",
        observed: ["first", "second"],
        sourceKinds: ["endpoint"],
        observedAt: "2026-08-18T18:00:00Z",
      },
    },
    findings: {},
    remediation: {},
  });
  const after = snapshot({
    generatedAt: "2026-08-19T18:00:00Z",
    checks: {
      "SET-01": {
        ...before.checks["SET-01"],
        observed: ["a", "b"],
        observedAt: "2026-08-19T18:00:00Z",
      },
      "SEQ-01": {
        ...before.checks["SEQ-01"],
        observed: ["second", "first"],
        observedAt: "2026-08-19T18:00:00Z",
      },
    },
    findings: {},
    remediation: {},
  });

  const delta = classifyDelta(before, after);
  assert.equal(delta.items.find((item) => item.key === "SET-01").classification, "Unchanged");
  assert.equal(delta.items.find((item) => item.key === "SEQ-01").classification, "Changed");
});

test("main and the executable CLI cover path, load, compare, save, and invalid commands", async () => {
  const root = await temporaryDirectory();
  const input = join(root, "current.json");
  try {
    await writeFile(input, JSON.stringify(snapshot()), "utf8");
    assert.equal((await main(["path", "--domain", "example.com"])).domain, "example.com");
    // `normalize` exposes the same validation the cache engine enforces, so a
    // shell recipe never has to reimplement hostname rules.
    assert.equal((await main(["normalize", "--domain", "EXAMPLE.com"])).domain, "example.com");
    assert.equal(
      (await main(["normalize", "--domain", "m\u00fcnich.example"])).domain,
      "xn--mnich-kva.example",
    );
    await assert.rejects(main(["normalize", "--domain", "good.example@evil.test"]), /DNS host/);
    await assert.rejects(
      main(["normalize", "--domain", "example.com", "--input", input]),
      /not supported/,
    );
    await assert.rejects(main(["unknown", "--domain", "example.com"]), /command/);
    await assert.rejects(main(["save", "--domain", "example.com"]), /input/);
    await assert.rejects(main(["path", "example.com"]), /unexpected argument/);
    await assert.rejects(main(["path", "--domain"]), /missing value/);
    await assert.rejects(main(["path"]), /domain is required/);
    await assert.rejects(main(["path", "--domain", "example.com", "--bogus", "x"]), /unsupported/);
    await assert.rejects(
      main(["path", "--domain", "example.com", "--domain", "other.com"]),
      /duplicate/,
    );
    await assert.rejects(
      main(["path", "--domain", "example.com", "--input", input]),
      /not supported/,
    );

    const env = {
      ...process.env,
      HOME: root,
      USERPROFILE: root,
      XDG_CACHE_HOME: root,
      LOCALAPPDATA: root,
    };
    const pathResult = await execFileAsync(
      process.execPath,
      [SCRIPT, "path", "--domain", "example.com"],
      { env },
    );
    const resolvedPath = JSON.parse(pathResult.stdout);
    assert.equal(resolvedPath.domain, "example.com");
    assert.equal(resolve(resolvedPath.path).startsWith(`${resolve(root)}${sep}`), true);
    const missingCompare = await execFileAsync(
      process.execPath,
      [SCRIPT, "compare", "--domain", "missing.example", "--input", input],
      { env },
    );
    assert.equal(JSON.parse(missingCompare.stdout).status, "missing");
    const { stdout } = await execFileAsync(
      process.execPath,
      [SCRIPT, "save", "--domain", "example.com", "--input", input],
      { env },
    );
    assert.equal(JSON.parse(stdout).status, "created");
    const loaded = await execFileAsync(
      process.execPath,
      [SCRIPT, "load", "--domain", "example.com"],
      { env },
    );
    assert.equal(JSON.parse(loaded.stdout).status, "found");
    const compared = await execFileAsync(
      process.execPath,
      [SCRIPT, "compare", "--domain", "example.com", "--input", input],
      { env },
    );
    assert.equal(JSON.parse(compared.stdout).status, "compared");
    await assert.rejects(
      execFileAsync(process.execPath, [SCRIPT, "unknown", "--domain", "example.com"], { env }),
      (error) => {
        const failure = JSON.parse(error.stderr);
        assert.equal(error.code, 1);
        assert.equal(error.stdout, "");
        assert.equal(failure.status, "error");
        assert.equal(failure.error, "command must be one of: normalize, path, load, compare, save");
        assert.doesNotMatch(error.stderr, /(?:at file:|[A-Z]:\\|node:internal)/);
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("--cache-root isolates every command from the operating system cache location", async () => {
  const root = await temporaryDirectory();
  const cacheRoot = join(root, "isolated-cache");
  const input = join(root, "current.json");
  try {
    await writeFile(input, JSON.stringify(snapshot()), "utf8");

    // Point the platform cache variables at a decoy, so any command that
    // ignored --cache-root would write there and be caught below.
    const decoy = join(root, "decoy");
    const env = {
      ...process.env,
      HOME: decoy,
      USERPROFILE: decoy,
      XDG_CACHE_HOME: decoy,
      LOCALAPPDATA: decoy,
    };
    const run = async (...args) =>
      JSON.parse(
        (
          await execFileAsync(
            process.execPath,
            [SCRIPT, ...args, "--cache-root", cacheRoot],
            { env },
          )
        ).stdout,
      );
    const inside = (value) => resolve(value).startsWith(`${resolve(cacheRoot)}${sep}`);

    assert.equal(inside((await run("path", "--domain", "example.com")).path), true);

    const saved = await run("save", "--domain", "example.com", "--input", input);
    assert.equal(saved.status, "created");
    assert.equal(inside(saved.path), true);

    const loaded = await run("load", "--domain", "example.com");
    assert.equal(loaded.status, "found");
    assert.equal(inside(loaded.path), true);

    const compared = await run("compare", "--domain", "example.com", "--input", input);
    assert.equal(compared.status, "compared");
    assert.equal(inside(compared.path), true);

    // The platform cache location must never have been created.
    await assert.rejects(lstat(decoy), (error) => error.code === "ENOENT");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
