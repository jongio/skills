import assert from "node:assert/strict";
import test from "node:test";
import { createProgressService } from "../runtime/progress.mjs";
import { trackingResult } from "../runtime/references.mjs";

const primary = { id: "primary", primary: true };
const headA = "a".repeat(40);
const headB = "b".repeat(40);
const pr = { reference: "owner/repo#42", owned: true, state: "OPEN", headRefOid: headA, title: "Current PR" };
const observedAt = "2026-10-27T18:00:00.000Z";
async function fixture() {
  let saved;
  const options = {
    sessionId: "references-test",
    store: { load: async () => saved, save: async (value) => { saved = structuredClone(value); } },
    readSources: async () => ({ plan: { exists: false }, rows: [], dependencies: [] }),
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
