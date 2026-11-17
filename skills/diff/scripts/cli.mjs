#!/usr/bin/env node
// Cross-harness CLI bridge for skills/diff.
// Drives the shared canvas-kit loopback runtime + userStore("diff", ...) for
// Copilot CLI, Claude Code, Cursor, Codex, Windsurf, and local terminals.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createCanvasRuntime } from "../runtime/canvas-kit/server.mjs";
import { userStore } from "../runtime/canvas-kit/storage.mjs";
import {
  MAX_REVIEW_ARTIFACT_BYTES,
  createDiffCanvasConfig,
  openDiffInstance,
} from "../runtime/canvas.mjs";
import {
  resolveCurrentBranchPrNumber,
  resolveTrustedExecutable,
  sanitizePublicErrorMessage,
} from "../runtime/diff-loader.mjs";

const SAFE_CAPABILITY_URL_RE =
  /^http:\/\/127\.0\.0\.1:(\d{1,5})\/\?capability=[0-9a-f]{32,128}$/;
const SAFE_DOMAIN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
const SAFE_ARTIFACT_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}\.json$/;
const POSITIVE_INT_RE = /^[1-9]\d{0,8}$/;
const VALID_STATUSES = new Set(["draft", "pending", "addressed"]);
const DEFAULT_IDLE_TIMEOUT_MS = 1_800_000;
const MIN_IDLE_TIMEOUT_MS = 100;
const MAX_IDLE_TIMEOUT_MS = 86_400_000;
const MAX_ARTIFACT_BYTES = MAX_REVIEW_ARTIFACT_BYTES;

const USAGE_TEXT = [
  "Usage:",
  "  node scripts/cli.mjs [serve] [--cwd <dir>] [--spec <spec> | --staged | --cached | --unstaged | --repo <owner/repo> --pr <num> [--account <login>] | pr [<num>] | <spec>] [--focus <file>] [--no-open] [--print-url] [--wait] [--idle-timeout-ms <ms>] [--json] [-- <paths...>]",
  "  node scripts/cli.mjs review [--cwd <dir>] [--domain <domainId> | target flags...] [--json]",
  "  node scripts/cli.mjs list [--status pending|draft|addressed] [--json]",
  "  node scripts/cli.mjs address [--cwd <dir>] [--domain <domainId> | target flags...] [--json]",
  "  node scripts/cli.mjs reopen [--clear-comments] [--cwd <dir>] [--domain <domainId> | target flags...] [--json]",
].join("\n");

export function validateLoopbackCapabilityUrl(url) {
  if (typeof url !== "string") {
    throw new Error("Invalid loopback capability URL");
  }
  const match = SAFE_CAPABILITY_URL_RE.exec(url);
  if (!match) {
    throw new Error("Refusing to open non-loopback or malformed capability URL");
  }
  const port = Number.parseInt(match[1], 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Invalid loopback port in capability URL");
  }
  return url;
}

function buildSanitizedBrowserEnv(baseEnv = process.env) {
  const clean = {};
  for (const [key, value] of Object.entries(baseEnv ?? {})) {
    if (value === undefined) continue;
    const upper = key.toUpperCase();
    if (
      upper === "GH_TOKEN" ||
      upper === "GITHUB_TOKEN" ||
      upper.startsWith("COPILOT_GH_ACCOUNT_")
    ) {
      continue;
    }
    clean[key] = value;
  }
  clean.NoDefaultCurrentDirectoryInExePath = "1";
  return clean;
}

function resolveBrowserExecutable(
  platform,
  {
    env = process.env,
    untrustedRoots = [],
    resolveExecutable,
    requireFilesystemResolution = true,
  } = {},
) {
  const rawCandidate =
    platform === "darwin"
      ? "open"
      : platform === "win32"
        ? path.win32.join(
            String(env?.SystemRoot || process.env.SystemRoot || "C:\\Windows"),
            "System32",
            "rundll32.exe",
          )
        : "xdg-open";

  if (!requireFilesystemResolution && !resolveExecutable) {
    return rawCandidate;
  }

  const resolver = resolveExecutable ?? resolveTrustedExecutable;
  return resolver(rawCandidate, {
    env,
    platform,
    untrustedRoots: [...untrustedRoots, process.cwd()],
  });
}

