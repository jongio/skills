import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const POLICIES = new Set(["off", "autopilot_only", "all_active"]);

const NON_RETRYABLE_RE =
  /\b(401|403|unauthorized|forbidden|oauth|mcp\b[\s\S]{0,40}auth|token\s+expired|sign[\s-]?in|quota|billing|insufficient|trust|untrusted|user\s+cancel|cancelled|canceled|aborted|abort)\b/i;

export async function acquireFleetLeader(scopeKey = "default") {
  const digest = createHash("sha256").update(String(scopeKey)).digest("hex").slice(0, 32);
  const address =
    process.platform === "win32"
      ? `\\\\.\\pipe\\copilot-fleet-leader-${digest}`
      : process.platform === "linux"
        ? `\0copilot-fleet-leader-${digest}`
        : join(tmpdir(), `copilot-fleet-leader-${digest}.sock`);

  const server = createServer((socket) => socket.destroy());
  return new Promise((resolve, reject) => {
    server.once("error", (error) => {
      if (error.code === "EADDRINUSE") resolve(null);
      else reject(error);
    });
    server.listen(address, () =>
      resolve({
        close: () => new Promise((done, fail) => server.close((err) => (err ? fail(err) : done()))),
      }),
    );
  });
}

export function classifyRecoveryCandidate(session, currentMs, { graceMs = 60_000, zombieThresholdMs = 900_000 } = {}) {
  if (!session || typeof session !== "object") return { action: "none", autoEligible: false, reason: null };

  if (session.awaitingInput || session.pendingPlan || session.pendingPermission || session.pendingElicitation) {
    return { action: "none", autoEligible: false, reason: "Waiting on operator input or approval" };
  }

  if (session.activity === "busy") {
    if (Number.isFinite(session.busyDurationMs) && session.busyDurationMs >= zombieThresholdMs) {
      return {
        action: "zombie_stall",
        autoEligible: false,
        reason: "Session has been busy beyond threshold without completion; inspect or restart CLI.",
      };
    }
    return { action: "none", autoEligible: false, reason: null };
  }

  const errorText = [session.interruptionReason, session.lastError?.message]
    .filter((part) => typeof part === "string" && part.trim())
    .join(" — ");

  const failedSubagents = Array.isArray(session.failedSubagents) ? session.failedSubagents : [];
  const hasCliCrash =
    session.surface === "cli" &&
    session.lockState?.hasLockFile === true &&
    session.lockState?.alive === false &&
    (session.incompleteLeafCount || 0) > 0;

  const hasSignal =
    Boolean(session.wasInterrupted) ||
    Boolean(session.lastError) ||
    failedSubagents.length > 0 ||
    hasCliCrash;

  if (!hasSignal) return { action: "none", autoEligible: false, reason: null };

  if (errorText && NON_RETRYABLE_RE.test(errorText)) {
    return {
      action: "attention_only",
      autoEligible: false,
      reason: `Non-retryable blocker: ${errorText.slice(0, 240)}`,
    };
  }

  if (session.surface === "cli") {
    return {
      action: "cli_resume",
      autoEligible: false,
      resumeCommand: `copilot --resume ${session.id}`,
      reason: errorText || "Standalone CLI process exited with unfinished tasks.",
    };
  }

  const hasRemainingWork =
    (session.incompleteLeafCount || 0) > 0 ||
    failedSubagents.length > 0 ||
    (session.resumableWorkflowCount || 0) > 0;

  if (!hasRemainingWork) {
    return { action: "none", autoEligible: false, reason: null };
  }

  const failedAtMs = Number.isFinite(session.failedAtMs) ? session.failedAtMs : null;
  if (failedAtMs !== null && currentMs - failedAtMs < graceMs) {
    return {
      action: "grace_wait",
      autoEligible: false,
      reason: "Waiting for built-in host retry grace window to elapse.",
    };
  }

  const kind = failedSubagents.length > 0 ? "subagent_failed" : "interrupted_work";
  return {
    action: "wake_verify",
    kind,
    autoEligible: true,
    reason:
      errorText ||
      (failedSubagents.length > 0
        ? `Subagent ${failedSubagents[0].name || failedSubagents[0].id} failed while parent session went idle.`
        : "Session stopped with unfinished canonical tasks."),
  };
}

function buildRecoveryPrompt(session, classified) {
  if (classified.kind === "subagent_failed" && Array.isArray(session.failedSubagents) && session.failedSubagents.length > 0) {
    const names = session.failedSubagents.map((s) => s.name || s.id).slice(0, 3).join(", ");
    return `Automated recovery check: subagent (${names}) failed and this session became idle with unfinished tasks. Inspect current task and workspace state before resuming remaining work.`;
  }
  return "Automated recovery check: the previous turn stopped unexpectedly while canonical tasks remain incomplete. Verify git status and SQL todos first, then continue safely from the last verified state.";
}

