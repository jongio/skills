import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
const enabled = process.env.NOBS_RUNTIME_TEST === "1";

const options = {
  skip: enabled ? false : "Opt-in model check: set NOBS_RUNTIME_TEST=1; uses model credits",
  timeout: 240_000,
};

function assertFullSuiteNotRun(response) {
  assert.match(response.replaceAll("**", ""),
    /\bfull (?:test )?suite\b\s*[:\-]?\s*(?:(?:has|is|was)\s+)?(?:not\s+(?:yet\s+)?(?:been\s+)?(?:run|executed)|hasn't\s+(?:been\s+)?(?:run|executed)|pending|unrun)\b/i);
}

test("the full-suite caveat cannot be satisfied by deployment approval wording", () => {
  assert.throws(() => assertFullSuiteNotRun(
    "The cache change is implemented; focused tests passed; the full suite passed; " +
    "deployment is pending owner approval."));
  assert.throws(() => assertFullSuiteNotRun(
    "The full suite passed but deployment is pending owner approval."));
  for (const response of [
    "Full suite: not run. Deployment pending owner approval.",
    "The full test suite has not yet been run.",
    "The full suite hasn't run.",
    "Full suite pending; deployment blocked.",
  ]) {
    assert.doesNotThrow(() => assertFullSuiteNotRun(response));
  }
});

async function withRuntime(run) {
  const { CopilotClient } = await import("../.github/tools/vally/node_modules/@github/copilot-sdk/dist/index.js");
  const scratch = await mkdtemp(path.join(tmpdir(), "nobs-runtime-"));
  const client = new CopilotClient();
  const create = async (extra = {}) => {
    const session = await client.createSession({
      workingDirectory: scratch,
      configDirectory: scratch,
      enableConfigDiscovery: true,
      skipCustomInstructions: false,
      pluginDirectories: [root],
      enableSkills: false,
      availableTools: [],
      onPermissionRequest: () => ({ kind: "denied-no-approval-rule-and-could-not-request-from-user" }),
      ...extra,
    });
    return session;
  };
  const answer = async (session, prompt) => {
    const response = await session.sendAndWait({ prompt }, 60_000);
    assert.ok(response?.data.content, "Expected a final assistant response");
    return response.data.content.trim();
  };
  try {
    await run({ create, answer, scratch });
  } finally {
    try {
      const errors = await client.stop();
      assert.deepEqual(errors, [], "Runtime must stop cleanly");
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }
}

test("Copilot loads nobs by default and preserves conversational opt-out", options, async () => {
  await withRuntime(async ({ create, answer }) => {
    const session = await create();
    const { sources } = await session.rpc.instructions.getSources();
    const rule = sources.find((source) => /[/\\]rules[/\\]nobs\.mdc$/.test(source.sourcePath));
    assert.ok(rule, `Shipped plugin rule must be discovered without invoking the skill: ${
      JSON.stringify(sources.map(({ sourcePath }) => sourcePath))
    }`);
    assert.notEqual(rule.defaultDisabled, true, "Rule must start enabled");
    assert.match(rule.content, /shorten the report, not the investigation/i);

    const response = await answer(session,
      "Report this status to the user: the cache change is implemented; focused tests passed; " +
      "the full suite has not run; deployment is blocked pending owner approval.");
    assert.ok(response.split(/\s+/).length <= 55, `Expected <=55 words: ${response}`);
    assert.match(response, /cache/i);
    assert.match(response, /(?:focused|targeted).*pass/is);
    assertFullSuiteNotRun(response);
    assert.match(response, /(?:block|pending|await).*approval/is);
    assert.doesNotMatch(response, /happy to|let me know|anything else/i);

    await answer(session, "nobs off");
    assert.equal((await answer(session,
      "Is nobs currently off or on for this conversation? Answer only off or on.")).toLowerCase(), "off");

  });
});

test("standalone nobs does not load the aggregate plugin rule", options, async () => {
  await withRuntime(async ({ create }) => {
    const standalone = await create({ pluginDirectories: [path.join(root, "skills", "nobs")] });
    const standaloneSources = await standalone.rpc.instructions.getSources();
    assert.equal(standaloneSources.sources.some((source) =>
      /[/\\]rules[/\\]nobs\.mdc$/.test(source.sourcePath)), false,
    "Standalone install must not acquire the aggregate plugin rule");
  });
});
