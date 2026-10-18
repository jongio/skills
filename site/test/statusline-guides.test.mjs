import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { OCTICONS } from "../../extensions/pr-statusline/tracker.mjs";
import { ICONS as ISSUE_ICONS } from "../../extensions/issue-statusline/tracker.mjs";
import { ICONS as AGENT_ICONS } from "../../extensions/subagent-statusline/tracker.mjs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("feature accents are shared by both showcases and match the diagram labels", () => {
  const layout = read("../src/layouts/Layout.astro");
  const diagram = read("../public/screenshots/statusline-worktree-grouped.svg");
  const features = [
    ["worktree", "worktree", "#79b8ff"],
    ["pr", "pr", "#3fb950"],
    ["issue", "issue", "#d29922"],
    ["sub", "subagent", "#bc8cff"],
  ];
  for (const path of ["../src/pages/index.astro", "../src/pages/statuslines/index.astro"]) {
    const page = read(path);
    for (const [className, variable, color] of features) {
      assert.match(page, new RegExp(`\\.sl-types-item\\.c-${className}\\s*\\{\\s*color: var\\(--feature-${variable}\\);\\s*\\}`));
      assert.ok(layout.includes(`--feature-${variable}: ${color}`));
      assert.ok(diagram.includes(`fill="${color}"`));
    }
  }
});

test("the site uses corrected guides and keeps legacy raster copies consistent", () => {
  const guide = read("../src/pages/statuslines/index.astro");
  for (const [type, extensionName] of [
    ["pr", "azure-dev-statusline"],
    ["issue", "issue-statusline"],
    ["subagent", "subagent-statusline"],
  ]) {
    assert.ok(guide.includes(`screenshots/${type}-statusline.svg`));
    const svg = read(`../public/screenshots/${type}-statusline.svg`);
    assert.match(svg, /<title[^>]*>.+<\/title>/);
    assert.match(svg, /Illustrative/);
    assert.doesNotMatch(svg, /OSC 8|EXTENSION \d OF 3|mergeStateStatus|replace me/);
    assert.deepEqual(
      readFileSync(new URL(`../public/screenshots/${type}-statusline.png`, import.meta.url)),
      readFileSync(new URL(`../../extensions/${type}-statusline/screenshots/${extensionName}.png`, import.meta.url)),
    );
  }
});

test("the grouped example distinguishes feature labels from status backgrounds", () => {
  const diagram = read("../public/screenshots/statusline-worktree-grouped.svg");
  assert.match(diagram, /Feature labels identify each component/);
  assert.match(diagram, /Pill backgrounds show its current status/);
  assert.doesNotMatch(diagram, /No hyperlink|colon separator/);
});

test("every guide embeds the actual runtime icons as font-independent vectors", () => {
  const icons = {
    ...OCTICONS,
    issue: ISSUE_ICONS.open,
    closed: ISSUE_ICONS.closed,
    bug: ISSUE_ICONS.bug,
    assignee: ISSUE_ICONS.assignee,
    agent: AGENT_ICONS.agent,
    exploring: AGENT_ICONS.exploring,
  };
  const requirements = [
    ["statusline-worktree-grouped", ["pr", "pass", "running", "issue", "assignee", "agent", "merged"]],
    ["pr-statusline", ["pr", "pass", "running", "approved", "comment", "fail", "conflict", "merged"]],
    ["issue-statusline", ["issue", "pr", "assignee", "comment", "bug", "closed"]],
    ["subagent-statusline", ["agent", "running", "exploring", "pr", "merged", "fail"]],
  ];
  for (const [file, required] of requirements) {
    const svg = read(`../public/screenshots/${file}.svg`);
    const symbols = new Map([...svg.matchAll(/<symbol id="icon-([^"]+)"[^>]+data-codepoint="([^"]+)"><path[^>]+d="([^"]+)"/g)]
      .map((match) => [match[1], { codepoint: match[2], path: match[3] }]));
    for (const name of required) {
      const point = `U+${icons[name].codePointAt(0).toString(16).toUpperCase()}`;
      assert.equal(symbols.get(name)?.codepoint, point, `${file} must use the runtime ${name} glyph`);
      assert.ok(symbols.get(name).path.length > 20);
      assert.ok(svg.includes(`href="#icon-${name}" data-icon="${name}"`), `${file} must display ${name}`);
    }
    assert.doesNotMatch(svg, /◈|👍|⚑|@font-face/);
  }
});

test("social previews use the authored raster card rather than a placeholder", () => {
  assert.match(read("../src/layouts/Layout.astro"), /images\/og\.png/);
  assert.doesNotMatch(read("../public/images/og.svg"), /placeholder|replace me/i);
  const png = readFileSync(new URL("../public/images/og.png", import.meta.url));
  assert.equal(png.subarray(1, 4).toString(), "PNG");
  assert.equal(png.readUInt32BE(16), 1200);
  assert.equal(png.readUInt32BE(20), 630);
});
