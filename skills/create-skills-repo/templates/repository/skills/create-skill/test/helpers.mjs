import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function write(path, content) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

export function minimalVallyLock() {
  return {
    name: "vally-tool",
    version: "1.0.0",
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": {
        name: "vally-tool",
        version: "1.0.0",
        devDependencies: { "@microsoft/vally-cli": "0.14.0" },
      },
      "node_modules/@microsoft/vally-cli": {
        version: "0.14.0",
        resolved: "https://registry.npmjs.org/@microsoft/vally-cli/-/vally-cli-0.14.0.tgz",
        integrity: "sha512-test",
        dev: true,
      },
    },
  };
}

export function createRepositoryFixture(root, options = {}) {
  mkdirSync(join(root, ".git"), { recursive: true });
  mkdirSync(join(root, "skills", "existing"), { recursive: true });
  write(join(root, "skills", "existing", "SKILL.md"), "---\nname: existing\ndescription: Existing skill description.\n---\n");
  write(
    join(root, "README.md"),
    "# Skills\n\n| Skill | Description |\n| --- | --- |\n| [`existing`](skills/existing/) | Existing. |\n",
  );
  write(
    join(root, "marketplace.json"),
    `${JSON.stringify({ name: "fixture", plugins: [] }, null, 2)}\n`,
  );
  write(
    join(root, "plugin.json"),
    `${JSON.stringify(
      {
        name: "fixture",
        author: { name: "Octo Cat" },
        repository: "https://github.com/octocat/skills",
        keywords: ["skills"],
      },
      null,
      2,
    )}\n`,
  );
  write(
    join(root, ".github", "workflows", "skill-eval.yml"),
    options.managed
      ? "jobs:\n  plan:\n    steps:\n      - run: |\n          find skills -path 'skills/*/evals/*/eval.yaml'\n          all=$(jq -sc '.' matrix.jsonl)\n"
      : "jobs:\n  plan:\n    steps:\n      - run: |\n          all='[\n            {\"skill\":\"skills/existing\",\"skill_id\":\"existing\",\"eval_spec\":\"evals/existing/eval.yaml\"}\n          ]'\n",
  );
  write(
    join(root, ".github", "dependabot.yml"),
    "version: 2\nupdates:\n  - package-ecosystem: npm\n    directory: /skills/existing\n    schedule:\n      interval: weekly\n",
  );
  write(
    join(root, ".github", "tools", "vally", "package-lock.json"),
    `${JSON.stringify(minimalVallyLock(), null, 2)}\n`,
  );
  mkdirSync(join(root, "site", "src", "content", "skills"), { recursive: true });
  mkdirSync(join(root, "site", "public", "images"), { recursive: true });
  write(join(root, "docs", "thumbnail-prompts.md"), "# Skill thumbnail prompts\n");
  if (options.managed) {
    write(
      join(root, "skills-repo.config.json"),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          templateVersion: 1,
          owner: { login: "octocat", name: "Octo Cat", url: "https://github.com/octocat" },
          repository: {
            name: "skills",
            url: "https://github.com/octocat/skills",
            visibility: "public",
          },
          package: {
            name: "octocat-skills",
            displayName: "Octocat Skills",
            description: "Portable fixture skills.",
            version: "1.0.0",
          },
          catalog: { enabled: true, template: "skills-catalog" },
          github: { defaultBranch: "main" },
        },
        null,
        2,
      )}\n`,
    );
    const managedFiles = [
      "README.md",
      "marketplace.json",
      "plugin.json",
      ".github/workflows/skill-eval.yml",
      ".github/dependabot.yml",
    ];
    const files = {};
    for (const relativePath of managedFiles) {
      const normalized = readFileSync(join(root, relativePath), "utf8").replace(/\r\n?/g, "\n");
      files[relativePath] = {
        sha256: createHash("sha256").update(normalized).digest("hex"),
        normalization: "lf",
      };
    }
    write(
      join(root, ".skills-repo", "state.json"),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          hashVersion: 1,
          templateVersion: 1,
          files,
        },
        null,
        2,
      )}\n`,
    );
  }
}
