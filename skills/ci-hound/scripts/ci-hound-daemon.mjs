#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { MessageChannel, Worker, receiveMessageOnPort } from "node:worker_threads";

export const FLAKE_PATTERNS = [
  {
    id: "epipe-stdin",
    label: "Subprocess unused stdin EPIPE race",
    regex: /write EPIPE/i,
    remediation: "Set child stdio[0] to 'ignore' when no stdin payload is provided instead of writing empty stdin.",
  },
  {
    id: "windows-eperm-lock",
    label: "Windows NTFS EPERM on lock/file unlink",
    regex: /EPERM: operation not permitted, (unlink|rm|rename)/i,
    remediation: "Treat EPERM/EACCES alongside ENOENT during concurrent Windows lock-slot stat/read/unlink inspection.",
  },
  {
    id: "wall-clock-timeout",
    label: "Tight subprocess/test wall-clock timeout under runner contention",
    regex: /(timed out after \d+ms|ETIMEDOUT|\btimed_out\b)/i,
    remediation: "Increase tight wall-clock timeouts on shared CI runners or bound retries with exponential backoff.",
  },
  {
    id: "apt-mirror-timeout",
    label: "Ubuntu apt-get mirror download timeout",
    regex: /(apt-get|Unable to fetch some archives|Connection timed out.*ubuntu)/i,
    remediation: "Pass Acquire::Retries=3 and Acquire::http::Timeout=30 to apt-get and allow sufficient step timeout.",
  },
  {
    id: "pnpm-bootstrap-timeout",
    label: "Corepack/pnpm store bootstrap network timeout",
    regex: /(pnpm store path|Corepack.*timed out|Input required and not supplied: path)/i,
    remediation: "Capture pnpm store path into a variable with retries and non-empty validation before writing $GITHUB_OUTPUT.",
  },
  {
    id: "vscode-extension-host-timeout",
    label: "VS Code extension host activation or notification timeout",
    regex: /(Verify installed bytes and retained archives|Test installed desktop artifact|Health errors waited for notification dismissal)/i,
    remediation: "Bound extension host activation and notification dismissal waits under shared macOS/Windows runner contention.",
  },
  {
    id: "ci-admission-lag",
    label: "GitHub Actions job/step or search-index eventual consistency lag",
    regex: /(Required source CI (job|step) did not succeed|No trusted exact-SHA default-branch CI run exists|Admit Main CI and prepare or resume the exact release candidate|Locate the original source packet for a full rerun)/i,
    remediation: "Treat incomplete job/step metadata and transient empty filtered run queries as retryable pending state.",
  },
  {
    id: "canvas-browser-fixture-timeout",
    label: "Canvas browser fixture teardown or Playwright timeout",
    regex: /(Exercise Canvas browser workflows|Owned Canvas fixture required forced termination)/i,
    remediation: "Close active SSE/HTTP connections before server.close() during fixture shutdown and rerun the failed integration job.",
  },
  {
    id: "skill-eval-trial-variance",
    label: "Vally skill-eval trial grader failure",
    regex: /(Assert eval passed)/i,
    remediation: "Inspect Vally results.jsonl trial graders (skill-invocation, diff-empty, tool-calls, prompt score) for stimulus ambiguity.",
  },
];

export function isValidRepoSlug(value) {
  if (typeof value !== "string") {
    return false;
  }
  const parts = value.trim().split("/");
  if (parts.length !== 2) {
    return false;
  }
  const [owner, repo] = parts;
  if (!owner || !repo || owner === "." || owner === ".." || repo === "." || repo === "..") {
    return false;
  }
  return /^[A-Za-z0-9_.-]+$/.test(owner) && /^[A-Za-z0-9_.-]+$/.test(repo);
}

export function normalizeRepoSlug(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function selectDeliverySkill({
  eventType = "",
  hasExistingPr = false,
  hasCommittedFixBranch = false,
  docsOrConfigOnlyStaged = false,
} = {}) {
  if (hasExistingPr || hasCommittedFixBranch || docsOrConfigOnlyStaged) {
    return "pr";
  }
  if (eventType === "JOB_FAILED" || eventType === "WORKFLOW_FAILED" || eventType === "OPTIMIZE") {
    return "go";
  }
  return "pr";
}

export function defaultMaxWaitSec(env = process.env) {
  const raw = Number.parseInt(String(env?.COPILOT_TASK_WAIT_TIMEOUT_SECONDS ?? ""), 10);
  const hostWaitSec = Number.isFinite(raw) && raw > 0 ? Math.min(raw, 600) : 600;
  return hostWaitSec > 60 ? hostWaitSec - 60 : Math.max(5, Math.floor(hostWaitSec / 2));
}

export function parseArgs(argv, env = process.env) {
  const args = {
    mode: "watch",
    repo: "",
    explicitRepos: [],
    addRepos: [],
    removeRepos: [],
    clearRepos: false,
    owner: "",
    visibility: "",
    worktreeRoot: "",
    branch: "main",
    explicitBranch: false,
    stateFile: "",
    explicitStateFile: false,
    configFile: join(homedir(), ".copilot", "ci-hound", "config.json"),
    activeIntervalSec: 15,
    idleIntervalSec: 60,
    watchRunIds: [],
    watchRunsByRepo: {},
    wakeOnNewCommit: false,
    wakeOnAllGreen: true,
    maxPolls: 0,
    maxWaitSec: defaultMaxWaitSec(env),
    mergeMode: "approval",
    explicitMergeMode: false,
    hasExistingPr: false,
    hasCommittedFixBranch: false,
    docsOrConfigOnlyStaged: false,
  };

  const addValidatedRepos = (targetList, rawValue) => {
    for (const item of String(rawValue)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)) {
      if (!isValidRepoSlug(item)) {
        throw new Error(`Invalid repository slug "${item}". Expected "<owner>/<repo>".`);
      }
      const normalized = normalizeRepoSlug(item);
      if (!targetList.includes(normalized)) {
        targetList.push(normalized);
      }
    }
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (
      token === "watch" ||
      token === "status" ||
      token === "optimize" ||
      token === "once" ||
      token === "setup"
    ) {
      args.mode = token;
    } else if (token === "--mode" && argv[i + 1]) {
      args.mode = argv[++i];
    } else if (token === "--repo" && argv[i + 1]) {
      const val = argv[++i].trim();
      addValidatedRepos(args.explicitRepos, val);
      args.repo = args.explicitRepos[0] || "";
    } else if (token === "--repos" && argv[i + 1]) {
      addValidatedRepos(args.explicitRepos, argv[++i]);
      if (!args.repo && args.explicitRepos.length > 0) {
        args.repo = args.explicitRepos[0];
      }
    } else if (token === "--add-repo" && argv[i + 1]) {
      addValidatedRepos(args.addRepos, argv[++i]);
    } else if (token === "--remove-repo" && argv[i + 1]) {
      addValidatedRepos(args.removeRepos, argv[++i]);
    } else if (token === "--clear-repos") {
      args.clearRepos = true;
    } else if (token === "--all-my-repos") {
      args.owner = "@me";
    } else if (token === "--owner" && argv[i + 1]) {
      args.owner = argv[++i].trim();
    } else if (token === "--visibility" && argv[i + 1]) {
      args.visibility = argv[++i].trim().toLowerCase();
    } else if (token.startsWith("--visibility=")) {
      args.visibility = token.slice("--visibility=".length).trim().toLowerCase();
    } else if (token === "--worktree-root" && argv[i + 1]) {
      args.worktreeRoot = resolve(argv[++i]);
    } else if (token === "--config-file" && argv[i + 1]) {
      args.configFile = resolve(argv[++i]);
    } else if (token === "--branch" && argv[i + 1]) {
      args.branch = argv[++i];
      args.explicitBranch = true;
    } else if (token === "--state-file" && argv[i + 1]) {
      args.stateFile = resolve(argv[++i]);
      args.explicitStateFile = true;
    } else if (token === "--active-interval" && argv[i + 1]) {
      args.activeIntervalSec = Math.max(5, Number.parseInt(argv[++i], 10) || 15);
    } else if (token === "--idle-interval" && argv[i + 1]) {
      args.idleIntervalSec = Math.max(15, Number.parseInt(argv[++i], 10) || 60);
    } else if (token === "--watch-run" && argv[i + 1]) {
      const rawWatch = String(argv[++i]).trim();
      const colonIdx = rawWatch.indexOf(":");
      if (colonIdx !== -1) {
        const rawRepoPart = rawWatch.slice(0, colonIdx).trim();
        const rawIdPart = rawWatch.slice(colonIdx + 1).trim();
        const idPart = /^[1-9]\d*$/.test(rawIdPart) ? Number.parseInt(rawIdPart, 10) : NaN;
        if (!isValidRepoSlug(rawRepoPart) || !Number.isSafeInteger(idPart) || idPart <= 0) {
          throw new Error(`Invalid --watch-run "${rawWatch}". Expected "<runId>" or "<owner>/<repo>:<runId>".`);
        }
        const repoPart = normalizeRepoSlug(rawRepoPart);
        args.watchRunsByRepo[repoPart] ??= [];
        if (!args.watchRunsByRepo[repoPart].includes(idPart)) {
          args.watchRunsByRepo[repoPart].push(idPart);
        }
      } else {
        const idPart = /^[1-9]\d*$/.test(rawWatch) ? Number.parseInt(rawWatch, 10) : NaN;
        if (!Number.isSafeInteger(idPart) || idPart <= 0) {
          throw new Error(`Invalid --watch-run "${rawWatch}". Expected "<runId>" or "<owner>/<repo>:<runId>".`);
        }
        if (!args.watchRunIds.includes(idPart)) {
          args.watchRunIds.push(idPart);
        }
      }
    } else if (token === "--wake-on-commit") {
      args.wakeOnNewCommit = true;
    } else if (token === "--no-wake-on-green") {
      args.wakeOnAllGreen = false;
    } else if (token === "--max-polls" && argv[i + 1]) {
      args.maxPolls = Math.max(1, Number.parseInt(argv[++i], 10) || 1);
    } else if (token === "--max-wait-sec" && argv[i + 1]) {
      const parsedWait = Number.parseInt(argv[++i], 10);
      if (!Number.isSafeInteger(parsedWait) || parsedWait < 0) {
        throw new Error(`Invalid --max-wait-sec "${parsedWait}". Expected a non-negative integer.`);
      }
      args.maxWaitSec = parsedWait;
    } else if (token === "--merge" && argv[i + 1]) {
      args.mergeMode = argv[++i];
      args.explicitMergeMode = true;
    } else if (token.startsWith("--merge=")) {
      args.mergeMode = token.slice("--merge=".length);
      args.explicitMergeMode = true;
    } else if (token === "--existing-pr") {
      args.hasExistingPr = true;
    } else if (token === "--existing-worktree") {
      args.hasCommittedFixBranch = true;
    } else if (token === "--docs-only-staged") {
      args.docsOrConfigOnlyStaged = true;
    }
  }

  if (args.mode === "setup" && (args.watchRunIds.length > 0 || Object.keys(args.watchRunsByRepo).length > 0)) {
    throw new Error("--watch-run cannot be used with `setup` mode.");
  }
  if (args.mergeMode !== "approval" && args.mergeMode !== "auto") {
    throw new Error(`Invalid --merge mode "${args.mergeMode}". Expected "approval" or "auto".`);
  }
  if (args.visibility && !["all", "private", "public"].includes(args.visibility)) {
    throw new Error(`Invalid --visibility "${args.visibility}". Expected "all", "private", or "public".`);
  }
  if (args.owner && args.owner !== "@me" && !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(args.owner)) {
    throw new Error(`Invalid --owner "${args.owner}". Expected "@me" or a valid GitHub login.`);
  }

  if (!args.repo) {
    args.repo = detectRepoFromGit();
  }
  if (!args.stateFile) {
    const safeSlug = normalizeRepoSlug(args.repo || "default").replace(/[^a-zA-Z0-9._-]+/g, "__");
    args.stateFile = join(homedir(), ".copilot", "ci-hound", `${safeSlug}.json`);
  }
  return args;
}

