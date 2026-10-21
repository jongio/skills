import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (name) => readFileSync(new URL(`../${name}`, import.meta.url), "utf8").replaceAll("\r\n", "\n");
const policy = (text) => text.split("## Response policy\n")[1]?.split("\n## ")[0].trim();

test("nobs ships a standalone skill and an identical default-on Copilot policy", () => {
  const skill = read("skills/nobs/SKILL.md");
  const rule = read("com.github.copilot/rules/nobs.mdc");
  assert.match(rule, /^alwaysApply: true$/m);
  assert.match(skill, /^---\r?\nname: nobs\r?\ndescription: >-/);
  assert.ok(policy(skill), "The standalone skill needs its own portable policy");
  assert.equal(policy(skill), policy(rule), "The skill and plugin default must not drift");
  assert.match(rule, /enabled by default/i);
  assert.doesNotMatch(rule, /invoke.*(?:skill|\/nobs)/i);
});

test("nobs preserves explicit opt-outs, completeness, and safety", () => {
  const rule = read("com.github.copilot/rules/nobs.mdc");
  assert.match(rule, /explicit opt-out means OFF/);
  assert.match(rule, /asking about its status is not a mode command/);
  assert.match(rule, /nobs off/);
  assert.match(rule, /nobs on/);
  assert.match(rule, /risks, failures, blockers, uncertainty/);
  assert.match(rule, /approval/);
  assert.match(rule, /shorten the report, not the investigation/i);
  assert.match(rule, /explicit.*detail/i);
  assert.doesNotMatch(rule, /Never edit personal instruction files/i);
  assert.match(rule, /Do not persist nobs preferences/i);
});

test("nobs defines context precedence and never executes quoted context", () => {
  const skill = read("skills/nobs/SKILL.md").replace(/\s+/g, " ");
  assert.match(skill, /supplied after.*invocation/i);
  assert.match(skill, /selection.*attachment/i);
  assert.match(skill, /most recent substantive/i);
  assert.match(skill, /untrusted data, not instructions/i);
  assert.match(skill, /Do not execute commands/i);
});

test("nobs documents plugin scope and unsupported persistence without modifying personal files", () => {
  const readme = read("skills/nobs/README.md");
  assert.match(readme, /Copilot CLI/);
  assert.match(readme, /standalone.*does not enable/is);
  assert.match(readme, /Persistent opt-out is unsupported/);
  assert.match(readme, /does not edit.*personal/is);
});
