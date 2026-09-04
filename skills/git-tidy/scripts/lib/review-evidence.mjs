import {
  buildReviewBundle,
  isSensitiveReviewPath,
} from "./review-bundle.mjs";
import { createGitBoundary, GitBoundaryError } from "./git.mjs";
const GENERATED_PATH =
  /(?:^|\/)(?:dist|build|coverage|vendor|generated|gen)(?:\/|$)|(?:\.min\.(?:js|css)|\.generated\.[^/]+|-lock\.json|\.lock)$/iu;

function gap(code, affectedIds, reason) {
  return {
    code,
    affectedIds: [...new Set(affectedIds)].sort(),
    reason,
  };
}

function rethrowCancellation(error, signal) {
  if (signal?.aborted || error?.code === "CANCELLED") throw error;
}

function parseBatch(buffer, requested) {
  const text = new TextDecoder("ascii", { fatal: true }).decode(buffer);
  if (text.includes("\r") || !text.endsWith("\n")) {
    throw new TypeError("cat-file batch response has invalid framing");
  }
  const lines = text.slice(0, -1).split("\n");
  if (lines.length !== requested.length) {
    throw new TypeError("cat-file batch response count mismatch");
  }
  return lines.map((line, index) => {
    const match =
      /^([0-9a-f]+) (blob|commit|tree|tag) ([0-9]+)$/u.exec(line);
    if (!match || match[1] !== requested[index]) {
      throw new TypeError("cat-file batch response has invalid schema");
    }
    const size = Number(match[3]);
    if (!Number.isSafeInteger(size)) {
      throw new TypeError("blob size is unsafe");
    }
    return { oid: match[1], type: match[2], size };
  });
}

function frameLines(bytes, prefix) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { text: "", binary: true };
  }
  if (bytes.includes(0)) {
    return { text: "", binary: true };
  }
  return {
    text: text.split(/\n/u).map((line, index, lines) =>
      index === lines.length - 1 && line === ""
        ? ""
        : `${prefix}${line}\n`).join(""),
    binary: false,
  };
}

function requiredSides(unit) {
  if (unit.kind === "add") {
    return [{ label: "after", oid: unit.newOid, prefix: "+" }];
  }
  if (unit.kind === "delete") {
    return [{ label: "before", oid: unit.oldOid, prefix: "-" }];
  }
  return [
    { label: "before", oid: unit.oldOid, prefix: "-" },
    { label: "after", oid: unit.newOid, prefix: "+" },
  ].filter(({ oid }) => oid !== null);
}

function baseRecord(unit) {
  return {
    changeUnitId: unit.id,
    displayPath: unit.path?.display ?? "<undisclosed>",
    identity: { rawBase64: unit.path?.rawBase64 ?? "" },
    newMode: unit.newMode,
  };
}

function classifyCandidate(unit, base) {
  const normalizedPath = base.displayPath.replaceAll("\\", "/");
  if (unit.sourceComponent === "ignored") {
    return { code: "ignored-content", record: null };
  }
  if (unit.kind === "gitlink" || unit.newMode === "160000") {
    return { record: { ...base, diff: "", submodule: true } };
  }
  if (unit.newMode === "120000" || unit.oldMode === "120000") {
    return { record: { ...base, diff: "", symlink: true } };
  }
  if (isSensitiveReviewPath(normalizedPath)) {
    return { record: { ...base, diff: "", sensitive: true } };
  }
  if (GENERATED_PATH.test(normalizedPath)) {
    return { record: { ...base, diff: "", generated: true } };
  }
  const sides = requiredSides(unit);
  if (sides.length === 0 || sides.some(({ oid }) => !oid)) {
    return { code: "review-identity-incomplete", record: null };
  }
  return { sides };
}

async function readMetadata(boundary, oids, signal) {
  if (oids.length === 0) {
    return new Map();
  }
  const result = await boundary.run([
    "cat-file",
    "--batch-check=%(objectname) %(objecttype) %(objectsize)",
  ], {
    input: `${oids.join("\n")}\n`,
    signal,
  });
  return new Map(
    parseBatch(result.stdout, oids).map((entry) => [entry.oid, entry]),
  );
}

function candidateFits(candidate, metadata, limits, reservedOids, totalRead) {
  let additionalBytes = 0;
  const candidateOids = new Set();
  for (const { oid } of candidate.sides) {
    const object = metadata.get(oid);
    if (!object || object.type !== "blob") {
      return { code: "review-non-blob" };
    }
    if (object.size > limits.maxReviewBytesPerFile) {
      return { code: "review-byte-limit" };
    }
    if (!reservedOids.has(oid) && !candidateOids.has(oid)) {
      additionalBytes += object.size;
      candidateOids.add(oid);
    }
  }
  if (totalRead + additionalBytes > limits.maxReviewBytesTotal) {
    return { code: "review-byte-limit" };
  }
  return { additionalBytes };
}

