import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  findUntrustedRepositoryRoot,
  GitBoundaryError,
  resolveExecutablePath,
  runBoundedProcess,
} from "./git-process.mjs";
import { createGitHubEnvironment } from "./github-environment.mjs";

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

function approvedHttpsHost(remoteUrl) {
  if (path.isAbsolute(remoteUrl)) return null;
  let url;
  try {
    url = new URL(remoteUrl);
  } catch {
    throw new GitBoundaryError("REMOTE_URL_UNSAFE", "unsupported remote URL");
  }
  if (url.protocol === "file:" && !url.host && !url.search && !url.hash &&
      !url.username && !url.password) return null;
  if (
    url.protocol !== "https:" || url.username || url.password ||
    url.port || url.search || url.hash ||
    !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(url.hostname) ||
    url.hostname.split(".").some((label) =>
      label.length > 63 || label.startsWith("-") || label.endsWith("-") ||
      label.length === 0) ||
    url.hostname.length > 253 ||
    !/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/u.test(url.pathname) ||
    url.pathname.split("/").some((part) => part === "." || part === "..") ||
    // Reject URL normalization, encoded paths, and ambiguous authority syntax.
    remoteUrl !== url.href
  ) {
    throw new GitBoundaryError("REMOTE_URL_UNSAFE", "unsupported remote URL");
  }
  return url.hostname;
}

function authenticationRequired(error) {
  return error?.code === "COMMAND_FAILED" &&
    /could not read (?:Username|Password)|authentication failed|invalid username or (?:password|token)|repository not found|requested URL returned error: (?:401|403|404)\b/iu
      .test(error.details?.stderr?.toString("utf8") ?? "");
}

export function remoteVerificationFailureMessage(code) {
  const messages = {
    "github-cli-unavailable": "GitHub CLI is unavailable or untrusted. Install or select a trusted gh executable outside the target repository, then retry.",
    "github-credentials-unavailable": "No GitHub CLI credentials are available for the approved host. Check gh auth status --hostname <approved-host>, GH_CONFIG_DIR, and repository read access, then retry. No login or credential change was performed.",
    "github-credentials-invalid": "GitHub CLI returned an invalid credential for the approved host. Check gh auth status --hostname <approved-host> and GH_CONFIG_DIR, then retry.",
    "github-authentication-failed": "The approved repository rejected GitHub CLI authentication. Check repository read permission, token expiration, and organization SSO authorization, then retry.",
    "github-auth-timeout": "GitHub CLI credential lookup timed out. Check the existing CLI session and credential store for the approved host, then retry.",
    "github-read-only-auth-unsupported": "This GitHub CLI does not support read-only token lookup. Use a trusted CLI supporting gh auth token --no-refresh, then retry. Verification never retries without the flag or changes credentials.",
    "remote-url-unsafe": "Use the exact approved credential-free HTTPS owner/repository URL or an absolute local repository path. Executable transports and ambiguous URLs are not supported.",
    "remote-url-mismatch": "The URL differs from the previously approved remote identity. Return to fresh analysis and separate remote-verification approval.",
    "remote-response-unsafe": "The remote response contained credential material and was discarded. No evidence or action plan was accepted.",
  };
  return messages[code] ?? "Remote verification failed; no cleanup is authorized. Check connectivity and access to the exact approved repository, then retry.";
}

