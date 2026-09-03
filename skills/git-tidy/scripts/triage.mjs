#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  canonicalJson,
  projectCompatibility,
  validateLastCopyBatch,
} from "./lib/mechanical-core.mjs";
import { collectEvidence } from "./lib/evidence.mjs";
import { checkNodeCapability } from "./lib/git.mjs";
import {
  buildCollectedReviewBundle,
  collectRepositoryReviewRecords,
  selectReviewChangeUnitIds,
} from "./lib/review-evidence.mjs";
import { buildWorkItems } from "./lib/triage-policy.mjs";
import { validateMechanicalResult } from "./lib/result-schema.mjs";
import {
  allCarriers,
  carrierSnapshot,
  compare,
  DEPTHS,
  DESTRUCTIVE,
  digestResult,
  drift,
  exactKeys,
  planStep,
  runDigest,
  SCHEMA_VERSION,
  SCOPES,
  sortSteps,
} from "./lib/triage-shared.mjs";

export {
  DEPTHS,
  SCHEMA_VERSION,
  SCOPES,
};

export function parseArguments(argv) {
  if (
    !Array.isArray(argv) ||
    argv.some((arg) => typeof arg !== "string")
  ) {
    throw new TypeError("argv must be an array of strings");
  }

  let operation = "analyze";
  let scope = "all";
  let depth = "proof";
  let includeIgnored = false;
  let dryRun = false;
  let scopeSeen = false;
  let operationSeen = false;
  let depthSeen = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "analyze" || arg === "revalidate") {
      if (operationSeen || index !== 0) {
        throw new TypeError("operation must appear once and first");
      }
      operation = arg;
      operationSeen = true;
      continue;
    }
    if (SCOPES.includes(arg)) {
      if (operation === "revalidate") {
        throw new TypeError("revalidate does not accept a scope");
      }
      if (scopeSeen) {
        throw new TypeError("scope may be specified only once");
      }
      scope = arg;
      scopeSeen = true;
      continue;
    }
    if (arg === "--depth") {
      if (operation === "revalidate") {
        throw new TypeError("revalidate reads depth from prior input");
      }
      if (depthSeen) {
        throw new TypeError("--depth may be specified only once");
      }
      const value = argv[++index];
      if (!DEPTHS.includes(value)) {
        throw new TypeError(
          "--depth requires metadata, proof, or review",
        );
      }
      depth = value;
      depthSeen = true;
      continue;
    }
    if (arg === "--include-ignored") {
      if (operation === "revalidate" || includeIgnored) {
        throw new TypeError("invalid duplicate option");
      }
      includeIgnored = true;
      continue;
    }
    if (arg === "--dry-run") {
      if (operation === "revalidate" || dryRun) {
        throw new TypeError("invalid duplicate option");
      }
      dryRun = true;
      continue;
    }
    throw new TypeError(`unknown argument: ${arg ?? "<missing>"}`);
  }

  return Object.freeze({
    operation,
    scope,
    depth,
    includeIgnored,
    dryRun,
  });
}

function addNodeCapability(evidence, nodeCapability) {
  evidence.coverage.capabilities = [
    ...evidence.coverage.capabilities,
    nodeCapability,
  ].sort((left, right) => compare(left.name, right.name));
  if (nodeCapability.available) {
    return;
  }
  evidence.coverage.state = "partial";
  evidence.coverage.gaps.push({
    code: "node-runtime-unavailable",
    affectedIds: evidence.carriers.map(({ id }) => id),
    reason:
      "Node.js 22 or newer is required for proof, review, and revalidation.",
  });
}

function createAnalyzeResult(evidence, workItems, runId) {
  return {
    schemaVersion: SCHEMA_VERSION,
    operation: "analyze",
    runId,
    generatedAt: new Date().toISOString(),
    repository: evidence.repository,
    request: evidence.request,
    workItems,
    inventory: evidence.inventory,
    coverage: evidence.coverage,
    reviewBundle: null,
    actionPlan: null,
    drift: [],
    compatibility: projectCompatibility(workItems),
  };
}

