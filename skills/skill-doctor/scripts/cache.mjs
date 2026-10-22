import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const isHash = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const within = (root, file) => {
  const relative = path.relative(root, file);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
};
const text = (value) => typeof value === "string" && value.trim().length > 0 && value.length <= 4096;
const statuses = new Set(["no-change", "pending", "delivered"]);
const prUrl = (value) => typeof value === "string" && /^https:\/\/github\.com\/[^/?#\s]+\/[^/?#\s]+\/pull\/[1-9]\d*$/.test(value);

function git(directory, ...args) {
  return execFileSync("git", ["-C", directory, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, LC_ALL: "C" },
  }).trim();
}

function canonicalCandidate(value) {
  let cursor = path.resolve(value);
  const tail = [];
  while (!existsSync(cursor)) {
    tail.unshift(path.basename(cursor));
    const parent = path.dirname(cursor);
    if (parent === cursor) throw new Error("Cannot resolve path");
    cursor = parent;
  }
  return path.join(realpathSync.native(cursor), ...tail);
}

export function targetIdentity(target) {
  const directory = realpathSync.native(target);
  if (!lstatSync(directory).isDirectory()) throw new Error("Target must be a directory");
  const root = realpathSync.native(git(directory, "rev-parse", "--show-toplevel"));
  const common = realpathSync.native(git(directory, "rev-parse", "--path-format=absolute", "--git-common-dir"));
  return { root, common, key: digest([common, path.relative(root, directory)]) };
}

function assertPrivatePath(file, identity) {
  const resolved = canonicalCandidate(file);
  if (within(identity.root, resolved) || within(identity.common, resolved)) {
    throw new Error("Cache and receipts must stay outside Git");
  }
  let parent = resolved;
  while (!existsSync(parent)) parent = path.dirname(parent);
  if (!lstatSync(parent).isDirectory()) parent = path.dirname(parent);
  try {
    git(parent, "rev-parse", "--show-toplevel");
  } catch (error) {
    if (error.status === 128 && /not a git repository/i.test(String(error.stderr))) return resolved;
    throw error;
  }
  throw new Error("Cache and receipts must stay outside every repository");
}

export function resolveWindow(options = {}, now = new Date()) {
  const parse = (value) => {
    if (!text(value) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
      throw new Error("Use ISO timestamps with an explicit timezone");
    }
    const stamp = Date.parse(value);
    const [year, month, day] = value.slice(0, 10).split("-").map(Number);
    const calendar = new Date(Date.UTC(year, month - 1, day));
    if (!Number.isFinite(stamp) || calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) {
      throw new Error("Invalid timestamp");
    }
    return stamp;
  };
  if (options.days !== undefined && options.since !== undefined) throw new Error("Choose days or since, not both");
  const until = options.until === undefined ? now.getTime() : parse(options.until);
  const days = options.days === undefined ? 7 : Number(options.days);
  if (!Number.isFinite(days) || days <= 0) throw new Error("Days must be positive");
  const since = options.since === undefined ? until - days * 86400000 : parse(options.since);
  if (!Number.isFinite(since) || since >= until || until > now.getTime()) throw new Error("Invalid or future window");
  return { since: new Date(since).toISOString(), until: new Date(until).toISOString() };
}

export function snapshotKey(snapshot) {
  if (!snapshot || !["source", "account", "id", "revision"].every((key) => text(snapshot[key])) || typeof snapshot.complete !== "boolean") {
    throw new Error("Each snapshot needs source, account, id, revision, and complete");
  }
  return digest([snapshot.source, snapshot.account, snapshot.id, snapshot.revision]);
}

function validateEntry(entry) {
  if (!entry || !statuses.has(entry.status) || !Number.isFinite(Date.parse(entry.checkedAt))) throw new Error("Invalid cache entry");
  if (Object.keys(entry).some((key) => !["status", "checkedAt", "receipt", "pr"].includes(key))) throw new Error("Unexpected cache field");
  if (entry.status !== "no-change" && (!text(entry.receipt) || !path.isAbsolute(entry.receipt))) throw new Error("A private receipt is required");
  if (entry.status === "delivered" && !prUrl(entry.pr)) throw new Error("A verified GitHub PR URL is required");
}