async function githubAuthentication(host, gitPath, root, options, untrustedRoots) {
  let ghPath;
  try {
    ghPath = resolveExecutablePath(options.ghPath ?? "gh", { untrustedRoots });
  } catch {
    throw new GitBoundaryError("GITHUB_CLI_UNAVAILABLE", "trusted gh unavailable");
  }
  const ghEnvironment = { ...createGitHubEnvironment(ghPath, gitPath) };
  const explicitlyBoundHost = ghEnvironment.GH_HOST?.toLowerCase() === host;
  for (const key of ["GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"]) {
    if (!explicitlyBoundHost || host === "github.com") delete ghEnvironment[key];
  }
  for (const key of ["GH_TOKEN", "GITHUB_TOKEN"]) {
    if (host !== "github.com" && !explicitlyBoundHost) delete ghEnvironment[key];
  }
  ghEnvironment.GH_HOST = host;
  if (ghEnvironment.GH_CONFIG_DIR) {
    ghEnvironment.GH_CONFIG_DIR = path.resolve(ghEnvironment.GH_CONFIG_DIR);
  }
  let result;
  try {
    result = await (options.runner ?? runBoundedProcess)(ghPath, [
      "auth", "token", "--hostname", host, "--no-refresh",
    ], {
      cwd: root,
      env: ghEnvironment,
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? options.commandTimeoutMs,
      maxStdoutBytes: 16 * 1024,
      maxStderrBytes: 16 * 1024,
    });
  } catch (error) {
    const unsupported = error?.code === "COMMAND_FAILED" &&
      /unknown flag: --no-refresh/iu.test(
        error.details?.stderr?.toString("utf8") ?? "",
      );
    const code = unsupported ? "GITHUB_READ_ONLY_AUTH_UNSUPPORTED"
      : error?.code === "TIMEOUT" ? "GITHUB_AUTH_TIMEOUT"
      : error?.code === "CANCELLED" ? "CANCELLED"
      : "GITHUB_CREDENTIALS_UNAVAILABLE";
    throw new GitBoundaryError(code, "GitHub credential lookup failed");
  }
  const token = result.stdout.toString("utf8").replace(/\r?\n$/u, "");
  result.stdout.fill(0);
  result.stderr.fill(0);
  if (result.exitCode !== 0 || !/^[\x21-\x7e]{1,16384}$/u.test(token)) {
    throw new GitBoundaryError("GITHUB_CREDENTIALS_INVALID", "invalid credential");
  }
  const encoded = Buffer.from(`x-access-token:${token}`, "utf8").toString("base64");
  return {
    header: `Authorization: Basic ${encoded}`,
    secrets: [token, encoded, Buffer.from(token).toString("base64")],
  };
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
  let auth = null;
  let env;
  try {
    const host = approvedHttpsHost(remoteUrl);
    if (options.expectedRemoteId !== undefined &&
        options.expectedRemoteId !== remoteId(remoteUrl)) {
      throw new GitBoundaryError("REMOTE_URL_MISMATCH", "remote URL changed");
    }
    const untrustedRoots = [
      findUntrustedRepositoryRoot(process.cwd()),
      ...(options.untrustedRoots ?? []),
    ];
    const gitPath = resolveExecutablePath(options.gitPath ?? "git", {
      untrustedRoots,
    });
    env = inheritedEnvironment(root);
    env.PATH = path.dirname(gitPath);
    delete env.Path;
    env.GIT_TEMPLATE_DIR = hooks;
    const run = async (args) => {
      try {
        const result = await (options.runner ?? runBoundedProcess)(gitPath, args, {
          cwd: root,
          env,
          signal: options.signal,
          timeoutMs: options.timeoutMs ?? options.commandTimeoutMs,
          maxStdoutBytes: options.maxStdoutBytes,
          maxStderrBytes: options.maxStderrBytes,
        });
        if (auth?.secrets.some((secret) => result.stdout.includes(secret))) {
          throw new GitBoundaryError("REMOTE_RESPONSE_UNSAFE", "unsafe response");
        }
        return result;
      } catch (error) {
        if (auth && authenticationRequired(error)) {
          throw new GitBoundaryError(
            "GITHUB_AUTHENTICATION_FAILED",
            "approved repository rejected authentication",
          );
        }
        throw error;
      }
    };
    await mkdir(hooks);
    await run(["init", "--bare", "--quiet", repository]);
    const configured = [
      "--git-dir", repository,
      "-c", `core.hooksPath=${hooks}`,
      "-c", "core.fsmonitor=false",
      "-c", "credential.helper=",
      "-c", "protocol.allow=never",
      "-c", "protocol.https.allow=always",
      "-c", "protocol.file.allow=always",
      "-c", "http.followRedirects=false",
    ];
    const advertise = () => run([
      ...configured,
      "ls-remote",
      "--symref",
      remoteUrl,
      "HEAD",
      "refs/heads/*",
    ]);
    let advertisement;
    try {
      advertisement = await advertise();
    } catch (error) {
      if (host === null || !authenticationRequired(error)) throw error;
      auth = await githubAuthentication(
        host, gitPath, root, options, untrustedRoots,
      );
      // The secret exists only in this child's environment, never argv or disk.
      env.GIT_CONFIG_COUNT = "1";
      env.GIT_CONFIG_KEY_0 = `http.${remoteUrl}.extraHeader`;
      env.GIT_CONFIG_VALUE_0 = auth.header;
      advertisement = await advertise();
    }
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
    if (env) {
      delete env.GIT_CONFIG_VALUE_0;
      delete env.GIT_CONFIG_KEY_0;
      delete env.GIT_CONFIG_COUNT;
    }
    auth = null;
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
}