export function openSystemBrowser(
  url,
  {
    platform = process.platform,
    spawnFn = spawn,
    env = process.env,
    untrustedRoots = [],
    resolveExecutable,
  } = {},
) {
  const safeUrl = validateLoopbackCapabilityUrl(url);
  const cmd = resolveBrowserExecutable(platform, {
    env,
    untrustedRoots,
    resolveExecutable,
    requireFilesystemResolution: spawnFn === spawn,
  });
  const args =
    platform === "win32"
      ? ["url.dll,FileProtocolHandler", safeUrl]
      : [safeUrl];
  const childEnv = buildSanitizedBrowserEnv(env);

  return new Promise((resolve, reject) => {
    const child = spawnFn(cmd, args, {
      cwd: os.tmpdir(),
      env: childEnv,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      shell: false,
    });
    let settled = false;
    if (typeof child?.once !== "function") {
      settled = true;
      child?.unref?.();
      resolve({ launched: true });
      return;
    }
    child.once("error", (err) => {
      if (settled) return;
      settled = true;
      reject(
        new Error(
          `Failed to launch system browser: ${sanitizePublicErrorMessage(err)}`,
        ),
      );
    });
    child.once("spawn", () => {
      if (settled) return;
      settled = true;
      child.unref?.();
      resolve({ launched: true });
    });
  });
}

function assertSafeDomainOption(raw) {
  if (
    typeof raw !== "string" ||
    !raw ||
    raw === "." ||
    raw === ".." ||
    raw.includes("..") ||
    raw === "default" ||
    raw === "unconfigured" ||
    !SAFE_DOMAIN_ID_RE.test(raw)
  ) {
    throw new Error(`Invalid --domain identifier '${String(raw ?? "")}'`);
  }
  return raw;
}

function assertSafeSpecValue(raw) {
  if (typeof raw !== "string" || !raw.trim() || /[\0\r\n]/.test(raw)) {
    throw new Error("Invalid --spec value");
  }
  const trimmed = raw.trim();
  if (
    trimmed.startsWith("-") &&
    trimmed !== "--staged" &&
    trimmed !== "--cached" &&
    trimmed !== "--unstaged"
  ) {
    throw new Error(`Invalid diff spec '${trimmed}': refs must not start with '-'`);
  }
  return trimmed;
}

