import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  analyzeRepository,
  revalidateRepository,
} from "../scripts/triage.mjs";
import {
  failedRemoteBaseline,
  offlineRemoteBaseline,
  parseRemoteAdvertisement,
  remoteBaselineFresh,
  verifyRemoteBaseline,
} from "../scripts/lib/remote-verification.mjs";
import { validateMechanicalResult } from "../scripts/lib/result-schema.mjs";
import { main as verifyRemoteMain } from "../scripts/verify-remote.mjs";
import { createRepoFixture } from "./helpers/repo-fixture.mjs";

const verifyRemoteScript = fileURLToPath(
  new URL("../scripts/verify-remote.mjs", import.meta.url),
);
const triageScript = fileURLToPath(
  new URL("../scripts/triage.mjs", import.meta.url),
);

async function remoteFixture(label) {
  const fixture = await createRepoFixture(label);
  await fixture.write("tracked.txt", "initial\n");
  fixture.commit();
  const remoteRoot = await mkdtemp(
    path.join(tmpdir(), "git-tidy-approved-remote-"),
  );
  const remotePath = path.join(remoteRoot, "remote.git");
  fixture.git(["clone", "--quiet", "--bare", fixture.root, remotePath]);
  fixture.git(["remote", "add", "origin", remotePath]);
  fixture.git([
    "fetch",
    "--quiet",
    "origin",
    "+refs/heads/*:refs/remotes/origin/*",
  ]);
  fixture.git(["remote", "set-head", "origin", "main"]);
  return {
    fixture,
    remotePath,
    async cleanup() {
      await fixture.cleanup();
      await rm(remoteRoot, { recursive: true, force: true, maxRetries: 3 });
    },
  };
}

function findCarrier(result, type, predicate = () => true) {
  return result.workItems
    .flatMap(({ carriers }) => carriers)
    .find((carrier) => carrier.type === type && predicate(carrier));
}

test("remote baseline helpers and advertisement parser fail closed", async () => {
  assert.equal(offlineRemoteBaseline().state, "offline");
  assert.equal(failedRemoteBaseline("offline").failureCode, "offline");
  assert.equal(remoteBaselineFresh(offlineRemoteBaseline()), false);
  for (const remoteUrl of ["", "bad\nurl", `x${"y".repeat(4096)}`, null]) {
    await assert.rejects(
      verifyRemoteBaseline(remoteUrl),
      /remoteUrl must be a bounded NUL-free string/u,
    );
  }
  const oid = "a".repeat(40);
  const valid = Buffer.from(
    `ref: refs/heads/main\tHEAD\n${oid}\tHEAD\n${oid}\trefs/heads/main\n`,
  );
  assert.deepEqual(parseRemoteAdvertisement(valid), {
    defaultRef: "refs/heads/main",
    defaultOid: oid,
    heads: [{ ref: "refs/heads/main", oid }],
  });
  for (const advertisement of [
    "broken\n",
    `${oid}\trefs/heads/main\n`,
    `ref: refs/heads/main\tHEAD\n${"b".repeat(40)}\tHEAD\n${oid}\trefs/heads/main\n`,
    `ref: refs/heads/main\tHEAD\n${oid}\tHEAD\n${oid}\trefs/heads/main\n${oid}\trefs/heads/main\n`,
    `ref: refs/heads/main\tHEAD\n${oid}\tHEAD\n${oid}\trefs/heads/main\n${"b".repeat(64)}\trefs/heads/other\n`,
  ]) {
    assert.throws(
      () => parseRemoteAdvertisement(Buffer.from(advertisement)),
      /remote/u,
    );
  }
  const failed = await verifyRemoteBaseline(
    path.join(tmpdir(), "git-tidy-missing-remote"),
  );
  assert.equal(failed.state, "failed");
  assert.ok(failed.failureCode);
});