export function loadConfig(configFile) {
  if (configFile && existsSync(configFile)) {
    try {
      const parsed = JSON.parse(readFileSync(configFile, "utf8"));
      const normalizedRepos = [];
      if (Array.isArray(parsed.repos)) {
        for (const r of parsed.repos) {
          if (isValidRepoSlug(r)) {
            const norm = normalizeRepoSlug(r);
            if (!normalizedRepos.includes(norm)) {
              normalizedRepos.push(norm);
            }
          }
        }
      }
      return {
        repos: normalizedRepos,
        owner: typeof parsed.owner === "string" ? parsed.owner : "",
        visibility: ["all", "private", "public"].includes(parsed.visibility) ? parsed.visibility : "",
        branch: typeof parsed.branch === "string" && parsed.branch ? parsed.branch : "main",
        mergeMode: parsed.mergeMode === "auto" ? "auto" : "approval",
        worktreeRoot: typeof parsed.worktreeRoot === "string" ? parsed.worktreeRoot : "",
      };
    } catch {
      // Fall through to default config
    }
  }
  return {
    repos: [],
    owner: "",
    visibility: "",
    branch: "main",
    mergeMode: "approval",
    worktreeRoot: "",
  };
}

function writeJsonAtomically(filePath, value) {
  mkdirSync(dirname(filePath), { recursive: true });
  const content = `${JSON.stringify(value, null, 2)}\n`;
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tempPath, content, "utf8");
    renameSync(tempPath, filePath);
  } finally {
    try {
      if (existsSync(tempPath)) {
        rmSync(tempPath, { force: true });
      }
    } catch {
      // Ignore cleanup race
    }
  }
}

export function saveConfig(configFile, config) {
  writeJsonAtomically(configFile, config);
}

export function applySetupConfig(args, existingConfig) {
  const next = {
    repos: [...(existingConfig.repos || [])],
    owner: existingConfig.owner || "",
    visibility: existingConfig.visibility || "",
    branch: existingConfig.branch || "main",
    mergeMode: existingConfig.mergeMode || "approval",
    worktreeRoot: existingConfig.worktreeRoot || "",
  };

  if (args.clearRepos) {
    next.repos = [];
    next.owner = "";
    next.visibility = "";
  }
  if (args.explicitRepos.length > 0) {
    next.repos = [...args.explicitRepos];
    if (!args.owner) {
      next.owner = "";
      if (!args.visibility) {
        next.visibility = "";
      }
    }
  }
  for (const r of args.addRepos) {
    if (!next.repos.includes(r)) {
      next.repos.push(r);
    }
  }
  if (args.removeRepos.length > 0) {
    next.repos = next.repos.filter((r) => !args.removeRepos.includes(r));
  }
  if (args.owner) {
    next.owner = args.owner;
    if (!next.visibility && !args.visibility) {
      next.visibility = "all";
    }
  }
  if (args.visibility) {
    next.visibility = args.visibility;
  }
  if (args.explicitBranch) {
    next.branch = args.branch;
  }
  if (args.explicitMergeMode) {
    next.mergeMode = args.mergeMode;
  }
  if (args.worktreeRoot) {
    next.worktreeRoot = args.worktreeRoot;
  }
  return next;
}

function fetchPaginatedRepos(baseEndpoint, state, execFn = defaultExecGh) {
  const results = [];
  for (let page = 1; ; page += 1) {
    const res = ghApiWithEtag(`${baseEndpoint}&page=${page}`, state, execFn);
    if (res.rateLimited) {
      if (state) {
        state.rateLimited = true;
      }
      if (Array.isArray(res.data)) {
        results.push(...res.data);
      }
      break;
    }
    if (!Array.isArray(res.data)) {
      throw new Error(res.error || `Repository discovery failed for ${baseEndpoint}&page=${page}`);
    }
    if (res.data.length === 0) {
      break;
    }
    results.push(...res.data);
    if (res.data.length < 100) {
      break;
    }
  }
  return results;
}

export function discoverOwnerRepos(owner, visibility = "all", state, execFn = defaultExecGh) {
  if (!owner) {
    return [];
  }
  if (state) {
    state.rateLimited = false;
    if (state.metrics) {
      state.metrics.retryAfterSec = null;
    }
  }
  const effectiveVisibility = visibility || "all";
  let rawRepos = [];
  if (owner === "@me") {
    rawRepos = fetchPaginatedRepos(
      `user/repos?affiliation=owner&visibility=${effectiveVisibility}&per_page=100`,
      state,
      execFn
    );
  } else {
    const lowerOwner = owner.toLowerCase();
    const accessible = fetchPaginatedRepos(
      `user/repos?affiliation=owner,organization_member,collaborator&visibility=${effectiveVisibility}&per_page=100`,
      state,
      execFn
    ).filter((r) => typeof r?.owner?.login === "string" && r.owner.login.toLowerCase() === lowerOwner);

    const byName = new Map();
    for (const r of accessible) {
      if (isValidRepoSlug(r?.full_name)) {
        byName.set(normalizeRepoSlug(r.full_name), r);
      }
    }
    if (effectiveVisibility !== "private" && !state?.rateLimited) {
      const publicOwnerRepos = fetchPaginatedRepos(
        `users/${encodeURIComponent(owner)}/repos?type=all&per_page=100`,
        state,
        execFn
      );
      for (const r of publicOwnerRepos) {
        const normName = isValidRepoSlug(r?.full_name) ? normalizeRepoSlug(r.full_name) : "";
        if (
          normName &&
          (!r?.owner?.login || r.owner.login.toLowerCase() === lowerOwner) &&
          !byName.has(normName)
        ) {
          byName.set(normName, r);
        }
      }
    }
    rawRepos = [...byName.values()];
  }

  return rawRepos
    .filter((r) => {
      if (!r || r.archived || r.disabled || !isValidRepoSlug(r.full_name)) {
        return false;
      }
      if (effectiveVisibility === "private" && r.private !== true) {
        return false;
      }
      if (effectiveVisibility === "public" && r.private !== false) {
        return false;
      }
      return true;
    })
    .map((r) => normalizeRepoSlug(r.full_name));
}

export function resolveTargetRepos(args, config, discoveryState, execFn = defaultExecGh) {
  if (args.explicitRepos.length > 0) {
    return [...new Set(args.explicitRepos.map(normalizeRepoSlug))];
  }
  const effectiveOwner = args.owner || config?.owner || "";
  const effectiveVisibility = args.visibility || config?.visibility || "all";
  const hasConfiguredRepos = Array.isArray(config?.repos) && config.repos.length > 0;
  const hasConfiguredScope = Boolean(effectiveOwner || hasConfiguredRepos);
  const combined = new Set((config?.repos || []).map(normalizeRepoSlug).filter(Boolean));
  if (effectiveOwner) {
    for (const r of discoverOwnerRepos(effectiveOwner, effectiveVisibility, discoveryState, execFn)) {
      combined.add(normalizeRepoSlug(r));
    }
  }
  if (hasConfiguredScope) {
    return [...combined];
  }
  return args.repo ? [normalizeRepoSlug(args.repo)] : [];
}

export function detectRepoFromGit(cwd = process.cwd()) {
  try {
    const remote = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const match = remote.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/i);
    return match ? normalizeRepoSlug(match[1]) : "";
  } catch {
    return "";
  }
}

export function loadState(stateFile) {
  if (existsSync(stateFile)) {
    try {
      const parsed = JSON.parse(readFileSync(stateFile, "utf8"));
      return {
        repo: parsed.repo || "",
        branch: parsed.branch || "main",
        lastMainSha: parsed.lastMainSha || "",
        etags: parsed.etags || {},
        runs: parsed.runs || {},
        stepTelemetry: parsed.stepTelemetry || {},
        jobTelemetry: parsed.jobTelemetry || {},
        flakeSightings: parsed.flakeSightings || [],
        metrics: parsed.metrics || { apiCalls: 0, cacheHits304: 0, lastPollAt: null },
      };
    } catch {
      // Fall through to fresh state
    }
  }
  return {
    repo: "",
    branch: "main",
    lastMainSha: "",
    etags: {},
    runs: {},
    stepTelemetry: {},
    jobTelemetry: {},
    flakeSightings: [],
    metrics: { apiCalls: 0, cacheHits304: 0, lastPollAt: null },
  };
}

export function saveState(stateFile, state) {
  writeJsonAtomically(stateFile, state);
}

export function normalizeWorkflowTelemetryName(name) {
  const raw = String(name || "unknown").trim() || "unknown";
  if (/^npm_and_yarn in .* - Update #\d+$/i.test(raw) || / - Update #\d+$/i.test(raw)) {
    return "Dependabot Updates";
  }
  return raw;
}

function slimWorkflowRunRecord(run) {
  if (!run || typeof run !== "object") return run;
  const slim = {
    id: run.id,
    name: run.name,
    event: run.event,
    head_branch: run.head_branch,
    head_sha: run.head_sha,
    status: run.status,
    conclusion: run.conclusion,
    updated_at: run.updated_at,
    html_url: run.html_url,
  };
  if (run.workflow_id !== undefined) slim.workflow_id = run.workflow_id;
  if (run.path !== undefined) slim.path = run.path;
  if (run.run_attempt !== undefined) slim.run_attempt = run.run_attempt;
  if (run.head_repository && typeof run.head_repository === "object") {
    slim.head_repository = {
      ...(run.head_repository.id !== undefined ? { id: run.head_repository.id } : {}),
      ...(run.head_repository.full_name !== undefined ? { full_name: run.head_repository.full_name } : {}),
    };
  }
  if (Array.isArray(run.pull_requests)) {
    slim.pull_requests = run.pull_requests.map((pr) => ({
      ...(pr?.number !== undefined ? { number: pr.number } : {}),
      ...(pr?.head
        ? {
            head: {
              ...(pr.head.ref !== undefined ? { ref: pr.head.ref } : {}),
              ...(pr.head.repo?.id !== undefined ? { repo: { id: pr.head.repo.id } } : {}),
            },
          }
        : {}),
      ...(pr?.base
        ? {
            base: {
              ...(pr.base.ref !== undefined ? { ref: pr.base.ref } : {}),
              ...(pr.base.repo?.id !== undefined ? { repo: { id: pr.base.repo.id } } : {}),
            },
          }
        : {}),
    }));
  }
  return slim;
}

