import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { planSetup, applySetup } from "../scripts/setup.mjs";

test("standalone setup installs only a thin shared loader and rejects stale/unowned writes", (t) => {
  const home = mkdtempSync(join(tmpdir(), "progress-setup-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const plan = planSetup({ home });
  assert.throws(() => applySetup(plan, "wrong"), /approval/);
  assert.throws(() => applySetup({ ...plan, content: "unapproved bytes" }, plan.hash), /Stale/);
  assert.throws(() => applySetup({ ...plan, file: join(home, "unapproved.mjs") }, plan.hash), /Stale/);
  assert.equal(applySetup(plan, plan.hash).applied, true);
  const loader = readFileSync(plan.file, "utf8");
  assert.match(loader, /runtime\/extension\.mjs/);
  assert.ok(loader.length < 1000);
  assert.throws(() => applySetup(plan, plan.hash), /Stale/);
  const again = planSetup({ home });
  assert.equal(applySetup(again, again.hash).unchanged, true);
  for (const content of ["// user owned", ""]) {
    writeFileSync(plan.file, content);
    assert.throws(() => planSetup({ home }), /not managed/);
    assert.equal(readFileSync(plan.file, "utf8"), content);
  }
});

test("setup preserves a dangling user-owned loader introduced after an absent-file preview", (t) => {
  const home = mkdtempSync(join(tmpdir(), "progress-link-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const plan = planSetup({ home });
  const target = join(home, "missing-user-loader.mjs");
  mkdirSync(dirname(plan.file), { recursive: true });
  try { symlinkSync(target, plan.file, "file"); }
  catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) { t.skip("File symlinks unavailable on this host"); return; }
    throw error;
  }
  assert.equal(existsSync(plan.file), false);
  assert.equal(lstatSync(plan.file).isSymbolicLink(), true);
  const linkTarget = readlinkSync(plan.file);
  assert.throws(() => applySetup(plan, plan.hash), /symlink/i);
  assert.equal(lstatSync(plan.file).isSymbolicLink(), true);
  assert.equal(readlinkSync(plan.file), linkTarget);
  assert.equal(existsSync(target), false);
  assert.throws(() => planSetup({ home }), /symlink/i);
});

test("setup rejects dangling loader ancestors without creating their targets", (t) => {
  const home = mkdtempSync(join(tmpdir(), "progress-parent-link-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const target = join(home, "missing-user-directory");
  const link = join(home, "extensions");
  symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
  assert.equal(existsSync(link), false);
  assert.throws(() => planSetup({ home }), /symlink/i);
  assert.equal(lstatSync(link).isSymbolicLink(), true);
  assert.equal(existsSync(target), false);
});
