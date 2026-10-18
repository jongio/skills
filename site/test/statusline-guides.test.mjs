import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { OCTICONS } from "../../extensions/pr-statusline/tracker.mjs";
import { ICONS as ISSUE_ICONS } from "../../extensions/issue-statusline/tracker.mjs";
import { summarizeIssueStatus } from "../../extensions/issue-statusline/github.mjs";
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

test("the overview headings align with matching-color pill groups", () => {
  const diagram = read("../public/screenshots/statusline-worktree-grouped.svg");
  const colors = {
    worktree: ["#79b8ff", "#183a6b", "Branch &amp; Worktree", 2],
    pr: ["#3fb950", "#165c32", "Pull Requests", 2],
    issue: ["#d29922", "#764410", "Issues", 1],
    sub: ["#bc8cff", "#6235a0", "Subagents", 1],
  };
  const groups = [...diagram.matchAll(/<g id="feature-([^"]+)"[^>]*>([\s\S]*?)<\/g>/g)];
  assert.equal(groups.length, 4);
  assert.deepEqual(groups.map(([, name]) => name), Object.keys(colors));
  const attribute = (tag, name) => tag.match(new RegExp(`\\b${name}="([^"]+)"`))?.[1];
  const rectangles = [];
  for (const [, name, content] of groups) {
    const header = content.match(/<text[^>]+>([^<]+)<\/text>/);
    assert.ok(header, `${name} must have a heading`);
    const pills = [...content.matchAll(/<rect[^>]+>/g)].map((match) => match[0]);
    assert.equal(attribute(header[0], "fill"), colors[name][0], `${name} heading color`);
    assert.equal(header[1], colors[name][2], `${name} heading label`);
    assert.equal(pills.length, colors[name][3], `${name} pill count`);
    const headingGap = Number(attribute(pills[0], "y")) - Number(attribute(header[0], "y"));
    assert.ok(headingGap > 0 && headingGap <= 20, `${name} heading must be directly above its pills`);
    for (const pill of pills) {
      assert.equal(attribute(pill, "fill"), colors[name][1], `${name} pill background`);
      assert.equal(attribute(pill, "stroke"), attribute(header[0], "fill"), `${name} heading matches pill`);
      assert.equal(attribute(header[0], "x"), attribute(pill, "x"), `${name} heading is aligned`);
      assert.ok(Number(attribute(header[0], "y")) < Number(attribute(pill, "y")));
      const rectangle = Object.fromEntries(["x", "y", "width", "height"].map((key) => [key, Number(attribute(pill, key))]));
      assert.ok(rectangle.x >= 0 && rectangle.y >= 0 && rectangle.width > 0 && rectangle.height > 0);
      assert.ok(rectangle.x + rectangle.width <= 1680 && rectangle.y + rectangle.height <= 560);
      rectangles.push(rectangle);
    }
  }
  for (let i = 0; i < rectangles.length; i++) {
    const a = rectangles[i];
    for (const b of rectangles.slice(i + 1)) {
      assert.ok(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y, "Pill groups must not overlap");
    }
  }
  const contentByFeature = Object.fromEntries(groups.map(([, name, content]) => [name, content]));
  assert.equal([...contentByFeature.pr.matchAll(/data-icon="pass"/g)].length, 2);
  assert.equal([...contentByFeature.pr.matchAll(/>8\/8<\/text>/g)].length, 2);
  assert.doesNotMatch(contentByFeature.issue, /data-icon="pr"|data-icon="assignee"|P1|alex/);
  assert.match(contentByFeature.sub, /data-icon="merged"/);
  assert.match(contentByFeature.sub, />4 merged<\/text>/);
  assert.doesNotMatch(contentByFeature.sub, /starting|in PR|data-icon="running"/);
  assert.match(diagram, /Example states: PR checks passed · issue unassigned · subagent PRs merged/);
  assert.doesNotMatch(diagram, /← SUBAGENTS|labels and outlines|No hyperlink|colon separator/);
  for (const page of ["../src/pages/index.astro", "../src/pages/statuslines/index.astro"]) {
    assert.doesNotMatch(read(page), /sl-types-banner|sl-types-sep|explanatory outlines|outlines versus/);
  }
});

test("amber issue examples match the runtime's unassigned and unlinked status", () => {
  const status = summarizeIssueStatus({
    state: "OPEN",
    labels: { nodes: [{ name: "enhancement" }] },
    assignees: { nodes: [] },
    closedByPullRequestsReferences: { nodes: [] },
    comments: { totalCount: 1 },
  });
  const icons = { issue: ISSUE_ICONS.open, comment: ISSUE_ICONS.comment, assignee: ISSUE_ICONS.assignee, pr: ISSUE_ICONS.linkedPr };
  for (const [file, number] of [["statusline-worktree-grouped", 18], ["issue-statusline", 19]]) {
    const svg = read(`../public/screenshots/${file}.svg`);
    const example = svg.match(/<rect[^>]+fill="#764410"[^>]*\/>([\s\S]*?)(?=<rect|<\/g>)/);
    assert.ok(example, `${file} must contain the amber issue example`);
    const tokens = [...example[1].matchAll(/<use\b[^>]*\/>|<text\b[^>]*>([^<]*)<\/text>/g)]
      .map(([tag, text]) => ({
        x: Number(tag.match(/\bx="([^"]+)"/)?.[1]),
        value: tag.startsWith("<use") ? icons[tag.match(/\bdata-icon="([^"]+)"/)?.[1]] : text,
      }));
    for (const token of tokens) {
      assert.ok(Number.isFinite(token.x));
      assert.equal(typeof token.value, "string");
    }
    assert.equal(tokens.sort((a, b) => a.x - b.x).map(({ value }) => value).join(" "), `${ISSUE_ICONS.open} widget#${number} ${status}`);
  }
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
    ["statusline-worktree-grouped", ["pr", "pass", "issue", "comment", "agent", "merged"]],
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
