import { createHash, randomBytes } from "node:crypto";
import {
  lstat,
  link,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  canonicalJson,
  validateRelativeTemplatePath,
} from "./config.mjs";

export const STATE_FILE = ".skills-repo/state.json";
export const STATE_SCHEMA_VERSION = 1;
const TEXT_NORMALIZATION = "lf";
const RAW_NORMALIZATION = "raw";
const BINARY_EXTENSIONS = new Set([
  ".gif",
  ".ico",
  ".jpeg",
  ".jpg",
  ".pdf",
  ".png",
  ".webp",
  ".zip",
]);

function normalizeText(buffer) {
  return Buffer.from(buffer.toString("utf8").replace(/\r\n?/g, "\n"), "utf8");
}

export function hashContent(content, normalization = TEXT_NORMALIZATION) {
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
  const normalized = normalization === TEXT_NORMALIZATION
    ? normalizeText(buffer)
    : buffer;
  return createHash("sha256").update(normalized).digest("hex");
}

function normalizationFor(relativePath, content) {
  if (BINARY_EXTENSIONS.has(path.extname(relativePath).toLowerCase())) {
    return RAW_NORMALIZATION;
  }
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
  return buffer.includes(0) ? RAW_NORMALIZATION : TEXT_NORMALIZATION;
}

export function buildState(desired, templateVersion) {
  const files = {};
  for (const relativePath of [...desired.keys()].sort()) {
    const normalization = normalizationFor(relativePath, desired.get(relativePath));
    files[relativePath] = {
      sha256: hashContent(desired.get(relativePath), normalization),
      normalization,
    };
  }
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    hashVersion: 1,
    templateVersion,
    files,
  };
}

