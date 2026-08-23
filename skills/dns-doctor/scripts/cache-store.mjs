#!/usr/bin/env node

import {
  constants,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { domainToASCII } from "node:url";
import { homedir } from "node:os";
import { basename, dirname, join, posix, resolve, win32 } from "node:path";
import { isIP } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { compareText, stableJson, stableKey } from "./stable-json.mjs";

export const CACHE_SCHEMA_VERSION = 1;
export const MAX_CACHE_BYTES = 1024 * 1024;
// Tolerance for honest clock differences between the writing and reading hosts.
const MAX_FUTURE_SKEW_MS = 24 * 60 * 60 * 1000;
const MAX_MAP_ENTRIES = 500;
const MAX_ARRAY_ITEMS = 100;
const BLOCKED_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const EVIDENCE_STATES = new Set([
  "Verified",
  "Corroborated",
  "Inferred",
  "Not verified",
  "Not applicable",
]);
const HEALTH_STATES = new Set([
  "Healthy",
  "Degraded",
  "Unhealthy",
  "Not verified",
  "Not applicable",
]);
const SEVERITIES = new Set([
  "Critical",
  "High",
  "Medium",
  "Low",
  "Informational",
]);
const FINDING_STATES = new Set(["open", "resolved", "accepted-risk"]);
const REMEDIATION_STATES = new Set([
  "not-started",
  "planned",
  "approved",
  "in-progress",
  "verified",
  "failed",
  "rolled-back",
]);
const writeQueues = new Map();
const SENSITIVE_TEXT = [
  /(?:authorization|proxy-authorization|cookie|set-cookie)\s*:/i,
  /\b(?:api[_ -]?key|access[_ -]?token|client[_ -]?secret|password)\s*[=:]/i,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /[?&](?:access_token|api_key|apikey|client_secret|password)=/i,
  // The patterns above only catch text that labels itself as a secret. These
  // catch the secret values themselves, which is what actually leaks when an
  // agent pastes a raw header or token into observed evidence.
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/,
  /\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{16,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/,
  /\b(?:Basic|Bearer)\s+[A-Za-z0-9+/._-]{16,}={0,2}/,
];
const SENSITIVE_KEY = /^(?:.*(?:authoriz|cookie|api[-_]?key|token|secret|password|session|credential).*)$/i;
const INVALID_RAW_DOMAIN = /[\p{White_Space}\p{Default_Ignorable_Code_Point}/\\?#@:;|`$()[\]{}<>"']/u;
export function normalizeDomain(value) {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    throw new Error("domain must be a non-empty hostname without surrounding whitespace");
  }
  if (INVALID_RAW_DOMAIN.test(value)) {
    throw new Error("domain must contain only a complete DNS hostname");
  }
  const withoutRootDot = value.endsWith(".") ? value.slice(0, -1) : value;
  const ascii = domainToASCII(withoutRootDot).toLowerCase();
  if (!ascii || ascii.length > 253 || isIP(ascii)) {
    throw new Error("domain must be a valid DNS hostname");
  }
  const labels = ascii.split(".");
  if (
    labels.length < 2 ||
    labels.some(
      (label) =>
        label.length === 0 ||
        label.length > 63 ||
        !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
    )
  ) {
    throw new Error("domain must be a valid multi-label DNS hostname");
  }
  return ascii;
}
export function cachePathForDomain(domain, options = {}) {
  const normalized = normalizeDomain(domain);
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const pathApi = platform === "win32" ? win32 : posix;
  let root = options.cacheRoot;
  if (!root && platform === "win32") {
    root = pathApi.join(
      env.LOCALAPPDATA || pathApi.join(home, "AppData", "Local"),
      "dns-doctor",
      "cache",
    );
  } else if (!root && platform === "darwin") {
    root = pathApi.join(home, "Library", "Caches", "dns-doctor");
  } else if (!root) {
    root = pathApi.join(env.XDG_CACHE_HOME || pathApi.join(home, ".cache"), "dns-doctor");
  }
  if (!pathApi.isAbsolute(root)) throw new Error("cache root must be an absolute path");
  return pathApi.join(root, `${normalized}.json`);
}
function record(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}
function string(value, label, maxLength = 4096) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
  ) {
    throw new Error(`${label} must be a non-empty bounded string without control characters`);
  }
  if (SENSITIVE_TEXT.some((pattern) => pattern.test(value))) {
    throw new Error(`${label} appears to contain credential or session material`);
  }
  return value;
}

