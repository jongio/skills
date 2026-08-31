export const HELP = `
create-skills-repo creates and maintains portable skills repositories.

Usage:
  node scripts/cli.mjs create <target> --owner-login <login> [options]
  node scripts/cli.mjs upgrade <target> [options]
  node scripts/cli.mjs sync <target>
  node scripts/cli.mjs check <target>
  node scripts/cli.mjs dry-run <create|upgrade|sync> <target> [options]

Create options:
  --owner-login <login>
  --owner-name <name>
  --repo <name>
  --package-name <name>
  --display-name <name>
  --description <text>
  --visibility <public|private|internal>
  --default-branch <name>
  --no-catalog
  --create-skill-source <path>
  --catalog-script <path>
  --catalog-templates-dir <path>
  --catalog-registry <owner/repo>
  --catalog-registry-ref <full-commit-sha>

Upgrade options:
  --create-skill-source <path>

The command only performs local repository writes. It prints a GitHub operations
plan as argument arrays. It never executes git or gh.
`.trim();

const VALUE_OPTIONS = new Set([
  "owner-login",
  "owner-name",
  "repo",
  "package-name",
  "display-name",
  "description",
  "visibility",
  "default-branch",
  "create-skill-source",
  "catalog-script",
  "catalog-templates-dir",
  "catalog-registry",
  "catalog-registry-ref",
]);
const BOOLEAN_OPTIONS = new Set(["no-catalog", "help"]);

export function parseArguments(argv) {
  const positional = [];
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) {
      positional.push(value);
      continue;
    }
    const name = value.slice(2);
    if (BOOLEAN_OPTIONS.has(name)) {
      options[name] = true;
      continue;
    }
    if (!VALUE_OPTIONS.has(name)) {
      throw new Error(`Unknown option: ${value}.`);
    }
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      throw new Error(`Option ${value} requires a value.`);
    }
    options[name] = next;
    index += 1;
  }
  return { positional, options };
}