export async function createRecoveryWatchdog({
  store,
  now = Date.now,
  graceMs = 60_000,
  baseBackoffMs = 30_000,
  maxRetries = 3,
  zombieThresholdMs = 900_000,
  isLeader = () => false,
  recoverSession = async () => {},
} = {}) {
  const loaded = (await store?.load?.(null)) || null;
  const state =
    loaded && loaded.version === 1 && typeof loaded.entries === "object"
      ? {
          version: 1,
          policy: POLICIES.has(loaded.policy) ? loaded.policy : "off",
          entries: { ...loaded.entries },
          history: Array.isArray(loaded.history) ? loaded.history.slice(-50) : [],
        }
      : { version: 1, policy: "off", entries: {}, history: [] };

  async function persist() {
    if (store?.save) await store.save(state);
  }

  async function setPolicy(nextPolicy) {
    if (!POLICIES.has(nextPolicy)) {
      throw new Error(`Invalid recovery policy: ${String(nextPolicy)}`);
    }
    state.policy = nextPolicy;
    await persist();
    return state.policy;
  }

  async function evaluate(sessions = []) {
    const currentMs = now();
    let dirty = false;
    const evaluations = {};

    for (const session of sessions) {
      if (!session?.id) continue;
      const prev = state.entries[session.id] || {
        attempts: 0,
        circuitOpen: false,
        lastAttemptMs: null,
        progressFingerprint: session.progressFingerprint || null,
        lastReason: null,
      };

      if (session.progressFingerprint && prev.progressFingerprint && session.progressFingerprint !== prev.progressFingerprint) {
        prev.attempts = 0;
        prev.circuitOpen = false;
        prev.progressFingerprint = session.progressFingerprint;
        dirty = true;
      } else if (session.progressFingerprint && !prev.progressFingerprint) {
        prev.progressFingerprint = session.progressFingerprint;
      }

      const classified = classifyRecoveryCandidate(session, currentMs, { graceMs, zombieThresholdMs });
      evaluations[session.id] = {
        ...classified,
        attempts: prev.attempts,
        maxRetries,
        circuitOpen: prev.circuitOpen,
      };

      const modeAllowed =
        state.policy === "all_active" ||
        (state.policy === "autopilot_only" && session.mode === "autopilot");

      if (classified.autoEligible && state.policy !== "off" && modeAllowed && isLeader()) {
        if (prev.circuitOpen || prev.attempts >= maxRetries) {
          if (!prev.circuitOpen) {
            prev.circuitOpen = true;
            dirty = true;
          }
          evaluations[session.id].circuitOpen = true;
        } else {
          const requiredWait = prev.attempts === 0 ? 0 : baseBackoffMs * 2 ** (prev.attempts - 1);
          const sinceLast = prev.lastAttemptMs == null ? Infinity : currentMs - prev.lastAttemptMs;
          if (sinceLast >= requiredWait) {
            const prompt = buildRecoveryPrompt(session, classified);
            prev.attempts += 1;
            prev.lastAttemptMs = currentMs;
            prev.lastReason = classified.reason;
            if (prev.attempts >= maxRetries) {
              // Stays eligible to complete this final attempt; subsequent ticks without progress open the circuit.
            }
            state.history.push({
              sessionId: session.id,
              at: new Date(currentMs).toISOString(),
              attempt: prev.attempts,
              mode: "auto",
              reason: classified.reason,
            });
            if (state.history.length > 50) state.history = state.history.slice(-50);
            dirty = true;
            await recoverSession({
              sessionId: session.id,
              prompt,
              attempt: prev.attempts,
              reason: classified.reason,
              manual: false,
            });
            evaluations[session.id].attempts = prev.attempts;
          }
        }
      }

      state.entries[session.id] = prev;
    }

    if (dirty) await persist();
    return evaluations;
  }

  async function triggerManual(session) {
    if (!session?.id) throw new Error("Target session is required");
    if (session.surface === "cli") {
      throw new Error(`Standalone CLI sessions must be resumed in a terminal: copilot --resume ${session.id}`);
    }
    const currentMs = now();
    const classified = classifyRecoveryCandidate(session, currentMs, { graceMs: 0, zombieThresholdMs });
    if (classified.action === "attention_only") {
      throw new Error(classified.reason || "Session has a non-retryable blocker");
    }
    const prev = state.entries[session.id] || {
      attempts: 0,
      circuitOpen: false,
      lastAttemptMs: null,
      progressFingerprint: session.progressFingerprint || null,
    };
    prev.circuitOpen = false;
    prev.attempts += 1;
    prev.lastAttemptMs = currentMs;
    state.entries[session.id] = prev;
    const prompt = buildRecoveryPrompt(session, classified);
    state.history.push({
      sessionId: session.id,
      at: new Date(currentMs).toISOString(),
      attempt: prev.attempts,
      mode: "manual",
      reason: classified.reason || "Manual operator recovery wake",
    });
    if (state.history.length > 50) state.history = state.history.slice(-50);
    await persist();
    await recoverSession({
      sessionId: session.id,
      prompt,
      attempt: prev.attempts,
      reason: classified.reason || "Manual operator recovery wake",
      manual: true,
    });
    return { ok: true, sessionId: session.id, attempt: prev.attempts };
  }

  return {
    getPolicy: () => state.policy,
    setPolicy,
    evaluate,
    triggerManual,
    snapshot: () => structuredClone(state),
  };
}