function slimJobRecord(job) {
  if (!job || typeof job !== "object") return job;
  return {
    id: job.id,
    name: job.name,
    status: job.status,
    conclusion: job.conclusion,
    created_at: job.created_at,
    started_at: job.started_at,
    completed_at: job.completed_at,
    html_url: job.html_url,
    steps: Array.isArray(job.steps)
      ? job.steps.map((s) => ({
          name: s?.name,
          status: s?.status,
          conclusion: s?.conclusion,
          started_at: s?.started_at,
          completed_at: s?.completed_at,
        }))
      : [],
  };
}

export function slimEtagData(endpoint, data) {
  if (!data || typeof data !== "object") {
    return data;
  }
  const ep = String(endpoint || "");
  if (/^repos\/[^/]+\/[^/]+\/commits\//i.test(ep)) {
    return typeof data.sha === "string" ? { sha: data.sha } : data;
  }
  if (/\/actions\/runs\/\d+\/jobs\b/i.test(ep) && Array.isArray(data.jobs)) {
    return {
      ...(typeof data.total_count === "number" ? { total_count: data.total_count } : {}),
      jobs: data.jobs.map(slimJobRecord),
    };
  }
  if (/\/actions\/runs(?:\?|$)/i.test(ep) && Array.isArray(data.workflow_runs)) {
    return {
      ...(typeof data.total_count === "number" ? { total_count: data.total_count } : {}),
      workflow_runs: data.workflow_runs.map(slimWorkflowRunRecord),
    };
  }
  if (/\/actions\/runs\/\d+$/i.test(ep) && data.id !== undefined) {
    return slimWorkflowRunRecord(data);
  }
  if (/^(?:user\/repos|users\/[^/]+\/repos)\?/i.test(ep) && Array.isArray(data)) {
    return data.map((r) => ({
      full_name: r?.full_name,
      ...(r?.owner ? { owner: { login: r.owner.login } } : {}),
      private: Boolean(r?.private),
      archived: Boolean(r?.archived),
      disabled: Boolean(r?.disabled),
    }));
  }
  return data;
}

export function pruneState(
  state,
  {
    maxRuns = 100,
    maxEtags = 100,
    maxJobTelemetry = 200,
    maxStepTelemetry = 500,
    protectedRunIds = [],
  } = {}
) {
  if (!state || typeof state !== "object") {
    return state;
  }
  const protectedSet = new Set((protectedRunIds || []).map((id) => String(id)));
  if (state.runs && typeof state.runs === "object") {
    const targetBranch = state.branch || "main";
    const allRunIds = Object.keys(state.runs).sort((a, b) => Number(b) - Number(a));
    if (allRunIds.length > maxRuns) {
      let keptCount = 0;
      for (const runId of allRunIds) {
        const runRecord = state.runs[runId];
        const isTrackedActiveMainRun = Boolean(
          runRecord &&
            runRecord.status !== "completed" &&
            runRecord.head_branch === targetBranch &&
            !isPullRequestRunEvent(runRecord.event)
        );
        if (protectedSet.has(runId) || isTrackedActiveMainRun) {
          keptCount += 1;
          continue;
        }
        if (keptCount < maxRuns) {
          keptCount += 1;
        } else {
          delete state.runs[runId];
        }
      }
    }
  }
  if (state.etags && typeof state.etags === "object") {
    const targetBranch = state.branch || "main";
    for (const endpoint of Object.keys(state.etags)) {
      const jobsMatch = endpoint.match(/\/actions\/runs\/(\d+)\/jobs\b/);
      if (jobsMatch) {
        const runIdStr = jobsMatch[1];
        const runRecord = state.runs?.[runIdStr];
        const isWatchedOrActiveMain = Boolean(
          runRecord &&
            runRecord.status !== "completed" &&
            (protectedSet.has(runIdStr) ||
              (runRecord.head_branch === targetBranch && !isPullRequestRunEvent(runRecord.event)))
        );
        const isPendingEmptyJobsRecheck = Boolean(
          runRecord &&
            runRecord.status === "completed" &&
            !runRecord.telemetryRecorded &&
            (runRecord.emptyJobsPolls || 0) > 0 &&
            (runRecord.emptyJobsPolls || 0) < 2
        );
        if (!isWatchedOrActiveMain && !isPendingEmptyJobsRecheck) {
          delete state.etags[endpoint];
          continue;
        }
      }
      const entry = state.etags[endpoint];
      if (entry && entry.data !== undefined) {
        entry.data = slimEtagData(endpoint, entry.data);
      }
    }
    const etagEntries = Object.entries(state.etags);
    if (etagEntries.length > maxEtags) {
      etagEntries.sort((a, b) => {
        const ta = Date.parse(a[1]?.updatedAt || "") || 0;
        const tb = Date.parse(b[1]?.updatedAt || "") || 0;
        return tb - ta;
      });
      for (const [oldEndpoint] of etagEntries.slice(maxEtags)) {
        delete state.etags[oldEndpoint];
      }
    }
  }
  if (state.jobTelemetry && typeof state.jobTelemetry === "object") {
    const mergedJobs = {};
    for (const entry of Object.values(state.jobTelemetry)) {
      if (!entry || typeof entry !== "object") continue;
      const wf = normalizeWorkflowTelemetryName(entry.workflow);
      const key = `${wf} :: ${entry.job}`;
      const existing = mergedJobs[key];
      if (!existing) {
        mergedJobs[key] = { ...entry, workflow: wf };
      } else {
        existing.samples = (existing.samples || 0) + (entry.samples || 0);
        existing.failures = (existing.failures || 0) + (entry.failures || 0);
        existing.totalDurationSec = (existing.totalDurationSec || 0) + (entry.totalDurationSec || 0);
        existing.maxDurationSec = Math.max(existing.maxDurationSec || 0, entry.maxDurationSec || 0);
        existing.totalQueueSec = (existing.totalQueueSec || 0) + (entry.totalQueueSec || 0);
        existing.maxQueueSec = Math.max(existing.maxQueueSec || 0, entry.maxQueueSec || 0);
      }
    }
    const jobEntries = Object.entries(mergedJobs);
    if (jobEntries.length > maxJobTelemetry) {
      jobEntries.sort(
        (a, b) =>
          (b[1].failures || 0) - (a[1].failures || 0) ||
          (b[1].totalDurationSec || 0) - (a[1].totalDurationSec || 0) ||
          (b[1].samples || 0) - (a[1].samples || 0)
      );
    }
    state.jobTelemetry = Object.fromEntries(jobEntries.slice(0, maxJobTelemetry));
  }
  if (state.stepTelemetry && typeof state.stepTelemetry === "object") {
    const mergedSteps = {};
    for (const entry of Object.values(state.stepTelemetry)) {
      if (!entry || typeof entry !== "object") continue;
      const wf = normalizeWorkflowTelemetryName(entry.workflow);
      const key = `${wf} :: ${entry.job} :: ${entry.step}`;
      const existing = mergedSteps[key];
      if (!existing) {
        mergedSteps[key] = { ...entry, workflow: wf };
      } else {
        existing.samples = (existing.samples || 0) + (entry.samples || 0);
        existing.failures = (existing.failures || 0) + (entry.failures || 0);
        existing.totalDurationSec = (existing.totalDurationSec || 0) + (entry.totalDurationSec || 0);
        existing.maxDurationSec = Math.max(existing.maxDurationSec || 0, entry.maxDurationSec || 0);
      }
    }
    const stepEntries = Object.entries(mergedSteps);
    if (stepEntries.length > maxStepTelemetry) {
      stepEntries.sort(
        (a, b) =>
          (b[1].failures || 0) - (a[1].failures || 0) ||
          (b[1].totalDurationSec || 0) - (a[1].totalDurationSec || 0) ||
          (b[1].samples || 0) - (a[1].samples || 0)
      );
    }
    state.stepTelemetry = Object.fromEntries(stepEntries.slice(0, maxStepTelemetry));
  }
  if (Array.isArray(state.flakeSightings)) {
    state.flakeSightings = state.flakeSightings.filter(
      (entry) =>
        entry &&
        entry.conclusion !== "cancelled" &&
        !/^Require every .* to succeed$/i.test(entry.step || "")
    );
    for (const entry of state.flakeSightings) {
      if (!entry.matchedPattern) {
        entry.matchedPattern = matchFlakePattern(
          `${entry.workflow || ""} ${entry.job || ""} ${entry.step || ""} ${entry.conclusion || ""}`
        );
      }
    }
    state.flakeSightings = state.flakeSightings.slice(0, 50);
  }
  return state;
}

function parseRetryAfterHeader(rawVal) {
  if (!rawVal) return null;
  const trimmed = String(rawVal).trim();
  if (/^\d+$/.test(trimmed)) {
    return Number.parseInt(trimmed, 10);
  }
  const dateMs = Date.parse(trimmed);
  if (Number.isFinite(dateMs)) {
    return Math.max(1, Math.ceil((dateMs - Date.now()) / 1000));
  }
  return null;
}

export function parseHttpResponse(raw) {
  let remaining = String(raw || "").replace(/\r\n/g, "\n");
  let lastHeaderBlock = "";
  while (/^HTTP\/[\d.]+\s+\d{3}\b/.test(remaining)) {
    const splitIndex = remaining.indexOf("\n\n");
    if (splitIndex === -1) {
      lastHeaderBlock = remaining;
      remaining = "";
      break;
    }
    lastHeaderBlock = remaining.slice(0, splitIndex);
    remaining = remaining.slice(splitIndex + 2).trimStart();
  }
  if (!lastHeaderBlock) {
    return {
      status: 200,
      etag: "",
      rateLimitRemaining: null,
      rateLimitReset: null,
      retryAfterSec: null,
      bodyText: remaining,
    };
  }
  const bodyText = remaining.trim();
  const statusMatch = lastHeaderBlock.match(/^HTTP\/[\d.]+\s+(\d{3})/m);
  const status = statusMatch ? Number.parseInt(statusMatch[1], 10) : 200;
  const etagMatch = lastHeaderBlock.match(/^etag:\s*(.+)$/im);
  const etag = etagMatch ? etagMatch[1].trim() : "";
  const remMatch = lastHeaderBlock.match(/^x-ratelimit-remaining:\s*(\d+)\s*$/im);
  const rateLimitRemaining = remMatch ? Number.parseInt(remMatch[1], 10) : null;
  const resetMatch = lastHeaderBlock.match(/^x-ratelimit-reset:\s*(\d+)\s*$/im);
  const rateLimitReset = resetMatch ? Number.parseInt(resetMatch[1], 10) : null;
  const retryMatch = lastHeaderBlock.match(/^retry-after:\s*(.+)$/im);
  const retryAfterSec = retryMatch ? parseRetryAfterHeader(retryMatch[1]) : null;
  return { status, etag, rateLimitRemaining, rateLimitReset, retryAfterSec, bodyText };
}

