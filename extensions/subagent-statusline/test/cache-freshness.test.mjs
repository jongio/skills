import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SubagentTracker, syncSession, writeState } from "../tracker.mjs";
import { readPrCache, writePrCache } from "../../pr-statusline/github.mjs";
import { prefetchStatuses } from "../../github-refresh.mjs";
import { statuslineGitHub } from "../../github-transport.mjs";

const url = "https://github.com/fixture/repo/pull/1";
function tracker(id = "freshness") {
  const value = new SubagentTracker(id);
  value.observe({ type: "subagent.started", timestamp: new Date(1000).toISOString(),
    data: { agentId: "worker", agentType: "general-purpose" } });
  value.linkPr("worker", url);
  return value;
}

test("failed, expired, future and undated cache entries cannot newly settle an agent", () => {
  for (const entry of [
    { checkedAt: 1000, ttlMs: 120000, lastError: "Unavailable" },
    { checkedAt: 1000, ttlMs: 1000 },
    { checkedAt: 2001, ttlMs: 120000 },
    { ttlMs: 120000 },
  ]) {
    const value = tracker();
    value.syncWithPrCache({ [url]: { ...entry, info: { state: "MERGED" } } }, 2000);
    assert.deepEqual(value.agents.get("worker").mergedPrs, []);
    assert.equal(value.agents.get("worker").settlementObservedAt, undefined);
    assert.equal(value.counts().merged, 0);
  }
});

test("fresh merge and reopen observations work without expiring already confirmed settlement", () => {
  const value = tracker();
  value.syncWithPrCache({ [url]: { checkedAt: 1000, info: { state: "MERGED" } } }, 1000);
  assert.equal(value.counts().merged, 1);
  value.syncWithPrCache({ [url]: { checkedAt: 1000, lastError: "Unavailable", info: { state: "OPEN" } } }, 200000);
  assert.equal(value.counts().merged, 1);
  assert.equal(value.agents.get("worker").settlementObservedAt, 1000);
  value.syncWithPrCache({ [url]: { checkedAt: 200000, info: { state: "OPEN" } } }, 200000);
  assert.deepEqual(value.agents.get("worker").mergedPrs, []);
  assert.equal(value.agents.get("worker").settlementObservedAt, undefined);
});

for (const failure of ["http", "credentials"]) {
  test(`real ${failure} failure retains diagnostics but cannot settle an agent through persisted replay`, async (t) => {
    const home = mkdtempSync(join(tmpdir(), "agent-cache-freshness-"));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    const value = tracker("failed-refresh");
    writeState(value.snapshot(), home);
    writePrCache({ [url]: { checkedAt: 1000, ttlMs: 120000, scope: "fixture", info: { state: "MERGED" } } }, home);
    t.mock.method(statuslineGitHub, "cacheScope", async () => {
      if (failure === "credentials") throw new Error("Unavailable");
      return "fixture";
    });
    t.mock.method(statuslineGitHub, "request", async () => ({ ok: false, status: 503, error: "Unavailable", headers: {} }));
    const fetch = await prefetchStatuses("pr", [{ url }], { home, now: 2000, force: true });
    assert.throws(() => fetch(url), /Unavailable/);
    assert.equal(readPrCache(home)[url].info.state, "MERGED", "diagnostic history remains available");
    assert.match(readPrCache(home)[url].lastError, /Unavailable/);
    const current = syncSession({ session_id: "failed-refresh" }, { home, now: 2000 }).tracker;
    assert.deepEqual(current.agents.get("worker").mergedPrs, []);
    assert.equal(current.counts().merged, 0);
  });
}
