import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const marker = "// Managed by diff.";
const defaultEntry = fileURLToPath(new URL("../runtime/extension.mjs", import.meta.url));

function assertSafeDestination(home, file) {
  let current = resolve(home);
  const rootStat = existsSync(current) ? lstatSync(current) : null;
  if (rootStat?.isSymbolicLink()) {
    throw new Error("Refusing symlinked COPILOT_HOME directory");
  }
  for (const component of ["extensions", "diff", "extension.mjs"]) {
    current = join(current, component);
    let entry;
    try {
      entry = lstatSync(current);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (entry?.isSymbolicLink()) {
      throw new Error("Refusing symlinked loader destination");
    }
  }
  if (!file.startsWith(resolve(home) + sep)) {
    throw new Error("Invalid loader destination");
  }
}

export function findInstalledPluginDiffExtension(home) {
  const pluginsRoot = join(resolve(home), "installed-plugins");
  let rootStat;
  try {
    rootStat = lstatSync(pluginsRoot);
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return null;

  function scanDir(dir, depth) {
    if (depth > 3) return null;
    const candidate = join(dir, "com.github.copilot", "extensions", "diff", "extension.mjs");
    try {
      const stat = lstatSync(candidate);
      if (stat.isFile() && !stat.isSymbolicLink()) {
        return candidate;
      }
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }

    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name === "node_modules" || entry.name.startsWith(".")) {
        continue;
      }
      const found = scanDir(join(dir, entry.name), depth + 1);
      if (found) return found;
    }
    return null;
  }

  return scanDir(pluginsRoot, 0);
}

export function planSetup({
  home = process.env.COPILOT_HOME || join(homedir(), ".copilot"),
  entry = defaultEntry,
} = {}) {
  const resolvedHome = resolve(home);
  const resolvedEntry = resolve(entry);
  const file = join(resolvedHome, "extensions", "diff", "extension.mjs");
  assertSafeDestination(resolvedHome, file);

  const pluginExtension = findInstalledPluginDiffExtension(resolvedHome);
  const before = existsSync(file) ? readFileSync(file, "utf8") : null;
  if (before !== null && !before.startsWith(`${marker}\n`)) {
    throw new Error("Existing loader is not managed by this skill; preserve it");
  }

  if (pluginExtension) {
    const hash = createHash("sha256")
      .update(file)
      .update("\0")
      .update(before ?? "<absent>")
      .update("\0")
      .update(`plugin:${pluginExtension}`)
      .digest("hex");
    return {
      home: resolvedHome,
      entry: resolvedEntry,
      file,
      pluginManaged: true,
      pluginFile: pluginExtension,
      content: null,
      hash,
      unchanged: before === null,
    };
  }

  if (!existsSync(resolvedEntry) || !lstatSync(resolvedEntry).isFile()) {
    throw new Error("Installed runtime is missing; reinstall the diff skill");
  }
  const content = `${marker}\nawait import(${JSON.stringify(pathToFileURL(resolvedEntry).href)});\n`;
  const hash = createHash("sha256")
    .update(file)
    .update("\0")
    .update(before ?? "<absent>")
    .update("\0")
    .update(content)
    .digest("hex");
  return {
    home: resolvedHome,
    entry: resolvedEntry,
    file,
    pluginManaged: false,
    pluginFile: null,
    content,
    hash,
    unchanged: before === content,
  };
}

export function applySetup(plan, approval = plan?.hash) {
  if (!plan || typeof approval !== "string" || approval !== plan.hash) {
    throw new Error("Exact preview hash approval required");
  }
  const current = planSetup({ home: plan.home, entry: plan.entry });
  if (
    current.hash !== plan.hash ||
    current.file !== plan.file ||
    current.content !== plan.content ||
    current.pluginManaged !== plan.pluginManaged
  ) {
    throw new Error("Stale setup preview; preview again");
  }

  if (current.pluginManaged) {
    if (existsSync(current.file)) {
      unlinkSync(current.file);
      return {
        applied: true,
        removedStandaloneLoader: true,
        pluginManaged: true,
        pluginFile: current.pluginFile,
        file: current.file,
      };
    }
    return {
      applied: false,
      unchanged: true,
      pluginManaged: true,
      pluginFile: current.pluginFile,
      file: current.file,
    };
  }

  if (current.unchanged) {
    return { applied: false, unchanged: true, pluginManaged: false, file: current.file };
  }
  const dir = dirname(current.file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    try { chmodSync(dir, 0o700); } catch {}
  }
  const temp = `${current.file}.${randomBytes(8).toString("hex")}.tmp`;
  writeFileSync(temp, current.content, { flag: "wx", mode: 0o600 });
  try {
    if (process.platform !== "win32") {
      try { chmodSync(temp, 0o600); } catch {}
    }
    renameSync(temp, current.file);
  } catch (error) {
    try { unlinkSync(temp); } catch {}
    throw error;
  }
  return { applied: true, pluginManaged: false, file: current.file };
}

function isDirectEntryModule(metaUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  const selfPath = fileURLToPath(metaUrl);
  try {
    return realpathSync.native(argv1) === realpathSync.native(selfPath);
  } catch {
    return resolve(argv1) === resolve(selfPath);
  }
}

if (isDirectEntryModule(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (
      args.length > 0 &&
      !(args.length === 1 && args[0] === "--dry-run") &&
      !(args.length === 2 && args[0] === "--approve")
    ) {
      throw new Error("Usage: node scripts/setup.mjs [--dry-run | --approve <hash>]");
    }
    const plan = planSetup();
    const out =
      args.length === 0
        ? applySetup(plan, plan.hash)
        : args[0] === "--approve"
          ? applySetup(plan, args[1])
          : {
              applied: false,
              pluginManaged: plan.pluginManaged,
              pluginFile: plan.pluginFile,
              file: plan.file,
              runtime: plan.entry,
              hash: plan.hash,
              unchanged: plan.unchanged,
            };
    console.log(JSON.stringify(out, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
