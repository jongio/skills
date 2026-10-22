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
    branch: "main",
    stateFile: "",
    activeIntervalSec: 15,
    idleIntervalSec: 60,
    watchRunIds: [],
    wakeOnNewCommit: false,
    wakeOnAllGreen: true,
    maxPolls: 0,
    mergeMode: "approval",
    hasExistingPr: false,
    hasCommittedFixBranch: false,
    docsOrConfigOnlyStaged: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "watch" || token === "status" || token === "optimize" || token === "once") {
      args.mode = token;
    } else if (token === "--mode" && argv[i + 1]) {
      args.mode = argv[++i];
    } else if (token === "--repo" && argv[i + 1]) {
      args.repo = argv[++i];
    } else if (token === "--branch" && argv[i + 1]) {
      args.branch = argv[++i];
    } else if (token === "--state-file" && argv[i + 1]) {
      args.stateFile = argv[++i];
    } else if (token === "--active-interval" && argv[i + 1]) {
      args.activeIntervalSec = Math.max(5, Number.parseInt(argv[++i], 10) || 15);
    } else if (token === "--idle-interval" && argv[i + 1]) {
      args.idleIntervalSec = Math.max(15, Number.parseInt(argv[++i], 10) || 60);
    } else if (token === "--watch-run" && argv[i + 1]) {
      args.watchRunIds.push(Number.parseInt(argv[++i], 10));
    } else if (token === "--wake-on-commit") {
      args.wakeOnNewCommit = true;
    } else if (token === "--no-wake-on-green") {
      args.wakeOnAllGreen = false;
    } else if (token === "--max-polls" && argv[i + 1]) {
      args.maxPolls = Math.max(1, Number.parseInt(argv[++i], 10) || 1);
    } else if (token === "--merge" && argv[i + 1]) {
      args.mergeMode = argv[++i];
    } else if (token.startsWith("--merge=")) {
      args.mergeMode = token.slice("--merge=".length);
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

  if (!args.repo) {
    args.repo = detectRepoFromGit();
  }
  if (!args.stateFile) {
    const safeSlug = (args.repo || "default").replace(/[^a-zA-Z0-9._-]+/g, "__");
    args.stateFile = join(homedir(), ".copilot", "ci-hound", `${safeSlug}.json`);
  } else {
    args.stateFile = resolve(args.stateFile);
  }
  return args;
}

export function detectRepoFromGit(cwd = process.cwd()) {
  try {
    const remote = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const match = remote.match(/github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?$/i);
    return match ? match[1] : "";
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
  const normalized = raw.replace(/\r\n/g, "\n");
  const splitIndex = normalized.indexOf("\n\n");
  if (splitIndex === -1) {
    return { status: 200, etag: "", bodyText: normalized };
  }
  const headerBlock = normalized.slice(0, splitIndex);
  const bodyText = normalized.slice(splitIndex + 2).trim();
  const statusMatch = headerBlock.match(/^HTTP\/[\d.]+\s+(\d{3})/m);
  const status = statusMatch ? Number.parseInt(statusMatch[1], 10) : 200;
  const etagMatch = headerBlock.match(/^etag:\s*(.+)$/im);
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
    if (existing.head_branch === args.branch && existing.status !== "completed") {
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
    const isMainBranch = run.head_branch === args.branch;
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
      const runHasExistingPr = Boolean(
        args.hasExistingPr ||
          run.event === "pull_request" ||
          (Array.isArray(run.pull_requests) && run.pull_requests.length > 0) ||
          (isWatchedRun && !isMainBranch)
      );
      const deliveryContext = {
        hasExistingPr: runHasExistingPr,
        hasCommittedFixBranch: Boolean(args.hasCommittedFixBranch),
        docsOrConfigOnlyStaged: Boolean(args.docsOrConfigOnlyStaged),
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
          watchRunIds: args.watchRunIds,
          sha: state.lastMainSha,
          runs: watchedRecords,
        });
      }
    } else if (state.lastMainSha) {
      const headMainRuns = Object.values(state.runs).filter(
        (r) => r.head_branch === args.branch && r.head_sha === state.lastMainSha
      );
      const allCompletedGreen =
        headMainRuns.length > 0 &&
        headMainRuns.every((r) => r.status === "completed" && (r.conclusion === "success" || r.conclusion === "skipped"));
      if (allCompletedGreen) {
        events.push({
          type: "ALL_GREEN",
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

async function sleepSeconds(sec) {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, sec * 1000));
}

export async function runCli(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (!args.repo) {
    console.error("Error: could not determine GitHub repository. Pass --repo <owner/repo>.");
    process.exit(1);
  }
  const state = loadState(args.stateFile);

  if (args.mode === "status" || args.mode === "optimize" || args.mode === "once") {
    const tick = evaluatePollTick(args, state);
    saveState(args.stateFile, state);
    const report = buildOptimizationReport(state, args.mergeMode);
    console.log(JSON.stringify({ mode: args.mode, tick, report }, null, 2));
    return;
  }

  let polls = 0;
  while (true) {
    polls += 1;
    const tick = evaluatePollTick(args, state);
    saveState(args.stateFile, state);
    if (tick.events.length > 0) {
      console.log(JSON.stringify({ events: tick.events, metrics: state.metrics }, null, 2));
      return;
    }
    if (args.maxPolls > 0 && polls >= args.maxPolls) {
      console.log(JSON.stringify({ events: [{ type: "MAX_POLLS_REACHED" }], metrics: state.metrics }, null, 2));
      return;
    }
    await sleepSeconds(tick.nextIntervalSec);
  }
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}` || process.argv[1]?.endsWith("ci-hound-daemon.mjs")) {
  runCli();
}