function timestamp(value, label, nullable = false) {
  if (nullable && value === null) return null;
  const normalized = string(value, label, 64);
  const match = /^([1-9]\d{3})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(?:Z|[+-]\d{2}:\d{2})$/.exec(normalized);
  if (!match) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
  const [, year, month, day, hour, minute, second] = match;
  const calendar = new Date(Date.UTC(+year, +month - 1, +day, +hour, +minute, +second));
  if (
    calendar.getUTCFullYear() !== +year ||
    calendar.getUTCMonth() !== +month - 1 ||
    calendar.getUTCDate() !== +day ||
    calendar.getUTCHours() !== +hour ||
    calendar.getUTCMinutes() !== +minute ||
    calendar.getUTCSeconds() !== +second
  ) {
    throw new Error(`${label} must contain a valid calendar date and time`);
  }
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) throw new Error(`${label} must be an ISO timestamp`);
  // A far-future timestamp in an untrusted baseline would make every current
  // observation look stale, silently downgrading new findings to
  // "Not reverified". Bound the value so a poisoned or clock-skewed cache
  // fails loudly instead.
  if (parsed.getTime() > Date.now() + MAX_FUTURE_SKEW_MS) {
    throw new Error(`${label} is too far in the future`);
  }
  return parsed.toISOString();
}

function enumValue(value, allowed, label) {
  const normalized = string(value, label, 64);
  if (!allowed.has(normalized)) throw new Error(`${label} has an unsupported value`);
  return normalized;
}
function mapEntries(value, label) {
  const entries = Object.entries(record(value, label));
  if (entries.length > MAX_MAP_ENTRIES) throw new Error(`${label} has too many entries`);
  return entries;
}
function mapKey(value, label) {
  if (
    BLOCKED_KEYS.has(value) ||
    value.length > 160 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)
  ) {
    throw new Error(`${label} contains an invalid key`);
  }
  return value;
}
function stringList(value, label, itemLength = 253) {
  if (!Array.isArray(value) || value.length > MAX_ARRAY_ITEMS) {
    throw new Error(`${label} must be a bounded array`);
  }
  return [...new Set(value.map((item, index) => string(item, `${label}[${index}]`, itemLength)))]
    .sort(compareText);
}

function evidenceValue(value, label, depth = 0) {
  if (depth > 4) throw new Error(`${label} exceeds the maximum nesting depth`);
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") return string(value, label);
  if (Array.isArray(value)) {
    if (value.length > MAX_ARRAY_ITEMS) throw new Error(`${label} has too many items`);
    return value.map((item, index) => evidenceValue(item, `${label}[${index}]`, depth + 1));
  }
  const output = {};
  for (const [key, item] of mapEntries(value, label)) {
    const safeKey = mapKey(key, label);
    if (SENSITIVE_KEY.test(safeKey)) {
      throw new Error(`${label}.${safeKey} appears to contain credential or session material`);
    }
    output[safeKey] = evidenceValue(item, `${label}.${safeKey}`, depth + 1);
  }
  return output;
}

function sanitizeIntent(value) {
  if (value === undefined) return {};
  const input = record(value, "intent");
  const output = {};
  if (input.canonicalWebHost !== undefined) {
    output.canonicalWebHost = normalizeDomain(input.canonicalWebHost);
  }
  if (input.redirectOnlyHosts !== undefined) {
    output.redirectOnlyHosts = [...new Set(
      stringList(input.redirectOnlyHosts, "intent.redirectOnlyHosts").map(normalizeDomain),
    )].sort(compareText);
  }
  if (input.mailMode !== undefined) output.mailMode = string(input.mailMode, "intent.mailMode", 64);
  if (input.providers !== undefined) {
    output.providers = stringList(input.providers, "intent.providers", 128);
  }
  if (input.knownDkimSelectors !== undefined) {
    output.knownDkimSelectors = stringList(
      input.knownDkimSelectors,
      "intent.knownDkimSelectors",
      63,
    );
  }
  return output;
}

