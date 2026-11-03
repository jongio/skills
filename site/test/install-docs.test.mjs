import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const SITE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = path.resolve(SITE_ROOT, "..");

const read = (...parts) => readFileSync(path.join(REPO_ROOT, ...parts), "utf8");

test("site pages and skill catalog entries never recommend -g --agent github-copilot or bare /plugin install pr@jongio-skills", () => {
  for (const rel of [
    "README.md",
    "site/src/pages/index.astro",
    "site/src/pages/about.astro",
    "site/src/pages/catalog/[slug].astro",
    "site/src/components/SkillCard.astro",
  ]) {
    const content = read(rel);
    assert.doesNotMatch(
      content,
      /-g\s+--agent\s+github-copilot/,
      `${rel} must not recommend -g --agent github-copilot (shadows plugin and breaks /pr)`,
    );
  }

  const catalogDir = path.join(SITE_ROOT, "src", "content", "skills");
  for (const file of readdirSync(catalogDir).filter((name) => name.endsWith(".md"))) {
    const content = read("site", "src", "content", "skills", file);
    assert.doesNotMatch(
      content,
      /-g\s+--agent\s+github-copilot/,
      `site/src/content/skills/${file} must not recommend -g --agent github-copilot`,
    );
  }

  const skillsDir = path.join(REPO_ROOT, "skills");
  for (const entry of readdirSync(skillsDir, { withFileTypes: true }).filter((d) => d.isDirectory())) {
    const readmePath = path.join(skillsDir, entry.name, "README.md");
    const content = readFileSync(readmePath, "utf8");
    assert.doesNotMatch(
      content,
      /-g\s+--agent\s+github-copilot/,
      `skills/${entry.name}/README.md must not recommend -g --agent github-copilot`,
    );
  }

  const skillCard = read("site/src/components/SkillCard.astro");
  assert.match(
    skillCard,
    /skillId === "pr"\s*\?\s*"\/plugin install jongio-skills@jongio-skills"\s*:\s*`\/plugin install \$\{skillId\}@jongio-skills`/,
    "SkillCard.astro must copy the aggregate plugin install command for pr and individual plugin commands for other skills",
  );

  const slugPage = read("site/src/pages/catalog/[slug].astro");
  assert.match(
    slugPage,
    /skill\.id !== "pr"\s*\?/,
    "catalog/[slug].astro must gate single-skill plugin install on skill.id !== 'pr'",
  );
});

test("site install sections document the cross-platform one-liner and native CLI plugin commands", () => {
  for (const rel of [
    "README.md",
    "site/src/pages/index.astro",
    "site/src/pages/about.astro",
    "site/src/pages/catalog/[slug].astro",
  ]) {
    const content = read(rel);
    assert.match(content, /install\.ps1/, `${rel} must include install.ps1 one-liner`);
    assert.match(content, /install\.sh/, `${rel} must include install.sh one-liner`);
    assert.match(content, /jongio-skills@jongio-skills/, `${rel} must include jongio-skills@jongio-skills`);
    assert.match(content, /codex plugin add jongio-skills/, `${rel} must include Codex CLI plugin install`);
  }
});
