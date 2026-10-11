#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import path from "node:path";

import { verifyRemoteBaseline } from "./lib/remote-verification.mjs";

const MAX_INPUT_BYTES = 16 * 1024;

async function readInput(stream) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_INPUT_BYTES) {
      throw new RangeError("stdin exceeds the 16 KiB limit");
    }
    chunks.push(bytes);
  }
  if (size === 0) throw new TypeError("verify-remote requires JSON stdin");
  const value = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
  );
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1 ||
    !Object.hasOwn(value, "remoteUrl")
  ) {
    throw new TypeError("stdin must contain exactly remoteUrl");
  }
  return value;
}

export async function main({
  input = process.stdin,
  output = process.stdout,
} = {}) {
  const { remoteUrl } = await readInput(input);
  const baseline = await verifyRemoteBaseline(remoteUrl);
  output.write(`${JSON.stringify(baseline)}\n`);
  return baseline;
}

function sanitizeError(error) {
  return String(error?.message ?? "remote verification failed")
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
    .replace(/\s+/gu, " ")
    .slice(0, 500)
    .trim();
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(
      `git-tidy verify-remote: ${sanitizeError(error)}\n`,
    );
    process.exitCode = 2;
  });
}
