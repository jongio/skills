import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  applyPluginInstall,
  discoverCanonicalSkills,
  parseInstallPluginArgs,
  PLATFORM_TARGETS,
} from "../scripts/install-plugin.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function withTempHome(fn) {
  const raw = mkdtempSync(path.join(tmpdir(), "install-plugin-test-"));
  const home = realpathSync.native ? realpathSync.native(raw) : realpathSync(raw);
  const hadCopilotHome = Object.prototype.hasOwnProperty.call(process.env, "COPILOT_HOME");
  const prevCopilotHome = process.env.COPILOT_HOME;
  process.env.COPILOT_HOME = path.join(home, ".copilot");
  try {
    return fn(home);
  } finally {
    if (hadCopilotHome) {
      process.env.COPILOT_HOME = prevCopilotHome;
    } else {
      delete process.env.COPILOT_HOME;
    }
    rmSync(home, { recursive: true, force: true });
  }
}

test("discoverCanonicalSkills lists all canonical repo skills including pr and go", () => {
  const skills = discoverCanonicalSkills(REPO_ROOT);
  assert.ok(skills.includes("pr"), "must include pr");
  assert.ok(skills.includes("go"), "must include go");
  assert.ok(skills.includes("nobs"), "must include nobs");
  assert.ok(skills.length >= 22, `expected at least 22 skills, got ${skills.length}`);
});

test("parseInstallPluginArgs parses flags and repeatable platforms", () => {
  const parsed = parseInstallPluginArgs([
    "--dry-run",
    "--platform",
    "copilot,claude",
    "--agent=gemini",
    "--json",
  ]);
  assert.equal(parsed.dryRun, true);
  assert.equal(parsed.json, true);
  assert.deepEqual(parsed.platforms, ["copilot", "claude", "gemini"]);
});

test("parseInstallPluginArgs rejects unknown flags and unsupported platforms", () => {
  assert.throws(() => parseInstallPluginArgs(["--bogus"]), /Unknown option/);
  assert.throws(() => parseInstallPluginArgs(["--platform", "unknown-cli"]), /Unsupported platform/);
});

test("applyPluginInstall verifies provenance, runs native plugin CLIs first, and removes conflicting raw skill copies", () => {
  withTempHome((home) => {
    const agentsPr = path.join(home, ".agents", "skills", "pr");
    const agentsUnrelated = path.join(home, ".agents", "skills", "microsoft-foundry");
    const copilotGo = path.join(home, ".copilot", "skills", "go");
    const copilotUnrelated = path.join(home, ".copilot", "skills", "azd-app");
    const claudeNobs = path.join(home, ".claude", "skills", "nobs");
    const claudeHandwrittenPr = path.join(home, ".claude", "skills", "pr");
    const claudeUnrelated = path.join(home, ".claude", "skills", "playwright-cli");
    const staleDirect = path.join(home, ".copilot", "installed-plugins", "_direct", "skills");

    for (const dir of [
      agentsPr,
      agentsUnrelated,
      copilotGo,
      copilotUnrelated,
      claudeNobs,
      claudeHandwrittenPr,
      claudeUnrelated,
      staleDirect,
    ]) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        path.join(dir, "SKILL.md"),
        "---\nname: custom\n---\nHand-authored skill mentioning https://github.com/jongio/skills.\n",
      );
    }
    // Give copilotGo and claudeNobs real jongio/skills provenance via canonical SKILL.md content
    writeFileSync(
      path.join(copilotGo, "SKILL.md"),
      readFileSync(path.join(REPO_ROOT, "skills", "go", "SKILL.md"), "utf8"),
    );
    writeFileSync(
      path.join(claudeNobs, "SKILL.md"),
      readFileSync(path.join(REPO_ROOT, "skills", "nobs", "SKILL.md"), "utf8"),
    );
    writeFileSync(path.join(staleDirect, "plugin.json"), JSON.stringify({ name: "jongio-skills", version: "2.0.0" }));

    const lockPath = path.join(home, ".agents", ".skill-lock.json");
    writeFileSync(
      lockPath,
      JSON.stringify(
        {
          version: 3,
          skills: {
            pr: { source: "jongio/skills", sourceType: "github" },
            "custom-jongio": { source: "jongio/skills", sourceType: "github" },
            "microsoft-foundry": { source: "microsoft/azure-skills", sourceType: "github" },
          },
        },
        null,
        2,
      ),
    );

    const calls = [];
    const mockRunner = (cmd, args) => {
      // Verify cleanup has not occurred yet while plugin commands are running
      assert.equal(existsSync(agentsPr), true, "cleanup must be deferred until native plugin commands succeed");
      calls.push([cmd, ...args]);
      return { status: 0, stdout: "ok", stderr: "" };
    };

    const dryResult = applyPluginInstall({
      home,
      repoRoot: REPO_ROOT,
      availableClis: new Set(["copilot", "claude", "gemini"]),
      dryRun: true,
      commandRunner: mockRunner,
    });

    assert.equal(dryResult.dryRun, true);
    assert.equal(calls.length, 0, "dry-run must not execute CLI commands");
    assert.equal(existsSync(agentsPr), true, "dry-run must not delete files");

    applyPluginInstall({
      home,
      repoRoot: REPO_ROOT,
      availableClis: new Set(["copilot", "claude", "gemini"]),
      dryRun: false,
      commandRunner: mockRunner,
    });

    // Provenance-verified jongio/skills removed from raw personal folders
    assert.equal(existsSync(agentsPr), false, "~/.agents/skills/pr must be removed");
    assert.equal(existsSync(copilotGo), false, "~/.copilot/skills/go must be removed");
    assert.equal(existsSync(claudeNobs), false, "~/.claude/skills/nobs must be removed");
    assert.equal(existsSync(staleDirect), false, "stale _direct/skills plugin copy must be removed");

    // Hand-written skill with colliding directory name (even if it mentions jongio/skills) preserved
    assert.equal(existsSync(claudeHandwrittenPr), true, "unverified ~/.claude/skills/pr must be preserved");

    // Unrelated user skills preserved
    assert.equal(existsSync(agentsUnrelated), true, "unrelated ~/.agents/skills/microsoft-foundry must be preserved");
    assert.equal(existsSync(copilotUnrelated), true, "unrelated ~/.copilot/skills/azd-app must be preserved");
    assert.equal(existsSync(claudeUnrelated), true, "unrelated ~/.claude/skills/playwright-cli must be preserved");

    // Lockfile cleaned of jongio/skills entries while keeping microsoft-foundry
    const updatedLock = JSON.parse(readFileSync(lockPath, "utf8"));
    assert.equal(Object.hasOwn(updatedLock.skills, "pr"), false);
    assert.equal(Object.hasOwn(updatedLock.skills, "custom-jongio"), false);
    assert.equal(Object.hasOwn(updatedLock.skills, "microsoft-foundry"), true);

    // Native plugin CLIs invoked for copilot, claude, and gemini (with --consent)
    assert.deepEqual(calls, [
      ["copilot", "plugin", "marketplace", "add", "jongio/skills"],
      ["copilot", "plugin", "install", "jongio-skills@jongio-skills"],
      ["claude", "plugin", "marketplace", "add", "jongio/skills"],
      ["claude", "plugin", "install", "jongio-skills@jongio-skills"],
      ["gemini", "extensions", "install", "https://github.com/jongio/skills", "--consent"],
    ]);
  });
});

