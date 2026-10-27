import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
