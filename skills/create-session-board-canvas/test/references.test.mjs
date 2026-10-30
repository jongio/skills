import assert from "node:assert/strict";
import test from "node:test";
import { createProgressService } from "../runtime/progress.mjs";
import { createTrackingSync, trackingChangeKind, trackingResult } from "../runtime/references.mjs";
import { notifySessionTracking } from "../../../extensions/github-refresh.mjs";

const primary = { id: "primary", primary: true };
const headA = "a".repeat(40);
const headB = "b".repeat(40);
const pr = { reference: "owner/repo#42", owned: true, state: "OPEN", headRefOid: headA, title: "Current PR" };
const observedAt = "2026-10-27T18:00:00.000Z";
async function fixture(onChange) {
  let saved;
  const options = {
    sessionId: "references-test",
    store: { load: async () => saved, save: async (value) => { saved = structuredClone(value); } },
    readSources: async () => ({ plan: { exists: false }, rows: [], dependencies: [] }),
    onChange,
  };
  const service = await createProgressService(options);
  return { service, resume: () => createProgressService(options) };
}

test("only explicit successful tracking controls produce ownership snapshots", () => {
  const payload = JSON.stringify([{ url: "https://github.com/owner/repo/pull/42", owned: true }, { url: "https://github.com/other/repo/pull/1", owned: false }]);
  const input = { toolName: "session_prs", toolArgs: { action: "list" }, toolResult: { resultType: "success", textResultForLlm: payload } };
  assert.equal(trackingResult(input).values.length, 1);
  assert.equal(trackingResult({ ...input, toolName: "powershell" }), null);
  assert.equal(trackingResult({ ...input, toolName: "untrusted.session_prs" }), null);
  assert.equal(trackingResult({ ...input, toolResult: { resultType: "failure" } }), null);
  assert.ok(trackingResult({ ...input, toolResult: { textResultForLlm: '[{"url":"https://github.com/owner/repo/pull/42"}]' } }).error);
});

test("successful statusline tool refresh is an invalidation, never an empty ownership snapshot", () => {
  const input = { toolName: "session_statusline", toolArgs: { action: "refresh" }, toolResult: {
    resultType: "success", textResultForLlm: "Refreshed this session's tracked statusline entries. Tracking and enabled components are unchanged.",
  } };
  assert.deepEqual(trackingResult(input), { refreshAll: true });
  assert.deepEqual(trackingResult({ ...input, toolResult: {
    resultType: "success", textResultForLlm: "Session statusline refresh incomplete:\nRemote status unavailable",
  } }), { refreshAll: true });
  assert.equal(trackingResult({ ...input, toolResult: { resultType: "failure" } }), null);
  assert.ok(trackingResult({ ...input, toolResult: { resultType: "success", textResultForLlm: "" } }).error);
  assert.equal(trackingResult({ ...input, toolName: "session_prs" }), null);
});

test("session control snapshots mirror targets and clear without enrolling work", async () => {
  const { service } = await fixture();
  await service.syncTracking({ kind: "prs", values: [{ url: "https://github.com/owner/repo/pull/42", owned: true }] });
  assert.equal(service.snapshot().references.source.status, "partial");
  await service.syncTracking({ kind: "issues", values: [] });
  assert.equal(service.snapshot().references.source.status, "verified");
  assert.equal(service.snapshot().references.prs[0].reference, "owner/repo#42");
  assert.equal(service.snapshot().references.prs[0].ci.status, "unknown");
  const clear = trackingResult({ toolName: "session_statusline", toolArgs: { action: "clear" }, toolResult: {
    resultType: "success", textResultForLlm: "Cleared this session's PR, issue, subagent, and worktree entries. Component settings and transcripts are unchanged.",
  } });
  await service.syncTracking(clear);
  assert.deepEqual(service.snapshot().references.prs, []);
  assert.deepEqual(service.snapshot().tasks, []);
  await assert.rejects(service.update({ action: "ci", reference: pr.reference, headRefOid: headA, status: "passed", passed: 1, total: 1, observedAt }, primary), /tracked PR/);
});