function sanitizeChecks(value) {
  const output = {};
  for (const [rawKey, rawCheck] of mapEntries(value, "checks")) {
    const key = mapKey(rawKey, "checks");
    const check = record(rawCheck, `checks.${key}`);
    if (!Array.isArray(check.observed) || check.observed.length > MAX_ARRAY_ITEMS) {
      throw new Error(`checks.${key}.observed must be a bounded array`);
    }
    const evidenceOrder = check.evidenceOrder === undefined
      ? "set"
      : enumValue(check.evidenceOrder, new Set(["set", "sequence"]), `checks.${key}.evidenceOrder`);
    const observed = check.observed.map((item, index) =>
      evidenceValue(item, `checks.${key}.observed[${index}]`),
    );
    const normalizedObserved = evidenceOrder === "sequence"
      ? observed
      : [...new Map(observed.map((item) => [stableKey(item), item])).entries()]
          .sort(([left], [right]) => compareText(left, right))
          .map(([, item]) => item);
    output[key] = {
      state: enumValue(check.state, EVIDENCE_STATES, `checks.${key}.state`),
      health: enumValue(check.health, HEALTH_STATES, `checks.${key}.health`),
      evidenceOrder,
      observed: normalizedObserved,
      sourceKinds: stringList(check.sourceKinds, `checks.${key}.sourceKinds`, 64),
      observedAt: timestamp(check.observedAt, `checks.${key}.observedAt`),
    };
  }
  return output;
}

function sanitizeFindings(value) {
  const output = {};
  for (const [rawKey, rawFinding] of mapEntries(value, "findings")) {
    const key = mapKey(rawKey, "findings");
    // The delta engine resolves a finding to its check by the segment before
    // the first colon. An unprefixed key would resolve to nothing and silently
    // classify a brand-new finding as "Not reverified", so require the shape
    // here rather than degrading quietly later.
    const separator = key.indexOf(":");
    if (separator < 1 || separator === key.length - 1) {
      throw new Error(`findings.${key} must be named <checkId>:<slug>`);
    }
    const finding = record(rawFinding, `findings.${key}`);
    output[key] = {
      severity: enumValue(finding.severity, SEVERITIES, `findings.${key}.severity`),
      status: enumValue(finding.status, FINDING_STATES, `findings.${key}.status`),
      owner: string(finding.owner, `findings.${key}.owner`, 128),
      summary: string(finding.summary, `findings.${key}.summary`, 1024),
    };
  }
  return output;
}

function sanitizeRemediation(value) {
  const output = {};
  for (const [rawKey, rawRemediation] of mapEntries(value, "remediation")) {
    const key = mapKey(rawKey, "remediation");
    const remediation = record(rawRemediation, `remediation.${key}`);
    output[key] = {
      state: enumValue(
        remediation.state,
        REMEDIATION_STATES,
        `remediation.${key}.state`,
      ),
      lastActionAt: timestamp(
        remediation.lastActionAt,
        `remediation.${key}.lastActionAt`,
        true,
      ),
    };
  }
  return output;
}

export function sanitizeSnapshot(value, expectedDomain) {
  const input = record(value, "snapshot");
  if (input.schemaVersion !== CACHE_SCHEMA_VERSION) {
    // Report only the shape, never the untrusted value. This message reaches
    // the agent transcript through `loadBaseline`, so echoing raw cache bytes
    // here would turn a corrupt cache into a prompt-injection channel.
    throw new Error(`unsupported cache schema version (${typeof input.schemaVersion})`);
  }
  const domain = normalizeDomain(input.domain);
  if (expectedDomain !== undefined && domain !== normalizeDomain(expectedDomain)) {
    throw new Error(`cache domain mismatch: expected ${normalizeDomain(expectedDomain)}, got ${domain}`);
  }
  const generatedAt = timestamp(input.generatedAt, "generatedAt");
  const checks = sanitizeChecks(input.checks);
  for (const [key, check] of Object.entries(checks)) {
    if (new Date(check.observedAt) > new Date(generatedAt)) {
      throw new Error(`checks.${key}.observedAt cannot be later than generatedAt`);
    }
  }
  return {
    schemaVersion: CACHE_SCHEMA_VERSION,
    domain,
    generatedAt,
    scope: stringList(input.scope, "scope", 64),
    intent: sanitizeIntent(input.intent),
    checks,
    findings: sanitizeFindings(input.findings),
    remediation: sanitizeRemediation(input.remediation),
  };
}

function samePath(left, right) {
  return normalizedPath(left) === normalizedPath(right);
}