function computeResetDelaySec(rateLimitReset) {
  if (!Number.isFinite(rateLimitReset) || rateLimitReset <= 0) return null;
  return Math.max(1, Math.ceil(rateLimitReset - Date.now() / 1000));
}

export function computeNextPollIntervalSec(args, activeMainRuns, metrics = {}) {
  const baseSec = activeMainRuns > 0 ? args.activeIntervalSec : args.idleIntervalSec;
  let intervalSec = baseSec;
  if (Number.isFinite(metrics?.rateLimitRemaining) && metrics.rateLimitRemaining < 500) {
    const floorSec = activeMainRuns > 0 ? 60 : 120;
    intervalSec = Math.max(baseSec * 2, floorSec);
  }
  const resetDelaySec =
    metrics?.rateLimitRemaining === 0 ? computeResetDelaySec(metrics?.rateLimitReset) : null;
  if (Number.isFinite(resetDelaySec) && resetDelaySec > 0) {
    intervalSec = Math.max(intervalSec, resetDelaySec);
  }
  if (Number.isFinite(metrics?.retryAfterSec) && metrics.retryAfterSec > 0) {
    intervalSec = Math.max(intervalSec, metrics.retryAfterSec);
  }
  return intervalSec;
}

export function ghApiWithEtag(endpoint, state, execFn = defaultExecGh) {
  const cached = state.etags[endpoint];
  const ghArgs = ["api", "-i", endpoint];
  if (cached?.etag) {
    ghArgs.push("-H", `If-None-Match: ${cached.etag}`);
  }
  state.metrics.apiCalls = (state.metrics.apiCalls || 0) + 1;
  const result = execFn(ghArgs);
  const parsed = parseHttpResponse(result.stdout || "");
  if (parsed.rateLimitRemaining !== null) {
    state.metrics.rateLimitRemaining = parsed.rateLimitRemaining;
  }
  if (parsed.rateLimitReset !== null) {
    state.metrics.rateLimitReset = parsed.rateLimitReset;
  }
  if (parsed.retryAfterSec !== null) {
    state.metrics.retryAfterSec = Math.max(state.metrics.retryAfterSec || 0, parsed.retryAfterSec);
  }

  if (parsed.status === 304 && cached?.data !== undefined) {
    state.metrics.cacheHits304 = (state.metrics.cacheHits304 || 0) + 1;
    return { fromCache: true, data: cached.data };
  }
  const isRateLimited =
    parsed.status === 429 ||
    (parsed.status === 403 &&
      (parsed.rateLimitRemaining === 0 ||
        parsed.retryAfterSec !== null ||
        /rate limit/i.test(parsed.bodyText || result.stderr || "")));
  if (isRateLimited) {
    const resetDelaySec =
      parsed.rateLimitRemaining === 0 ? computeResetDelaySec(parsed.rateLimitReset) : null;
    state.metrics.retryAfterSec = Math.max(
      state.metrics.retryAfterSec || 0,
      parsed.retryAfterSec || 0,
      resetDelaySec || 0,
      60
    );
    return {
      fromCache: Boolean(cached?.data !== undefined),
      data: cached?.data ?? null,
      rateLimited: true,
      error: result.stderr || `HTTP ${parsed.status} rate limited`,
    };
  }
  if (!result.ok && parsed.status !== 304) {
    return { fromCache: false, data: cached?.data ?? null, error: result.stderr || `HTTP ${parsed.status}` };
  }
  try {
    const rawData = JSON.parse(parsed.bodyText);
    const data = slimEtagData(endpoint, rawData);
    if (parsed.etag) {
      state.etags[endpoint] = { etag: parsed.etag, data, updatedAt: new Date().toISOString() };
    }
    return { fromCache: false, data };
  } catch (error) {
    return { fromCache: false, data: cached?.data ?? null, error: error.message };
  }
}

export function parseGhApiArgs(ghArgs) {
  if (!Array.isArray(ghArgs) || ghArgs[0] !== "api") {
    return null;
  }
  let includeHeaders = false;
  let method = "";
  const headers = {};
  let endpoint = "";
  const rawFields = {};
  const typedFields = {};

  for (let i = 1; i < ghArgs.length; i += 1) {
    const token = ghArgs[i];
    if (token === "-i" || token === "--include") {
      includeHeaders = true;
    } else if ((token === "-X" || token === "--method") && ghArgs[i + 1]) {
      method = String(ghArgs[++i]).toUpperCase();
    } else if ((token === "-H" || token === "--header") && ghArgs[i + 1]) {
      const rawHeader = String(ghArgs[++i]);
      const colonIdx = rawHeader.indexOf(":");
      if (colonIdx <= 0) return null;
      headers[rawHeader.slice(0, colonIdx).trim()] = rawHeader.slice(colonIdx + 1).trim();
    } else if ((token === "-f" || token === "--raw-field") && ghArgs[i + 1]) {
      const pair = String(ghArgs[++i]);
      const eqIdx = pair.indexOf("=");
      if (eqIdx <= 0) return null;
      rawFields[pair.slice(0, eqIdx)] = pair.slice(eqIdx + 1);
    } else if ((token === "-F" || token === "--field") && ghArgs[i + 1]) {
      const pair = String(ghArgs[++i]);
      const eqIdx = pair.indexOf("=");
      if (eqIdx <= 0) return null;
      const key = pair.slice(0, eqIdx);
      const val = pair.slice(eqIdx + 1);
      if (val.startsWith("@")) return null;
      if (/^-?\d+$/.test(val)) {
        typedFields[key] = Number.parseInt(val, 10);
      } else if (val === "true" || val === "false") {
        typedFields[key] = val === "true";
      } else if (val === "null") {
        typedFields[key] = null;
      } else {
        typedFields[key] = val;
      }
    } else if (token.startsWith("-")) {
      return null;
    } else if (!endpoint) {
      endpoint = token;
    } else {
      return null;
    }
  }

  if (!endpoint) {
    return null;
  }

  if (endpoint === "graphql") {
    const query = rawFields.query ?? typedFields.query;
    if (typeof query !== "string" || !query) {
      return null;
    }
    const variables = { ...rawFields, ...typedFields };
    delete variables.query;
    return {
      url: "https://api.github.com/graphql",
      method: method || "POST",
      includeHeaders,
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ query, variables }),
    };
  }

  if (Object.keys(rawFields).length > 0 || Object.keys(typedFields).length > 0) {
    return null;
  }

  const normalizedEndpoint = endpoint.replace(/^\/+/, "");
  const url = /^https?:\/\//i.test(endpoint)
    ? endpoint
    : `https://api.github.com/${normalizedEndpoint}`;
  return {
    url,
    method: method || "GET",
    includeHeaders,
    headers,
    body: undefined,
  };
}

let keepAliveWorkerState = null;
let nextWorkerReqId = 0;
let activeChunkDeadlineMs = 0;

function resolveGhTokenOnce() {
  const envToken = (process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "").trim();
  if (envToken) {
    return envToken;
  }
  try {
    return execFileSync("gh", ["auth", "token"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    }).trim();
  } catch {
    return "";
  }
}

function getKeepAliveWorker() {
  if (process.env.GH_HOST || process.env.CI_HOUND_DISABLE_KEEPALIVE === "1") {
    return null;
  }
  if (keepAliveWorkerState !== null) {
    return keepAliveWorkerState;
  }
  const token = resolveGhTokenOnce();
  if (!token) {
    keepAliveWorkerState = false;
    return false;
  }
  try {
    const { port1, port2 } = new MessageChannel();
    const workerCode = `
      const { parentPort } = require("node:worker_threads");
      let replyPort = null;
      parentPort.on("message", async (msg) => {
        if (msg.initPort) {
          replyPort = msg.initPort;
          return;
        }
        const { reqId, token, req, timeoutMs, signalBuf } = msg;
        const signal = new Int32Array(signalBuf);
        try {
          const res = await fetch(req.url, {
            method: req.method,
            headers: {
              Accept: "application/vnd.github+json",
              Authorization: "Bearer " + token,
              "X-GitHub-Api-Version": "2022-11-28",
              "User-Agent": "jongio-skills-daemon",
              ...req.headers,
            },
            body: req.body,
            signal: AbortSignal.timeout(timeoutMs || 28000),
          });
          const bodyText = await res.text();
          let stdout = bodyText;
          if (req.includeHeaders) {
            const hdrLines = ["HTTP/2.0 " + res.status];
            for (const h of ["etag", "x-ratelimit-remaining", "x-ratelimit-reset", "retry-after"]) {
              const v = res.headers.get(h);
              if (v !== null && v !== undefined && v !== "") hdrLines.push(h + ": " + v);
            }
            stdout = hdrLines.join("\\r\\n") + "\\r\\n\\r\\n" + bodyText;
          }
          replyPort.postMessage({
            reqId,
            ok: res.ok || (req.includeHeaders && res.status === 304),
            stdout,
            stderr: res.ok || res.status === 304 ? "" : (bodyText || ("HTTP " + res.status)),
          });
        } catch (err) {
          replyPort.postMessage({
            reqId,
            ok: false,
            transportError: true,
            stdout: "",
            stderr: err && err.message ? err.message : String(err),
          });
        } finally {
          Atomics.store(signal, 0, 1);
          Atomics.notify(signal, 0, 1);
        }
      });
    `;
    const worker = new Worker(workerCode, { eval: true });
    worker.unref();
    worker.postMessage({ initPort: port2 }, [port2]);
    keepAliveWorkerState = { worker, port1, token };
    return keepAliveWorkerState;
  } catch {
    keepAliveWorkerState = false;
    return false;
  }
}

function defaultExecGh(ghArgs) {
  const remainingMs = activeChunkDeadlineMs > 0 ? activeChunkDeadlineMs - Date.now() : 30000;
  if (activeChunkDeadlineMs > 0 && remainingMs <= 0) {
    return {
      ok: false,
      timedOut: true,
      stdout: "",
      stderr: "Chunk deadline exceeded",
    };
  }
  const boundedTimeoutMs = Math.min(30000, Math.max(500, remainingMs));
  const parsedReq = parseGhApiArgs(ghArgs);
  if (parsedReq) {
    const ka = getKeepAliveWorker();
    if (ka) {
      const reqId = (nextWorkerReqId += 1);
      const signalBuf = new SharedArrayBuffer(4);
      const signal = new Int32Array(signalBuf);
      ka.worker.postMessage({
        reqId,
        token: ka.token,
        req: parsedReq,
        timeoutMs: Math.min(28000, boundedTimeoutMs),
        signalBuf,
      });
      const waitRes = Atomics.wait(signal, 0, 0, boundedTimeoutMs);
      while (true) {
        const msg = receiveMessageOnPort(ka.port1);
        if (!msg) break;
        if ((waitRes === "ok" || waitRes === "not-equal") && msg.message?.reqId === reqId) {
          const isReadOnlyRequest =
            parsedReq.method === "GET" || parsedReq.url.endsWith("/graphql");
          if (msg.message.transportError && isReadOnlyRequest) {
            break;
          }
          return {
            ok: msg.message.ok,
            stdout: msg.message.stdout,
            stderr: msg.message.stderr,
          };
        }
      }
    }
  }
  const secondRemainingMs = activeChunkDeadlineMs > 0 ? activeChunkDeadlineMs - Date.now() : 30000;
  if (activeChunkDeadlineMs > 0 && secondRemainingMs <= 0) {
    return {
      ok: false,
      timedOut: true,
      stdout: "",
      stderr: "Chunk deadline exceeded",
    };
  }
  const res = spawnSync("gh", ghArgs, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: Math.min(30000, Math.max(500, secondRemainingMs)),
  });
  return {
    ok: res.status === 0,
    stdout: res.stdout || "",
    stderr: res.stderr || (res.error ? res.error.message : ""),
  };
}

