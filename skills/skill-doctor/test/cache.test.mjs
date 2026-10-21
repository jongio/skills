import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { resolveWindow, run, snapshotKey, targetIdentity } from "../scripts/cache.mjs";

const snapshot = { source: "cloud-v1", account: "test-user", id: "session-one", revision: "r1", complete: true };
function fixture(t) {
  const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "skill-doctor-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", repo]);
  const input = path.join(root, "input.json");
  const receipt = path.join(root, "receipt.json");
  writeFileSync(receipt, '{"lesson":"Synthetic correction","branch":"skill-doctor/example"}');
  const options = { target: repo, input, "cache-dir": path.join(root, "cache") };
  const set = (sessions) => writeFileSync(input, JSON.stringify({ sessions }));
  set([snapshot]);
  const plan = () => run("plan", options);
  const record = (sessions, expected = plan().token) => {
    set(sessions);
    return run("record", { ...options, expected });
  };
  return { root, repo, receipt, options, set, plan, record };
}

test("default week and explicit windows are deterministic and strict", () => {
  const now = new Date("2026-10-21T21:00:00Z");
  assert.deepEqual(resolveWindow({}, now), { since: "2026-10-14T21:00:00.000Z", until: now.toISOString() });
  assert.equal(resolveWindow({ days: "14" }, now).since, "2026-10-07T21:00:00.000Z");
  assert.equal(resolveWindow({ since: "2026-10-01T00:00:00-07:00", until: "2026-10-08T00:00:00Z" }, now).since, "2026-10-01T07:00:00.000Z");
  for (const options of [{ days: 0 }, { days: -1 }, { days: "oops" }, { since: "yesterday" }, { since: "2026-02-30T00:00:00Z" }, { until: "2027-01-01T00:00:00Z" }, { since: now.toISOString() }, { days: 1, since: "2026-10-01T00:00:00Z" }]) {
    assert.throws(() => resolveWindow(options, now));
  }
});

test("plan is read-only; same-day completed snapshots skip but changed revisions audit", (t) => {
  const f = fixture(t);
  assert.equal(f.plan().sessions[0].action, "audit");
  assert.equal(existsSync(f.options["cache-dir"]), false);
  f.record([{ ...snapshot, status: "no-change" }]);
  assert.equal(f.plan().sessions[0].action, "skip");
  f.set([{ ...snapshot, complete: false }]);
  assert.equal(f.plan().sessions[0].action, "skip");
  f.set([{ ...snapshot, revision: "r2" }]);
  assert.equal(f.plan().sessions[0].action, "audit");
  const cache = readFileSync(f.plan().cache, "utf8");
  for (const privateValue of [snapshot.id, snapshot.account, snapshot.revision]) assert.equal(cache.includes(`"${privateValue}"`), false);
});

test("pending delivery survives changed snapshots and empty later windows", (t) => {
  const f = fixture(t);
  f.record([{ ...snapshot, status: "pending", receipt: f.receipt }]);
  assert.equal(f.plan().sessions[0].action, "resume");
  f.set([{ ...snapshot, revision: "r2" }]);
  assert.equal(f.plan().sessions[0].action, "audit");
  assert.equal(f.plan().pending.length, 1);
  f.set([]);
  assert.equal(f.plan().pending.length, 1);
  f.record([{ ...snapshot, status: "delivered", receipt: f.receipt, pr: "https://github.com/example/skills/pull/1" }]);
  assert.equal(f.plan().sessions[0].action, "skip");
  assert.equal(f.plan().pending.length, 0);
});

test("incomplete audits and invalid delivery cannot suppress future work", (t) => {
  const f = fixture(t);
  for (const extra of [
    { complete: false, status: "no-change" },
    { status: "wrong" },
    { status: "pending" },
    { status: "pending", receipt: path.join(f.root, "missing.json") },
    { status: "delivered", receipt: f.receipt, pr: "https://elsewhere.test/pull/1" },
  ]) {
    assert.throws(() => f.record([{ ...snapshot, ...extra }]));
  }
  f.set([snapshot]);
  assert.equal(f.plan().sessions[0].action, "audit");
});

test("stale writers, held locks, and corrupt caches fail explicitly", (t) => {
  const f = fixture(t);
  const before = f.plan();
  f.record([{ ...snapshot, status: "no-change" }]);
  const bytes = readFileSync(before.cache, "utf8");
  assert.throws(() => f.record([{ ...snapshot, status: "no-change" }], before.token), /Stale/);
  assert.equal(readFileSync(before.cache, "utf8"), bytes);
  assert.deepEqual(readdirSync(f.options["cache-dir"]), [path.basename(before.cache)]);
  const lock = `${before.cache}.lock`;
  writeFileSync(lock, "other-process");
  assert.throws(() => f.record([{ ...snapshot, status: "no-change" }]), /EEXIST/);
  assert.equal(readFileSync(lock, "utf8"), "other-process");
  writeFileSync(before.cache, "broken json");
  assert.throws(f.plan, SyntaxError);
});