export function parseCliArgs(argv = []) {
  const args = Array.isArray(argv) ? argv.map((v) => String(v)) : [];
  const ddIdx = args.indexOf("--");
  const head = ddIdx >= 0 ? args.slice(0, ddIdx) : args;
  const paths = ddIdx >= 0 ? args.slice(ddIdx + 1) : [];

  if (head.includes("--help") || head.includes("-h")) {
    return { command: "help" };
  }

  let command = "serve";
  let idx = 0;
  const first = head[0];
  if (first === "serve" || first === "open") {
    command = "serve";
    idx = 1;
  } else if (first === "review" || first === "get-review" || first === "get_review") {
    command = "review";
    idx = 1;
  } else if (first === "list" || first === "address" || first === "reopen") {
    command = first;
    idx = 1;
  }

  let cwd = "";
  let spec = "";
  let repo = "";
  let pr = null;
  let inferPr = false;
  let account;
  let focusFile = "";
  let domain = "";
  let status = "";
  let clearComments = false;
  let noOpen = false;
  let printUrl = false;
  let wait = false;
  let idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS;
  let hasIdleTimeoutFlag = false;
  let json = false;
  const positionals = [];

  const readValue = (flagName) => {
    if (idx + 1 >= head.length) {
      throw new Error(`Missing value for ${flagName}`);
    }
    idx += 1;
    return head[idx];
  };

  for (; idx < head.length; idx += 1) {
    const tok = head[idx];
    if (tok === "--cwd") {
      cwd = readValue("--cwd");
    } else if (tok === "--spec") {
      if (spec) throw new Error("Conflicting diff spec flags");
      spec = assertSafeSpecValue(readValue("--spec"));
    } else if (tok === "--staged" || tok === "--cached" || tok === "--unstaged") {
      if (spec) throw new Error("Conflicting diff spec flags");
      spec = tok;
    } else if (tok === "--repo") {
      repo = readValue("--repo");
    } else if (tok === "--pr") {
      const rawPr = readValue("--pr");
      if (!POSITIVE_INT_RE.test(rawPr)) {
        throw new Error(`Invalid --pr number '${rawPr}'`);
      }
      pr = Number.parseInt(rawPr, 10);
    } else if (tok === "--account") {
      account = readValue("--account");
    } else if (tok === "--focus") {
      focusFile = readValue("--focus");
    } else if (tok === "--domain") {
      domain = assertSafeDomainOption(readValue("--domain"));
    } else if (tok === "--status") {
      const rawStatus = readValue("--status");
      if (!VALID_STATUSES.has(rawStatus)) {
        throw new Error(`Invalid --status '${rawStatus}' (expected pending, draft, or addressed)`);
      }
      status = rawStatus;
    } else if (tok === "--clear-comments") {
      clearComments = true;
    } else if (tok === "--no-open") {
      noOpen = true;
    } else if (tok === "--print-url") {
      printUrl = true;
    } else if (tok === "--wait") {
      wait = true;
    } else if (tok === "--idle-timeout-ms") {
      hasIdleTimeoutFlag = true;
      const rawTimeout = readValue("--idle-timeout-ms");
      if (!/^\d+$/.test(rawTimeout)) {
        throw new Error(`Invalid --idle-timeout-ms '${rawTimeout}'`);
      }
      const parsedTimeout = Number.parseInt(rawTimeout, 10);
      if (
        !Number.isInteger(parsedTimeout) ||
        parsedTimeout < MIN_IDLE_TIMEOUT_MS ||
        parsedTimeout > MAX_IDLE_TIMEOUT_MS
      ) {
        throw new Error(
          `--idle-timeout-ms must be between ${MIN_IDLE_TIMEOUT_MS} and ${MAX_IDLE_TIMEOUT_MS}`,
        );
      }
      idleTimeoutMs = parsedTimeout;
    } else if (tok === "--json") {
      json = true;
    } else if (tok.startsWith("-")) {
      throw new Error(`Unknown or unsafe option '${tok}'`);
    } else {
      positionals.push(tok);
    }
  }

  if (positionals.length > 0) {
    if (command === "list") {
      throw new Error("Unexpected positional arguments for 'list'");
    }
    if (positionals[0] === "pr") {
      if (pr !== null || spec) {
        throw new Error("Conflicting PR and diff spec arguments");
      }
      if (positionals.length === 1) {
        inferPr = true;
      } else if (positionals.length === 2 && POSITIVE_INT_RE.test(positionals[1])) {
        pr = Number.parseInt(positionals[1], 10);
      } else {
        throw new Error(`Invalid PR number '${positionals[1]}'`);
      }
    } else if (positionals.length === 1) {
      if (spec || pr !== null || repo) {
        throw new Error("Conflicting positional diff spec and flags");
      }
      spec = assertSafeSpecValue(positionals[0]);
    } else {
      throw new Error(`Unexpected positional arguments: ${positionals.join(" ")}`);
    }
  }

  const hasPrTarget = pr !== null || inferPr || Boolean(repo);
  if (spec && (hasPrTarget || account !== undefined)) {
    throw new Error("Conflicting PR and Git diff spec options");
  }
  if (inferPr && repo) {
    throw new Error("Specify an explicit PR number when using --repo");
  }
  if (account !== undefined && !hasPrTarget) {
    throw new Error("--account requires a pull request target (--pr or pr)");
  }

  if (domain) {
    if (command !== "review" && command !== "address" && command !== "reopen") {
      throw new Error(`--domain is only supported with review, address, or reopen`);
    }
    if (
      repo ||
      pr !== null ||
      inferPr ||
      account !== undefined ||
      spec ||
      paths.length > 0
    ) {
      throw new Error("--domain cannot be combined with diff target flags");
    }
  }

  if (status && command !== "list") {
    throw new Error("--status is only supported with 'list'");
  }
  if (clearComments && command !== "reopen") {
    throw new Error("--clear-comments is only supported with 'reopen'");
  }
  if (command !== "serve") {
    if (focusFile) {
      throw new Error("--focus is only supported with 'serve'");
    }
    if (noOpen) {
      throw new Error("--no-open is only supported with 'serve'");
    }
    if (printUrl) {
      throw new Error("--print-url is only supported with 'serve'");
    }
    if (wait) {
      throw new Error("--wait is only supported with 'serve'");
    }
    if (hasIdleTimeoutFlag) {
      throw new Error("--idle-timeout-ms is only supported with 'serve'");
    }
  }

  return {
    command,
    cwd,
    spec,
    repo,
    pr,
    inferPr,
    account,
    focusFile,
    domain,
    status,
    clearComments,
    noOpen,
    printUrl,
    wait,
    idleTimeoutMs,
    json,
    paths,
  };
}

