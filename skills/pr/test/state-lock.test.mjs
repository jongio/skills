import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import test from "node:test";
import { loadPersistedPrSession, savePersistedPrSession } from "../scripts/pr-watch-daemon.mjs";

for (const boundary of ["probe-only", "denied-read"]) {
  test(`review 5709684255: ${boundary} cannot erase protected PR quota or peer state`, (t) => {
    const root = path.resolve(".state-lock-fixtures");
    fs.mkdirSync(root, { recursive: true });
    const dir = fs.mkdtempSync(path.join(root, "store-"));
    t.after(() => {
      fs.rmSync(dir, { recursive: true, force: true });
      if (fs.readdirSync(root).length === 0) fs.rmSync(root, { recursive: true });
    });
    const until = Date.now() + 900000;
    savePersistedPrSession("fixture/repo", { cooldownUntilMs: until, entries: {
      1: { watchState: { copilotErrorRetriesByHead: { head: 2 } }, sinceCommentId: 10 },
    } }, dir);
    const file = path.join(dir, "fixture__repo.json");
    const read = fs.readFileSync;
    const exists = fs.existsSync;
    const before = read(file, "utf8");
    const original = Object.assign(new Error("protected PR session read denied"), { code: "EACCES" });
    let failure;
    t.mock.method(fs, "existsSync", (target) => target === file ? false : exists(target));
    if (boundary === "denied-read") t.mock.method(fs, "readFileSync", (target, ...args) => {
      if (target === file) throw original;
      return read(target, ...args);
    });
    syncBuiltinESMExports();
    try {
      try {
        savePersistedPrSession("fixture/repo", { entries: {
          2: { watchState: {}, sinceCommentId: 20 },
        } }, dir);
      } catch (error) { failure = error; }
      const persisted = JSON.parse(read(file, "utf8"));
      t.diagnostic(JSON.stringify({ boundary, persistedCooldown: persisted.cooldownUntilMs,
        entries: Object.keys(persisted.entries), error: failure?.cause?.code }));
      if (boundary === "denied-read") {
        assert.equal(failure?.cause, original);
        assert.equal(read(file, "utf8"), before);
      } else {
        assert.equal(failure, undefined);
        assert.equal(persisted.cooldownUntilMs, until);
        assert.equal(persisted.entries[1].sinceCommentId, 10);
        assert.equal(persisted.entries[1].watchState.copilotErrorRetriesByHead.head, 2);
        assert.equal(persisted.entries[2].sinceCommentId, 20);
      }
      assert.equal(exists(`${file}.lock`), false);
      assert.equal(fs.readdirSync(dir).some((name) => name.endsWith(".pending")), false);
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
  });
}

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
