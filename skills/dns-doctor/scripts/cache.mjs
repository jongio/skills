#!/usr/bin/env node

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  cachePathForDomain,
  loadBaseline,
  loadSnapshotFile,
  normalizeDomain,
  saveBaseline,
} from "./cache-store.mjs";
import { classifyDelta } from "./cache-delta.mjs";

function parseArguments(argv) {
  const [command, ...rest] = argv;
  const options = {};
  const supported = new Set(["domain", "input", "cache-root"]);
  for (let index = 0; index < rest.length; index++) {
    const token = rest[index];
    if (!token.startsWith("--")) throw new Error(`unexpected argument: ${token}`);
    const name = token.slice(2);
    if (!supported.has(name)) throw new Error(`unsupported option: --${name}`);
    if (name in options) throw new Error(`duplicate option: --${name}`);
    const value = rest[++index];
    if (!value || value.startsWith("--")) throw new Error(`missing value for --${name}`);
    options[name] = value;
  }
  return { command, options };
}

export async function main(argv = process.argv.slice(2)) {
  const { command, options } = parseArguments(argv);
  if (!options.domain) throw new Error("--domain is required");
  if ((command === "normalize" || command === "path" || command === "load") && options.input) {
    throw new Error(`--input is not supported by ${command}`);
  }
  // Directs every read and write at an explicit root instead of the operating
  // system cache location. Evaluations and tests need this to stay hermetic:
  // without it, a run writes a real baseline into the user's cache directory.
  const cacheOptions = options["cache-root"] ? { cacheRoot: options["cache-root"] } : {};
  // Exposes the same validation the cache engine enforces, so an agent never
  // has to hand-roll hostname checks in shell. A separate implementation would
  // drift from this one, and on Windows it would otherwise need Python for
  // UTS 46, which the platform does not ship.
  if (command === "normalize") {
    return { domain: normalizeDomain(options.domain) };
  }
  if (command === "path") {
    return {
      domain: normalizeDomain(options.domain),
      path: cachePathForDomain(options.domain, cacheOptions),
    };
  }
  if (command === "load") return loadBaseline(options.domain, cacheOptions);
  if (command === "compare") {
    if (!options.input) throw new Error("--input is required");
    const loaded = await loadBaseline(options.domain, cacheOptions);
    if (loaded.status !== "found") return loaded;
    const current = await loadSnapshotFile(options.input, options.domain);
    return {
      status: "compared",
      path: loaded.path,
      delta: classifyDelta(loaded.baseline, current),
    };
  }
  if (command === "save") {
    if (!options.input) throw new Error("--input is required");
    return saveBaseline(
      options.domain,
      await loadSnapshotFile(options.input, options.domain),
      cacheOptions,
    );
  }
  throw new Error("command must be one of: normalize, path, load, compare, save");
}

const isDirect = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isDirect) {
  main()
    .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`${JSON.stringify({ status: "error", error: error.message })}\n`);
      process.exitCode = 1;
    });
}
