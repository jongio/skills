import assert from "node:assert/strict";
import { mkdtemp, readFile, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { run } from "../scripts/tracking-prune.mjs";
import { createRepoFixture } from "./helpers/repo-fixture.mjs";

test("tracking prune confirms exact refs and verifies recovery before deletion", async (t) => {
  const origin = await createRepoFixture("tracking-prune-origin");
  const local = await createRepoFixture("tracking-prune-local");
  const archiveDir = await mkdtemp(path.join(tmpdir(), "tracking-prune-test-"));
  const bundlePath = path.join(archiveDir, "recovery.bundle");
  t.after(async () => {
    await unlink(bundlePath).catch((error) => { if (error.code !== "ENOENT") throw error; });
    await rmdir(archiveDir);
    await local.cleanup();
    await origin.cleanup();
  });
  await origin.write("base", "base");
  const base = origin.commit();
  local.git(["remote", "add", "origin", origin.root]);
  local.git(["fetch", "origin"]);
  local.git(["switch", "--create", "main", "origin/main"]);
  local.git(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
  await local.write("private-work", "unique");
  const unique = local.commit();
  local.git(["reset", "--hard", base]);
  local.git(["update-ref", "refs/remotes/origin/merged", base]);
  local.git(["update-ref", "refs/remotes/origin/unique", unique]);
  local.git(["update-ref", "refs/remotes/origin/duplicate", unique]);
  const input = { remoteUrl: origin.root, bundlePath, excludeWitnessRefs: [] };
  local.git(["branch", "pending-removal", unique]);
  assert.equal((await run("plan", input, local.root)).bundleRequired, false);
  input.excludeWitnessRefs.push("refs/heads/pending-removal");

  await assert.rejects(
    run("plan", { ...input, bundlePath: path.join(local.root, "recovery.bundle") }, local.root),
    /outside all worktrees/,
  );
  const before = await local.snapshot();
  const plan = await run("plan", input, local.root);
  assert.deepEqual(await local.snapshot(), before);
  assert.deepEqual(plan.rows.map(({ ref, unreachableCommits }) => [ref, unreachableCommits]), [
    ["refs/remotes/origin/duplicate", 1],
    ["refs/remotes/origin/merged", 0],
    ["refs/remotes/origin/unique", 1],
  ]);
  assert.equal(plan.unreachableCommits, 1);
  assert.equal(plan.bundleRequired, true);

  const approved = { input, approvedPlanId: plan.planId };
  local.git(["update-ref", "refs/remotes/origin/unique", base]);
  await assert.rejects(run("apply", approved, local.root), /plan changed/i);
  local.git(["update-ref", "refs/remotes/origin/unique", unique]);

  origin.git(["branch", "unique", base]);
  await assert.rejects(run("apply", approved, local.root), /plan changed/i);
  assert.equal(local.oid("refs/remotes/origin/unique"), unique);
  origin.git(["branch", "-d", "unique"]);

  await writeFile(bundlePath, "existing file");
  await assert.rejects(run("apply", approved, local.root), { code: "EEXIST" });
  assert.equal(local.oid("refs/remotes/origin/unique"), unique);
  assert.equal(await readFile(bundlePath, "utf8"), "existing file");
  await unlink(bundlePath);

  const result = await run("apply", approved, local.root);
  assert.deepEqual(result.pruned, plan.rows.map(({ ref }) => ref));
  assert.equal(result.bundle, bundlePath);
  assert.equal(local.oid("refs/remotes/origin/HEAD"), base);
  assert.equal(local.oid("refs/remotes/origin/main"), base);
  const recovered = local.git(["bundle", "list-heads", bundlePath]).stdout.toString("utf8");
  assert.match(recovered, new RegExp(unique + " refs/remotes/origin/unique"));
  assert.deepEqual((await run("plan", input, local.root)).rows, []);

  local.git(["update-ref", "refs/remotes/origin/merged", base]);
  const mergedPlan = await run("plan", input, local.root);
  assert.equal(mergedPlan.bundleRequired, false);
  const withoutBundle = await run("apply", { input, approvedPlanId: mergedPlan.planId }, local.root);
  assert.deepEqual(withoutBundle, { pruned: ["refs/remotes/origin/merged"], bundle: null });
});