test("verify-remote CLI adapter enforces closed bounded JSON", async () => {
  const output = [];
  const writable = new Writable({
    write(chunk, encoding, callback) {
      output.push(Buffer.from(chunk));
      callback();
    },
  });
  const failed = await verifyRemoteMain({
    input: Readable.from([
      JSON.stringify({
        remoteUrl: path.join(tmpdir(), "git-tidy-missing-cli-remote"),
      }),
    ]),
    output: writable,
  });
  assert.equal(failed.state, "failed");
  assert.equal(JSON.parse(Buffer.concat(output).toString("utf8")).state, "failed");
  for (const input of [
    "",
    "{",
    JSON.stringify({ remoteUrl: "x", extra: true }),
    JSON.stringify({ wrong: "x" }),
    " ".repeat(16 * 1024 + 1),
  ]) {
    await assert.rejects(
      verifyRemoteMain({ input: Readable.from([input]), output: writable }),
    );
  }

  const invalid = spawnSync(process.execPath, [verifyRemoteScript], {
    input: "",
    encoding: "utf8",
    shell: false,
  });
  assert.equal(invalid.status, 2);
  assert.equal(invalid.stdout, "");
  assert.match(invalid.stderr, /^git-tidy verify-remote: /u);
  assert.equal(invalid.stderr.trim().split(/\r?\n/u).length, 1);
});

test("remote verification ignores repository-controlled configuration", async () => {
  const remote = await remoteFixture("hardening-config-injection");
  try {
    remote.fixture.git([
      "config",
      "--local",
      "remote.origin.uploadpack",
      "definitely-not-an-executable",
    ]);
    remote.fixture.git([
      "config",
      "--local",
      "protocol.file.allow",
      "never",
    ]);
    const baseline = await verifyRemoteBaseline(remote.remotePath, {
      untrustedRoots: [remote.fixture.root],
    });
    assert.equal(baseline.state, "verified");
    assert.equal(baseline.defaultRef, "refs/heads/main");
    assert.equal(baseline.defaultOid, remote.fixture.oid("main"));
    assert.equal(remoteBaselineFresh(baseline), true);
  } finally {
    await remote.cleanup();
  }
});

test("schema 1.2 binds verified mode and baseline into result identity", async () => {
  const remote = await remoteFixture("hardening-schema");
  try {
    const baseline = await verifyRemoteBaseline(remote.remotePath);
    const analyzed = await analyzeRepository(remote.fixture.root, {
      executionMode: "verified",
      remoteBaseline: baseline,
    });
    assert.equal(analyzed.schemaVersion, "1.2.0");
    assert.equal(analyzed.executionMode, "verified");
    assert.equal(validateMechanicalResult(analyzed).valid, true);
    const cli = spawnSync(
      process.execPath,
      [triageScript, "analyze-verified", "branches"],
      {
        cwd: remote.fixture.root,
        input: JSON.stringify({ remoteBaseline: baseline }),
        encoding: "utf8",
        shell: false,
        maxBuffer: 32 * 1024 * 1024,
      },
    );
    assert.equal(cli.status, 0, cli.stderr);
    assert.equal(JSON.parse(cli.stdout).executionMode, "verified");

    for (const mutate of [
      (value) => {
        value.executionMode = "offline";
      },
      (value) => {
        value.remoteBaseline.defaultOid = "f".repeat(40);
      },
      (value) => {
        value.operation = "revalidate";
      },
    ]) {
      const changed = structuredClone(analyzed);
      mutate(changed);
      assert.equal(validateMechanicalResult(changed).valid, false);
    }
  } finally {
    await remote.cleanup();
  }
});

test("work scopes inventory every branch, worktree, and stash carrier", async () => {
  const remote = await remoteFixture("hardening-carrier-inventory");
  try {
    remote.fixture.git(["branch", "topic"]);
    remote.fixture.git(["branch", "linked"]);
    const linkedPath = path.join(remote.fixture.root, "linked-worktree");
    remote.fixture.git(["worktree", "add", "--quiet", linkedPath, "linked"]);
    await remote.fixture.write("stash.txt", "stash\n");
    remote.fixture.git(["add", "stash.txt"]);
    remote.fixture.git(["stash", "push", "--quiet"]);

    const analyzed = await analyzeRepository(remote.fixture.root, {
      scope: "branches",
    });
    const types = new Set(
      analyzed.workItems.flatMap(({ carriers }) =>
        carriers.map(({ type }) => type)),
    );
    assert.deepEqual(types, new Set([
      "local-branch",
      "remote-branch",
      "worktree",
      "stash",
    ]));
  } finally {
    await remote.cleanup();
  }
});

