import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import test from "node:test";
import { loadPersistedPrSession, savePersistedPrSession } from "../scripts/pr-watch-daemon.mjs";

test("transient lock-open EPERM is bounded acquisition contention, not lost state or an unlimited retry", (t) => {
  const root = path.resolve(".state-lock-fixtures");
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, "store-"));
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    if (fs.readdirSync(root).length === 0) fs.rmSync(root, { recursive: true });
  });
  const actualOpen = fs.openSync;
  let attempts = 0, permanent = false;
  t.mock.method(fs, "openSync", (file, flags, ...rest) => {
    if (flags === "wx") {
      attempts += 1;
      if (permanent || attempts === 1) throw Object.assign(new Error("lock acquisition denied"), { code: "EPERM" });
    }
    return actualOpen(file, flags, ...rest);
  });
  syncBuiltinESMExports();
  try {
    savePersistedPrSession("fixture/repo", { entries: {
      1: { watchState: { copilotErrorRetriesByHead: { head: 1 } }, sinceCommentId: 10 },
    } }, dir);
    assert.equal(attempts, 2);
    assert.equal(loadPersistedPrSession("fixture/repo", dir).entries[1].watchState.copilotErrorRetriesByHead.head, 1);
    permanent = true;
    attempts = 0;
    assert.throws(() => savePersistedPrSession("fixture/repo", { deadlineMs: Date.now() }, dir),
      (error) => /lock unavailable/.test(error.message) && error.cause?.code === "EPERM");
    assert.equal(attempts, 1, "an expired acquisition budget must not spin");
    assert.equal(loadPersistedPrSession("fixture/repo", dir).entries[1].sinceCommentId, 10);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});