export async function loadState(root) {
  const statePath = path.join(root, STATE_FILE);
  await ensureNoSymlinkParents(root, STATE_FILE);
  const stateMetadata = await lstat(statePath).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (stateMetadata?.isSymbolicLink() || (stateMetadata && !stateMetadata.isFile())) {
    throw new Error(`${STATE_FILE} must be a regular file.`);
  }
  let state;
  try {
    state = JSON.parse(await readFile(statePath, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read ${STATE_FILE}: ${error.message}`, {
      cause: error,
    });
  }
  if (
    state?.schemaVersion !== STATE_SCHEMA_VERSION ||
    state?.hashVersion !== 1 ||
    state?.files === null ||
    typeof state?.files !== "object" ||
    Array.isArray(state.files)
  ) {
    throw new Error(`${STATE_FILE} has an unsupported or invalid schema.`);
  }
  for (const [relativePath, record] of Object.entries(state.files)) {
    validateRelativeTemplatePath(relativePath, "managed state path");
    if (
      ![TEXT_NORMALIZATION, RAW_NORMALIZATION].includes(record?.normalization) ||
      !/^[a-f0-9]{64}$/.test(record?.sha256 ?? "")
    ) {
      throw new Error(`${STATE_FILE} has an invalid record for ${relativePath}.`);
    }
  }
  return state;
}

async function inspectPath(root, relativePath) {
  const absolute = path.join(root, relativePath);
  let metadata;
  try {
    metadata = await lstat(absolute);
  } catch (error) {
    if (error.code === "ENOENT") return { kind: "missing", absolute };
    throw error;
  }
  if (metadata.isSymbolicLink()) return { kind: "symlink", absolute };
  if (!metadata.isFile()) return { kind: "non-file", absolute };
  const content = await readFile(absolute);
  return {
    kind: "file",
    absolute,
    content,
  };
}

async function classifyManagedFilesWithPreimages(root, desired, state) {
  const changes = [];
  const conflicts = [];
  const unchanged = [];
  const preimages = new Map();

  for (const relativePath of [...desired.keys()].sort()) {
    validateRelativeTemplatePath(relativePath);
    const current = await inspectPath(root, relativePath);
    const normalization = normalizationFor(relativePath, desired.get(relativePath));
    const desiredHash = hashContent(desired.get(relativePath), normalization);
    const previous = state.files[relativePath];
    const currentHash = current.kind === "file"
      ? hashContent(current.content, previous?.normalization ?? normalization)
      : null;

    if (current.kind === "symlink" || current.kind === "non-file") {
      conflicts.push({ path: relativePath, reason: current.kind });
      continue;
    }
    if (!previous) {
      if (current.kind === "missing") {
        changes.push({ path: relativePath, operation: "create" });
        preimages.set(relativePath, current);
      } else if (currentHash === desiredHash) {
        unchanged.push(relativePath);
      } else {
        conflicts.push({ path: relativePath, reason: "untracked-collision" });
      }
      continue;
    }
    if (current.kind === "missing") {
      conflicts.push({ path: relativePath, reason: "deleted-managed-file" });
      continue;
    }
    if (currentHash === desiredHash) {
      unchanged.push(relativePath);
      continue;
    }
    if (currentHash !== previous.sha256) {
      conflicts.push({ path: relativePath, reason: "modified-managed-file" });
      continue;
    }
    changes.push({ path: relativePath, operation: "update" });
    preimages.set(relativePath, current);
  }

  for (const relativePath of Object.keys(state.files).sort()) {
    if (desired.has(relativePath)) continue;
    const current = await inspectPath(root, relativePath);
    const previous = state.files[relativePath];
    if (current.kind === "missing") {
      conflicts.push({ path: relativePath, reason: "deleted-retired-managed-file" });
    } else if (current.kind !== "file") {
      conflicts.push({ path: relativePath, reason: current.kind });
    } else if (
      hashContent(current.content, previous.normalization) !== previous.sha256
    ) {
      conflicts.push({ path: relativePath, reason: "modified-retired-managed-file" });
    } else {
      conflicts.push({ path: relativePath, reason: "retired-managed-file" });
    }
  }

  return { changes, conflicts, unchanged, preimages };
}

export async function classifyManagedFiles(root, desired, state) {
  const { preimages: _preimages, ...classification } =
    await classifyManagedFilesWithPreimages(root, desired, state);
  return classification;
}

export async function inspectManagedState(root, state) {
  const conflicts = [];
  for (const relativePath of Object.keys(state.files).sort()) {
    const current = await inspectPath(root, relativePath);
    const previous = state.files[relativePath];
    if (current.kind === "missing") {
      conflicts.push({ path: relativePath, reason: "deleted-managed-file" });
    } else if (current.kind !== "file") {
      conflicts.push({ path: relativePath, reason: current.kind });
    } else if (
      hashContent(current.content, previous.normalization) !== previous.sha256
    ) {
      conflicts.push({ path: relativePath, reason: "modified-managed-file" });
    }
  }
  return conflicts;
}

async function ensureNoSymlinkParents(root, relativePath) {
  const parts = relativePath.split("/").slice(0, -1);
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    try {
      const metadata = await lstat(current);
      if (metadata.isSymbolicLink()) {
        throw new Error(`Managed path parent is a symlink: ${relativePath}.`);
      }
      if (!metadata.isDirectory()) {
        throw new Error(`Managed path parent is not a directory: ${relativePath}.`);
      }
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
  }
}

function payloadFor(absolute, content) {
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
  return normalizationFor(absolute, buffer) === TEXT_NORMALIZATION
    ? normalizeText(buffer)
    : buffer;
}

async function replaceFile(absolute, content, token) {
  await mkdir(path.dirname(absolute), { recursive: true });
  const temporary = `${absolute}.create-skills-repo-${token}.tmp`;
  const payload = payloadFor(absolute, content);
  await writeFile(temporary, payload, { flag: "wx" });
  await rename(temporary, absolute);
  return payload;
}

async function matchesPublishedContent(root, relativePath, payload) {
  const current = await inspectPath(root, relativePath);
  return current.kind === "file" && current.content.equals(payload);
}

async function assertUnchangedSinceClassification(root, relativePath, expected) {
  const current = await inspectPath(root, relativePath);
  const isUnchanged =
    current.kind === expected.kind &&
    (current.kind !== "file" || current.content.equals(expected.content));
  if (!isUnchanged) {
    throw new Error(
      `Managed file changed during transaction: ${relativePath}. No replacement was published for this file.`,
    );
  }
}

async function acquireLock(root) {
  const lockPath = `${root}.create-skills-repo.lock`;
  await mkdir(path.dirname(root), { recursive: true });
  const candidate = `${lockPath}.${process.pid}.${randomBytes(8).toString("hex")}.candidate`;
  await writeFile(candidate, `${process.pid}\n`, { flag: "wx" });
  try {
    await link(candidate, lockPath);
  } catch (error) {
    if (error.code === "EEXIST") {
      const owner = await readFile(lockPath, "utf8").catch(() => "unknown");
      throw new Error(
        `Another create-skills-repo operation holds ${lockPath} for PID ${owner.trim() || "unknown"}. Remove the lock only after confirming that operation has stopped.`,
      );
    }
    throw error;
  } finally {
    await rm(candidate, { force: true });
  }
  return async () => {
    try {
      await rm(lockPath, { force: true });
    } catch (error) {
      throw new Error(`Could not release create-skills-repo lock ${lockPath}.`, {
        cause: error,
      });
    }
  };
}

export async function applyManagedTransaction(
  root,
  desired,
  state,
  templateVersion,
  options = {},
) {
  const release = await acquireLock(root);
  const originals = new Map();
  const published = [];
  const token = randomBytes(8).toString("hex");
  let applied = 0;
  try {
    const {
      preimages,
      ...classification
    } = await classifyManagedFilesWithPreimages(root, desired, state);
    if (classification.conflicts.length > 0) {
      return { ...classification, written: 0 };
    }
    for (const { path: relativePath } of classification.changes) {
      await ensureNoSymlinkParents(root, relativePath);
      const expected = preimages.get(relativePath);
      await assertUnchangedSinceClassification(root, relativePath, expected);
      originals.set(
        relativePath,
        expected.kind === "file" ? expected.content : null,
      );
    }

    const nextState = buildState(desired, templateVersion);
    const stateAbsolute = path.join(root, STATE_FILE);
    await ensureNoSymlinkParents(root, STATE_FILE);
    const stateInspection = await inspectPath(root, STATE_FILE);
    if (
      stateInspection.kind !== "missing" &&
      stateInspection.kind !== "file"
    ) {
      throw new Error(`${STATE_FILE} must be a regular file.`);
    }
    try {
      originals.set(STATE_FILE, await readFile(stateAbsolute));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      originals.set(STATE_FILE, null);
    }

    for (const { path: relativePath } of classification.changes) {
      if (options.beforeWrite) await options.beforeWrite(relativePath, applied);
      await assertUnchangedSinceClassification(
        root,
        relativePath,
        preimages.get(relativePath),
      );
      const payload = await replaceFile(
        path.join(root, relativePath),
        desired.get(relativePath),
        token,
      );
      published.push({ relativePath, payload });
      applied += 1;
      if (options.failAfter === applied) {
        throw new Error("Injected transaction failure.");
      }
    }
    const nextStateContent = canonicalJson(nextState);
    const previousStateContent = originals.get(STATE_FILE);
    if (
      previousStateContent === null ||
      normalizeText(previousStateContent).toString("utf8") !== nextStateContent
    ) {
      const payload = await replaceFile(stateAbsolute, nextStateContent, token);
      published.push({ relativePath: STATE_FILE, payload });
    }
    for (const { relativePath, payload } of published) {
      if (!(await matchesPublishedContent(root, relativePath, payload))) {
        throw new Error(`Managed file changed after publication: ${relativePath}.`);
      }
    }
    return { ...classification, written: applied };
  } catch (error) {
    const preserved = [];
    for (const { relativePath, payload } of published.reverse()) {
      if (!(await matchesPublishedContent(root, relativePath, payload))) {
        preserved.push(relativePath);
        continue;
      }
      const original = originals.get(relativePath);
      const absolute = path.join(root, relativePath);
      if (original === null) {
        await rm(absolute, { force: true });
      } else {
        await replaceFile(absolute, original, token);
      }
    }
    if (preserved.length > 0) {
      throw new Error(
        `${error.message} Rollback preserved external edits to: ${preserved.sort().join(", ")}.`,
        { cause: error },
      );
    }
    throw error;
  } finally {
    await release();
  }
}