export async function analyzeRepository(repoPath, options = {}) {
  const nodeCapability = await checkNodeCapability({
    nodePath: options.nodePath,
    timeoutMs: options.commandTimeoutMs,
  });
  const requestedDepth = options.depth ?? "proof";
  const depth = nodeCapability.available ? requestedDepth : "metadata";
  const evidence = await collectEvidence(repoPath, {
    ...options,
    depth,
  });
  addNodeCapability(evidence, nodeCapability);

  const workItems = buildWorkItems(evidence);
  const runId = runDigest(
    evidence.repository,
    evidence.request,
    allCarriers(workItems),
    evidence.changeUnits,
    evidence.inventory,
  );
  const result = createAnalyzeResult(evidence, workItems, runId);
  if (depth === "review") {
    const selectedChangeUnitIds = selectReviewChangeUnitIds(
      workItems,
      evidence.request.limits,
    );
    const reviewEvidence = await collectRepositoryReviewRecords(
      repoPath,
      evidence.changeUnits,
      selectedChangeUnitIds,
      evidence.request.limits,
      options,
    );
    evidence.coverage.observedCounts.reviewFiles = reviewEvidence.observed;
    evidence.coverage.skippedCounts.reviewFiles = reviewEvidence.skipped;
    for (const gap of reviewEvidence.gaps) {
      evidence.coverage.gaps.push({
        code: gap.code,
        affectedIds: gap.code === "review-selection-limit"
          ? []
          : gap.affectedIds,
        reason: gap.reason,
      });
    }
    if (reviewEvidence.gaps.length > 0) evidence.coverage.state = "partial";
    evidence.coverage.gaps.sort(
      (left, right) =>
        compare(left.code, right.code) ||
        compare(left.reason, right.reason),
    );
    result.reviewBundle = buildCollectedReviewBundle({
      workItems,
      records: reviewEvidence.records,
      gaps: reviewEvidence.gaps,
      limits: evidence.request.limits,
      runId,
    });
    result.coverage.skippedCounts.reviewFiles +=
      result.reviewBundle.counts.excludedFiles;
  }
  return result;
}

function validatePrior(prior, selectedCarrierIds) {
  const validation = validateMechanicalResult(prior);
  if (!validation.valid) {
    throw new TypeError(
      `stdin result is not a closed analyze ${SCHEMA_VERSION} result`,
    );
  }
  if (
    !Array.isArray(selectedCarrierIds) ||
    selectedCarrierIds.length === 0 ||
    selectedCarrierIds.some((id) => typeof id !== "string") ||
    new Set(selectedCarrierIds).size !== selectedCarrierIds.length
  ) {
    throw new TypeError(
      "selectedCarrierIds must be a nonempty unique string array",
    );
  }
}

function requiredCarrierIds(priorCarriers, selected, digestValid) {
  if (!digestValid) {
    return new Set();
  }
  const required = new Set(selected);
  for (const id of selected) {
    for (
      const witnessId of
      priorCarriers.get(id)?.preservationWitnessIds ?? []
    ) {
      required.add(witnessId);
    }
  }
  return required;
}

function compareRepository(prior, current, driftRecords) {
  if (canonicalJson(prior) !== canonicalJson(current)) {
    driftRecords.push(
      drift("repository", "identity", prior, current),
    );
  }
}

function compareCarriers(
  required,
  priorCarriers,
  currentCarriers,
  driftRecords,
) {
  for (const id of [...required].sort(compare)) {
    const before = priorCarriers.get(id);
    const after = currentCarriers.get(id);
    if (!before || !after) {
      driftRecords.push(drift(
        id,
        "carrier",
        before ? "present" : null,
        after ? "present" : null,
        "carrier-missing",
      ));
      continue;
    }
    const beforeSnapshot = carrierSnapshot(before);
    const afterSnapshot = carrierSnapshot(after);
    for (const field of Object.keys(beforeSnapshot)) {
      if (
        canonicalJson(beforeSnapshot[field]) !==
        canonicalJson(afterSnapshot[field])
      ) {
        driftRecords.push(drift(
          id,
          field,
          beforeSnapshot[field],
          afterSnapshot[field],
        ));
      }
    }
  }
}