export function sendFailureAlert(title, message) {
  if (process.env.CI_HOUND_NO_ALERT === "1") {
    return;
  }
  if (process.platform === "win32") {
    const safeTitle = title.replace(/'/g, "''");
    const safeMessage = message.replace(/'/g, "''");
    const psScript = `
      try { [console]::Beep(880, 250); [console]::Beep(660, 350) } catch {}
      try {
        Add-Type -AssemblyName System.Windows.Forms
        Add-Type -AssemblyName System.Drawing
        $n = New-Object System.Windows.Forms.NotifyIcon
        $n.Icon = [System.Drawing.SystemIcons]::Error
        $n.BalloonTipIcon = [System.Windows.Forms.ToolTipIcon]::Error
        $n.BalloonTipTitle = '${safeTitle}'
        $n.BalloonTipText = '${safeMessage}'
        $n.Visible = $true
        $n.ShowBalloonTip(8000)
        Start-Sleep -Seconds 2
        $n.Dispose()
      } catch {}
    `;
    spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", psScript], {
      stdio: "ignore",
      timeout: 6000,
    });
  } else if (process.platform === "darwin") {
    spawnSync("osascript", ["-e", `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)} sound name "Basso"`], {
      stdio: "ignore",
      timeout: 4000,
    });
  } else {
    spawnSync("notify-send", ["-u", "critical", title, message], {
      stdio: "ignore",
      timeout: 4000,
    });
  }
}

export function matchFlakePattern(text) {
  if (!text) {
    return null;
  }
  for (const pattern of FLAKE_PATTERNS) {
    if (pattern.regex.test(text)) {
      return { id: pattern.id, label: pattern.label, remediation: pattern.remediation };
    }
  }
  return null;
}

export function recordTelemetryForRun(run, jobs, state) {
  const workflowName = normalizeWorkflowTelemetryName(run.name || "unknown");
  for (const job of jobs) {
    if (
      job.status !== "completed" ||
      job.conclusion === "skipped" ||
      job.conclusion === "cancelled"
    ) {
      continue;
    }
    const jobKey = `${workflowName} :: ${job.name}`;
    const startedMs = job.started_at ? Date.parse(job.started_at) : NaN;
    const completedMs = job.completed_at ? Date.parse(job.completed_at) : NaN;
    const createdMs = job.created_at ? Date.parse(job.created_at) : NaN;
    const durationSec = Number.isFinite(startedMs) && Number.isFinite(completedMs) && completedMs >= startedMs
      ? Math.round((completedMs - startedMs) / 1000)
      : 0;
    const queueSec = Number.isFinite(createdMs) && Number.isFinite(startedMs) && startedMs >= createdMs
      ? Math.round((startedMs - createdMs) / 1000)
      : 0;

    const existingJob = state.jobTelemetry[jobKey] || {
      workflow: workflowName,
      job: job.name,
      samples: 0,
      failures: 0,
      totalDurationSec: 0,
      maxDurationSec: 0,
      totalQueueSec: 0,
      maxQueueSec: 0,
    };
    existingJob.samples += 1;
    if (job.conclusion !== "success") {
      existingJob.failures += 1;
    }
    existingJob.totalDurationSec += durationSec;
    existingJob.maxDurationSec = Math.max(existingJob.maxDurationSec, durationSec);
    existingJob.totalQueueSec += queueSec;
    existingJob.maxQueueSec = Math.max(existingJob.maxQueueSec, queueSec);
    state.jobTelemetry[jobKey] = existingJob;

    for (const step of job.steps || []) {
      if (
        step.status !== "completed" ||
        step.conclusion === "skipped" ||
        step.conclusion === "cancelled"
      ) {
        continue;
      }
      const sStart = step.started_at ? Date.parse(step.started_at) : NaN;
      const sEnd = step.completed_at ? Date.parse(step.completed_at) : NaN;
      const stepSec = Number.isFinite(sStart) && Number.isFinite(sEnd) && sEnd >= sStart
        ? Math.round((sEnd - sStart) / 1000)
        : 0;
      const stepKey = `${workflowName} :: ${job.name} :: ${step.name}`;
      const existingStep = state.stepTelemetry[stepKey] || {
        workflow: workflowName,
        job: job.name,
        step: step.name,
        samples: 0,
        failures: 0,
        totalDurationSec: 0,
        maxDurationSec: 0,
      };
      existingStep.samples += 1;
      if (step.conclusion !== "success") {
        existingStep.failures += 1;
      }
      existingStep.totalDurationSec += stepSec;
      existingStep.maxDurationSec = Math.max(existingStep.maxDurationSec, stepSec);
      state.stepTelemetry[stepKey] = existingStep;

      if (step.conclusion !== "success" && !/^Require every .* to succeed$/i.test(step.name || "")) {
        const matched = matchFlakePattern(
          `${workflowName} ${job.name} ${step.name} ${step.conclusion || ""} ${job.conclusion || ""}`
        );
        state.flakeSightings.unshift({
          timestamp: new Date().toISOString(),
          runId: run.id,
          headBranch: run.head_branch,
          headSha: (run.head_sha || "").slice(0, 8),
          event: run.event,
          workflow: workflowName,
          jobId: job.id,
          job: job.name,
          step: step.name,
          conclusion: step.conclusion,
          matchedPattern: matched,
          url: job.html_url || run.html_url,
        });
        state.flakeSightings = state.flakeSightings.slice(0, 50);
      }
    }
  }
}

export function buildOptimizationReport(state, mergeMode = "approval") {
  const slowJobs = Object.values(state.jobTelemetry)
    .map((entry) => ({
      ...entry,
      avgDurationSec: entry.samples > 0 ? Math.round(entry.totalDurationSec / entry.samples) : 0,
      avgQueueSec: entry.samples > 0 ? Math.round(entry.totalQueueSec / entry.samples) : 0,
      failureRate: entry.samples > 0 ? Number((entry.failures / entry.samples).toFixed(2)) : 0,
    }))
    .sort((a, b) => b.avgDurationSec - a.avgDurationSec)
    .slice(0, 10);

  const slowSteps = Object.values(state.stepTelemetry)
    .map((entry) => ({
      ...entry,
      avgDurationSec: entry.samples > 0 ? Math.round(entry.totalDurationSec / entry.samples) : 0,
    }))
    .sort((a, b) => b.avgDurationSec - a.avgDurationSec)
    .slice(0, 12);

  return {
    repo: state.repo,
    branch: state.branch,
    lastMainSha: state.lastMainSha,
    metrics: state.metrics,
    deliveryRouting: {
      newRepairOrOptimize: selectDeliverySkill({ eventType: "OPTIMIZE" }),
      existingWorktreeOrOpenPr: selectDeliverySkill({ hasExistingPr: true }),
      mergeMode,
    },
    slowJobs,
    slowSteps,
    recentFailures: state.flakeSightings.slice(0, 10),
  };
}

function isPullRequestRunEvent(event) {
  return event === "pull_request" || event === "pull_request_target";
}

function selectActiveBranchWorkflowRuns(runs, branch, lastMainSha) {
  const resolveKey = buildWorkflowIdentityResolver(runs);
  const latestOnBranch = new Map();
  for (const r of runs || []) {
    if (!r || typeof r !== "object") continue;
    if (r.head_branch !== branch || isPullRequestRunEvent(r.event)) continue;
    const wfKey = resolveKey(r);
    const prev = latestOnBranch.get(wfKey);
    if (!prev || (Number(r.id) || 0) > (Number(prev.id) || 0)) {
      latestOnBranch.set(wfKey, r);
    }
  }
  const eligibleByWorkflow = new Map();
  for (const [wfKey, latestRun] of latestOnBranch.entries()) {
    if (!lastMainSha || latestRun.head_sha === lastMainSha || latestRun.event === "schedule") {
      eligibleByWorkflow.set(wfKey, latestRun);
    }
  }
  return { resolveKey, eligibleByWorkflow };
}

function workflowKeyForRun(run) {
  if (!run || typeof run !== "object") return "unknown";
  return String(run.workflow_id || run.path || run.name || run.id || "unknown");
}

function buildWorkflowIdentityResolver(runs) {
  const explicitKeysByName = new Map();
  for (const r of runs || []) {
    if (!r || typeof r !== "object") continue;
    const explicitKey = r.workflow_id || r.path;
    if (explicitKey && r.name) {
      const nameKey = String(r.name).trim();
      if (!explicitKeysByName.has(nameKey)) {
        explicitKeysByName.set(nameKey, new Set());
      }
      explicitKeysByName.get(nameKey).add(String(explicitKey));
    }
  }
  return (run) => {
    if (!run || typeof run !== "object") return "unknown";
    if (run.workflow_id || run.path) {
      return String(run.workflow_id || run.path);
    }
    const nameKey = String(run.name || "").trim();
    const matchedExplicit = nameKey ? explicitKeysByName.get(nameKey) : null;
    if (matchedExplicit && matchedExplicit.size === 1) {
      return [...matchedExplicit][0];
    }
    return workflowKeyForRun(run);
  };
}

function latestRunsByWorkflow(runs, resolveKey = buildWorkflowIdentityResolver(runs)) {
  const byWorkflow = new Map();
  for (const r of runs || []) {
    if (!r || typeof r !== "object") continue;
    const wfKey = resolveKey(r);
    const prev = byWorkflow.get(wfKey);
    if (!prev || (Number(r.id) || 0) > (Number(prev.id) || 0)) {
      byWorkflow.set(wfKey, r);
    }
  }
  return [...byWorkflow.values()];
}

export function shouldEmitWatchStatus({
  polls = 1,
  phaseChangesCount = 0,
  summaryChanged = false,
  nowMs = Date.now(),
  lastEmitMs = 0,
  heartbeatSec = 60,
} = {}) {
  if (polls <= 1 || phaseChangesCount > 0 || summaryChanged) return true;
  return nowMs - lastEmitMs >= heartbeatSec * 1000;
}