test("an invalid batch leaves existing state intact and can be corrected", (t) => {
  const f = fixture(t);
  f.record([{ ...snapshot, status: "pending", receipt: f.receipt }]);
  const before = f.plan();
  const bytes = readFileSync(before.cache, "utf8");
  assert.throws(() => f.record([
    { ...snapshot, status: "delivered", receipt: f.receipt, pr: "https://github.com/example/skills/pull/1" },
    { ...snapshot, id: "second", complete: false, status: "no-change" },
  ], before.token), /Incomplete/);
  assert.equal(readFileSync(before.cache, "utf8"), bytes);
  assert.deepEqual(readdirSync(f.options["cache-dir"]), [path.basename(before.cache)]);
  f.record([{ ...snapshot, status: "delivered", receipt: f.receipt, pr: "https://github.com/example/skills/pull/1" }], before.token);
  assert.equal(f.plan().pending.length, 0);
});

test("unsupported cache schemas and invalid receipt JSON never become cache misses", (t) => {
  const f = fixture(t);
  f.record([{ ...snapshot, status: "no-change" }]);
  const file = f.plan().cache;
  for (const state of [
    { version: 2, entries: {} },
    { version: 1, entries: [] },
    { version: 1, entries: { invalid: {} } },
    { version: 1, entries: { [snapshotKey(snapshot)]: { status: "unknown", checkedAt: "2026-10-21T00:00:00Z" } } },
  ]) {
    writeFileSync(file, JSON.stringify(state));
    assert.throws(f.plan);
  }
  writeFileSync(file, '{"version":1,"entries":{}}');
  const token = f.plan().token;
  writeFileSync(f.receipt, "invalid receipt");
  assert.throws(() => f.record([{ ...snapshot, status: "pending", receipt: f.receipt }], token), SyntaxError);
  assert.equal(f.plan().token, token);
});

test("targets and account/backend namespaces are isolated", (t) => {
  const f = fixture(t);
  mkdirSync(path.join(f.repo, "skills"));
  assert.notEqual(targetIdentity(f.repo).key, targetIdentity(path.join(f.repo, "skills")).key);
  assert.notEqual(snapshotKey(snapshot), snapshotKey({ ...snapshot, source: "local-v1" }));
  assert.notEqual(snapshotKey(snapshot), snapshotKey({ ...snapshot, account: "another-user" }));
  f.set([snapshot, snapshot]);
  assert.throws(f.plan, /Duplicate/);
  assert.throws(() => snapshotKey({ ...snapshot, revision: "" }), /snapshot/);
});

test("source-only terseness audits skip unchanged skills, not changed instructions", (t) => {
  const f = fixture(t);
  const source = { source: "skill-source-v1", account: "target-local", id: "example", revision: "instruction-hash-v1", complete: true };
  f.record([{ ...source, status: "no-change" }, { ...snapshot, status: "no-change" }]);
  assert.deepEqual(f.plan().sessions.map(({ action }) => action), ["skip", "skip"]);
  f.set([{ ...source, revision: "instruction-hash-v2" }, snapshot]);
  assert.deepEqual(f.plan().sessions.map(({ action }) => action), ["audit", "skip"]);
});

test("linked worktrees share the same target cache identity", (t) => {
  const f = fixture(t);
  writeFileSync(path.join(f.repo, "test.txt"), "fixture");
  execFileSync("git", ["-C", f.repo, "add", "test.txt"]);
  execFileSync("git", ["-C", f.repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture"]);
  const linked = path.join(f.root, "linked");
  execFileSync("git", ["-C", f.repo, "worktree", "add", "-qb", "fixture", linked]);
  assert.equal(targetIdentity(f.repo).key, targetIdentity(linked).key);
});

test("cache and receipt files cannot be written inside any repository", (t) => {
  const f = fixture(t);
  assert.throws(() => run("plan", { ...f.options, "cache-dir": path.join(f.repo, ".cache") }), /outside Git/);
  const other = path.join(f.root, "other");
  mkdirSync(other);
  execFileSync("git", ["init", "-q", other]);
  assert.throws(() => run("plan", { ...f.options, "cache-dir": path.join(other, ".cache") }), /every repository/);
  const receipt = path.join(f.repo, "receipt.json");
  writeFileSync(receipt, "{}");
  assert.throws(() => f.record([{ ...snapshot, status: "pending", receipt }]), /outside Git/);
});

test("CLI emits machine-readable output and nonzero errors", (t) => {
  const f = fixture(t);
  const script = fileURLToPath(new URL("../scripts/cache.mjs", import.meta.url));
  const args = ["plan", "--target", f.repo, "--input", f.options.input, "--cache-dir", f.options["cache-dir"]];
  const result = spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).sessions[0].action, "audit");
  const invalid = spawnSync(process.execPath, [script, ...args, "--unknown", "x"], { encoding: "utf8" });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /skill-doctor cache:/);
});
