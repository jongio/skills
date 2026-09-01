import { createHash } from "node:crypto";
import { canonicalJson, validateConfig, validateTargetPath } from "./config.mjs";

function command(program, args, cwd) {
  if (
    typeof program !== "string" ||
    program.length === 0 ||
    !Array.isArray(args) ||
    args.some((value) => typeof value !== "string")
  ) {
    throw new Error("GitHub plan commands require a program and string arguments.");
  }
  return { program, args: [...args], cwd };
}

export function createGitHubPlan(configInput, targetInput) {
  const config = validateConfig(configInput);
  const target = validateTargetPath(targetInput);
  const visibilityFlag = `--${config.repository.visibility}`;
  const commands = [
    command("git", ["init", "--initial-branch", config.github.defaultBranch], target),
    command("git", ["add", "--all"], target),
    command("git", ["commit", "-m", "chore: initialize skills repository"], target),
    command(
      "gh",
      [
        "repo",
        "create",
        `${config.owner.login}/${config.repository.name}`,
        visibilityFlag,
        "--source",
        ".",
        "--remote",
        "origin",
      ],
      target,
    ),
    command(
      "git",
      ["push", "--set-upstream", "origin", config.github.defaultBranch],
      target,
    ),
  ];
  const binding = canonicalJson({ target, commands });
  return {
    schemaVersion: 1,
    approvalRequired: true,
    approved: false,
    repository: `${config.owner.login}/${config.repository.name}`,
    planHash: createHash("sha256").update(binding).digest("hex"),
    commands,
  };
}
