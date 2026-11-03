import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const REPO_SLUG = "jongio/skills";
const PLUGIN_SPEC = "jongio-skills@jongio-skills";

export const PLATFORM_TARGETS = Object.freeze([
  {
    id: "copilot",
    cli: "copilot",
    label: "GitHub Copilot CLI",
    commands: (repoSlug) => [
      ["copilot", ["plugin", "marketplace", "add", repoSlug]],
      ["copilot", ["plugin", "install", PLUGIN_SPEC]],
    ],
  },
  {
    id: "claude",
    cli: "claude",
    label: "Claude Code",
    commands: (repoSlug) => [
      ["claude", ["plugin", "marketplace", "add", repoSlug]],
      ["claude", ["plugin", "install", PLUGIN_SPEC]],
    ],
  },
  {
    id: "gemini",
    cli: "gemini",
    label: "Gemini CLI",
    commands: (repoSlug) => [
      ["gemini", ["extensions", "install", `https://github.com/${repoSlug}`]],
    ],
  },
]);

const SUPPORTED_PLATFORMS = new Set(PLATFORM_TARGETS.map((target) => target.id));

function atomicWriteText(filePath, content) {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpPath, content, "utf8");
  try {
    renameSync(tmpPath, filePath);
  } catch (error) {
    if (error?.code === "EPERM" || error?.code === "EACCES") {
      writeFileSync(filePath, content, "utf8");
      return;
    }
    throw error;
  } finally {
    rmSync(tmpPath, { force: true });
  }
}

export function discoverCanonicalSkills(repoRoot = REPO_ROOT) {
  const skillsRoot = join(resolve(repoRoot), "skills");
  if (!existsSync(skillsRoot)) return [];
  return readdirSync(skillsRoot, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        SKILL_NAME_RE.test(entry.name) &&
        existsSync(join(skillsRoot, entry.name, "SKILL.md")),
    )
    .map((entry) => entry.name)
    .sort();
}

