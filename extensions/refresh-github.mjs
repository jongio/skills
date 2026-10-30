import { homedir } from "node:os";
import { join } from "node:path";
import { refreshTracker } from "./github-refresh.mjs";
import { statuslineGitHub } from "./github-transport.mjs";

const args = process.argv.slice(2);
const id = args[args.indexOf("--session") + 1];
if (!args.includes("--session") || !/^[\w-]{1,128}$/.test(id || "")) {
  console.error("Usage: node refresh-github.mjs --session <id> --prs|--issues");
  process.exitCode = 1;
} else {
  try {
    if (!args.includes("--prs") && !args.includes("--issues")) throw new Error("Select --prs or --issues");
    for (const [flag, kind] of [["--prs", "pr"], ["--issues", "issue"]]) {
      if (!args.includes(flag)) continue;
      const failures = await refreshTracker(kind, id, {
        home: process.env.COPILOT_HOME || join(homedir(), ".copilot"), force: true,
      });
      if (failures.length) throw new Error(failures.join("\n"));
    }
    console.log("Refreshed tracked GitHub metadata.");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    await statuslineGitHub.close();
  }
}
