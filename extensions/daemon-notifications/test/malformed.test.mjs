import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createNotificationBridge } from "../bridge.mjs";

test("null records do not block later valid events or another subscription", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "notification-null-"));
  const logs = [];
  const bridge = createNotificationBridge({ sessionId: "null-records", log: async (message) => logs.push(message) }, { home });
  t.after(() => { bridge.stop(); rmSync(home, { recursive: true, force: true }); });
  const first = bridge.manage("subscribe", "first");
  const second = bridge.manage("subscribe", "second");
  const record = (stream) => JSON.stringify({ stream, sequence: 1, source: "fixture", type: "JOB_FAILED" }) + "\n";
  writeFileSync(first.file, "null\n" + record("after-null"));
  writeFileSync(second.file, record("other-subscription"));
  await bridge.poll();
  assert.equal(logs.length, 2);
  await bridge.poll();
  assert.equal(logs.length, 2, "successful events remain deduplicated");
});