test("references and CI are primary-owned and bound to the exact PR head", async () => {
  const { service } = await fixture();
  await assert.rejects(service.update({ action: "references", prs: [pr], issues: [] }, { id: "worker" }), /primary/i);
  await service.update({ action: "references", prs: [pr], issues: [] }, primary);
  await service.update({ action: "ci", reference: pr.reference, headRefOid: headA, status: "passed", passed: 2, total: 2, observedAt }, primary);
  assert.equal(service.snapshot().references.prs[0].ci.status, "passed");
  await service.syncTracking({ kind: "prs", values: [{ ...pr, headRefOid: headB, state: "CLOSED" }] });
  assert.equal(service.snapshot().references.prs[0].headRefOid, headA, "tracking membership cannot overwrite verified head metadata");
  assert.equal(service.snapshot().references.prs[0].ci.status, "passed");
  await service.update({ action: "references", prs: [{ ...pr, headRefOid: headB }], issues: [] }, primary);
  assert.equal(service.snapshot().references.prs[0].ci.status, "unknown");
  await assert.rejects(service.update({ action: "ci", reference: pr.reference, headRefOid: headA, status: "passed", passed: 2, total: 2, observedAt }, primary), /head/);
});

test("CI timestamps and complete counts prevent stale or empty green snapshots", async () => {
  const { service } = await fixture();
  await service.update({ action: "references", prs: [pr], issues: [] }, primary);
  const input = { action: "ci", reference: pr.reference, headRefOid: headA, status: "passed", passed: 2, total: 2, observedAt };
  await service.update(input, primary);
  await service.update(input, primary);
  await assert.rejects(service.update({ ...input, status: "pending", observedAt: "2026-10-27T17:59:00Z" }, primary), /Stale/);
  await assert.rejects(service.update({ ...input, status: "pending" }, primary), /Conflicting/);
  await assert.rejects(service.update({ ...input, passed: 0, total: 0 }, primary), /complete non-empty/);
  await assert.rejects(service.update({ ...input, pendingChecks: ["lint"] }, primary), /complete non-empty/);
});

test("unavailable tracking preserves last-known data but resume requires a fresh sync", async () => {
  const { service, resume } = await fixture();
  await service.update({ action: "references", prs: [pr], issues: [] }, primary);
  await service.syncTracking({ kind: "prs", error: "Tracking unavailable" });
  assert.equal(service.snapshot().references.prs.length, 1);
  assert.equal(service.snapshot().references.source.status, "unavailable");
  const restored = await resume();
  assert.equal(restored.snapshot().references.source.status, "unknown");
  assert.equal(restored.snapshot().references.prs.length, 1);
});

test("reference URLs cannot change kind or execute scripts, and hosts remain distinct", async () => {
  const { service } = await fixture();
  await assert.rejects(service.update({ action: "references", prs: [{ ...pr, url: "javascript:alert(1)" }], issues: [] }, primary), /URL|identity/);
  await assert.rejects(service.update({ action: "references", prs: [{ ...pr, url: "https://github.com/owner/repo/issues/42" }], issues: [] }, primary), /identity/);
  await assert.rejects(service.update({ action: "references", prs: [{ ...pr, owned: false }], issues: [] }, primary), /session-owned/);
  await service.update({ action: "references", prs: [pr, { ...pr, url: "https://enterprise.example/owner/repo/pull/42" }], issues: [] }, primary);
  await assert.rejects(service.update({ action: "ci", reference: pr.reference, headRefOid: headA, status: "passed", passed: 1, total: 1, observedAt }, primary), /ambiguous/);
  await service.update({ action: "ci", reference: "https://enterprise.example/owner/repo/pull/42", headRefOid: headA, status: "passed", passed: 1, total: 1, observedAt }, primary);
  assert.equal(service.snapshot().references.prs.filter((entry) => entry.ci.status === "passed").length, 1);
});