function normalizedPath(value) {
  const normalized = resolve(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

// Reject a path that is itself redirected, while tolerating links above it.
// Comparing a path to its own fully resolved form would also reject every
// legitimate ancestor link: on macOS `os.tmpdir()` lives under `/var`, which is
// a link to `/private/var`, so that stricter form fails for any temp-rooted
// cache. Anchoring on the parent keeps the guard aimed at the component an
// attacker could actually plant.
async function assertNotRedirected(target, message) {
  const canonicalParent = await realpath(dirname(target));
  const actual = await realpath(target);
  if (!samePath(join(canonicalParent, basename(target)), actual)) {
    throw new Error(message);
  }
}

async function inspectReadableFile(file) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error("cache path must be a regular file, not a symbolic link or reparse point");
  }
  await assertNotRedirected(file, "cache path resolves through a symbolic link or reparse point");
  if (info.size > MAX_CACHE_BYTES) {
    throw new Error(`cache file exceeds ${MAX_CACHE_BYTES} bytes`);
  }
}

async function readBoundedJson(file) {
  await inspectReadableFile(file);
  const noFollow = process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0);
  const handle = await open(file, constants.O_RDONLY | noFollow);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_CACHE_BYTES) {
      throw new Error(`cache file exceeds ${MAX_CACHE_BYTES} bytes or is not regular`);
    }
    const data = Buffer.allocUnsafe(MAX_CACHE_BYTES + 1);
    let length = 0;
    while (length <= MAX_CACHE_BYTES) {
      const { bytesRead } = await handle.read(data, length, data.byteLength - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > MAX_CACHE_BYTES) {
      throw new Error(`cache file exceeds ${MAX_CACHE_BYTES} bytes`);
    }
    try {
      return JSON.parse(data.subarray(0, length).toString("utf8"));
    } catch {
      // The parser quotes a window of the offending bytes, and this message
      // reaches the agent transcript through loadBaseline. Report only that
      // parsing failed so a corrupt cache cannot become an injection channel.
      throw new Error("cache file is not valid JSON");
    }
  } finally {
    await handle.close();
  }
}

export async function loadBaseline(domain, options = {}) {
  const normalized = normalizeDomain(domain);
  const path = cachePathForDomain(normalized, options);
  try {
    await assertNotRedirected(
      dirname(path),
      "cache path resolves through a symbolic link or reparse point",
    );
    const parsed = await readBoundedJson(path);
    return {
      status: "found",
      path,
      baseline: sanitizeSnapshot(parsed, normalized),
    };
  } catch (error) {
    if (error?.code === "ENOENT") return { status: "missing", path };
    // Validation failures raised by this module carry no errno, while a
    // filesystem or permission failure does. Reporting the latter as an
    // invalid cache would hide a real operational problem behind a message
    // that reads like ordinary corruption.
    if (error?.code) throw error;
    return {
      status: "invalid",
      path,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function renameWithRetry(source, destination, renameFile = rename, wait = delay) {
  const retryDelays = [25, 50, 100, 200];
  for (let attempt = 0; ; attempt++) {
    try {
      await renameFile(source, destination);
      return;
    } catch (error) {
      const isTransient = error?.code === "EPERM" || error?.code === "EACCES" || error?.code === "EBUSY";
      if (!isTransient || attempt === retryDelays.length) throw error;
      await wait(retryDelays[attempt]);
    }
  }
}

async function persistBaseline(path, snapshot, renameFile) {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await assertNotRedirected(
    directory,
    "refusing to write through a symbolic link or reparse point",
  );

  let existed = false;
  try {
    const info = await lstat(path);
    existed = true;
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error("refusing to replace a symbolic link, reparse point, or non-file cache path");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const temporary = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  const serialized = Buffer.from(stableJson(snapshot), "utf8");
  if (serialized.byteLength > MAX_CACHE_BYTES) {
    throw new Error(`cache snapshot exceeds ${MAX_CACHE_BYTES} bytes`);
  }
  let handle;
  try {
    handle = await open(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    await handle.writeFile(serialized);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await renameWithRetry(temporary, path, renameFile);
  } catch (error) {
    await handle?.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }

  return {
    status: existed ? "updated" : "created",
    path,
    generatedAt: snapshot.generatedAt,
  };
}

export async function saveBaseline(domain, value, options = {}) {
  const normalized = normalizeDomain(domain);
  const snapshot = sanitizeSnapshot(value, normalized);
  const path = cachePathForDomain(normalized, options);
  const queueKey = normalizedPath(path);
  const previous = writeQueues.get(queueKey) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(() => persistBaseline(path, snapshot, options.renameFile));
  writeQueues.set(queueKey, current);
  try {
    return await current;
  } finally {
    if (writeQueues.get(queueKey) === current) writeQueues.delete(queueKey);
  }
}

export async function loadSnapshotFile(path, domain) {
  if (!path) throw new Error("snapshot path is required");
  return sanitizeSnapshot(await readBoundedJson(resolve(path)), domain);
}