export function listSavedReviews({ statusFilter = "", env = process.env } = {}) {
  const copilotHome = env?.COPILOT_HOME || path.join(os.homedir(), ".copilot");
  const segments = ["extensions", "diff", "artifacts"];
  let cursor = path.resolve(copilotHome);

  try {
    const rootStat = fs.lstatSync(cursor);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      throw new Error("Refusing to read symlinked COPILOT_HOME directory");
    }
  } catch (err) {
    if (err?.code === "ENOENT") return [];
    throw err;
  }

  for (const seg of segments) {
    cursor = path.join(cursor, seg);
    let st;
    try {
      st = fs.lstatSync(cursor);
    } catch (err) {
      if (err?.code === "ENOENT") return [];
      throw err;
    }
    if (st.isSymbolicLink() || !st.isDirectory()) {
      throw new Error("Refusing to read symlinked diff artifacts directory");
    }
  }

  const realArtifactsDir = fs.realpathSync(cursor);
  const realPrefix = realArtifactsDir.endsWith(path.sep)
    ? realArtifactsDir
    : realArtifactsDir + path.sep;

  const entries = fs.readdirSync(cursor);
  const reviews = [];

  for (const name of entries) {
    if (!SAFE_ARTIFACT_FILE_RE.test(name) || name.endsWith(".tmp")) continue;
    const fullPath = path.join(cursor, name);
    let st;
    try {
      st = fs.lstatSync(fullPath);
    } catch {
      continue;
    }
    if (st.isSymbolicLink() || !st.isFile() || st.size > MAX_ARTIFACT_BYTES) {
      continue;
    }
    let realFile;
    try {
      realFile = fs.realpathSync(fullPath);
    } catch {
      continue;
    }
    if (!realFile.startsWith(realPrefix)) {
      continue;
    }

    let doc;
    try {
      doc = JSON.parse(fs.readFileSync(realFile, "utf8"));
    } catch {
      continue;
    }
    if (!doc || typeof doc !== "object") continue;

    const itemStatus =
      doc.status === "pending" || doc.status === "addressed" ? doc.status : "draft";
    if (statusFilter && itemStatus !== statusFilter) continue;

    reviews.push({
      domain:
        typeof doc.domain === "string" && SAFE_DOMAIN_ID_RE.test(doc.domain)
          ? doc.domain
          : name.slice(0, -5),
      title: typeof doc.title === "string" ? doc.title : "Diff Viewer",
      diffSpec: typeof doc.diffSpec === "string" ? doc.diffSpec : "",
      branch: typeof doc.branch === "string" ? doc.branch : "",
      status: itemStatus,
      commentCount: Array.isArray(doc.comments) ? doc.comments.length : 0,
      viewedCount: Array.isArray(doc.viewedFiles) ? doc.viewedFiles.length : 0,
      source: doc.source && typeof doc.source === "object" ? doc.source : null,
      submittedAt: typeof doc.submittedAt === "string" ? doc.submittedAt : null,
      addressedAt: typeof doc.addressedAt === "string" ? doc.addressedAt : null,
      updatedAt: typeof doc.updatedAt === "string" ? doc.updatedAt : null,
    });
  }

  reviews.sort((a, b) => {
    const ta = Date.parse(a.updatedAt || a.submittedAt || "") || 0;
    const tb = Date.parse(b.updatedAt || b.submittedAt || "") || 0;
    if (tb !== ta) return tb - ta;
    return a.domain.localeCompare(b.domain);
  });

  return reviews;
}

