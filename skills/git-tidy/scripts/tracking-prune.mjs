#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { configuredArgs, isolatedEnvironment } from "./lib/git-boundary.mjs";
import {
  findUntrustedRepositoryRoot, resolveExecutablePath, runBoundedProcess,
} from "./lib/git-process.mjs";
import { verifyRemoteBaseline } from "./lib/remote-verification.mjs";
import { canonicalJson } from "./lib/mechanical-core.mjs";
import { exactKeys } from "./lib/triage-shared.mjs";
import { parseWorktrees } from "./lib/evidence-shared.mjs";

const trackingPrefix = "refs/remotes/origin/";
const branchPrefix = "refs/heads/";
const refspec = "+refs/heads/*:refs/remotes/origin/*";
const inputKeys = ["remoteUrl", "bundlePath", "excludeWitnessRefs"];
const decoder = new TextDecoder("utf-8", { fatal: true });

function digest(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function validRef(ref) {
  return /^refs\/[^\u0000-\u0020\u007f-\u009f]+$/u.test(ref) &&
    !/[~^:?*[\\]/u.test(ref) && !ref.includes("..") && !ref.includes("@{");
}

function gitRunner(cwd) {
  const root = findUntrustedRepositoryRoot(cwd);
  const executable = resolveExecutablePath("git", { untrustedRoots: [root] });
  const isolationRoot = path.join(root, ".git-tidy-env");
  const hooksPath = process.platform === "win32" ? "NUL" : "/dev/null";
  const env = {
    ...isolatedEnvironment(root, isolationRoot, true),
    GIT_GRAFT_FILE: hooksPath,
    GIT_NO_LAZY_FETCH: "1",
  };
  return async (args, input, stdoutFd) => {
    const argv = configuredArgs(args, isolationRoot, { hooksPath, fileProtocol: "never" });
    const { stdout } = await runBoundedProcess(executable, argv, { cwd, env, input, stdoutFd });
    return decoder.decode(stdout).trimEnd();
  };
}

function inputForPlan(value) {
  if (!exactKeys(value, inputKeys) || typeof value.remoteUrl !== "string" ||
      !Array.isArray(value.excludeWitnessRefs) ||
      !value.excludeWitnessRefs.every((ref) =>
        typeof ref === "string" && validRef(ref) &&
        (ref === "refs/stash" || ref.startsWith(branchPrefix))) ||
      typeof value.bundlePath !== "string" || !path.isAbsolute(value.bundlePath) ||
      /[\u0000-\u001f]/u.test(value.bundlePath) || !value.bundlePath.endsWith(".bundle")) {
    throw new Error("Expected an origin URL, absolute .bundle path, and excluded witness refs.");
  }
  return {
    remoteUrl: value.remoteUrl,
    bundlePath: path.resolve(value.bundlePath),
    excludeWitnessRefs: [...new Set(value.excludeWitnessRefs)].sort(),
  };
}

async function countLost(git, tips, witnesses) {
  if (tips.length === 0) return 0;
  const input = [...tips, ...witnesses.map(({ oid }) => "^" + oid), ""].join("\n");
  const output = await git(["rev-list", "--count", "--stdin"], input);
  const count = Number(output);
  if (!/^\d+$/u.test(output) || !Number.isSafeInteger(count)) {
    throw new Error("Invalid Git commit count.");
  }
  return count;
}

async function resolveBundlePath(git, bundlePath, commonDir, objectFormat) {
  const parent = await realpath(path.dirname(bundlePath));
  const destination = path.join(parent, path.basename(bundlePath));
  const rawWorktrees = await git(["worktree", "list", "--porcelain", "-z"]);
  const worktrees = parseWorktrees(Buffer.from(rawWorktrees, "utf8"), objectFormat);
  const protectedDirs = [commonDir];
  for (const worktree of worktrees) {
    if (!worktree.pathRepresentable || !path.isAbsolute(worktree.path)) {
      throw new Error("Cannot verify the bundle destination against every worktree.");
    }
    try {
      protectedDirs.push(await realpath(worktree.path));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      protectedDirs.push(path.resolve(worktree.path));
    }
  }
  for (const directory of protectedDirs) {
    const relative = path.relative(directory, destination);
    if (relative === "" ||
        (relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative))) {
      throw new Error("Recovery bundle path must be outside all worktrees and the Git common directory.");
    }
  }
  return destination;
}

async function snapshot(git, input, cwd) {
  if (await git(["remote", "get-url", "--all", "origin"]) !== input.remoteUrl ||
      await git(["config", "--get-all", "remote.origin.fetch"]) !== refspec) {
    throw new Error("Origin URL or branch tracking refspec does not match the plan.");
  }
  if (await git(["rev-parse", "--is-shallow-repository"]) !== "false") {
    throw new Error("Complete history is required to prove tracking-ref preservation.");
  }
  const remote = await verifyRemoteBaseline(input.remoteUrl, {
    untrustedRoots: [findUntrustedRepositoryRoot(cwd)],
  });
  if (remote.state !== "verified") throw new Error(`Origin verification failed: ${remote.failureCode}`);
  const objectFormat = await git(["rev-parse", "--show-object-format"]);
  const oidPattern = objectFormat === "sha1" ? /^[0-9a-f]{40}$/u : /^[0-9a-f]{64}$/u;
  if (!["sha1", "sha256"].includes(objectFormat) || !oidPattern.test(remote.defaultOid)) {
    throw new Error("Origin object format differs from the local repository.");
  }

  const refs = (await git([
    "for-each-ref", "--sort=refname",
    "--format=%(refname)%00%(objectname)%00%(symref)%00%(objecttype)%00%(*objecttype)",
  ])).split("\n").map((line) => {
    const [ref, oid, symbolic, type, peeledType] = line.split("\0");
    if (!oidPattern.test(oid) || peeledType === undefined) throw new Error("Invalid local ref record.");
    return { ref, oid, symbolic, type, peeledType };
  });
  const defaultTracking = trackingPrefix + remote.defaultRef.slice(branchPrefix.length);
  if (!refs.some(({ ref, oid, symbolic }) =>
    ref === defaultTracking && oid === remote.defaultOid && !symbolic)) {
    throw new Error("Verified default tip is missing or stale locally.");
  }
  const tracking = refs.filter(({ ref }) => ref.startsWith(trackingPrefix));
  const live = new Set(remote.heads.map(({ ref }) => trackingPrefix + ref.slice(branchPrefix.length)));
  const symTargets = new Set(refs.map(({ symbolic }) => symbolic).filter(Boolean));
  const targets = tracking.filter(({ ref, symbolic, type }) =>
    ref !== trackingPrefix + "HEAD" && !symbolic && validRef(ref) &&
    type === "commit" && !symTargets.has(ref) && !live.has(ref));
  const targetRefs = new Set(targets.map(({ ref }) => ref));
  const omitted = tracking.filter(({ ref }) =>
    ref !== trackingPrefix + "HEAD" && !live.has(ref) && !targetRefs.has(ref));
  const removed = new Set([...targetRefs, ...input.excludeWitnessRefs]);
  // Transient namespaces and reflogs cannot preserve an unarchived commit.
  const durableRef = /^(?:refs\/(?:heads|tags|remotes)\/|refs\/stash$)/u;
  const witnesses = refs.filter(({ ref, symbolic, type, peeledType }) =>
    !removed.has(ref) && !symbolic && validRef(ref) && durableRef.test(ref) &&
    (type === "commit" || peeledType === "commit")).map(({ ref, oid }) => ({ ref, oid }));
  const rows = [];
  for (const { ref, oid } of targets) {
    rows.push({ ref, oid, unreachableCommits: await countLost(git, [oid], witnesses) });
  }
  const unreachableCommits = await countLost(git, rows.map(({ oid }) => oid), witnesses);
  const commonDir = await realpath(await git(["rev-parse", "--path-format=absolute", "--git-common-dir"]));
  const bundlePath = await resolveBundlePath(git, input.bundlePath, commonDir, objectFormat);
  const evidence = {
    input: { ...input, bundlePath }, commonDir,
    objectFormat, defaultTracking, defaultOid: remote.defaultOid, liveHeads: remote.heads,
    rows, omitted: omitted.map(({ ref, oid }) => ({ ref, oid })), retainedWitnesses: witnesses,
    unreachableCommits, bundleRequired: unreachableCommits > 0,
  };
  return { ...evidence, planId: digest(evidence) };
}

async function verifyPack(bundle, objectFormat) {
  const hashSize = objectFormat === "sha1" ? 20 : 32;
  const file = await open(bundle, "r");
  try {
    const { size } = await file.stat();
    const header = Buffer.alloc(Math.min(size, 1024 * 1024));
    const { bytesRead } = await file.read(header, 0, header.length, 0);
    const separator = header.subarray(0, bytesRead).indexOf("\n\n");
    const start = separator + 2;
    if (separator < 0 || size <= start + hashSize ||
        header.subarray(start, start + 4).toString("ascii") !== "PACK") {
      throw new Error("Recovery bundle pack header is invalid.");
    }
    const trailer = Buffer.alloc(hashSize);
    const end = size - hashSize;
    if ((await file.read(trailer, 0, hashSize, end)).bytesRead !== hashSize) {
      throw new Error("Recovery bundle checksum is incomplete.");
    }
    const hash = createHash(objectFormat);
    for await (const chunk of createReadStream(bundle, { start, end: end - 1 })) hash.update(chunk);
    if (!hash.digest().equals(trailer)) throw new Error("Recovery bundle checksum mismatch.");
  } finally {
    await file.close();
  }
}

async function archive(git, plan) {
  const { bundlePath } = plan.input;
  const file = await open(bundlePath, "wx", 0o600);
  try {
    const refs = plan.rows.map(({ ref }) => ref);
    // Write directly to the private file. Git never replaces it with a lockfile.
    await git(["bundle", "create", "-", "--stdin"], refs.join("\n") + "\n", file.fd);
    await file.sync();
  } finally {
    await file.close();
  }
}

async function verifyArchive(git, plan) {
  const { bundlePath } = plan.input;
  const verified = await git(["bundle", "verify", bundlePath]);
  const heads = (await git(["bundle", "list-heads", bundlePath])).split("\n").sort();
  const expected = plan.rows.map(({ oid, ref }) => `${oid} ${ref}`).sort();
  if (!verified.includes("complete history") || canonicalJson(heads) !== canonicalJson(expected)) {
    throw new Error("Recovery bundle did not verify with every approved tip and complete history.");
  }
  await verifyPack(bundlePath, plan.objectFormat);
}

export async function run(mode, value, cwd = process.cwd(), { verify = verifyArchive } = {}) {
  if (mode !== "plan" && mode !== "apply") throw new Error("Expected plan or apply.");
  if (mode === "apply" && !exactKeys(value, ["input", "approvedPlanId"])) {
    throw new Error("Apply requires the displayed plan ID and original input.");
  }
  const input = inputForPlan(mode === "apply" ? value.input : value);
  const git = gitRunner(cwd);
  let plan = await snapshot(git, input, cwd);
  if (mode === "plan") return plan;
  if (plan.planId !== value.approvedPlanId) throw new Error("Tracking-ref plan changed. Review it again.");
  if (plan.rows.length === 0) return { pruned: [], bundle: null };
  if (plan.bundleRequired) {
    await archive(git, plan);
    const bundlePath = plan.input.bundlePath;
    const archived = await lstat(bundlePath, { bigint: true });
    await verify(git, plan);
    plan = await snapshot(git, input, cwd);
    if (plan.planId !== value.approvedPlanId) {
      throw new Error("Plan changed after writing the recovery bundle. Review it again.");
    }
    const current = await lstat(bundlePath, { bigint: true });
    if (!archived.isFile() || !current.isFile() ||
        ["dev", "ino", "size", "mtimeNs", "ctimeNs"].some((key) => archived[key] !== current[key])) {
      throw new Error("Recovery bundle changed after verification.");
    }
  }
  const guards = plan.bundleRequired
    ? [{ ref: plan.defaultTracking, oid: plan.defaultOid }]
    : plan.retainedWitnesses;
  const transaction = [
    "start", ...guards.map(({ ref, oid }) => `verify ${ref} ${oid}`),
    ...plan.rows.map(({ ref, oid }) => `delete ${ref} ${oid}`),
    "prepare", "commit", "",
  ].join("\n");
  await git(["update-ref", "--no-deref", "--stdin"], transaction);
  const remaining = new Set((await git(["for-each-ref", "--format=%(refname)", trackingPrefix])).split("\n"));
  if (plan.rows.some(({ ref }) => remaining.has(ref))) throw new Error("A pruned tracking ref is present again.");
  return { pruned: plan.rows.map(({ ref }) => ref), bundle: plan.bundleRequired ? plan.input.bundlePath : null };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of process.stdin) {
      bytes += chunk.length;
      if (bytes > 64 * 1024) throw new Error("Tracking-ref input exceeds 64 KiB.");
      chunks.push(chunk);
    }
    const result = await run(process.argv[2], JSON.parse(decoder.decode(Buffer.concat(chunks))));
    process.stdout.write(JSON.stringify(result) + "\n");
  } catch (error) {
    const message = String(error.message).replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ").slice(0, 500);
    process.stderr.write(`git-tidy tracking-prune: ${message}\n`);
    process.exitCode = 2;
  }
}
