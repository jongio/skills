#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

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
    regex: /(timed out after \d+ms|ETIMEDOUT)/i,
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
    id: "ci-admission-lag",
    label: "GitHub Actions job/step or search-index eventual consistency lag",
    regex: /(Required source CI (job|step) did not succeed|No trusted exact-SHA default-branch CI run exists)/i,
    remediation: "Treat incomplete job/step metadata and transient empty filtered run queries as retryable pending state.",
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

export function parseArgs(argv) {
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
        const idPart = Number.parseInt(rawWatch.slice(colonIdx + 1).trim(), 10);
        if (!isValidRepoSlug(rawRepoPart) || !Number.isSafeInteger(idPart) || idPart <= 0) {
          throw new Error(`Invalid --watch-run "${rawWatch}". Expected "<runId>" or "<owner>/<repo>:<runId>".`);
        }
        const repoPart = normalizeRepoSlug(rawRepoPart);
        args.watchRunsByRepo[repoPart] ??= [];
        if (!args.watchRunsByRepo[repoPart].includes(idPart)) {
          args.watchRunsByRepo[repoPart].push(idPart);
        }
      } else {
        const idPart = Number.parseInt(rawWatch, 10);
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

export function saveConfig(configFile, config) {
  mkdirSync(dirname(configFile), { recursive: true });
  writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`, "utf8");
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
    if (effectiveVisibility !== "private") {
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
  mkdirSync(dirname(stateFile), { recursive: true });
  writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export function parseHttpResponse(raw) {
  let remaining = raw.replace(/\r\n/g, "\n");
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
    return { status: 200, etag: "", bodyText: remaining };
  }
  const bodyText = remaining.trim();
  const statusMatch = lastHeaderBlock.match(/^HTTP\/[\d.]+\s+(\d{3})/m);
  const status = statusMatch ? Number.parseInt(statusMatch[1], 10) : 200;
  const etagMatch = lastHeaderBlock.match(/^etag:\s*(.+)$/im);
  const etag = etagMatch ? etagMatch[1].trim() : "";
  return { status, etag, bodyText };
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
  if (parsed.status === 304 && cached?.data !== undefined) {
    state.metrics.cacheHits304 = (state.metrics.cacheHits304 || 0) + 1;
    return { fromCache: true, data: cached.data };
  }
  if (!result.ok && parsed.status !== 304) {
    return { fromCache: false, data: cached?.data ?? null, error: result.stderr || `HTTP ${parsed.status}` };
  }
  try {
    const data = JSON.parse(parsed.bodyText);
    if (parsed.etag) {
      state.etags[endpoint] = { etag: parsed.etag, data, updatedAt: new Date().toISOString() };
    }
    return { fromCache: false, data };
  } catch (error) {
    return { fromCache: false, data: cached?.data ?? null, error: error.message };
  }
}

function defaultExecGh(ghArgs) {
  const res = spawnSync("gh", ghArgs, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return {
    ok: res.status === 0,
    stdout: res.stdout || "",
    stderr: res.stderr || "",
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
  const workflowName = run.name || "unknown";
  for (const job of jobs) {
    if (job.status !== "completed" || job.conclusion === "skipped") {
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
      if (step.status !== "completed" || step.conclusion === "skipped") {
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

      if (step.conclusion !== "success") {
        const matched = matchFlakePattern(`${job.name} ${step.name}`);
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

export function evaluatePollTick(args, state, execFn = defaultExecGh) {
  state.repo = args.repo;
  state.branch = args.branch;
  state.metrics.lastPollAt = new Date().toISOString();

  const events = [];

  const commitRes = ghApiWithEtag(`repos/${args.repo}/commits/${args.branch}`, state, execFn);
  const currentSha = commitRes.data?.sha || state.lastMainSha;
  if (currentSha && state.lastMainSha && currentSha !== state.lastMainSha) {
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

  const branchRunsRes = ghApiWithEtag(
    `repos/${args.repo}/actions/runs?branch=${encodeURIComponent(args.branch)}&per_page=20`,
    state,
    execFn
  );
  const allRunsRes = ghApiWithEtag(`repos/${args.repo}/actions/runs?per_page=25`, state, execFn);

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
    if (!runMap.has(watchId)) {
      const watchRes = ghApiWithEtag(`repos/${args.repo}/actions/runs/${watchId}`, state, execFn);
      if (watchRes.data?.id) {
        runMap.set(watchRes.data.id, watchRes.data);
      }
    }
  }
  const workflowRuns = [...runMap.values()];

  let activeMainRuns = 0;

  for (const run of workflowRuns) {
    const runKey = String(run.id);
    const prevRun = state.runs[runKey];
    const isPullRequestEvent = isPullRequestRunEvent(run.event);
    const isMainBranch = run.head_branch === args.branch && !isPullRequestEvent;
    const isWatchedRun = args.watchRunIds.includes(run.id);
    const isCurrentHeadMainRun = isMainBranch && run.head_sha === state.lastMainSha;

    if (isMainBranch && run.status !== "completed") {
      activeMainRuns += 1;
    }

    const needsJobsInspection =
      !prevRun ||
      prevRun.updated_at !== run.updated_at ||
      (isMainBranch && run.status !== "completed") ||
      (isWatchedRun && run.status !== "completed");

    let jobs = prevRun?.jobs || [];
    if (needsJobsInspection) {
      const jobsRes = ghApiWithEtag(`repos/${args.repo}/actions/runs/${run.id}/jobs?per_page=50`, state, execFn);
      if (jobsRes.data?.jobs) {
        jobs = jobsRes.data.jobs;
      }
      if (run.status === "completed" && !prevRun?.telemetryRecorded && jobs.length > 0) {
        recordTelemetryForRun(run, jobs, state);
      }
    }

    state.runs[runKey] = {
      id: run.id,
      name: run.name,
      event: run.event,
      head_branch: run.head_branch,
      head_sha: run.head_sha,
      status: run.status,
      conclusion: run.conclusion,
      updated_at: run.updated_at,
      html_url: run.html_url,
      telemetryRecorded: Boolean(prevRun?.telemetryRecorded || (run.status === "completed" && jobs.length > 0)),
      alertedFailure: Boolean(prevRun?.alertedFailure),
    };

    if ((isCurrentHeadMainRun || isWatchedRun) && !state.runs[runKey].alertedFailure) {
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

  const runIdsDescending = Object.keys(state.runs).sort((a, b) => Number(b) - Number(a));
  for (const oldId of runIdsDescending.slice(100)) {
    delete state.runs[oldId];
  }

  if (events.length === 0 && args.wakeOnAllGreen) {
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
    } else if (state.lastMainSha) {
      const headMainRuns = Object.values(state.runs).filter(
        (r) =>
          r.head_branch === args.branch &&
          !isPullRequestRunEvent(r.event) &&
          r.head_sha === state.lastMainSha
      );
      const allCompletedGreen =
        headMainRuns.length > 0 &&
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

  return {
    events,
    activeMainRuns,
    nextIntervalSec: activeMainRuns > 0 ? args.activeIntervalSec : args.idleIntervalSec,
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
  const targetRepos = resolveTargetRepos(args, config, discoveryState, execFn);
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
  let totalActiveMainRuns = 0;

  for (const repo of targetRepos) {
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
    allEvents.push(...tick.events);
    totalActiveMainRuns += tick.activeMainRuns;
    reports.push(buildOptimizationReport(repoState, effectiveMergeMode));
  }

  return {
    repos: targetRepos,
    events: allEvents,
    activeMainRuns: totalActiveMainRuns,
    nextIntervalSec: totalActiveMainRuns > 0 ? args.activeIntervalSec : args.idleIntervalSec,
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
    if (multi.repos.length === 0 && !hasOwnerScope) {
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
            nextIntervalSec: multi.nextIntervalSec,
          },
          report: multi.reports.length === 1 ? multi.reports[0] : multi.reports,
        },
        null,
        2
      )
    );
    return;
  }

  let polls = 0;
  while (true) {
    polls += 1;
    const multi = evaluateMultiRepoPollTick(args, existingConfig);
    if (multi.repos.length === 0 && !hasOwnerScope) {
      console.error(
        "Error: could not determine GitHub repository. Pass --repo <owner/repo> or run `setup` first."
      );
      process.exit(1);
    }
    if (multi.events.length > 0) {
      console.log(JSON.stringify({ repos: multi.repos, events: multi.events }, null, 2));
      return;
    }
    if (args.maxPolls > 0 && polls >= args.maxPolls) {
      console.log(JSON.stringify({ repos: multi.repos, events: [{ type: "MAX_POLLS_REACHED" }] }, null, 2));
      return;
    }
    await sleepSeconds(multi.nextIntervalSec);
  }
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}` || process.argv[1]?.endsWith("ci-hound-daemon.mjs")) {
  runCli();
}
