import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  GitBoundaryError,
  resolveExecutablePath,
  runBoundedProcess,
} from "./git-process.mjs";

export const REMOTE_BASELINE_MAX_AGE_MS = 5 * 60 * 1000;

function inheritedEnvironment(root) {
  const env = {};
  for (const key of [
    "PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "WINDIR",
    "ComSpec", "COMSPEC", "TMP", "TEMP", "TMPDIR",
  ]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return {
    ...env,
    HOME: root,
    XDG_CONFIG_HOME: root,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "Never",
    LC_ALL: "C",
    LANG: "C",
  };
}

function remoteId(remoteUrl) {
  return createHash("sha256").update(remoteUrl, "utf8").digest("hex");
}

function emptyBaseline(state, failureCode = null) {
  return Object.freeze({
    state,
    remoteId: null,
    defaultRef: null,
    defaultOid: null,
    heads: Object.freeze([]),
    verifiedAt: null,
    validUntil: null,
    failureCode,
  });
}

export function offlineRemoteBaseline() {
  return emptyBaseline("offline", "remote-verification-not-requested");
}

export function failedRemoteBaseline(code) {
  return emptyBaseline("failed", code);
}

export function parseRemoteAdvertisement(bytes) {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const heads = new Map();
  let defaultRef = null;
  let advertisedHeadOid = null;
  for (const line of text.split("\n")) {
    if (line.length === 0) continue;
    const symref = /^ref: (refs\/heads\/[^\s]+)\tHEAD$/u.exec(line);
    if (symref) {
      defaultRef = symref[1];
      continue;
    }
    const headOid = /^([0-9a-f]{40}|[0-9a-f]{64})\tHEAD$/u.exec(line);
    if (headOid) {
      advertisedHeadOid = headOid[1];
      continue;
    }
    const head = /^([0-9a-f]{40}|[0-9a-f]{64})\t(refs\/heads\/[^\s]+)$/u
      .exec(line);
    if (!head || heads.has(head[2])) {
      throw new GitBoundaryError(
        "REMOTE_ADVERTISEMENT_INVALID",
        "remote advertisement contains an invalid or duplicate head",
      );
    }
    heads.set(head[2], head[1]);
  }
  const defaultOid = defaultRef === null ? null : heads.get(defaultRef);
  if (heads.size === 0 || defaultRef === null || defaultOid === undefined) {
    throw new GitBoundaryError(
      "REMOTE_DEFAULT_UNAVAILABLE",
      "remote default branch identity is unavailable",
    );
  }
  if (advertisedHeadOid !== defaultOid) {
    throw new GitBoundaryError(
      "REMOTE_DEFAULT_MISMATCH",
      "remote HEAD does not match its advertised default branch",
    );
  }
  const oidLength = defaultOid.length;
  if ([...heads.values()].some((oid) => oid.length !== oidLength)) {
    throw new GitBoundaryError(
      "REMOTE_OBJECT_FORMAT_MIXED",
      "remote advertisement mixes object formats",
    );
  }
  return {
    defaultRef,
    defaultOid,
    heads: [...heads].map(([ref, oid]) => ({ ref, oid }))
      .sort((left, right) => left.ref.localeCompare(right.ref, "en")),
  };
}

function requireRemoteUrl(remoteUrl) {
  if (
    typeof remoteUrl !== "string" ||
    remoteUrl.length === 0 ||
    remoteUrl.length > 4096 ||
    remoteUrl.includes("\0") ||
    /[\r\n]/u.test(remoteUrl)
  ) {
    throw new TypeError("remoteUrl must be a bounded NUL-free string");
  }
}

export function remoteBaselineFresh(
  baseline,
  now = new Date(),
) {
  return baseline?.state === "verified" &&
    typeof baseline.validUntil === "string" &&
    Number.isFinite(Date.parse(baseline.validUntil)) &&
    now.getTime() <= Date.parse(baseline.validUntil);
}

export async function verifyRemoteBaseline(remoteUrl, options = {}) {
  requireRemoteUrl(remoteUrl);
  const root = await mkdtemp(path.join(tmpdir(), "git-tidy-remote-"));
  const repository = path.join(root, "repository.git");
  const hooks = path.join(root, "hooks");
  const gitPath = resolveExecutablePath(options.gitPath ?? "git", {
    untrustedRoots: options.untrustedRoots ?? [],
  });
  const env = inheritedEnvironment(root);
  const run = (args) => runBoundedProcess(gitPath, args, {
    cwd: root,
    env,
    signal: options.signal,
    timeoutMs: options.timeoutMs,
    maxStdoutBytes: options.maxStdoutBytes,
    maxStderrBytes: options.maxStderrBytes,
  });
  try {
    await mkdir(hooks);
    await run(["init", "--bare", "--quiet", repository]);
    const configured = [
      "--git-dir", repository,
      "-c", `core.hooksPath=${hooks}`,
      "-c", "core.fsmonitor=false",
      "-c", "credential.helper=",
      "-c", "protocol.ext.allow=never",
      "-c", "protocol.file.allow=always",
    ];
    const advertisement = await run([
      ...configured,
      "ls-remote",
      "--symref",
      remoteUrl,
      "HEAD",
      "refs/heads/*",
    ]);
    const parsed = parseRemoteAdvertisement(advertisement.stdout);
    await run([
      ...configured,
      "fetch",
      "--force",
      "--no-tags",
      "--no-prune",
      "--no-recurse-submodules",
      "--no-write-fetch-head",
      remoteUrl,
      "+refs/heads/*:refs/remotes/verified/*",
    ]);
    const confirmedAdvertisement = await run([
      ...configured,
      "ls-remote",
      "--symref",
      remoteUrl,
      "HEAD",
      "refs/heads/*",
    ]);
    const confirmed = parseRemoteAdvertisement(
      confirmedAdvertisement.stdout,
    );
    if (JSON.stringify(confirmed) !== JSON.stringify(parsed)) {
      throw new GitBoundaryError(
        "REMOTE_CHANGED_DURING_VERIFICATION",
        "remote identity changed during verification",
      );
    }
    const verifiedAt = new Date(options.now?.getTime?.() ?? Date.now());
    return Object.freeze({
      state: "verified",
      remoteId: remoteId(remoteUrl),
      defaultRef: parsed.defaultRef,
      defaultOid: parsed.defaultOid,
      heads: Object.freeze(parsed.heads.map(Object.freeze)),
      verifiedAt: verifiedAt.toISOString(),
      validUntil: new Date(
        verifiedAt.getTime() + REMOTE_BASELINE_MAX_AGE_MS,
      ).toISOString(),
      failureCode: null,
    });
  } catch (error) {
    if (error instanceof TypeError) throw error;
    return failedRemoteBaseline(
      typeof error?.code === "string"
        ? error.code.toLowerCase().replaceAll("_", "-")
        : "remote-verification-failed",
    );
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
}