test("platform-scoped install only cleans targeted platforms and preserves skills on failure or when no CLI is available", () => {
  withTempHome((home) => {
    const copilotGo = path.join(home, ".copilot", "skills", "go");
    const claudeNobs = path.join(home, ".claude", "skills", "nobs");
    mkdirSync(copilotGo, { recursive: true });
    mkdirSync(claudeNobs, { recursive: true });
    writeFileSync(
      path.join(copilotGo, "SKILL.md"),
      readFileSync(path.join(REPO_ROOT, "skills", "go", "SKILL.md"), "utf8"),
    );
    writeFileSync(
      path.join(claudeNobs, "SKILL.md"),
      readFileSync(path.join(REPO_ROOT, "skills", "nobs", "SKILL.md"), "utf8"),
    );

    // 1. No CLI detected without --clean-only refuses to delete skills
    assert.throws(
      () =>
        applyPluginInstall({
          home,
          repoRoot: REPO_ROOT,
          availableClis: new Set(),
        }),
      /No target platform CLIs detected/,
    );
    assert.equal(existsSync(copilotGo), true);
    assert.equal(existsSync(claudeNobs), true);

    // 2. Failed CLI install leaves existing skills untouched
    assert.throws(
      () =>
        applyPluginInstall({
          home,
          repoRoot: REPO_ROOT,
          platforms: ["copilot"],
          availableClis: new Set(["copilot", "claude"]),
          commandRunner: () => ({ status: 1, stdout: "", stderr: "network error" }),
        }),
      /Plugin command failed/,
    );
    assert.equal(existsSync(copilotGo), true, "failed install must not delete copilot skills");

    // 3. Targeting only --platform copilot cleans copilot but leaves claude untouched
    applyPluginInstall({
      home,
      repoRoot: REPO_ROOT,
      platforms: ["copilot"],
      availableClis: new Set(["copilot", "claude"]),
      commandRunner: () => ({ status: 0, stdout: "ok", stderr: "" }),
    });
    assert.equal(existsSync(copilotGo), false, "migrated copilot skill must be cleaned");
    assert.equal(existsSync(claudeNobs), true, "untargeted claude skill must be preserved");
  });
});

