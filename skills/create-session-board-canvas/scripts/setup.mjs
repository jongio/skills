import { createHash, randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const marker = "// Managed by create-session-board-canvas.";
const defaultEntry = fileURLToPath(new URL("../runtime/extension.mjs", import.meta.url));

function assertSafeDestination(home, file) {
  let current = resolve(home);
  for (const component of ["extensions", "session-progress", "extension.mjs"]) {
    current = join(current, component);
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error("Refusing symlinked loader destination");
  }
  if (!file.startsWith(resolve(home) + sep)) throw new Error("Invalid loader destination");
}

export function planSetup({ home = process.env.COPILOT_HOME || join(homedir(), ".copilot"), entry = defaultEntry } = {}) {
  const file = join(resolve(home), "extensions", "session-progress", "extension.mjs");
  assertSafeDestination(home, file);
  if (!existsSync(entry) || !lstatSync(entry).isFile()) throw new Error("Installed runtime is missing; reinstall the skill");
  const before = existsSync(file) ? readFileSync(file, "utf8") : null;
  if (before && !before.startsWith(`${marker}\n`)) throw new Error("Existing loader is not managed by this skill; preserve it");
  const content = `${marker}\nawait import(${JSON.stringify(pathToFileURL(resolve(entry)).href)});\n`;
  const hash = createHash("sha256").update(file).update("\0").update(before ?? "<absent>").update("\0").update(content).digest("hex");
  return { home: resolve(home), entry: resolve(entry), file, content, hash, unchanged: before === content };
}

export function applySetup(plan, approval) {
  if (approval !== plan.hash) throw new Error("Exact preview hash approval required");
  const current = planSetup({ home: plan.home, entry: plan.entry });
  if (current.hash !== plan.hash || current.file !== plan.file || current.content !== plan.content) throw new Error("Stale setup preview; preview again");
  if (current.unchanged) return { applied: false, unchanged: true, file: current.file };
  mkdirSync(dirname(current.file), { recursive: true });
  const temp = `${current.file}.${randomBytes(8).toString("hex")}.tmp`;
  writeFileSync(temp, current.content, { flag: "wx" });
  try { renameSync(temp, current.file); }
  catch (error) { unlinkSync(temp); throw error; }
  return { applied: true, file: current.file };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length && !(args.length === 1 && args[0] === "--dry-run") &&
        !(args.length === 2 && args[0] === "--approve")) throw new Error("Usage: node scripts\\setup.mjs --dry-run | --approve <hash>");
    const plan = planSetup();
    console.log(JSON.stringify(args[0] === "--approve" ? applySetup(plan, args[1]) :
      { applied: false, file: plan.file, runtime: defaultEntry, hash: plan.hash, unchanged: plan.unchanged }, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
