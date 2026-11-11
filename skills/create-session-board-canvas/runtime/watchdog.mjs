import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const POLICIES = new Set(["off", "autopilot_only", "all_active"]);
const SAFE_SESSION_ID = /^[A-Za-z0-9._-]{1,128}$/;

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

export function classifyRecoveryCandidate(
  session,
  currentMs,
  { graceMs = 60_000, zombieThresholdMs = 900_000, observedAtMs = null } = {},
) {
  if (!session || typeof session !== "object") return { action: "none", autoEligible: false, reason: null, hasSignal: false };

  if (session.rootCancelled) {
    return { action: "none", autoEligible: false, reason: "Session turn was cancelled by operator", hasSignal: false };
  }

  if (session.awaitingInput || session.pendingPlan || session.pendingPermission || session.pendingElicitation) {
    return { action: "none", autoEligible: false, reason: "Waiting on operator input or approval", hasSignal: false };
  }

  if (session.activity === "unknown" || session.lifecycleUnknown) {
    return { action: "none", autoEligible: false, reason: "Session lifecycle state is incomplete", hasSignal: false };
  }

  if (session.activity === "busy") {
    if (Number.isFinite(session.busyDurationMs) && session.busyDurationMs >= zombieThresholdMs) {
      return {
        action: "zombie_stall",
        autoEligible: false,
        hasSignal: false,
        reason: "Session has been busy beyond threshold without completion; inspect or restart CLI.",
      };
    }
    return { action: "none", autoEligible: false, reason: null, hasSignal: false };
  }

  const failedSubagents = Array.isArray(session.failedSubagents) ? session.failedSubagents : [];
  const errorText = [
    session.interruptionReason,
    session.lastError?.message,
    ...failedSubagents.map((sub) => sub?.error),
  ]
    .filter((part) => typeof part === "string" && part.trim())
    .join(" — ");

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

  if (!hasSignal) return { action: "none", autoEligible: false, reason: null, hasSignal: false };

  if (errorText && NON_RETRYABLE_RE.test(errorText)) {
    return {
      action: "attention_only",
      autoEligible: false,
      hasSignal: true,
      reason: `Non-retryable blocker: ${errorText.slice(0, 240)}`,
    };
  }

  if (session.surface === "cli") {
    const safeId = SAFE_SESSION_ID.test(String(session.id || "")) ? session.id : null;
    return {
      action: "cli_resume",
      autoEligible: false,
      hasSignal: true,
      resumeCommand: safeId ? `copilot --resume ${safeId}` : null,
      reason: errorText || "Standalone CLI process exited with unfinished tasks.",
    };
  }

  const hasRemainingWork =
    (session.incompleteLeafCount || 0) > 0 ||
    failedSubagents.length > 0 ||
    (session.resumableWorkflowCount || 0) > 0;

  if (!hasRemainingWork) {
    return { action: "none", autoEligible: false, reason: null, hasSignal: false };
  }

  const effectiveFailedAtMs = Number.isFinite(session.failedAtMs)
    ? session.failedAtMs
    : Number.isFinite(observedAtMs)
      ? observedAtMs
      : currentMs;
  if (currentMs - effectiveFailedAtMs < graceMs) {
    return {
      action: "grace_wait",
      autoEligible: false,
      hasSignal: true,
      reason: "Waiting for built-in host retry grace window to elapse.",
    };
  }

  const kind = failedSubagents.length > 0 ? "subagent_failed" : "interrupted_work";
  return {
    action: "wake_verify",
    kind,
    autoEligible: true,
    hasSignal: true,
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
  function normalizeStoreData(data) {
    if (!data || data.version !== 1 || typeof data.entries !== "object") return null;
    return {
      version: 1,
      policy: POLICIES.has(data.policy) ? data.policy : "off",
      entries: structuredClone(data.entries),
      history: Array.isArray(data.history) ? structuredClone(data.history.slice(-50)) : [],
    };
  }

  const initialLoaded = normalizeStoreData(await store?.load?.(null));
  const state = initialLoaded || { version: 1, policy: "off", entries: {}, history: [] };
  let queueTail = Promise.resolve();
  const serialize = (work) => {
    const next = queueTail.catch(() => {}).then(work);
    queueTail = next;
    return next;
  };

  function mergeEntries(targetEntries, diskEntries) {
    for (const [id, diskEntry] of Object.entries(diskEntries || {})) {
      if (!diskEntry || typeof diskEntry !== "object") continue;
      const local = targetEntries[id];
      if (!local) {
        targetEntries[id] = structuredClone(diskEntry);
        continue;
      }
      if (diskEntry.progressFingerprint === local.progressFingerprint) {
        local.attempts = Math.max(local.attempts || 0, diskEntry.attempts || 0);
        local.circuitOpen = Boolean(local.circuitOpen || diskEntry.circuitOpen);
        if (Number.isFinite(diskEntry.lastAttemptMs) && (!Number.isFinite(local.lastAttemptMs) || diskEntry.lastAttemptMs > local.lastAttemptMs)) {
          local.lastAttemptMs = diskEntry.lastAttemptMs;
          local.lastReason = diskEntry.lastReason ?? local.lastReason;
        }
        const clearedAt = Math.max(
          Number.isFinite(local.failureClearedAtMs) ? local.failureClearedAtMs : 0,
          Number.isFinite(diskEntry.failureClearedAtMs) ? diskEntry.failureClearedAtMs : 0,
        );
        local.failureClearedAtMs = clearedAt > 0 ? clearedAt : null;
        const validLocalObs =
          Number.isFinite(local.firstObservedFailureMs) && local.firstObservedFailureMs > clearedAt
            ? local.firstObservedFailureMs
            : null;
        const validDiskObs =
          Number.isFinite(diskEntry.firstObservedFailureMs) && diskEntry.firstObservedFailureMs > clearedAt
            ? diskEntry.firstObservedFailureMs
            : null;
        local.firstObservedFailureMs =
          validLocalObs != null && validDiskObs != null
            ? Math.min(validLocalObs, validDiskObs)
            : validLocalObs ?? validDiskObs;
      } else if ((diskEntry.lastAttemptMs || 0) > (local.lastAttemptMs || 0)) {
        targetEntries[id] = structuredClone(diskEntry);
      }
    }
  }

  async function syncPolicyFromStore() {
    const disk = normalizeStoreData(await store?.load?.(null));
    if (!disk) return;
    state.policy = disk.policy;
    mergeEntries(state.entries, disk.entries);
    if (disk.history.length > state.history.length) {
      state.history = disk.history.slice(-50);
    }
  }

  async function rollbackCancelledAttempt(sessionId, attemptId, { priorAttempts, priorLastAttemptMs, priorReason }) {
    if (!store?.save) {
      const local = state.entries[sessionId];
      if (local && local.pendingAttemptId === attemptId) {
        local.attempts = priorAttempts;
        local.lastAttemptMs = priorLastAttemptMs;
        local.lastReason = priorReason ?? null;
        local.pendingAttemptId = null;
      }
      state.history = state.history.filter((item) => item.attemptId !== attemptId);
      return state.entries[sessionId];
    }
    const disk = normalizeStoreData(await store.load(null));
    if (disk) {
      state.policy = disk.policy;
      mergeEntries(state.entries, disk.entries);
      if (disk.history.length > state.history.length) {
        state.history = disk.history.slice(-50);
      }
      const diskTarget = disk.entries[sessionId];
      if (diskTarget && diskTarget.pendingAttemptId && diskTarget.pendingAttemptId !== attemptId) {
        // A newer attempt was already recorded by another active leader; preserve that newer accounting!
        state.entries[sessionId] = structuredClone(diskTarget);
        state.history = disk.history.filter((item) => item.attemptId !== attemptId).slice(-50);
        await store.save(state);
        return state.entries[sessionId];
      }
    }
    const target = state.entries[sessionId];
    if (target && target.pendingAttemptId === attemptId) {
      target.attempts = priorAttempts;
      target.lastAttemptMs = priorLastAttemptMs;
      target.lastReason = priorReason ?? null;
      target.pendingAttemptId = null;
    }
    state.history = state.history.filter((item) => item.attemptId !== attemptId).slice(-50);
    await store.save(state);
    return state.entries[sessionId];
  }

  async function persist({ preservePolicy = false } = {}) {
    if (!store?.save) return;
    const disk = normalizeStoreData(await store?.load?.(null));
    if (disk) {
      if (!preservePolicy) state.policy = disk.policy;
      mergeEntries(state.entries, disk.entries);
      if (disk.history.length > state.history.length) {
        state.history = disk.history.slice(-50);
      }
    }
    await store.save(state);
  }

  function setPolicy(nextPolicy) {
    return serialize(async () => {
      if (!POLICIES.has(nextPolicy)) {
        throw new Error(`Invalid recovery policy: ${String(nextPolicy)}`);
      }
      const disk = normalizeStoreData(await store?.load?.(null));
      if (disk) {
        // Adopt authoritative persisted retry/breaker entries on policy-only writes so a follower never clobbers leader state.
        state.entries = structuredClone(disk.entries);
        state.history = structuredClone(disk.history);
      }
      state.policy = nextPolicy;
      await store?.save?.(state);
      return state.policy;
    });
  }

  function evaluate(sessions = [], { canDispatch = () => true } = {}) {
    return serialize(async () => {
      await syncPolicyFromStore();
      const currentMs = now();
      let dirty = false;
      const evaluations = {};

      for (const session of sessions) {
        if (!session?.id) continue;
        const prev = state.entries[session.id] || {
          attempts: 0,
          circuitOpen: false,
          lastAttemptMs: null,
          firstObservedFailureMs: null,
          failureClearedAtMs: null,
          progressFingerprint: session.progressFingerprint || null,
          lastReason: null,
        };

        if (session.progressFingerprint && prev.progressFingerprint && session.progressFingerprint !== prev.progressFingerprint) {
          prev.attempts = 0;
          prev.circuitOpen = false;
          prev.firstObservedFailureMs = null;
          prev.failureClearedAtMs = currentMs;
          prev.progressFingerprint = session.progressFingerprint;
          dirty = true;
        } else if (session.progressFingerprint && !prev.progressFingerprint) {
          prev.progressFingerprint = session.progressFingerprint;
        }

        const probeObserved = prev.firstObservedFailureMs ?? currentMs;
        const classified = classifyRecoveryCandidate(session, currentMs, {
          graceMs,
          zombieThresholdMs,
          observedAtMs: probeObserved,
        });

        if (classified.hasSignal) {
          if (prev.firstObservedFailureMs == null) {
            const candidateObs = Number.isFinite(session.failedAtMs) ? session.failedAtMs : currentMs;
            prev.firstObservedFailureMs =
              Number.isFinite(prev.failureClearedAtMs) && candidateObs <= prev.failureClearedAtMs
                ? currentMs
                : candidateObs;
            dirty = true;
          }
        } else if (prev.firstObservedFailureMs != null) {
          prev.firstObservedFailureMs = null;
          prev.failureClearedAtMs = currentMs;
          dirty = true;
        }

        evaluations[session.id] = {
          ...classified,
          attempts: prev.attempts,
          maxRetries,
          circuitOpen: prev.circuitOpen,
        };

        const modeAllowed =
          state.policy === "all_active" ||
          (state.policy === "autopilot_only" && session.mode === "autopilot");

        if (classified.autoEligible && state.policy !== "off" && modeAllowed && isLeader() && canDispatch()) {
          if (prev.circuitOpen || prev.attempts >= maxRetries) {
            if (!prev.circuitOpen) {
              prev.circuitOpen = true;
              dirty = true;
            }
            evaluations[session.id].circuitOpen = true;
          } else {
            const requiredWait = prev.attempts === 0 ? 0 : baseBackoffMs * 2 ** (prev.attempts - 1);
            const sinceLast = prev.lastAttemptMs == null ? Infinity : currentMs - prev.lastAttemptMs;
            if (sinceLast >= requiredWait && canDispatch()) {
              const prompt = buildRecoveryPrompt(session, classified);
              const priorAttempts = prev.attempts;
              const priorLastAttemptMs = prev.lastAttemptMs;
              const priorReason = prev.lastReason ?? null;
              const attemptId = `${session.id}:${currentMs}:${Math.random().toString(36).slice(2, 8)}`;
              prev.attempts += 1;
              prev.lastAttemptMs = currentMs;
              prev.lastReason = classified.reason;
              prev.pendingAttemptId = attemptId;
              state.entries[session.id] = prev;
              state.history.push({
                attemptId,
                sessionId: session.id,
                at: new Date(currentMs).toISOString(),
                attempt: prev.attempts,
                mode: "auto",
                reason: classified.reason,
              });
              if (state.history.length > 50) state.history = state.history.slice(-50);
              await persist();
              dirty = false;

              // Recheck leader, policy, and active-viewer cancellation after async persistence before dispatching!
              const stillAllowed =
                state.policy !== "off" &&
                (state.policy === "all_active" || (state.policy === "autopilot_only" && session.mode === "autopilot")) &&
                isLeader() &&
                canDispatch();
              if (!stillAllowed) {
                const rolledBack = await rollbackCancelledAttempt(session.id, attemptId, {
                  priorAttempts,
                  priorLastAttemptMs,
                  priorReason,
                });
                evaluations[session.id].attempts = rolledBack?.attempts ?? priorAttempts;
                continue;
              }

              prev.pendingAttemptId = null;
              evaluations[session.id].attempts = prev.attempts;
              try {
                await recoverSession({
                  sessionId: session.id,
                  prompt,
                  attempt: prev.attempts,
                  reason: classified.reason,
                  manual: false,
                });
              } catch (dispatchError) {
                evaluations[session.id].dispatchError = String(dispatchError?.message || dispatchError).slice(0, 200);
              }
            }
          }
        }

        state.entries[session.id] = prev;
      }

      if (dirty) await persist();
      return evaluations;
    });
  }

  function triggerManual(session) {
    return serialize(async () => {
      if (!session?.id) throw new Error("Target session is required");
      if (session.surface === "cli") {
        const safeId = SAFE_SESSION_ID.test(String(session.id)) ? session.id : "<session-id>";
        throw new Error(`Standalone CLI sessions must be resumed in a terminal: copilot --resume ${safeId}`);
      }
      if (session.awaitingInput || session.pendingPlan || session.pendingPermission || session.pendingElicitation) {
        throw new Error("Session is waiting on operator input or approval; resolve the pending prompt first.");
      }
      if (session.rootCancelled) {
        throw new Error("Session turn was cancelled by the operator; send an explicit message in the composer to resume.");
      }
      await syncPolicyFromStore();
      const currentMs = now();
      const classified = classifyRecoveryCandidate(session, currentMs, { graceMs: 0, zombieThresholdMs });
      if (classified.action === "attention_only") {
        throw new Error(classified.reason || "Session has a non-retryable blocker");
      }
      const prev = state.entries[session.id] || {
        attempts: 0,
        circuitOpen: false,
        lastAttemptMs: null,
        firstObservedFailureMs: null,
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
    });
  }

  return {
    getPolicy: () => state.policy,
    setPolicy,
    evaluate,
    triggerManual,
    snapshot: () => structuredClone(state),
  };
}