test("cleanOnly mode removes conflicting raw skills without running plugin commands, and preserves foreign-owned lockfile skills", () => {
  withTempHome((home) => {
    const agentsPr = path.join(home, ".agents", "skills", "pr");
    const foreignGo = path.join(home, ".agents", "skills", "go");
    const privateRepoRetro = path.join(home, ".agents", "skills", "retro");
    mkdirSync(agentsPr, { recursive: true });
    mkdirSync(foreignGo, { recursive: true });
    mkdirSync(privateRepoRetro, { recursive: true });
    writeFileSync(path.join(agentsPr, "SKILL.md"), "---\nname: pr\n---\n");
    writeFileSync(
      path.join(foreignGo, "SKILL.md"),
      readFileSync(path.join(REPO_ROOT, "skills", "go", "SKILL.md"), "utf8"),
    );
    writeFileSync(path.join(privateRepoRetro, "SKILL.md"), "---\nname: retro\n---\n");
    writeFileSync(
      path.join(home, ".agents", ".skill-lock.json"),
      JSON.stringify({
        version: 3,
        skills: {
          pr: { source: "jongio/skills", sourceUrl: "https://github.com/jongio/skills.git" },
          go: { source: "other-owner/other-repo", sourceType: "github" },
          retro: { source: "jongio/skills-private", sourceUrl: "https://github.com/jongio/skills-private.git" },
        },
      }),
    );

    const calls = [];
    const result = applyPluginInstall({
      home,
      repoRoot: REPO_ROOT,
      cleanOnly: true,
      availableClis: new Set(["copilot", "claude"]),
      commandRunner: (cmd, args) => {
        calls.push([cmd, ...args]);
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    assert.equal(existsSync(agentsPr), false, "jongio/skills pr must be removed");
    assert.equal(existsSync(foreignGo), true, "foreign-owned go skill must be preserved");
    assert.equal(existsSync(privateRepoRetro), true, "prefix-colliding jongio/skills-private skill must be preserved");
    assert.equal(calls.length, 0, "cleanOnly must not invoke plugin CLIs");
    assert.equal(result.pluginActions.length, 0);
  });
});

test("preserves ~/.agents/skills when a direct shared consumer (~/.codex or ~/.cline) is present unless cleanShared is enabled, and scopes foreign lock ownership to ~/.agents/skills", () => {
  withTempHome((home) => {
    const agentsPr = path.join(home, ".agents", "skills", "pr");
    const foreignAgentsGo = path.join(home, ".agents", "skills", "go");
    const independentCopilotGo = path.join(home, ".copilot", "skills", "go");
    mkdirSync(agentsPr, { recursive: true });
    mkdirSync(foreignAgentsGo, { recursive: true });
    mkdirSync(independentCopilotGo, { recursive: true });
    mkdirSync(path.join(home, ".cline"), { recursive: true });
    writeFileSync(
      path.join(agentsPr, "SKILL.md"),
      readFileSync(path.join(REPO_ROOT, "skills", "pr", "SKILL.md"), "utf8"),
    );
    writeFileSync(path.join(foreignAgentsGo, "SKILL.md"), "---\nname: go\n---\nForeign go skill.\n");
    writeFileSync(
      path.join(independentCopilotGo, "SKILL.md"),
      readFileSync(path.join(REPO_ROOT, "skills", "go", "SKILL.md"), "utf8"),
    );
    writeFileSync(
      path.join(home, ".agents", ".skill-lock.json"),
      JSON.stringify({
        version: 3,
        skills: {
          go: { source: "other-owner/other-repo", sourceType: "github" },
        },
      }),
    );

    applyPluginInstall({
      home,
      repoRoot: REPO_ROOT,
      platforms: ["copilot"],
      availableClis: new Set(["copilot"]),
      commandRunner: () => ({ status: 0, stdout: "ok", stderr: "" }),
    });
    assert.equal(existsSync(agentsPr), true, "shared ~/.agents/skills/pr must be preserved when ~/.cline exists");
    assert.equal(existsSync(foreignAgentsGo), true, "foreign ~/.agents/skills/go must be preserved");
    assert.equal(
      existsSync(independentCopilotGo),
      false,
      "independent canonical ~/.copilot/skills/go must be cleaned even when ~/.agents/skills/go is foreign-owned",
    );

    applyPluginInstall({
      home,
      repoRoot: REPO_ROOT,
      platforms: ["copilot"],
      cleanShared: true,
      availableClis: new Set(["copilot"]),
      commandRunner: () => ({ status: 0, stdout: "ok", stderr: "" }),
    });
    assert.equal(existsSync(agentsPr), false, "cleanShared: true removes ~/.agents/skills/pr");
    assert.equal(existsSync(foreignAgentsGo), true, "foreign ~/.agents/skills/go remains preserved");
  });
});

test("wrapper scripts exist and forward to scripts/install-plugin.mjs", () => {
  const ps1 = readFileSync(path.join(REPO_ROOT, "install.ps1"), "utf8");
  const sh = readFileSync(path.join(REPO_ROOT, "install.sh"), "utf8");
  assert.match(ps1, /install-plugin\.mjs/);
  assert.match(sh, /install-plugin\.mjs/);
  assert.equal(PLATFORM_TARGETS.length, 3);
});