function validateCurrentSelection(
  currentCarriers,
  selected,
  driftRecords,
) {
  const lastCopy = validateLastCopyBatch(
    [...currentCarriers.values()],
    selected,
  );
  if (!lastCopy.valid) {
    driftRecords.push(drift(
      "selection",
      "preservation",
      "complete",
      "incomplete",
      "last-copy-drift",
    ));
  }
  for (const id of selected) {
    const carrier = currentCarriers.get(id);
    if (
      carrier &&
      (!carrier.eligible || !DESTRUCTIVE.has(carrier.action))
    ) {
      driftRecords.push(drift(
        id,
        "eligible",
        true,
        carrier.eligible,
        "carrier-ineligible",
      ));
    }
  }
}

export async function revalidateRepository(
  repoPath,
  prior,
  selectedCarrierIds,
  options = {},
) {
  validatePrior(prior, selectedCarrierIds);
  const expectedPriorDigest = digestResult(prior);
  const priorDigestValid = prior.runId === expectedPriorDigest;
  const current = await analyzeRepository(repoPath, {
    scope: prior.request.scope,
    depth: prior.request.depth,
    includeIgnored: prior.request.includeIgnored,
    limits: prior.request.limits,
    ...options,
  });
  const priorCarriers = new Map(
    allCarriers(prior.workItems).map((carrier) => [carrier.id, carrier]),
  );
  const currentCarriers = new Map(
    allCarriers(current.workItems).map((carrier) => [carrier.id, carrier]),
  );
  const selected = [...selectedCarrierIds].sort(compare);
  const required = requiredCarrierIds(
    priorCarriers,
    selected,
    priorDigestValid,
  );
  const driftRecords = [];
  if (!priorDigestValid) {
    driftRecords.push(drift(
      "analysis",
      "runId",
      expectedPriorDigest,
      prior.runId,
      "prior-run-id-mismatch",
    ));
  }
  compareRepository(
    prior.repository,
    current.repository,
    driftRecords,
  );
  compareCarriers(
    required,
    priorCarriers,
    currentCarriers,
    driftRecords,
  );
  validateCurrentSelection(currentCarriers, selected, driftRecords);
  driftRecords.sort(
    (left, right) =>
      compare(left.subjectId, right.subjectId) ||
      compare(left.field, right.field),
  );

  const actionPlan = driftRecords.length === 0
    ? {
      basedOnRunId: prior.runId,
      selectedCarrierIds: selected,
      revalidatedAt: new Date().toISOString(),
      authorized: false,
      steps: selected.map(
        (id) => planStep(currentCarriers.get(id)),
      ).sort(sortSteps),
    }
    : null;
  return {
    ...current,
    operation: "revalidate",
    actionPlan,
    drift: driftRecords,
  };
}

async function readBoundedStdin(maxBytes = 20 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > maxBytes) {
      throw new RangeError("stdin exceeds the 20 MiB limit");
    }
    chunks.push(chunk);
  }
  if (size === 0) {
    throw new TypeError("revalidate requires JSON stdin");
  }
  const text = new TextDecoder("utf-8", { fatal: true })
    .decode(Buffer.concat(chunks));
  return JSON.parse(text);
}

export async function main(
  argv = process.argv.slice(2),
  cwd = process.cwd(),
) {
  const parsed = parseArguments(argv);
  let result;
  if (parsed.operation === "analyze") {
    result = await analyzeRepository(cwd, parsed);
  } else {
    const input = await readBoundedStdin();
    if (!exactKeys(input, ["result", "selectedCarrierIds"])) {
      throw new TypeError(
        "revalidate stdin must contain only result and selectedCarrierIds",
      );
    }
    result = await revalidateRepository(
      cwd,
      input.result,
      input.selectedCarrierIds,
    );
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result;
}

function sanitizeError(error) {
  return String(error?.message ?? "analysis failed")
    .replace(
      /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu,
      " ",
    )
    .replace(/\s+/gu, " ")
    .slice(0, 500)
    .trim();
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const message = sanitizeError(error);
    process.stderr.write(
      `git-tidy: ${message || "analysis failed"}\n`,
    );
    process.exitCode = 2;
  });
}
