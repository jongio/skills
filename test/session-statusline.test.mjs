import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("the plugin ships default-on active-session enrollment without enrolling references", () => {
  const rule = read("com.github.copilot/rules/session-statusline.mdc");
  assert.match(rule, /^alwaysApply: true$/m);
  assert.match(rule, /Never add pills for references/);
  assert.match(rule, /Remove a target\s+when this session stops working on it/);
  assert.match(rule, /Honor manual clear\/remove/);
  assert.match(rule, /When the session statusline tools are available/);
  assert.match(rule, /Use the `session-statusline` skill/);
});

test("session-statusline is discoverable through the aggregate plugin and individual marketplace entry", () => {
  const plugin = JSON.parse(read("plugin.json"));
  const marketplace = JSON.parse(read("marketplace.json"));
  assert.ok(plugin.keywords.includes("session-statusline"));
  const entry = marketplace.plugins.find(({ name }) => name === "session-statusline");
  assert.equal(entry.source, "./skills/session-statusline");
  const skill = read("skills/session-statusline/SKILL.md");
  assert.equal(entry.version, /^  version: "([^"]+)"/m.exec(skill)?.[1]);
  assert.match(skill, /^name: session-statusline$/m);
});