async function readBlob(boundary, oid, metadata, limits, signal) {
  const result = await boundary.run(["cat-file", "-p", oid], {
    signal,
    maxStdoutBytes: limits.maxReviewBytesPerFile,
  });
  if (result.stdout.length !== metadata.get(oid).size) {
    const error = new Error("Blob size changed during review collection.");
    error.code = "review-blob-size-drift";
    throw error;
  }
  return result.stdout;
}

function buildDiff(candidate, blobs) {
  const sections = [];
  let binary = false;
  for (const side of candidate.sides) {
    const framed = frameLines(blobs.get(side.oid), side.prefix);
    binary ||= framed.binary;
    if (!framed.binary) {
      sections.push(
        `${side.label === "before" ? "--- before" : "+++ after"}\n` +
        framed.text,
      );
    }
  }
  return {
    ...candidate.base,
    diff: binary ? Buffer.alloc(0) : sections.join(""),
    binary,
  };
}

export async function collectReviewRecords({
  boundary,
  changeUnits,
  limits,
  selectedChangeUnitIds = null,
  signal,
} = {}) {
  if (
    !boundary ||
    typeof boundary.run !== "function" ||
    !Array.isArray(changeUnits) ||
    (selectedChangeUnitIds !== null &&
      !Array.isArray(selectedChangeUnitIds))
  ) {
    throw new TypeError("boundary and changeUnits are required");
  }

  const records = [];
  const gaps = [];
  const contentCandidates = [];
  const selected = selectedChangeUnitIds === null
    ? null
    : new Set(selectedChangeUnitIds);
  const omitted = [];
  for (
    const unit of [...changeUnits].sort(
      (left, right) => left.id.localeCompare(right.id, "en"),
    )
  ) {
    if (selected !== null && !selected.has(unit.id)) {
      omitted.push(unit.id);
      continue;
    }
    const base = baseRecord(unit);
    const candidate = classifyCandidate(unit, base);
    if (candidate.record) {
      records.push(candidate.record);
    } else if (candidate.code) {
      gaps.push(gap(
        candidate.code,
        [unit.id],
        candidate.code === "ignored-content"
          ? "Ignored content was not read."
          : "Review object identity is incomplete.",
      ));
    } else {
      contentCandidates.push({ ...candidate, base, unit });
    }
  }
  if (omitted.length > 0) {
    gaps.push(gap(
      "review-selection-limit",
      omitted,
      "Review content was omitted by work-item and file limits.",
    ));
  }

  const oids = [...new Set(contentCandidates.flatMap(
    ({ sides }) => sides.map(({ oid }) => oid),
  ))].sort();
  let metadata;
  try {
    metadata = await readMetadata(boundary, oids, signal);
  } catch (error) {
    rethrowCancellation(error, signal);
    gaps.push(gap(
      "review-metadata-unavailable",
      contentCandidates.map(({ unit }) => unit.id),
      error?.code ?? "Blob metadata unavailable.",
    ));
    return {
      records,
      gaps,
      observed: changeUnits.length,
      skipped: changeUnits.length - records.length,
    };
  }

  const blobs = new Map();
  const reservedOids = new Set();
  let totalRead = 0;
  for (const candidate of contentCandidates) {
    const fit = candidateFits(
      candidate,
      metadata,
      limits,
      reservedOids,
      totalRead,
    );
    if (fit.code) {
      gaps.push(gap(
        fit.code,
        [candidate.unit.id],
        fit.code === "review-non-blob"
          ? "Review object is not a blob."
          : "Blob content exceeds the configured review read budget.",
      ));
      continue;
    }

    try {
      for (const { oid } of candidate.sides) {
        if (!blobs.has(oid)) {
          blobs.set(
            oid,
            await readBlob(boundary, oid, metadata, limits, signal),
          );
          reservedOids.add(oid);
          totalRead += metadata.get(oid).size;
        }
      }
      records.push(buildDiff(candidate, blobs));
    } catch (error) {
      rethrowCancellation(error, signal);
      gaps.push(gap(
        error?.code === "review-blob-size-drift"
          ? "review-blob-size-drift"
          : "review-content-unavailable",
        [candidate.unit.id],
        error?.code ?? "Blob content unavailable.",
      ));
    }
  }

  return {
    records,
    gaps: gaps.sort((left, right) =>
      left.code.localeCompare(right.code, "en")),
    observed: changeUnits.length,
    skipped: changeUnits.length - records.length,
  };
}