function buildOpenInput(parsed, resolvedPr) {
  const input = {};
  if (parsed.cwd) input.cwd = parsed.cwd;
  if (parsed.spec) input.spec = parsed.spec;
  if (parsed.repo) input.repo = parsed.repo;
  if (resolvedPr !== null) input.pr = resolvedPr;
  if (parsed.account !== undefined) input.account = parsed.account;
  if (parsed.focusFile) input.focusFile = parsed.focusFile;
  if (parsed.paths.length > 0) input.paths = parsed.paths;
  return input;
}

function writeOutput(stream, payload, asJson) {
  if (asJson) {
    stream.write(`${JSON.stringify(payload)}\n`);
    return;
  }
  if (typeof payload === "string") {
    stream.write(`${payload}\n`);
    return;
  }
  stream.write(`${JSON.stringify(payload, null, 2)}\n`);
}

async function shutdownServeRuntime(runtime, inst) {
  for (const sseRes of inst?.clients ?? []) {
    try {
      sseRes.end();
    } catch {
      // ignore
    }
  }
  inst?.server?.closeIdleConnections?.();
  inst?.server?.closeAllConnections?.();
  await runtime.shutdown();
}

export async function runCli(argv = process.argv.slice(2), deps = {}) {
  const env = deps.env ?? process.env;
  const execFn = deps.execFn;
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const settleMs = deps.settleMs ?? 250;
  const abortSignal = deps.abortSignal ?? null;

  const parsed = parseCliArgs(argv);
  if (parsed.command === "help") {
    stdout.write(`${USAGE_TEXT}\n`);
    return { ok: true, help: true };
  }

  if (parsed.command === "list") {
    const reviews = listSavedReviews({ statusFilter: parsed.status, env });
    const out = { ok: true, reviews };
    writeOutput(stdout, out, parsed.json);
    return out;
  }

  const workspacePath = parsed.cwd
    ? path.resolve(parsed.cwd)
    : deps.cwd
      ? path.resolve(deps.cwd)
      : process.cwd();

  const openBrowser =
    deps.openBrowser ??
    ((targetUrl) =>
      openSystemBrowser(targetUrl, {
        env,
        untrustedRoots: [workspacePath, process.cwd()],
      }));

  let resolvedPr = parsed.pr;
  if (parsed.inferPr) {
    resolvedPr = await resolveCurrentBranchPrNumber(workspacePath, {
      execFn,
      env,
      account: parsed.account,
    });
  }
  const openInput = buildOpenInput(parsed, resolvedPr);

  const storeFactory =
    deps.storeFactory ??
    ((safeFile) => {
      const prev = process.env.COPILOT_HOME;
      if (env?.COPILOT_HOME !== undefined) {
        process.env.COPILOT_HOME = env.COPILOT_HOME;
      }
      try {
        return userStore("diff", safeFile);
      } finally {
        if (env?.COPILOT_HOME !== undefined) {
          if (prev === undefined) delete process.env.COPILOT_HOME;
          else process.env.COPILOT_HOME = prev;
        }
      }
    });

  if (
    parsed.command === "review" ||
    parsed.command === "address" ||
    parsed.command === "reopen"
  ) {
    const config = createDiffCanvasConfig({ execFn, env, storeFactory });
    const runtime = createCanvasRuntime(config);
    try {
      const sdkCtx = parsed.domain
        ? { workspacePath, targetDomainId: parsed.domain }
        : { workspacePath, openInput };
      const actionName =
        parsed.command === "review"
          ? "get_review"
          : parsed.command === "address"
            ? "mark_addressed"
            : "reopen_review";
      const actionInput =
        parsed.command === "reopen"
          ? { clearComments: Boolean(parsed.clearComments) }
          : {};
      const result = await runtime.invokeFromAgent(actionName, actionInput, sdkCtx);
      const out = { ok: true, ...result };
      writeOutput(stdout, out, parsed.json);
      return out;
    } finally {
      await runtime.shutdown();
    }
  }

  // parsed.command === "serve"
  let submittedResolve = null;
  const submittedPromise = new Promise((resolve) => {
    submittedResolve = resolve;
  });

  const config = createDiffCanvasConfig({
    execFn,
    env,
    storeFactory,
    onReviewSubmitted: (info) => {
      submittedResolve?.(info);
    },
  });
  const runtime = createCanvasRuntime(config);

  try {
    const panel = await openDiffInstance(runtime, config, {
      instanceId: "cli-viewer",
      input: openInput,
      workspacePath,
    });
    validateLoopbackCapabilityUrl(panel.url);

    const inst = runtime._instances.get("cli-viewer");
    const domainId = inst?.domainId ?? "default";
    const initialState = await runtime.getState(domainId);

    if (!parsed.noOpen) {
      await openBrowser(panel.url);
    }

    deps.onReady?.({
      url: panel.url,
      domain: initialState.domain,
      status: panel.status,
    });

    let idleTimer = null;
    let resolveStop = null;
    const stopPromise = new Promise((resolve) => {
      resolveStop = resolve;
    });

    const resetIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        resolveStop?.({ reason: "timeout" });
      }, parsed.idleTimeoutMs);
    };
    resetIdleTimer();

    if (inst?.server) {
      inst.server.on("request", resetIdleTimer);
    }

    const onSignal = () => resolveStop?.({ reason: "signal" });
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    const onAbort = () => resolveStop?.({ reason: "signal" });
    abortSignal?.addEventListener("abort", onAbort, { once: true });

    try {
      if (!parsed.wait) {
        const startPayload = {
          ok: true,
          status: panel.status,
          domain: initialState.domain,
          title: initialState.title,
          branch: initialState.branch,
          stats: initialState.stats,
          waiting: false,
          ...(parsed.printUrl ? { url: panel.url } : {}),
        };
        writeOutput(stdout, startPayload, parsed.json);
        await stopPromise;
        return startPayload;
      }

      if (parsed.printUrl) {
        stderr.write(`DIFF_VIEWER_URL=${panel.url}\n`);
      }

      const outcome = await Promise.race([
        submittedPromise.then((info) => ({ reason: "submitted", info })),
        stopPromise,
      ]);

      if (outcome.reason === "submitted") {
        await new Promise((r) => setTimeout(r, settleMs));
        const review = await runtime.invokeFromAgent(
          "get_review",
          {},
          { instanceId: "cli-viewer", workspacePath },
        );
        await shutdownServeRuntime(runtime, inst);
        const out = {
          ok: true,
          submitted: true,
          ...(parsed.printUrl ? { url: panel.url } : {}),
          ...review,
        };
        writeOutput(stdout, out, parsed.json);
        return out;
      }

      const review = await runtime.invokeFromAgent(
        "get_review",
        {},
        { instanceId: "cli-viewer", workspacePath },
      );
      await shutdownServeRuntime(runtime, inst);
      const out = {
        ok: outcome.reason !== "timeout",
        submitted: false,
        reason: outcome.reason,
        ...(parsed.printUrl ? { url: panel.url } : {}),
        ...review,
      };
      writeOutput(stdout, out, parsed.json);
      return out;
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
      abortSignal?.removeEventListener("abort", onAbort);
    }
  } finally {
    const activeInst = runtime._instances.get("cli-viewer");
    await shutdownServeRuntime(runtime, activeInst);
  }
}

const isDirectEntry =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectEntry) {
  const cliArgs = process.argv.slice(2);
  runCli(cliArgs).then(
    (res) => {
      if (res && res.ok === false) {
        process.exitCode = 1;
      }
    },
    (err) => {
      const ddIdx = cliArgs.indexOf("--");
      const headArgs = ddIdx === -1 ? cliArgs : cliArgs.slice(0, ddIdx);
      const jsonMode = headArgs.includes("--json");
      const message = sanitizePublicErrorMessage(err);
      if (jsonMode) {
        process.stdout.write(`${JSON.stringify({ ok: false, error: message })}\n`);
      } else {
        process.stderr.write(`diff error: ${message}\n`);
      }
      process.exitCode = 1;
    },
  );
}
