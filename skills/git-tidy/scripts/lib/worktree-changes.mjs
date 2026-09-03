import { lstat } from "node:fs/promises";
import path from "node:path";

import {
  createGitBoundary,
  hashFilesystemEntry,
} from "./git.mjs";
import {
  addGap,
  changeUnit,
  markLimit,
  parseLine,
} from "./evidence-shared.mjs";
import {
  parseStatusRecord,
  readIgnoredState,
  readSparseState,
  statusRecords,
  summarizeStatus,
} from "./worktree-state.mjs";

export { statusRecords };

function unavailableSparse(reason) {
  return {
    gaps: [
      { code: "sparse-enabled-unknown", reason },
      { code: "sparse-cone-unknown", reason },
      { code: "sparse-index-unknown", reason },
      { code: "sparse-pattern-count-unknown", reason },
    ],
    observed: {
      enabled: null,
      cone: null,
      sparseIndex: null,
      patternCount: null,
    },
  };
}

function worktreeBoundaryOptions(request, context) {
  return {
    timeoutMs: request.limits.commandTimeoutMs,
    maxStdoutBytes: request.limits.maxStdoutBytes,
    maxStderrBytes: request.limits.maxStderrBytes,
    signal: context.signal,
  };
}

export async function inspectWorktree(entry, request, context) {
  if (!entry.pathRepresentable) {
    addGap(
      context,
      "worktree-path-unrepresentable",
      [],
      "registered worktree path is not valid UTF-8",
    );
    return {
      boundary: null,
      gitDir: Buffer.alloc(0),
      missing: false,
      rawStatus: Buffer.alloc(0),
      ignored: {
        count: null,
        reason: "worktree path is not representable",
      },
      sparse: unavailableSparse("worktree path is not representable"),
      unknown: true,
    };
  }

  let boundary;
  let rawStatus = Buffer.alloc(0);
  let missing = false;
  let unknown = false;
  try {
    await lstat(entry.path);
    boundary = await createGitBoundary(
      entry.path,
      worktreeBoundaryOptions(request, context),
    );
    rawStatus = (await boundary.run([
      "status",
      "--porcelain=v2",
      "-z",
      "--branch",
      "--untracked-files=all",
    ], { signal: context.signal })).stdout;
  } catch (error) {
    missing = error?.code === "ENOENT";
    unknown = !missing;
    addGap(
      context,
      missing ? "worktree-missing" : "worktree-status-unavailable",
      [],
      missing
        ? "registered worktree path is missing"
        : error.code ?? "worktree status unavailable",
    );
  }

  let gitDir = Buffer.alloc(0);
  let ignored = {
    count: null,
    reason: "worktree boundary is unavailable",
  };
  let sparse = unavailableSparse("worktree boundary is unavailable");
  if (boundary) {
    [ignored, sparse] = await Promise.all([
      readIgnoredState(boundary, context.signal),
      readSparseState(boundary, context.signal),
    ]);
    try {
      const result = await boundary.run([
        "rev-parse",
        "--path-format=absolute",
        "--absolute-git-dir",
      ], { signal: context.signal });
      gitDir = parseLine(result.stdout, "worktree git directory");
    } catch (error) {
      unknown = true;
      addGap(
        context,
        "worktree-git-dir-unavailable",
        [],
        error.code ?? "worktree git directory unavailable",
      );
    }
  }
  return {
    boundary,
    gitDir,
    ignored,
    missing,
    rawStatus,
    sparse,
    unknown,
  };
}

export function parseTrackedRecord(record, boundary, units, context) {
  const tracked = parseStatusRecord(record);
  if (
    !tracked ||
    !["ordinary", "rename"].includes(tracked.type)
  ) {
    return false;
  }
  if (tracked.type === "rename") {
    addGap(
      context,
      "worktree-rename-incomplete",
      [],
      "porcelain rename/copy records require both raw paths",
    );
    return "incomplete";
  }
  if (tracked.xy[0] !== ".") {
    units.push(changeUnit({
      oldMode: tracked.headMode,
      newMode: tracked.indexMode,
      oldOid: tracked.headOid,
      newOid: tracked.indexOid,
      code: tracked.indexMode === "000000"
        ? "D"
        : tracked.headMode === "000000"
          ? "A"
          : "M",
      path: Buffer.from(tracked.path),
    }, "staged", boundary.objectFormat));
  }
  if (tracked.xy[1] !== ".") {
    addGap(
      context,
      "unstaged-content-unhashed",
      [],
      "unstaged content has no exact blob OID and was not represented as exact",
    );
    return "incomplete";
  }
  return true;
}

async function collectUntracked(
  record,
  entry,
  boundary,
  request,
  context,
  budget,
) {
  if (budget.attempts >= request.limits.maxUntrackedFiles) {
    markLimit(context, "maxUntrackedFiles");
    return null;
  }
  if (budget.bytes >= request.limits.maxUntrackedBytesTotal) {
    markLimit(context, "maxUntrackedBytesTotal");
    return null;
  }

  const relative = record.slice(2);
  const root = path.resolve(entry.path);
  const absolute = path.resolve(entry.path, relative);
  if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) {
    addGap(
      context,
      "unsafe-untracked-path",
      [],
      "untracked path escaped worktree",
    );
    return null;
  }

  budget.attempts += 1;
  const remainingBytes =
    request.limits.maxUntrackedBytesTotal - budget.bytes;
  const maxBytes = Math.min(
    request.limits.maxUntrackedBytesPerFile,
    remainingBytes,
  );
  try {
    const hashed = await hashFilesystemEntry(absolute, {
      objectFormat: boundary.objectFormat,
      signal: context.signal,
      maxBytes,
    });
    budget.bytes += hashed.size;
    return changeUnit({
      oldMode: "000000",
      newMode: hashed.kind === "symlink" ? "120000" : "100644",
      oldOid: "0".repeat(hashed.oid.length),
      newOid: hashed.oid,
      code: "A",
      path: Buffer.from(relative),
    }, "untracked", boundary.objectFormat);
  } catch (error) {
    if (
      error?.code === "HASH_LIMIT" &&
      remainingBytes <= request.limits.maxUntrackedBytesPerFile
    ) {
      markLimit(context, "maxUntrackedBytesTotal");
    }
    addGap(
      context,
      "untracked-hash-unavailable",
      [],
      error.code ?? "untracked hash unavailable",
    );
    return null;
  }
}

export async function statusChangeUnits(
  entry,
  inspection,
  request,
  context,
  budget,
) {
  let records = [];
  let complete = !inspection.unknown && !inspection.missing;
  try {
    records = statusRecords(inspection.rawStatus);
  } catch {
    complete = false;
    addGap(
      context,
      "worktree-path-unrepresentable",
      [],
      "worktree status contains a path that is not valid UTF-8",
    );
  }
  const units = [];
  for (const record of records) {
    const tracked = parseTrackedRecord(
      record,
      inspection.boundary,
      units,
      context,
    );
    if (tracked) {
      complete &&= tracked !== "incomplete";
      continue;
    }
    if (record.startsWith("? ")) {
      const unit = await collectUntracked(
        record,
        entry,
        inspection.boundary,
        request,
        context,
        budget,
      );
      if (unit) {
        units.push(unit);
      } else {
        complete = false;
      }
      continue;
    }
    complete = false;
    addGap(
      context,
      record.startsWith("u ")
        ? "worktree-conflict"
        : "worktree-status-record-unrecognized",
      [],
      "worktree status record is incomplete",
    );
  }
  return {
    complete,
    counts: summarizeStatus(records),
    records,
    units,
  };
}