function reviewUnitIds(item) {
  return [...new Set([
    ...item.changeUnits.map(({ id }) => id),
    ...(item.carriers ?? []).flatMap(
      ({ observed }) =>
        observed?.componentChangeUnitIds?.trackedFinal ?? [],
    ),
  ])];
}

export function selectReviewChangeUnitIds(workItems, limits) {
  const selected = new Set();
  for (const item of workItems.slice(0, limits.maxReviewWorkItems)) {
    for (const unitId of reviewUnitIds(item)
      .sort((left, right) => left.localeCompare(right, "en"))
      .slice(0, limits.maxReviewFilesPerItem)) {
      selected.add(unitId);
    }
  }
  return [...selected].sort((left, right) => left.localeCompare(right, "en"));
}

export async function collectRepositoryReviewRecords(
  repoPath,
  changeUnits,
  selectedChangeUnitIds,
  limits,
  options = {},
) {
  const controller = new AbortController();
  const externalAbort = () => controller.abort();
  options.signal?.addEventListener("abort", externalAbort, { once: true });
  if (options.signal?.aborted) controller.abort();
  const timer = setTimeout(
    () => controller.abort(),
    limits.collectionTimeoutMs,
  );
  timer.unref?.();
  try {
    const boundary = await createGitBoundary(repoPath, {
      gitPath: options.gitPath,
      timeoutMs: limits.commandTimeoutMs,
      maxStdoutBytes: limits.maxStdoutBytes,
      maxStderrBytes: limits.maxStderrBytes,
      signal: controller.signal,
    });
    return await collectReviewRecords({
      boundary,
      changeUnits,
      limits,
      selectedChangeUnitIds,
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted && !options.signal?.aborted) {
      throw new GitBoundaryError(
        "COLLECTION_TIMEOUT",
        "review collection time budget exceeded",
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", externalAbort);
  }
}

function workItemIdsByChangeUnit(workItems) {
  const result = new Map();
  for (const item of workItems) {
    for (const unitId of reviewUnitIds(item)) {
      const ids = result.get(unitId) ?? [];
      ids.push(item.id);
      result.set(unitId, ids);
    }
  }
  return result;
}

function mergeGap(bundle, entry, affectedIds) {
  const omittedCount = Math.max(1, entry.affectedIds.length);
  const existing = bundle.gaps.find(({ code }) => code === entry.code);
  if (existing) {
    existing.count += omittedCount;
    existing.affectedIds = [
      ...new Set([...existing.affectedIds, ...affectedIds]),
    ].sort();
    return;
  }
  bundle.gaps.push({
    code: entry.code,
    count: omittedCount,
    affectedIds: [...new Set(affectedIds)].sort(),
  });
}

export function buildCollectedReviewBundle({
  workItems,
  records,
  gaps = [],
  limits,
  runId,
}) {
  const unitToItems = workItemIdsByChangeUnit(workItems);
  const byUnit = new Map();
  for (const record of records) {
    const values = byUnit.get(record.changeUnitId) ?? [];
    values.push(record);
    byUnit.set(record.changeUnitId, values);
  }

  const diffRecords = [];
  for (const item of workItems) {
    for (const unitId of reviewUnitIds(item)) {
      for (const record of byUnit.get(unitId) ?? []) {
        const { changeUnitId, ...reviewRecord } = record;
        diffRecords.push({ ...reviewRecord, workItemId: item.id });
      }
    }
  }
  const bundle = buildReviewBundle({
    knownWorkItemIds: workItems.map(({ id }) => id),
    diffRecords,
    limits: {
      maxWorkItems: limits.maxReviewWorkItems,
      maxFilesPerItem: limits.maxReviewFilesPerItem,
      maxChangedLinesPerItem: limits.maxReviewChangedLinesPerItem,
      maxBytesPerFile: limits.maxReviewBytesPerFile,
      maxBytesTotal: limits.maxReviewBytesTotal,
    },
    nonce: runId.slice(0, 32),
    approveIgnored: false,
  });

  for (const entry of gaps) {
    const affectedIds = [...new Set(entry.affectedIds.flatMap(
      (unitId) => unitToItems.get(unitId) ?? [],
    ))];
    mergeGap(bundle, entry, affectedIds);
  }
  bundle.gaps.sort((left, right) =>
    left.code.localeCompare(right.code, "en"));
  bundle.complete = bundle.gaps.length === 0;
  return bundle;
}