export function computeCiHoundPhase({
  repo = "",
  branch = "main",
  sha = "",
  activeRuns = [],
} = {}) {
  const shortSha = (sha || "").slice(0, 8) || "unknown";
  if (!Array.isArray(activeRuns) || activeRuns.length === 0) {
    return {
      phase: `${branch}:idle:${shortSha}`,
      summary: `${repo}@${shortSha} (${branch}): idle (0 active runs)`,
    };
  }
  const sorted = [...activeRuns].sort((a, b) => (a.id || 0) - (b.id || 0));
  const phaseParts = sorted.map(
    (r) => `${r.id}:${r.completedJobsCount ?? 0}/${r.totalJobsCount ?? 0}`
  );
  const summaryParts = sorted.map((r) => {
    const activeSample = Array.isArray(r.inProgressJobs)
      ? r.inProgressJobs.slice(0, 3).join(", ")
      : "";
    const activeDetail = activeSample ? `; active: ${activeSample}` : "";
    return `${r.name || "workflow"} (${r.completedJobsCount ?? 0}/${r.totalJobsCount ?? 0} jobs passed${activeDetail})`;
  });
  return {
    phase: `${branch}:running:${shortSha}:${phaseParts.join("|")}`,
    summary: `${repo}@${shortSha} (${branch}): ${summaryParts.join(" | ")}`,
  };
}

export function evaluatePollTick(args, state, execFn = defaultExecGh) {
  state.repo = args.repo;
  state.branch = args.branch;
  const nowMs = Date.now();
  state.metrics.lastPollAt = new Date(nowMs).toISOString();
  if (Number.isFinite(state.metrics?.cooldownUntilMs) && state.metrics.cooldownUntilMs > nowMs) {
    const remainingSec = Math.max(1, Math.ceil((state.metrics.cooldownUntilMs - nowMs) / 1000));
    state.rateLimited = true;
    state.metrics.retryAfterSec = remainingSec;
    return {
      events: [
        {
          type: "RATE_LIMITED",
          repo: args.repo,
          retryAfterSec: remainingSec,
          rateLimitRemaining: state.metrics?.rateLimitRemaining ?? null,
        },
      ],
      activeMainRuns: 0,
      activeTargetRuns: 0,
      rateLimited: true,
      nextIntervalSec: remainingSec,
    };
  }
  state.metrics.cooldownUntilMs = null;
  state.metrics.rateLimitRemaining = null;
  state.metrics.rateLimitReset = null;
  state.metrics.retryAfterSec = null;
  state.rateLimited = false;

  const events = [];
  let tickRateLimited = false;

  const commitRes = ghApiWithEtag(`repos/${args.repo}/commits/${args.branch}`, state, execFn);
  if (commitRes.rateLimited) {
    tickRateLimited = true;
  }
  const currentSha = commitRes.data?.sha || state.lastMainSha;
  if (!tickRateLimited && currentSha && state.lastMainSha && currentSha !== state.lastMainSha) {
    const prevSha = state.lastMainSha;
    state.lastMainSha = currentSha;
    if (args.wakeOnNewCommit) {
      events.push({
        type: "NEW_MAIN_COMMIT",
        repo: args.repo,
        sha: currentSha,
        previousSha: prevSha,
      });
    }
  } else if (currentSha && !state.lastMainSha) {
    state.lastMainSha = currentSha;
  }

  let branchRunsRes = { data: null };
  if (!tickRateLimited) {
    branchRunsRes = ghApiWithEtag(
      `repos/${args.repo}/actions/runs?branch=${encodeURIComponent(args.branch)}&per_page=20`,
      state,
      execFn
    );
    if (branchRunsRes.rateLimited) {
      tickRateLimited = true;
    }
  }

  let allRunsRes = { data: null };
  if (!tickRateLimited) {
    allRunsRes = ghApiWithEtag(`repos/${args.repo}/actions/runs?per_page=25`, state, execFn);
    if (allRunsRes.rateLimited) {
      tickRateLimited = true;
    }
  }

  const runMap = new Map();
  for (const r of branchRunsRes.data?.workflow_runs || []) {
    runMap.set(r.id, r);
  }
  for (const r of allRunsRes.data?.workflow_runs || []) {
    if (!runMap.has(r.id)) {
      runMap.set(r.id, r);
    }
  }
  const trackedActiveIds = new Set(args.watchRunIds);
  for (const existing of Object.values(state.runs)) {
    if (
      existing.head_branch === args.branch &&
      !isPullRequestRunEvent(existing.event) &&
      existing.status !== "completed"
    ) {
      trackedActiveIds.add(existing.id);
    }
  }
  for (const watchId of trackedActiveIds) {
    if (tickRateLimited) {
      break;
    }
    if (!runMap.has(watchId)) {
      const watchRes = ghApiWithEtag(`repos/${args.repo}/actions/runs/${watchId}`, state, execFn);
      if (watchRes.rateLimited) {
        tickRateLimited = true;
        break;
      }
      if (watchRes.data?.id) {
        runMap.set(watchRes.data.id, watchRes.data);
      }
    }
  }
  const workflowRuns = [...runMap.values()];
  const { resolveKey: resolveWorkflowKey, eligibleByWorkflow } = selectActiveBranchWorkflowRuns(
    [...Object.values(state.runs || {}), ...workflowRuns],
    args.branch,
    state.lastMainSha
  );
  const latestMainRunIdByWorkflow = new Map(
    [...eligibleByWorkflow.entries()].map(([wfKey, r]) => [wfKey, Number(r.id)])
  );

  let activeMainRuns = 0;
  let activeTargetRuns = 0;
  const activeRunProgress = [];

  for (const run of workflowRuns) {
    const runKey = String(run.id);
    const prevRun = state.runs[runKey];
    const isPullRequestEvent = isPullRequestRunEvent(run.event);
    const isMainBranch = run.head_branch === args.branch && !isPullRequestEvent;
    const isWatchedRun = args.watchRunIds.includes(run.id);
    const isLatestWorkflowRunOnHead =
      isMainBranch &&
      latestMainRunIdByWorkflow.get(resolveWorkflowKey(run)) === Number(run.id);
    const isCurrentHeadMainRun =
      isLatestWorkflowRunOnHead || (isMainBranch && run.head_sha === state.lastMainSha);

    if (isMainBranch && run.status !== "completed") {
      activeMainRuns += 1;
    }

    const isActiveTargetRun = (isMainBranch || isWatchedRun) && run.status !== "completed";
    if (isActiveTargetRun) {
      activeTargetRuns += 1;
    }
    const prevJobsSettled = Boolean(
      prevRun?.telemetryRecorded || (prevRun?.emptyJobsPolls || 0) >= 2
    );
    const isCompletedNeedsInspection =
      run.status === "completed" &&
      (!prevJobsSettled ||
        ((isCurrentHeadMainRun || isWatchedRun) &&
          (!prevRun || prevRun.updated_at !== run.updated_at)));
    const needsJobsInspection = isActiveTargetRun || isCompletedNeedsInspection;

    let jobs = prevRun?.jobs || [];
    let jobsComplete = true;
    if (needsJobsInspection) {
      if (tickRateLimited) {
        if (isActiveTargetRun) {
          activeRunProgress.push({
            id: run.id,
            name: run.name,
            headSha: run.head_sha,
            totalJobsCount: jobs.length,
            completedJobsCount: 0,
            inProgressJobsCount: 0,
            inProgressJobs: [],
          });
        }
        continue;
      }
      const jobsRes = ghApiWithEtag(`repos/${args.repo}/actions/runs/${run.id}/jobs?per_page=50`, state, execFn);
      if (jobsRes.rateLimited) {
        tickRateLimited = true;
        if (isActiveTargetRun) {
          activeRunProgress.push({
            id: run.id,
            name: run.name,
            headSha: run.head_sha,
            totalJobsCount: jobs.length,
            completedJobsCount: 0,
            inProgressJobsCount: 0,
            inProgressJobs: [],
          });
        }
        continue;
      }
      if (!jobsRes.error && Array.isArray(jobsRes.data?.jobs)) {
        const collectedJobs = [...jobsRes.data.jobs];
        const totalJobsExpected =
          typeof jobsRes.data.total_count === "number"
            ? jobsRes.data.total_count
            : collectedJobs.length;
        let page = 2;
        while (collectedJobs.length < totalJobsExpected) {
          const pageRes = ghApiWithEtag(
            `repos/${args.repo}/actions/runs/${run.id}/jobs?per_page=50&page=${page}`,
            state,
            execFn
          );
          if (pageRes.rateLimited) {
            tickRateLimited = true;
            jobsComplete = false;
            break;
          }
          const pageJobs = pageRes.data?.jobs;
          if (pageRes.error || !Array.isArray(pageJobs) || pageJobs.length === 0) {
            jobsComplete = false;
            break;
          }
          collectedJobs.push(...pageJobs);
          page += 1;
        }
        if (collectedJobs.length < totalJobsExpected) {
          jobsComplete = false;
        }
        jobs = collectedJobs;
      } else {
        jobsComplete = false;
      }
      if (run.status === "completed" && jobsComplete && !prevRun?.telemetryRecorded && jobs.length > 0) {
        recordTelemetryForRun(run, jobs, state);
      }
    }

    if (isActiveTargetRun) {
      const completedJobsCount = jobs.filter(
        (j) => j.status === "completed" && (j.conclusion === "success" || j.conclusion === "skipped")
      ).length;
      const inProgressJobs = jobs
        .filter((j) => j.status !== "completed")
        .map((j) => {
          const activeStep = (j.steps || []).find((s) => s.status === "in_progress");
          return activeStep ? `${j.name} [${activeStep.name}]` : j.name;
        });
      activeRunProgress.push({
        id: run.id,
        name: run.name,
        headSha: run.head_sha,
        totalJobsCount: jobs.length,
        completedJobsCount,
        inProgressJobsCount: inProgressJobs.length,
        inProgressJobs,
      });
    }

    const telemetryRecorded = Boolean(
      prevRun?.telemetryRecorded || (run.status === "completed" && jobsComplete && jobs.length > 0)
    );
    const prevEmptyPolls =
      prevRun && prevRun.updated_at === run.updated_at ? prevRun.emptyJobsPolls || 0 : 0;
    const emptyJobsPolls =
      run.status === "completed" && !telemetryRecorded
        ? needsJobsInspection && jobsComplete && jobs.length === 0
          ? prevEmptyPolls + 1
          : prevEmptyPolls
        : 0;

    const currentAttempt = run.run_attempt ?? prevRun?.run_attempt;
    const prevAlertedAttempt = prevRun?.alertedAttempt;
    const prevAlertedAt = prevRun?.alertedAt || prevRun?.updated_at || "";
    const hasNewAttempt =
      currentAttempt !== undefined && prevAlertedAttempt !== undefined
        ? Number(currentAttempt) > Number(prevAlertedAttempt)
        : Boolean(
            prevRun?.status === "completed" &&
              prevAlertedAt &&
              run.updated_at &&
              prevAlertedAt !== run.updated_at
          );
    const resetAlertedFailure = Boolean(
      prevRun?.alertedFailure &&
        (hasNewAttempt || (prevRun?.status === "completed" && run.status !== "completed"))
    );
    const initialAlertedFailure = resetAlertedFailure ? false : Boolean(prevRun?.alertedFailure);

    state.runs[runKey] = {
      id: run.id,
      ...(run.workflow_id !== undefined
        ? { workflow_id: run.workflow_id }
        : prevRun?.workflow_id !== undefined
          ? { workflow_id: prevRun.workflow_id }
          : {}),
      ...(run.path !== undefined
        ? { path: run.path }
        : prevRun?.path !== undefined
          ? { path: prevRun.path }
          : {}),
      ...(currentAttempt !== undefined ? { run_attempt: currentAttempt } : {}),
      name: run.name,
      event: run.event,
      head_branch: run.head_branch,
      head_sha: run.head_sha,
      status: run.status,
      conclusion: run.conclusion,
      updated_at: jobsComplete ? run.updated_at : prevRun?.updated_at || "",
      html_url: run.html_url,
      telemetryRecorded,
      ...(emptyJobsPolls > 0 ? { emptyJobsPolls } : {}),
      alertedFailure: initialAlertedFailure,
      ...(initialAlertedFailure && (run.updated_at || prevAlertedAt)
        ? { alertedAt: run.updated_at || prevAlertedAt }
        : {}),
      ...(initialAlertedFailure && (currentAttempt !== undefined || prevAlertedAttempt !== undefined)
        ? { alertedAttempt: currentAttempt ?? prevAlertedAttempt }
        : {}),
    };

    const shouldAlertRunFailure =
      args.watchRunIds.length > 0 ? isWatchedRun : isLatestWorkflowRunOnHead;

    if (shouldAlertRunFailure && !state.runs[runKey].alertedFailure) {
      const explicitExistingFix =
        args.watchRunIds.length === 0 || isWatchedRun
          ? {
              hasExistingPr: Boolean(args.hasExistingPr),
              hasCommittedFixBranch: Boolean(args.hasCommittedFixBranch),
              docsOrConfigOnlyStaged: Boolean(args.docsOrConfigOnlyStaged),
            }
          : {
              hasExistingPr: false,
              hasCommittedFixBranch: false,
              docsOrConfigOnlyStaged: false,
            };
      const runSourceRepoId = run.head_repository?.id;
      const hasAssociatedPrForSourceBranch =
        runSourceRepoId !== undefined &&
        runSourceRepoId !== null &&
        Array.isArray(run.pull_requests) &&
        run.pull_requests.some(
          (pr) =>
            pr?.head?.repo?.id !== undefined &&
            pr?.head?.repo?.id === runSourceRepoId &&
            typeof pr?.head?.ref === "string" &&
            pr.head.ref === run.head_branch
        );
      const deliveryContext = {
        hasExistingPr: Boolean(
          explicitExistingFix.hasExistingPr || isPullRequestEvent || hasAssociatedPrForSourceBranch
        ),
        hasCommittedFixBranch: explicitExistingFix.hasCommittedFixBranch,
        docsOrConfigOnlyStaged: explicitExistingFix.docsOrConfigOnlyStaged,
      };
      const failedJobs = jobs.filter(
        (j) =>
          j.status === "completed" &&
          j.conclusion &&
          j.conclusion !== "success" &&
          j.conclusion !== "skipped" &&
          j.conclusion !== "neutral"
      );

      if (failedJobs.length > 0) {
        state.runs[runKey].alertedFailure = true;
        if (run.updated_at) {
          state.runs[runKey].alertedAt = run.updated_at;
        }
        if (currentAttempt !== undefined) {
          state.runs[runKey].alertedAttempt = currentAttempt;
        }
        const firstFailed = failedJobs[0];
        sendFailureAlert(
          `${args.repo} ${args.branch} CI Failed`,
          `${run.name} -> ${firstFailed.name} (${(run.head_sha || "").slice(0, 8)})`
        );
        events.push({
          type: "JOB_FAILED",
          repo: args.repo,
          runId: run.id,
          jobId: firstFailed.id,
          workflow: run.name,
          jobName: firstFailed.name,
          sha: run.head_sha,
          branch: run.head_branch,
          conclusion: firstFailed.conclusion,
          url: firstFailed.html_url || run.html_url,
          deliverySkill: selectDeliverySkill({ eventType: "JOB_FAILED", ...deliveryContext }),
          mergeMode: args.mergeMode,
        });
      } else if (
        run.status === "completed" &&
        run.conclusion &&
        run.conclusion !== "success" &&
        run.conclusion !== "skipped" &&
        run.conclusion !== "neutral"
      ) {
        state.runs[runKey].alertedFailure = true;
        if (run.updated_at) {
          state.runs[runKey].alertedAt = run.updated_at;
        }
        if (currentAttempt !== undefined) {
          state.runs[runKey].alertedAttempt = currentAttempt;
        }
        sendFailureAlert(
          `${args.repo} ${args.branch} Workflow Failed`,
          `${run.name} (${(run.head_sha || "").slice(0, 8)}) failed: ${run.conclusion}`
        );
        events.push({
          type: "WORKFLOW_FAILED",
          repo: args.repo,
          runId: run.id,
          workflow: run.name,
          sha: run.head_sha,
          branch: run.head_branch,
          conclusion: run.conclusion,
          url: run.html_url,
          deliverySkill: selectDeliverySkill({ eventType: "WORKFLOW_FAILED", ...deliveryContext }),
          mergeMode: args.mergeMode,
        });
      }
    }
  }

  pruneState(state, { protectedRunIds: args.watchRunIds || [] });
  state.rateLimited = tickRateLimited;

  const effectiveActiveRuns = Math.max(activeMainRuns, activeTargetRuns, activeRunProgress.length);
  const nextIntervalSec = computeNextPollIntervalSec(args, effectiveActiveRuns, state.metrics);

  if (tickRateLimited) {
    if (state.metrics) {
      state.metrics.cooldownUntilMs = Date.now() + nextIntervalSec * 1000;
    }
    events.push({
      type: "RATE_LIMITED",
      repo: args.repo,
      retryAfterSec: nextIntervalSec,
      rateLimitRemaining: state.metrics?.rateLimitRemaining ?? null,
    });
  } else if (events.length === 0 && args.wakeOnAllGreen) {
    if (args.watchRunIds.length > 0) {
      const watchedRecords = args.watchRunIds.map((id) => state.runs[String(id)]).filter(Boolean);
      const allWatchedDone =
        watchedRecords.length === args.watchRunIds.length &&
        watchedRecords.every((r) => r.status === "completed" && r.conclusion === "success");
      if (allWatchedDone) {
        events.push({
          type: "WATCHED_RUNS_GREEN",
          repo: args.repo,
          watchRunIds: args.watchRunIds,
          sha: state.lastMainSha,
          runs: watchedRecords,
        });
      }
    } else if (state.lastMainSha && activeMainRuns === 0) {
      const { eligibleByWorkflow: headEligibleByWorkflow } = selectActiveBranchWorkflowRuns(
        Object.values(state.runs),
        args.branch,
        state.lastMainSha
      );
      const headMainRuns = [...headEligibleByWorkflow.values()];
      const hasCurrentShaRun = headMainRuns.some((r) => r.head_sha === state.lastMainSha);
      const allCompletedGreen =
        hasCurrentShaRun &&
        headMainRuns.every((r) => r.status === "completed" && (r.conclusion === "success" || r.conclusion === "skipped"));
      if (allCompletedGreen) {
        events.push({
          type: "ALL_GREEN",
          repo: args.repo,
          sha: state.lastMainSha,
          runs: headMainRuns,
        });
      }
    }
  }

  const activeWatchedRun =
    args.watchRunIds.length > 0
      ? activeRunProgress.find((r) => args.watchRunIds.includes(r.id) && r.headSha)
      : null;
  const watchedRecordSha =
    args.watchRunIds.length > 0
      ? args.watchRunIds.map((id) => state.runs[String(id)]?.head_sha).find(Boolean)
      : "";
  const displaySha = activeWatchedRun?.headSha || watchedRecordSha || state.lastMainSha;
  const phaseInfo = computeCiHoundPhase({
    repo: args.repo,
    branch: args.branch,
    sha: displaySha,
    activeRuns: activeRunProgress,
  });
  const statusPayload = tickRateLimited
    ? null
    : {
        timestamp: state.metrics.lastPollAt,
        repo: args.repo,
        branch: args.branch,
        sha: displaySha,
        phase: phaseInfo.phase,
        summary: phaseInfo.summary,
        activeMainRuns,
        activeRuns: activeRunProgress,
        nextIntervalSec,
        cacheHits304: state.metrics?.cacheHits304 || 0,
        rateLimitRemaining: state.metrics?.rateLimitRemaining ?? null,
      };

  return {
    events,
    activeMainRuns,
    activeTargetRuns: effectiveActiveRuns,
    rateLimited: tickRateLimited,
    nextIntervalSec,
    ...(statusPayload ? { status: statusPayload } : {}),
  };
}

