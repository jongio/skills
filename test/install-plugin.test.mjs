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
  try {
    return fn(home);
  } finally {
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

test("applyPluginInstall removes conflicting raw skill copies and runs native plugin CLIs for copilot, claude, and gemini", () => {
  withTempHome((home) => {
    const agentsPr = path.join(home, ".agents", "skills", "pr");
    const agentsUnrelated = path.join(home, ".agents", "skills", "microsoft-foundry");
    const copilotGo = path.join(home, ".copilot", "skills", "go");
    const copilotUnrelated = path.join(home, ".copilot", "skills", "azd-app");
    const claudeNobs = path.join(home, ".claude", "skills", "nobs");
    const claudeUnrelated = path.join(home, ".claude", "skills", "playwright-cli");
    const staleDirect = path.join(home, ".copilot", "installed-plugins", "_direct", "skills");

    for (const dir of [agentsPr, agentsUnrelated, copilotGo, copilotUnrelated, claudeNobs, claudeUnrelated, staleDirect]) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "SKILL.md"), "---\nname: test\n---\n");
    }
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

    // Conflicting jongio/skills removed from raw personal folders
    assert.equal(existsSync(agentsPr), false, "~/.agents/skills/pr must be removed");
    assert.equal(existsSync(copilotGo), false, "~/.copilot/skills/go must be removed");
    assert.equal(existsSync(claudeNobs), false, "~/.claude/skills/nobs must be removed");
    assert.equal(existsSync(staleDirect), false, "stale _direct/skills plugin copy must be removed");

    // Unrelated user skills preserved
    assert.equal(existsSync(agentsUnrelated), true, "unrelated ~/.agents/skills/microsoft-foundry must be preserved");
    assert.equal(existsSync(copilotUnrelated), true, "unrelated ~/.copilot/skills/azd-app must be preserved");
    assert.equal(existsSync(claudeUnrelated), true, "unrelated ~/.claude/skills/playwright-cli must be preserved");

    // Lockfile cleaned of jongio/skills entries while keeping microsoft-foundry
    const updatedLock = JSON.parse(readFileSync(lockPath, "utf8"));
    assert.equal(Object.hasOwn(updatedLock.skills, "pr"), false);
    assert.equal(Object.hasOwn(updatedLock.skills, "custom-jongio"), false);
    assert.equal(Object.hasOwn(updatedLock.skills, "microsoft-foundry"), true);

    // Native plugin CLIs invoked for copilot, claude, and gemini
    assert.deepEqual(calls, [
      ["copilot", "plugin", "marketplace", "add", "jongio/skills"],
      ["copilot", "plugin", "install", "jongio-skills@jongio-skills"],
      ["claude", "plugin", "marketplace", "add", "jongio/skills"],
      ["claude", "plugin", "install", "jongio-skills@jongio-skills"],
      ["gemini", "extensions", "install", "https://github.com/jongio/skills"],
    ]);
  });
});

test("cleanOnly mode removes conflicting raw skills without running plugin commands, and preserves foreign-owned lockfile skills", () => {
  withTempHome((home) => {
    const agentsPr = path.join(home, ".agents", "skills", "pr");
    const foreignGo = path.join(home, ".agents", "skills", "go");
    mkdirSync(agentsPr, { recursive: true });
    mkdirSync(foreignGo, { recursive: true });
    writeFileSync(path.join(agentsPr, "SKILL.md"), "---\nname: pr\n---\n");
    writeFileSync(path.join(foreignGo, "SKILL.md"), "---\nname: go\n---\n");
    writeFileSync(
      path.join(home, ".agents", ".skill-lock.json"),
      JSON.stringify({
        version: 3,
        skills: {
          pr: { source: "jongio/skills", sourceType: "github" },
          go: { source: "other-owner/other-repo", sourceType: "github" },
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
    assert.equal(calls.length, 0, "cleanOnly must not invoke plugin CLIs");
    assert.equal(result.pluginActions.length, 0);
  });
});

test("wrapper scripts exist and forward to scripts/install-plugin.mjs", () => {
  const ps1 = readFileSync(path.join(REPO_ROOT, "install.ps1"), "utf8");
  const sh = readFileSync(path.join(REPO_ROOT, "install.sh"), "utf8");
  assert.match(ps1, /install-plugin\.mjs/);
  assert.match(sh, /install-plugin\.mjs/);
  assert.equal(PLATFORM_TARGETS.length, 3);
});