function load(file) {
  let raw;
  try {
    if (lstatSync(file).isSymbolicLink()) throw new Error("Refusing symlinked cache");
    raw = readFileSync(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return { state: { version: 1, entries: {} }, token: digest(null) };
    throw error;
  }
  const state = JSON.parse(raw);
  if (state.version !== 1 || !state.entries || Array.isArray(state.entries) || typeof state.entries !== "object" ||
      Object.keys(state).some((key) => !["version", "entries"].includes(key))) throw new Error("Unsupported cache format");
  for (const [key, entry] of Object.entries(state.entries)) {
    if (!isHash(key)) throw new Error("Invalid snapshot key");
    validateEntry(entry);
  }
  return { state, token: digest(raw) };
}

export function run(command, options) {
  if (!["plan", "record"].includes(command)) throw new Error("Use plan or record");
  if (!options.input) throw new Error("--input is required");
  const window = resolveWindow(options);
  const identity = targetIdentity(options.target ?? process.cwd());
  const directory = assertPrivatePath(options["cache-dir"] ?? path.join(homedir(), ".cache", "skill-doctor"), identity);
  const file = path.join(directory, `${identity.key}.json`);
  const input = JSON.parse(readFileSync(options.input, "utf8"));
  if (!Array.isArray(input.sessions)) throw new Error("Input must contain a sessions array");
  const keys = input.sessions.map(snapshotKey);
  if (new Set(keys).size !== keys.length) throw new Error("Duplicate snapshots");
  const current = load(file);
  if (command === "plan") {
    return {
      window, cache: file, token: current.token,
      sessions: keys.map((key, index) => ({
        index, key,
        action: !current.state.entries[key] ? "audit" : current.state.entries[key].status === "pending" ? "resume" : "skip",
      })),
      pending: Object.entries(current.state.entries).filter(([, entry]) => entry.status === "pending").map(([key, entry]) => ({ key, ...entry })),
    };
  }
  if (!isHash(options.expected)) throw new Error("--expected must be the plan token");
  const entries = input.sessions.map((snapshot) => {
    if (snapshot.complete !== true) throw new Error("Incomplete snapshots cannot be recorded");
    const entry = { status: snapshot.status, checkedAt: new Date().toISOString() };
    if (snapshot.status !== "no-change") {
      if (!text(snapshot.receipt) || !path.isAbsolute(snapshot.receipt)) throw new Error("An absolute receipt path is required");
      entry.receipt = assertPrivatePath(snapshot.receipt, identity);
      if (!lstatSync(entry.receipt).isFile()) throw new Error("Receipt must be an existing regular file");
      JSON.parse(readFileSync(entry.receipt, "utf8"));
    }
    if (snapshot.status === "delivered") entry.pr = snapshot.pr;
    validateEntry(entry);
    return entry;
  });
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lock = `${file}.lock`;
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(lock, String(process.pid), { flag: "wx", mode: 0o600 });
  try {
    const latest = load(file);
    if (latest.token !== options.expected) throw new Error("Stale cache token; replan and reconcile");
    keys.forEach((key, index) => { latest.state.entries[key] = entries[index]; });
    writeFileSync(temporary, `${JSON.stringify(latest.state, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    renameSync(temporary, file);
    return { recorded: keys.length, cache: file, token: load(file).token };
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
    unlinkSync(lock);
  }
}

if (process.argv[1] && realpathSync.native(process.argv[1]) === realpathSync.native(fileURLToPath(import.meta.url))) {
  try {
    const [command, ...args] = process.argv.slice(2);
    const options = {};
    const allowed = new Set(["target", "input", "cache-dir", "days", "since", "until", "expected"]);
    for (let index = 0; index < args.length; index += 2) {
      const key = args[index].slice(2);
      if (!args[index].startsWith("--") || !allowed.has(key) || !args[index + 1] || args[index + 1].startsWith("--") || Object.hasOwn(options, key)) {
        throw new Error("Expected unique --option value pairs");
      }
      options[key] = args[index + 1];
    }
    console.log(JSON.stringify(run(command, options), null, 2));
  } catch (error) {
    console.error(`skill-doctor cache: ${error.message}`);
    process.exitCode = 1;
  }
}
