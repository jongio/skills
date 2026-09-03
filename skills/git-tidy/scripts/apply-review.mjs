#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  applyReview,
  validateMechanicalResult,
} from "./lib/review-policy.mjs";

export const MAX_INPUT_BYTES = 20 * 1024 * 1024;
const MAX_ERROR_CHARACTERS = 500;

function exactKeys(value, keys) {
  return value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

export function applyReviewPayload(payload) {
  if (!exactKeys(payload, ["result", "review"])) {
    throw new TypeError(
      "stdin must contain exactly result and review",
    );
  }
  const validation = validateMechanicalResult(payload.result);
  if (!validation.valid) {
    return {
      accepted: false,
      result: structuredClone(payload.result),
      diagnostics: validation.diagnostics,
    };
  }
  return applyReview(payload.result, payload.review);
}

export async function readBoundedJson(
  stream,
  maxBytes = MAX_INPUT_BYTES,
) {
  if (
    !stream ||
    typeof stream[Symbol.asyncIterator] !== "function"
  ) {
    throw new TypeError("stdin must be an async byte stream");
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError("input limit must be a nonnegative safe integer");
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > maxBytes) {
      throw new RangeError("stdin exceeds the 20 MiB limit");
    }
    chunks.push(bytes);
  }
  if (size === 0) {
    throw new TypeError("apply-review requires JSON stdin");
  }

  const text = new TextDecoder("utf-8", { fatal: true })
    .decode(Buffer.concat(chunks));
  return JSON.parse(text);
}

export async function main({
  input = process.stdin,
  output = process.stdout,
} = {}) {
  const payload = await readBoundedJson(input);
  const applied = applyReviewPayload(payload);
  output.write(`${JSON.stringify(applied)}\n`);
  return applied;
}

function sanitizeError(error) {
  return String(error?.message ?? "review application failed")
    .replace(
      /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu,
      " ",
    )
    .replace(/\s+/gu, " ")
    .slice(0, MAX_ERROR_CHARACTERS)
    .trim();
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const message = sanitizeError(error);
    process.stderr.write(
      `git-tidy apply-review: ${message || "review application failed"}\n`,
    );
    process.exitCode = 2;
  });
}
