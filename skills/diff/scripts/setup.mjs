import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
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

export function planSetup({
  home = process.env.COPILOT_HOME || join(homedir(), ".copilot"),
  entry = defaultEntry,
} = {}) {
  const resolvedHome = resolve(home);
  const resolvedEntry = resolve(entry);
  const file = join(resolvedHome, "extensions", "diff", "extension.mjs");
  assertSafeDestination(resolvedHome, file);
  if (!existsSync(resolvedEntry) || !lstatSync(resolvedEntry).isFile()) {
    throw new Error("Installed runtime is missing; reinstall the diff skill");
  }
  const before = existsSync(file) ? readFileSync(file, "utf8") : null;
  if (before !== null && !before.startsWith(`${marker}\n`)) {
    throw new Error("Existing loader is not managed by this skill; preserve it");
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
    content,
    hash,
    unchanged: before === content,
  };
}

export function applySetup(plan, approval) {
  if (typeof approval !== "string" || approval !== plan.hash) {
    throw new Error("Exact preview hash approval required");
  }
  const current = planSetup({ home: plan.home, entry: plan.entry });
  if (
    current.hash !== plan.hash ||
    current.file !== plan.file ||
    current.content !== plan.content
  ) {
    throw new Error("Stale setup preview; preview again");
  }
  if (current.unchanged) {
    return { applied: false, unchanged: true, file: current.file };
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
  return { applied: true, file: current.file };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (
      args.length &&
      !(args.length === 1 && args[0] === "--dry-run") &&
      !(args.length === 2 && args[0] === "--approve")
    ) {
      throw new Error("Usage: node scripts/setup.mjs --dry-run | --approve <hash>");
    }
    const plan = planSetup();
    const out =
      args[0] === "--approve"
        ? applySetup(plan, args[1])
        : {
            applied: false,
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