export function stateFileForRepo(repo, args) {
  if (args.explicitStateFile) {
    return args.stateFile;
  }
  const safeSlug = normalizeRepoSlug(repo || "default").replace(/[^a-zA-Z0-9._-]+/g, "__");
  return join(dirname(args.configFile), `${safeSlug}.json`);
}

export function evaluateMultiRepoPollTick(args, config, execFn = defaultExecGh) {
  const discoveryStateFile = join(dirname(args.configFile), "_discovery.json");
  const discoveryState = loadState(discoveryStateFile);
  const nowMs = Date.now();
  let targetRepos = [];
  if (
    Number.isFinite(discoveryState.metrics?.cooldownUntilMs) &&
    discoveryState.metrics.cooldownUntilMs > nowMs &&
    args.explicitRepos.length === 0 &&
    !args.repo &&
    (!Array.isArray(config?.repos) || config.repos.length === 0) &&
    (args.owner || config?.owner)
  ) {
    const remainingSec = Math.max(1, Math.ceil((discoveryState.metrics.cooldownUntilMs - nowMs) / 1000));
    discoveryState.rateLimited = true;
    discoveryState.metrics.retryAfterSec = remainingSec;
  } else {
    discoveryState.rateLimited = false;
    if (discoveryState.metrics) {
      discoveryState.metrics.cooldownUntilMs = null;
      discoveryState.metrics.rateLimitRemaining = null;
      discoveryState.metrics.rateLimitReset = null;
      discoveryState.metrics.retryAfterSec = null;
    }
    targetRepos = resolveTargetRepos(args, config, discoveryState, execFn);
    if (discoveryState.rateLimited && discoveryState.metrics) {
      const discRetrySec = computeNextPollIntervalSec(args, 0, discoveryState.metrics);
      discoveryState.metrics.cooldownUntilMs = Date.now() + discRetrySec * 1000;
    }
  }
  for (const qualifiedRepo of Object.keys(args.watchRunsByRepo || {})) {
    if (args.explicitRepos.length > 0 && !args.explicitRepos.includes(qualifiedRepo)) {
      throw new Error(
        `Watched run repository "${qualifiedRepo}" is not in the explicit --repo/--repos list.`
      );
    }
    if (!targetRepos.includes(qualifiedRepo)) {
      targetRepos.push(qualifiedRepo);
    }
  }
  if (args.owner || config?.owner) {
    saveState(discoveryStateFile, discoveryState);
  }
  if (args.explicitStateFile && targetRepos.length > 1) {
    throw new Error("Cannot use a single --state-file when monitoring multiple repositories.");
  }
  if (args.watchRunIds.length > 0 && targetRepos.length > 1) {
    throw new Error(
      "Unqualified --watch-run requires a single target repository (pass --repo <owner/repo> or --watch-run <owner/repo>:<runId>)."
    );
  }

  const effectiveBranch = args.explicitBranch ? args.branch : config?.branch || args.branch || "main";
  const effectiveMergeMode = args.explicitMergeMode
    ? args.mergeMode
    : config?.mergeMode || args.mergeMode || "approval";
  const hasAnyWatchedRuns =
    args.watchRunIds.length > 0 || Object.keys(args.watchRunsByRepo || {}).length > 0;

  const allEvents = [];
  const reports = [];
  const statuses = [];
  let totalActiveMainRuns = 0;
  let anyRateLimited = Boolean(discoveryState.rateLimited);
  let minRateLimitRemaining = Number.isFinite(discoveryState.metrics?.rateLimitRemaining)
    ? discoveryState.metrics.rateLimitRemaining
    : null;
  let maxRateLimitReset = Number.isFinite(discoveryState.metrics?.rateLimitReset)
    ? discoveryState.metrics.rateLimitReset
    : null;
  let maxRetryAfterSec = Number.isFinite(discoveryState.metrics?.retryAfterSec)
    ? discoveryState.metrics.retryAfterSec
    : null;

  const mergeRateMetrics = (metrics) => {
    if (!metrics) return;
    if (Number.isFinite(metrics.rateLimitRemaining)) {
      minRateLimitRemaining =
        minRateLimitRemaining === null
          ? metrics.rateLimitRemaining
          : Math.min(minRateLimitRemaining, metrics.rateLimitRemaining);
    }
    if (Number.isFinite(metrics.rateLimitReset)) {
      maxRateLimitReset =
        maxRateLimitReset === null
          ? metrics.rateLimitReset
          : Math.max(maxRateLimitReset, metrics.rateLimitReset);
    }
    if (Number.isFinite(metrics.retryAfterSec) && metrics.retryAfterSec > 0) {
      maxRetryAfterSec =
        maxRetryAfterSec === null
          ? metrics.retryAfterSec
          : Math.max(maxRetryAfterSec, metrics.retryAfterSec);
    }
  };

  if (discoveryState.rateLimited) {
    const discRetrySec = computeNextPollIntervalSec(args, 0, discoveryState.metrics);
    allEvents.push({
      type: "RATE_LIMITED",
      repo: args.owner || config?.owner || "discovery",
      retryAfterSec: discRetrySec,
      rateLimitRemaining: discoveryState.metrics?.rateLimitRemaining ?? null,
    });
  } else {
    const pendingAllGreenEvents = [];
    for (const repo of targetRepos) {
      if (activeChunkDeadlineMs > 0 && Date.now() >= activeChunkDeadlineMs) {
        break;
      }
      const repoStateFile = stateFileForRepo(repo, args);
      const repoState = loadState(repoStateFile);
      const qualifiedIds = args.watchRunsByRepo?.[repo] || [];
      const repoWatchRunIds =
        targetRepos.length === 1
          ? [...new Set([...args.watchRunIds, ...qualifiedIds])]
          : [...qualifiedIds];
      const applyRepoExistingFlags = !hasAnyWatchedRuns || repoWatchRunIds.length > 0;
      const repoArgs = {
        ...args,
        repo,
        branch: effectiveBranch,
        mergeMode: effectiveMergeMode,
        stateFile: repoStateFile,
        watchRunIds: repoWatchRunIds,
        hasExistingPr: applyRepoExistingFlags ? Boolean(args.hasExistingPr) : false,
        hasCommittedFixBranch: applyRepoExistingFlags ? Boolean(args.hasCommittedFixBranch) : false,
        docsOrConfigOnlyStaged: applyRepoExistingFlags ? Boolean(args.docsOrConfigOnlyStaged) : false,
        wakeOnAllGreen: hasAnyWatchedRuns
          ? repoWatchRunIds.length > 0 && args.wakeOnAllGreen
          : args.wakeOnAllGreen,
      };
      const tick = evaluatePollTick(repoArgs, repoState, execFn);
      saveState(repoStateFile, repoState);
      for (const ev of tick.events) {
        if (ev.type === "ALL_GREEN" && targetRepos.length > 1) {
          pendingAllGreenEvents.push(ev);
        } else {
          allEvents.push(ev);
        }
      }
      if (tick.status) {
        statuses.push(tick.status);
      }
      totalActiveMainRuns += Math.max(
        tick.activeMainRuns,
        tick.activeTargetRuns || 0,
        tick.status?.activeRuns?.length || 0
      );
      mergeRateMetrics(repoState.metrics);
      reports.push(buildOptimizationReport(repoState, effectiveMergeMode));
      if (tick.rateLimited) {
        anyRateLimited = true;
        break;
      }
    }
    if (
      targetRepos.length > 1 &&
      !anyRateLimited &&
      totalActiveMainRuns === 0 &&
      allEvents.length === 0 &&
      pendingAllGreenEvents.length === targetRepos.length
    ) {
      allEvents.push(...pendingAllGreenEvents);
    }
  }

  const nextIntervalSec = computeNextPollIntervalSec(args, totalActiveMainRuns, {
    rateLimitRemaining: minRateLimitRemaining,
    rateLimitReset: maxRateLimitReset,
    retryAfterSec: maxRetryAfterSec,
  });

  return {
    repos: targetRepos,
    events: allEvents,
    activeMainRuns: totalActiveMainRuns,
    rateLimited: anyRateLimited,
    nextIntervalSec,
    statuses,
    reports,
  };
}