test("offline and stale baselines cannot emit destructive plans", async () => {
  const remote = await remoteFixture("hardening-stale-block");
  try {
    remote.fixture.git(["branch", "topic"]);
    const offline = await analyzeRepository(remote.fixture.root);
    const topic = findCarrier(
      offline,
      "local-branch",
      ({ displayName }) => displayName === "refs/heads/topic",
    );
    const blocked = await revalidateRepository(
      remote.fixture.root,
      offline,
      [topic.id],
    );
    assert.equal(blocked.actionPlan, null);
    assert.ok(blocked.drift.some(
      ({ code }) => code === "remote-baseline-not-fresh",
    ));

    const baseline = await verifyRemoteBaseline(remote.remotePath);
    const stale = structuredClone(baseline);
    stale.validUntil = new Date(Date.now() - 1).toISOString();
    await assert.rejects(
      analyzeRepository(remote.fixture.root, {
        executionMode: "verified",
        remoteBaseline: stale,
      }),
      /fresh verified remote baseline/u,
    );
  } finally {
    await remote.cleanup();
  }
});

test("fresh revalidation detects remote OID and approval drift", async () => {
  const remote = await remoteFixture("hardening-approval-drift");
  try {
    remote.fixture.git(["branch", "topic"]);
    const baseline = await verifyRemoteBaseline(remote.remotePath);
    const analyzed = await analyzeRepository(remote.fixture.root, {
      executionMode: "verified",
      remoteBaseline: baseline,
    });
    const topic = findCarrier(
      analyzed,
      "local-branch",
      ({ displayName }) => displayName === "refs/heads/topic",
    );
    const preview = await revalidateRepository(
      remote.fixture.root,
      analyzed,
      [topic.id],
      {
        approvalClass: "local-branch-deletion",
        verifyRemote: () => verifyRemoteBaseline(remote.remotePath),
      },
    );
    assert.ok(preview.actionPlan);
    assert.equal(preview.actionPlan.authorized, false);
    assert.equal(preview.actionPlan.approvalRevalidated, false);
    assert.deepEqual(preview.actionPlan.steps[0].argv, [
      "update-ref",
      "-d",
      "refs/heads/topic",
      topic.identity.tipOid,
    ]);
    const cliPreview = spawnSync(
      process.execPath,
      [triageScript, "revalidate"],
      {
        cwd: remote.fixture.root,
        input: JSON.stringify({
          result: analyzed,
          selectedCarrierIds: [topic.id],
          approvalClass: "local-branch-deletion",
          approvedPlan: null,
          remoteUrl: remote.remotePath,
        }),
        encoding: "utf8",
        shell: false,
        maxBuffer: 32 * 1024 * 1024,
      },
    );
    assert.equal(cliPreview.status, 0, cliPreview.stderr);
    assert.equal(
      JSON.parse(cliPreview.stdout).actionPlan.approvalClass,
      "local-branch-deletion",
    );

    const approvedPlan = {
      planId: preview.actionPlan.planId,
      approvalClass: preview.actionPlan.approvalClass,
    };
    const approved = await revalidateRepository(
      remote.fixture.root,
      analyzed,
      [topic.id],
      {
        approvalClass: "local-branch-deletion",
        approvedPlan,
        verifyRemote: () => verifyRemoteBaseline(remote.remotePath),
      },
    );
    assert.equal(approved.actionPlan.approvalRevalidated, true);
    assert.equal(approved.actionPlan.authorized, false);

    const approvalDrift = await revalidateRepository(
      remote.fixture.root,
      analyzed,
      [topic.id],
      {
        approvalClass: "local-branch-deletion",
        approvedPlan: {
          ...approvedPlan,
          planId: "0".repeat(64),
        },
        verifyRemote: () => verifyRemoteBaseline(remote.remotePath),
      },
    );
    assert.equal(approvalDrift.actionPlan, null);
    assert.ok(approvalDrift.drift.some(
      ({ code }) => code === "approval-plan-drift",
    ));

    await remote.fixture.write("tracked.txt", "remote advanced\n");
    remote.fixture.commit();
    remote.fixture.git(["push", "--quiet", remote.remotePath, "main"]);
    const oidDrift = await revalidateRepository(
      remote.fixture.root,
      analyzed,
      [topic.id],
      {
        approvalClass: "local-branch-deletion",
        approvedPlan,
        verifyRemote: () => verifyRemoteBaseline(remote.remotePath),
      },
    );
    assert.equal(oidDrift.actionPlan, null);
    assert.ok(oidDrift.drift.some(
      ({ code }) => code === "remote-baseline-drift",
    ));
  } finally {
    await remote.cleanup();
  }
});