function splitListValues(raw, flagName) {
  const items = String(raw ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (items.length === 0) {
    throw new Error(`Missing value for ${flagName}`);
  }
  return items;
}

export function parseInstallPluginArgs(argv = []) {
  const options = {
    cleanOnly: false,
    dryRun: false,
    help: false,
    json: false,
    platforms: [],
  };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--clean-only") {
      options.cleanOnly = true;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (
      arg === "--platform" ||
      arg.startsWith("--platform=") ||
      arg === "--agent" ||
      arg.startsWith("--agent=")
    ) {
      const flag = arg.startsWith("--platform") ? "--platform" : "--agent";
      const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : argv[++index];
      for (const platform of splitListValues(value, flag)) {
        if (!SUPPORTED_PLATFORMS.has(platform)) {
          throw new Error(
            `Unsupported platform: ${platform}. Supported: ${[...SUPPORTED_PLATFORMS].join(", ")}`,
          );
        }
        if (!options.platforms.includes(platform)) options.platforms.push(platform);
      }
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
}

export function detectAvailableClis(candidates = PLATFORM_TARGETS.map((target) => target.cli)) {
  const detected = new Set();
  const locator = process.platform === "win32" ? "where.exe" : "which";
  for (const cli of candidates) {
    const res = spawnSync(locator, [cli], { stdio: "ignore", windowsHide: true });
    if (res.status === 0) {
      detected.add(cli);
    }
  }
  return detected;
}

function defaultCommandRunner(cmd, args) {
  const result = spawnSync(cmd, args, {
    encoding: "utf8",
    windowsHide: true,
    shell: process.platform === "win32",
  });
  return {
    status: result.status ?? 1,
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
  };
}

export function planPluginInstall({
  home = homedir(),
  copilotHome = process.env.COPILOT_HOME || join(home, ".copilot"),
  repoRoot = REPO_ROOT,
  repoSlug = REPO_SLUG,
  platforms = null,
  cleanOnly = false,
  availableClis = null,
} = {}) {
  const resolvedHome = resolve(home);
  const resolvedCopilotHome = resolve(copilotHome);
  const canonicalSkills = discoverCanonicalSkills(repoRoot);
  const canonicalSet = new Set(canonicalSkills);
  const platformFilter = platforms && platforms.length > 0 ? new Set(platforms) : null;
  const detectedClis = availableClis ?? detectAvailableClis();

  // 1. Identify raw global skill folders that shadow installed plugins or collide with built-in /pr
  const rawRoots = [
    join(resolvedHome, ".agents", "skills"),
    join(resolvedCopilotHome, "skills"),
    join(resolvedHome, ".claude", "skills"),
  ];
  const lockPath = join(resolvedHome, ".agents", ".skill-lock.json");
  const lockOwnedNames = new Set();
  const foreignOwnedNames = new Set();
  const lockPrunedKeys = [];
  if (existsSync(lockPath)) {
    try {
      const parsed = JSON.parse(readFileSync(lockPath, "utf8"));
      if (parsed && typeof parsed.skills === "object" && parsed.skills !== null) {
        for (const [key, entry] of Object.entries(parsed.skills)) {
          if (entry?.source === repoSlug || (canonicalSet.has(key) && !entry?.source)) {
            lockOwnedNames.add(key);
            lockPrunedKeys.push(key);
          } else if (entry?.source && entry.source !== repoSlug) {
            foreignOwnedNames.add(key);
          }
        }
      }
    } catch {
      // Ignore unreadable lockfile during scan
    }
  }

  const cleanupPaths = [];
  for (const rawRoot of rawRoots) {
    if (!existsSync(rawRoot)) continue;
    for (const entry of readdirSync(rawRoot, { withFileTypes: true })) {
      if (foreignOwnedNames.has(entry.name)) continue;
      if (canonicalSet.has(entry.name) || lockOwnedNames.has(entry.name)) {
        cleanupPaths.push(join(rawRoot, entry.name));
      }
    }
  }

  // Also check for a stale _direct/skills copy of jongio-skills in Copilot CLI
  const staleDirectPlugin = join(resolvedCopilotHome, "installed-plugins", "_direct", "skills");
  const staleDirectManifest = join(staleDirectPlugin, "plugin.json");
  if (existsSync(staleDirectManifest)) {
    try {
      const manifest = JSON.parse(readFileSync(staleDirectManifest, "utf8"));
      if (manifest?.name === "jongio-skills") {
        cleanupPaths.push(staleDirectPlugin);
      }
    } catch {
      // Ignore unreadable manifest
    }
  }

  // 2. Plan native plugin installs for each detected platform CLI
  const pluginActions = [];
  if (!cleanOnly) {
    for (const target of PLATFORM_TARGETS) {
      if (platformFilter && !platformFilter.has(target.id)) continue;
      if (!detectedClis.has(target.cli)) continue;
      pluginActions.push({
        platform: target.id,
        label: target.label,
        commands: target.commands(repoSlug),
      });
    }
  }

  return {
    home: resolvedHome,
    copilotHome: resolvedCopilotHome,
    repoRoot: resolve(repoRoot),
    repoSlug,
    cleanupPaths,
    lockPath: lockPrunedKeys.length > 0 ? lockPath : null,
    lockPrunedKeys,
    pluginActions,
  };
}

export function applyPluginInstall({
  dryRun = false,
  commandRunner = defaultCommandRunner,
  ...planOptions
} = {}) {
  const plan = planPluginInstall(planOptions);
  if (dryRun) {
    return {
      dryRun: true,
      ...plan,
      commandResults: [],
    };
  }

  for (const targetPath of plan.cleanupPaths) {
    rmSync(targetPath, { recursive: true, force: true });
  }

  if (plan.lockPath && plan.lockPrunedKeys.length > 0 && existsSync(plan.lockPath)) {
    try {
      const parsed = JSON.parse(readFileSync(plan.lockPath, "utf8"));
      if (parsed && typeof parsed.skills === "object" && parsed.skills !== null) {
        for (const key of plan.lockPrunedKeys) {
          delete parsed.skills[key];
        }
        atomicWriteText(plan.lockPath, `${JSON.stringify(parsed, null, 2)}\n`);
      }
    } catch {
      // Best-effort lockfile cleanup
    }
  }

  const commandResults = [];
  for (const action of plan.pluginActions) {
    for (const [cmd, args] of action.commands) {
      const res = commandRunner(cmd, args);
      commandResults.push({
        platform: action.platform,
        command: [cmd, ...args].join(" "),
        status: res.status,
        stdout: res.stdout,
        stderr: res.stderr,
      });
      if (res.status !== 0) {
        throw new Error(
          `Plugin command failed for ${action.platform} (${cmd} ${args.join(" ")}): ${res.stderr || res.stdout || `exit code ${res.status}`}`,
        );
      }
    }
  }

  return {
    dryRun: false,
    ...plan,
    commandResults,
  };
}

function formatSummary(result) {
  const modeLabel = result.dryRun ? "[DRY RUN] " : "";
  const lines = [`${modeLabel}jongio/skills plugin installer`];

  if (result.cleanupPaths.length > 0) {
    lines.push(`\nRemoved conflicting raw skill paths (${result.cleanupPaths.length}):`);
    for (const item of result.cleanupPaths) lines.push(`  - ${item}`);
  } else {
    lines.push("\nNo conflicting raw skill paths in ~/.agents/skills, ~/.copilot/skills, or ~/.claude/skills.");
  }

  if (result.pluginActions.length > 0) {
    lines.push("\nPlatform plugin installs:");
    for (const action of result.pluginActions) {
      lines.push(`  - ${action.label}: ${action.commands.map(([c, a]) => `${c} ${a.join(" ")}`).join(" && ")}`);
    }
  } else {
    lines.push("\nNo target platform CLIs selected or detected.");
  }

  return lines.join("\n");
}

async function main() {
  const parsed = parseInstallPluginArgs(process.argv.slice(2));
  if (parsed.help) {
    console.log(
      [
        "Usage: node scripts/install-plugin.mjs [options]",
        "",
        "Cleans conflicting raw global skill copies (~/.agents/skills, ~/.copilot/skills, ~/.claude/skills)",
        "and installs the jongio-skills plugin across detected coding agent CLIs (copilot, claude, gemini).",
        "",
        "Options:",
        "  --platform <id[,...]> Target specific platform CLI(s): copilot, claude, gemini (alias: --agent)",
        "  --clean-only          Only remove conflicting raw global skill copies",
        "  --dry-run             Preview planned cleanup and native CLI plugin commands without executing",
        "  --json                Emit machine-readable JSON output",
        "  -h, --help            Show this help message",
      ].join("\n"),
    );
    return;
  }

  const result = applyPluginInstall({
    dryRun: parsed.dryRun,
    cleanOnly: parsed.cleanOnly,
    platforms: parsed.platforms.length > 0 ? parsed.platforms : null,
  });

  if (parsed.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatSummary(result));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[install-plugin] ${error.message}`);
    process.exitCode = 1;
  });
}