async function sleepSeconds(sec) {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, sec * 1000));
}

export async function runCli(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const existingConfig = loadConfig(args.configFile);

  if (args.mode === "setup") {
    const updatedConfig = applySetupConfig(args, existingConfig);
    saveConfig(args.configFile, updatedConfig);
    const discoveryStateFile = join(dirname(args.configFile), "_discovery.json");
    const discoveryState = loadState(discoveryStateFile);
    const resolvedRepos = resolveTargetRepos(
      { ...args, explicitRepos: [] },
      updatedConfig,
      discoveryState
    );
    if (updatedConfig.owner) {
      saveState(discoveryStateFile, discoveryState);
    }
    console.log(
      JSON.stringify(
        {
          mode: "setup",
          configFile: args.configFile,
          config: updatedConfig,
          resolvedRepos,
        },
        null,
        2
      )
    );
    return;
  }

  const hasOwnerScope = Boolean(args.owner || existingConfig?.owner);

  if (args.mode === "status" || args.mode === "optimize" || args.mode === "once") {
    const multi = evaluateMultiRepoPollTick(args, existingConfig);
    if (multi.repos.length === 0 && !hasOwnerScope && !multi.rateLimited) {
      console.error(
        "Error: could not determine GitHub repository. Pass --repo <owner/repo> or run `setup` first."
      );
      process.exit(1);
    }
    console.log(
      JSON.stringify(
        {
          mode: args.mode,
          repos: multi.repos,
          tick: {
            events: multi.events,
            activeMainRuns: multi.activeMainRuns,
            rateLimited: multi.rateLimited,
            nextIntervalSec: multi.nextIntervalSec,
            statuses: multi.statuses,
          },
          report: multi.reports.length === 1 ? multi.reports[0] : multi.reports,
        },
        null,
        2
      )
    );
    return;
  }

  const lastPhaseByRepo = new Map();
  const lastSummaryByRepo = new Map();
  const watchStartedAtMs = Date.now();
  activeChunkDeadlineMs = args.maxWaitSec > 0 ? watchStartedAtMs + args.maxWaitSec * 1000 : 0;
  let lastEmitMs = 0;
  let polls = 0;
  try {
    while (true) {
      polls += 1;
      const multi = evaluateMultiRepoPollTick(args, existingConfig);
      if (multi.repos.length === 0 && !hasOwnerScope && !multi.rateLimited) {
        console.error(
          "Error: could not determine GitHub repository. Pass --repo <owner/repo> or run `setup` first."
        );
        process.exit(1);
      }
      const terminalEvents = multi.events.filter((e) => e.type !== "RATE_LIMITED");
      if (terminalEvents.length > 0) {
        console.log(JSON.stringify({ repos: multi.repos, events: terminalEvents }, null, 2));
        return;
      }
      const phaseChanges = [];
      let summaryChanged = false;
      for (const st of multi.statuses || []) {
        const prevPhase = lastPhaseByRepo.get(st.repo);
        if (prevPhase && prevPhase !== st.phase) {
          phaseChanges.push({
            type: "PHASE_CHANGED",
            timestamp: st.timestamp,
            repo: st.repo,
            previousPhase: prevPhase,
            phase: st.phase,
            summary: st.summary,
          });
        }
        const prevSummary = lastSummaryByRepo.get(st.repo);
        if (prevSummary && prevSummary !== st.summary) {
          summaryChanged = true;
        }
        lastPhaseByRepo.set(st.repo, st.phase);
        lastSummaryByRepo.set(st.repo, st.summary);
      }
      const nowMs = Date.now();
      if (
        shouldEmitWatchStatus({
          polls,
          phaseChangesCount: phaseChanges.length,
          summaryChanged,
          nowMs,
          lastEmitMs,
        })
      ) {
        lastEmitMs = nowMs;
        console.log(
          JSON.stringify(
            {
              repos: multi.repos,
              events: phaseChanges,
              statuses: multi.statuses,
            },
            null,
            2
          )
        );
      }
      if (args.maxPolls > 0 && polls >= args.maxPolls) {
        console.log(JSON.stringify({ repos: multi.repos, events: [{ type: "MAX_POLLS_REACHED" }] }, null, 2));
        return;
      }
      if (args.maxWaitSec > 0) {
        const elapsedSec = Math.floor((Date.now() - watchStartedAtMs) / 1000);
        if (elapsedSec + multi.nextIntervalSec >= args.maxWaitSec) {
          const remainingWaitSec = Math.max(0, args.maxWaitSec - elapsedSec);
          if (remainingWaitSec > 0) {
            await sleepSeconds(remainingWaitSec);
          }
          console.log(
            JSON.stringify(
              {
                repos: multi.repos,
                events: [
                  {
                    type: "WATCH_CHUNK_TIMEOUT",
                    elapsedSec: Math.floor((Date.now() - watchStartedAtMs) / 1000),
                    maxWaitSec: args.maxWaitSec,
                  },
                ],
                statuses: multi.statuses,
              },
              null,
              2
            )
          );
          return;
        }
      }
      await sleepSeconds(multi.nextIntervalSec);
    }
  } finally {
    activeChunkDeadlineMs = 0;
  }
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}` || process.argv[1]?.endsWith("ci-hound-daemon.mjs")) {
  runCli();
}