test("tracking invalidations reread canonical controls instead of trusting notification content", async () => {
  const { service } = await fixture();
  const canonical = { prs: [pr], issues: [] };
  const calls = [];
  let sync, latest;
  const session = {
    log: async (message, options) => {
      assert.equal(options.ephemeral, true);
      const kind = trackingChangeKind({ type: "session.info", data: { infoType: "notification", message } });
      if (kind) latest = sync.refresh(kind);
    },
    rpc: { tools: { execute: async (request) => {
      calls.push(request);
      const kind = request.name === "session_prs" ? "prs" : "issues";
      assert.equal(sync.isReading(kind), true);
      return { resultType: "success", textResultForLlm: JSON.stringify(canonical[kind]) };
    } } },
  };
  sync = createTrackingSync(session, service);
  await notifySessionTracking(session, "all");
  await latest;
  assert.equal(service.snapshot().references.source.status, "verified");
  assert.equal(service.snapshot().references.prs.length, 1);
  canonical.prs = [];
  const fake = {
    type: "session.info",
    data: { infoType: "notification", message: "Session tracking changed: prs", prs: [pr], sessionId: "other-session" },
  };
  await sync.refresh(trackingChangeKind(fake));
  assert.deepEqual(service.snapshot().references.prs, []);
  assert.deepEqual(calls, [
    { name: "session_prs", arguments: { action: "list" } },
    { name: "session_issues", arguments: { action: "list" } },
    { name: "session_prs", arguments: { action: "list" } },
  ]);
  assert.equal(sync.isReading("prs"), false);
  await assert.rejects(service.update({ action: "ci", reference: pr.reference, headRefOid: headA,
    status: "passed", passed: 1, total: 1, observedAt }, primary), /tracked PR/i);
});

test("changes during an in-flight tracking read coalesce into a fresh follow-up snapshot", async () => {
  const snapshots = [];
  const { service } = await fixture((state) => snapshots.push(state.references));
  let release, started;
  const gate = new Promise((resolve) => { release = resolve; });
  const beginning = new Promise((resolve) => { started = resolve; });
  let values = [pr], reads = 0;
  const sync = createTrackingSync({ rpc: { tools: { execute: async ({ name }) => {
    const snapshot = name === "session_prs" ? structuredClone(values) : [];
    if (++reads === 1) { started(); await gate; }
    return JSON.stringify(snapshot);
  } } } }, service);
  const first = sync.refresh("prs");
  await beginning;
  values = [];
  const updates = Array.from({ length: 10 }, () => sync.refresh("prs"));
  const issues = sync.refresh("issues");
  release();
  await Promise.all([first, ...updates, issues]);
  assert.equal(reads, 3);
  assert.deepEqual(service.snapshot().references.prs, []);
  assert.equal(service.snapshot().references.source.status, "verified");
  assert.equal(snapshots.some((entry) => entry.source.known.prs && entry.prs.length), false,
    "A superseded read must not temporarily re-verify removed ownership");
});

test("unsupported, denied, failed, and malformed native reads keep ownership unverified", async () => {
  for (const result of [null, { resultType: "denied" }, { resultType: "failure" }, '[{"owned":true}]']) {
    const { service } = await fixture();
    await service.update({ action: "references", prs: [pr], issues: [] }, primary);
    const session = { rpc: { tools: { execute: async () => {
      if (result === null) throw new Error("Native tool execution unavailable");
      return result;
    } } } };
    await createTrackingSync(session, service).refresh("prs");
    const state = service.snapshot();
    assert.equal(state.references.source.status, "unavailable");
    assert.equal(state.references.source.known.prs, false);
    assert.equal(state.references.prs.length, 1);
    await assert.rejects(service.update({ action: "ci", reference: pr.reference, headRefOid: headA,
      status: "passed", passed: 1, total: 1, observedAt }, primary), /ownership/i);
  }
});

test("unrelated log text cannot select arbitrary tools or become an ownership snapshot", () => {
  for (const event of [
    { type: "assistant.message", data: { infoType: "notification", message: "Session tracking changed: prs" } },
    { type: "session.info", data: { infoType: "untrusted", message: "Session tracking changed: prs" } },
    { type: "session.info", data: { infoType: "notification", message: JSON.stringify([pr]) } },
    { type: "session.info", data: { infoType: "notification", message: "Session tracking changed: powershell" } },
  ]) assert.equal(trackingChangeKind(event), null);
});
