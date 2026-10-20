import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

test("retro regression candidate binds the source skill on Windows and POSIX", async () => {
  const candidate = await readFile(
    new URL("../.copilot/evals/retro-closeout-regressions.eval.yaml", import.meta.url),
    "utf8",
  );
  const skillPath = candidate.match(/^  skills:\r?\n    - ([^\r\n]+)\r?$/m)?.[1];
  assert.ok(skillPath, "candidate must bind the real source skill");
  assert.equal(path.posix.resolve("/repo/.copilot/evals", skillPath), "/repo/skills/retro");
  assert.equal(
    path.win32.resolve("C:\\repo\\.copilot\\evals", skillPath),
    "C:\\repo\\skills\\retro",
  );
});
