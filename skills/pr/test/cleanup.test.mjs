import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const skill = readFileSync(new URL("../SKILL.md", import.meta.url), "utf8");

function git(cwd, args, expectSuccess = true) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 15_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  if (expectSuccess) {
    assert.equal(result.status, 0, result.stderr);
  }
  return result;
}

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "pr-cleanup-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, ["init", "--quiet", "--bare", "remote.git"]);
  git(root, ["init", "--quiet", "--initial-branch=main", "work"]);
  const work = path.join(root, "work");
  const remote = path.join(root, "remote.git");
  git(work, ["config", "user.name", "Cleanup Test"]);
  git(work, ["config", "user.email", "cleanup@example.invalid"]);
  git(work, ["-c", "commit.gpgsign=false", "commit", "--quiet", "--allow-empty", "-m", "merged head"]);
  const mergedHead = git(work, ["rev-parse", "HEAD"]).stdout.trim();
  git(work, ["branch", "topic"]);
  git(work, ["remote", "add", "origin", remote]);
  git(work, ["push", "--quiet", "origin", "refs/heads/topic"]);
  git(work, ["-c", "commit.gpgsign=false", "commit", "--quiet", "--allow-empty", "-m", "new work"]);
  const newHead = git(work, ["rev-parse", "HEAD"]).stdout.trim();
  git(work, ["push", "--quiet", "origin", "HEAD:refs/heads/main"]);
  return { work, remote, mergedHead, newHead };
}

function cleanupCommand(kind, mergedHead) {
  const pattern = kind === "remote"
    ? /Remote deletion: `git ([^`]+)`/
    : /Local deletion,[^`]+`git ([^`]+)`/;
  const command = skill.match(pattern)?.[1];
  assert.ok(command, `missing guarded ${kind} deletion command`);
  return command
    .replaceAll("<branch>", "topic")
    .replaceAll("<merged-head-OID>", mergedHead)
    .replaceAll("<verified-head-remote>", "origin")
    .split(" ");
}

for (const kind of ["remote", "local"]) {
  test(`${kind} cleanup deletes a ref still at the confirmed PR head`, (t) => {
    const { work, remote, mergedHead } = fixture(t);
    const target = kind === "remote" ? ["--git-dir", remote] : [];
    git(work, cleanupCommand(kind, mergedHead));
    const ref = git(work, [...target, "show-ref", "--verify", "--quiet", "refs/heads/topic"], false);
    assert.equal(ref.status, 1, ref.stderr);
  });

  for (const recreated of [false, true]) {
    test(`${kind} cleanup preserves ${recreated ? "recreated" : "advanced"} branches`, (t) => {
      const { work, remote, mergedHead, newHead } = fixture(t);
      const target = kind === "remote" ? ["--git-dir", remote] : [];
      if (recreated) {
        git(work, [...target, "update-ref", "-d", "refs/heads/topic", mergedHead]);
      }
      git(work, [...target, "update-ref", "refs/heads/topic", newHead]);
      const deletion = git(work, cleanupCommand(kind, mergedHead), false);
      assert.notEqual(deletion.status, 0, "an outdated expected OID must reject deletion");
      assert.equal(git(work, [...target, "rev-parse", "refs/heads/topic"]).stdout.trim(), newHead);
    });
  }
}
