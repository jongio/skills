import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
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
      ["gemini", ["extensions", "install", `https://github.com/${repoSlug}`, "--consent"]],
    ],
  },
]);

const SUPPORTED_PLATFORMS = new Set(PLATFORM_TARGETS.map((target) => target.id));

const DIRECT_SHARED_AGENTS_CONSUMERS = Object.freeze([
  [".codex"],
  [".amp"],
  [".config", "amp"],
]);

const OTHER_CONSUMER_SKILL_DIRS = Object.freeze([
  [".codex", "skills"],
  [".cursor", "skills"],
  [".codeium", "windsurf", "skills"],
  [".cline", "skills"],
  [".roo", "skills"],
  [".config", "goose", "skills"],
  [".config", "opencode", "skills"],
]);

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
    cleanShared: false,
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
    } else if (arg === "--clean-shared") {
      options.cleanShared = true;
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

function normalizeLf(text) {
  return String(text ?? "").replaceAll("\r\n", "\n").trim();
}

function isExactRepoSourceUrl(sourceUrl, repoSlug) {
  if (typeof sourceUrl !== "string") return false;
  const normalized = sourceUrl
    .trim()
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
    .toLowerCase();
  const expectedSlug = repoSlug.toLowerCase();
  return (
    normalized === `https://github.com/${expectedSlug}` ||
    normalized === `ssh://git@github.com/${expectedSlug}` ||
    normalized === `git@github.com:${expectedSlug}`
  );
}

function hasPositiveJongioProvenance({
  kind,
  candidateDir,
  agentsSkillsDir,
  skillName,
  resolvedRepoRoot,
  canonicalSet,
  lockOwnedNames,
  foreignOwnedNames,
}) {
  if (foreignOwnedNames.has(skillName)) return false;

  // .agents/.skill-lock.json only establishes provenance for ~/.agents/skills/<name>
  // or symlinks pointing into ~/.agents/skills/<name>, never an independent hand-written
  // directory in ~/.claude/skills or ~/.copilot/skills.
  if (lockOwnedNames.has(skillName)) {
    if (kind === "agents") return true;
    try {
      const stat = lstatSync(candidateDir);
      if (stat.isSymbolicLink() && realpathSync(candidateDir).startsWith(agentsSkillsDir)) {
        return true;
      }
    } catch {
      // Fall through to canonical SKILL.md byte/normalized content check
    }
  }

  if (!canonicalSet.has(skillName)) return false;

  const candidateSkillMd = join(candidateDir, "SKILL.md");
  const canonicalSkillMd = join(resolvedRepoRoot, "skills", skillName, "SKILL.md");
  if (!existsSync(candidateSkillMd) || !existsSync(canonicalSkillMd)) return false;

  try {
    const candidateContent = normalizeLf(readFileSync(candidateSkillMd, "utf8"));
    const canonicalContent = normalizeLf(readFileSync(canonicalSkillMd, "utf8"));
    return candidateContent === canonicalContent;
  } catch {
    return false;
  }
}

function isSharedAgentSkillReferencedElsewhere(
  agentSkillPath,
  resolvedHome,
  activeCleanupPlatforms,
  cleanShared,
) {
  if (cleanShared) return false;

  // Preserve ~/.agents/skills entries when a direct shared-root consumer (such as Codex)
  // is present on the machine unless explicit --clean-shared / --clean-only consent is given.
  for (const segments of DIRECT_SHARED_AGENTS_CONSUMERS) {
    if (existsSync(join(resolvedHome, ...segments))) {
      return true;
    }
  }

  let targetRealPath;
  try {
    targetRealPath = realpathSync(agentSkillPath);
  } catch {
    return false;
  }

  const consumerRoots = [...OTHER_CONSUMER_SKILL_DIRS.map((segments) => join(resolvedHome, ...segments))];
  if (!activeCleanupPlatforms.has("claude")) {
    consumerRoots.push(join(resolvedHome, ".claude", "skills"));
  }
  if (!activeCleanupPlatforms.has("copilot")) {
    consumerRoots.push(join(resolvedHome, ".copilot", "skills"));
  }
  if (!activeCleanupPlatforms.has("gemini")) {
    consumerRoots.push(join(resolvedHome, ".gemini", "skills"));
  }

  const skillName = dirname(agentSkillPath) ? agentSkillPath.slice(dirname(agentSkillPath).length + 1) : "";
  for (const root of consumerRoots) {
    const candidate = join(root, skillName);
    try {
      const stat = lstatSync(candidate);
      if (stat.isSymbolicLink() && realpathSync(candidate) === targetRealPath) {
        return true;
      }
    } catch {
      // Ignore missing or broken links
    }
  }
  return false;
}

export function planPluginInstall(options = {}) {
  const {
    repoRoot = REPO_ROOT,
    repoSlug = REPO_SLUG,
    platforms = null,
    cleanOnly = false,
    cleanShared = false,
    availableClis = null,
  } = options;

  const explicitHome = options.home !== undefined;
  const resolvedHome = resolve(options.home ?? homedir());
  const resolvedCopilotHome = resolve(
    options.copilotHome ??
      (explicitHome
        ? join(resolvedHome, ".copilot")
        : process.env.COPILOT_HOME || join(resolvedHome, ".copilot")),
  );
  const resolvedRepoRoot = resolve(repoRoot);
  const canonicalSkills = discoverCanonicalSkills(resolvedRepoRoot);
  const canonicalSet = new Set(canonicalSkills);
  const platformFilter = platforms && platforms.length > 0 ? new Set(platforms) : null;
  const detectedClis = availableClis ?? detectAvailableClis();

  // 1. Plan native plugin installs for each detected & selected platform CLI first
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

  // Only clean raw skill folders for platforms that are actively being migrated (or selected in --clean-only)
  const activeCleanupPlatforms = cleanOnly
    ? platformFilter ?? new Set(SUPPORTED_PLATFORMS)
    : new Set(pluginActions.map((action) => action.platform));

  const lockPath = join(resolvedHome, ".agents", ".skill-lock.json");
  const lockOwnedNames = new Set();
  const foreignOwnedNames = new Set();
  if (existsSync(lockPath)) {
    try {
      const parsed = JSON.parse(readFileSync(lockPath, "utf8"));
      if (parsed && typeof parsed.skills === "object" && parsed.skills !== null) {
        for (const [key, entry] of Object.entries(parsed.skills)) {
          const sourceMatches = entry?.source === repoSlug;
          const urlMatches = isExactRepoSourceUrl(entry?.sourceUrl, repoSlug);
          const hasExplicitDifferentSource =
            (typeof entry?.source === "string" && entry.source !== repoSlug) ||
            (typeof entry?.sourceUrl === "string" && !urlMatches);
          if (hasExplicitDifferentSource) {
            foreignOwnedNames.add(key);
          } else if (sourceMatches || urlMatches) {
            lockOwnedNames.add(key);
          }
        }
      }
    } catch {
      // Unreadable lockfile does not grant deletion provenance
    }
  }

  const cleanupPaths = [];
  const preservedAgentSkills = new Set();

  // Platform-specific raw skill roots
  const scopedRoots = [];
  if (activeCleanupPlatforms.has("copilot")) {
    scopedRoots.push({ kind: "copilot", path: join(resolvedCopilotHome, "skills") });
  }
  if (activeCleanupPlatforms.has("claude")) {
    scopedRoots.push({ kind: "claude", path: join(resolvedHome, ".claude", "skills") });
  }
  if (activeCleanupPlatforms.has("copilot")) {
    scopedRoots.push({ kind: "agents", path: join(resolvedHome, ".agents", "skills") });
  }

  const agentsSkillsDir = join(resolvedHome, ".agents", "skills");
  for (const { kind, path: rawRoot } of scopedRoots) {
    if (!existsSync(rawRoot)) continue;
    for (const entry of readdirSync(rawRoot, { withFileTypes: true })) {
      const candidatePath = join(rawRoot, entry.name);
      if (
        !hasPositiveJongioProvenance({
          kind,
          candidateDir: candidatePath,
          agentsSkillsDir,
          skillName: entry.name,
          resolvedRepoRoot,
          canonicalSet,
          lockOwnedNames,
          foreignOwnedNames,
        })
      ) {
        continue;
      }
      if (
        kind === "agents" &&
        isSharedAgentSkillReferencedElsewhere(
          candidatePath,
          resolvedHome,
          activeCleanupPlatforms,
          cleanOnly || cleanShared,
        )
      ) {
        preservedAgentSkills.add(entry.name);
        continue;
      }
      cleanupPaths.push(candidatePath);
    }
  }

  // Only prune lockfile entries when .agents/skills is in scope and the entry is not still needed
  const lockPrunedKeys = activeCleanupPlatforms.has("copilot")
    ? [...lockOwnedNames].filter((key) => !preservedAgentSkills.has(key))
    : [];

  // Also check for a stale _direct/skills copy of jongio-skills in Copilot CLI when copilot is in scope
  if (activeCleanupPlatforms.has("copilot")) {
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
  }

  return {
    home: resolvedHome,
    copilotHome: resolvedCopilotHome,
    repoRoot: resolvedRepoRoot,
    repoSlug,
    cleanOnly,
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

  if (!plan.cleanOnly && plan.pluginActions.length === 0) {
    throw new Error(
      "No target platform CLIs detected or selected; install copilot, claude, or gemini CLI first, or pass --clean-only to remove conflicting raw skills.",
    );
  }

  // Run native plugin installations FIRST so a failed install never leaves existing skills deleted
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

  // Only clean conflicting raw skill paths and lock entries after native plugin installs succeed
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

  return {
    dryRun: false,
    ...plan,
    commandResults,
  };
}

function formatSummary(result) {
  const modeLabel = result.dryRun ? "[DRY RUN] " : "";
  const lines = [`${modeLabel}jongio/skills plugin installer`];

  if (result.pluginActions.length > 0) {
    lines.push("\nPlatform plugin installs:");
    for (const action of result.pluginActions) {
      lines.push(`  - ${action.label}: ${action.commands.map(([c, a]) => `${c} ${a.join(" ")}`).join(" && ")}`);
    }
  } else {
    lines.push("\nNo target platform CLIs selected or detected.");
  }

  if (result.cleanupPaths.length > 0) {
    lines.push(`\nRemoved conflicting raw skill paths (${result.cleanupPaths.length}):`);
    for (const item of result.cleanupPaths) lines.push(`  - ${item}`);
  } else {
    lines.push("\nNo conflicting raw skill paths in ~/.agents/skills, ~/.copilot/skills, or ~/.claude/skills.");
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
        "Installs the jongio-skills plugin across detected coding agent CLIs (copilot, claude, gemini)",
        "and cleans conflicting raw global skill copies (~/.agents/skills, ~/.copilot/skills, ~/.claude/skills).",
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
    cleanShared: parsed.cleanShared,
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
