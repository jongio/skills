import { join } from "node:path";

const VALUE_OPTIONS = new Set([
  "author",
  "base",
  "description",
  "default-branch",
  "dir",
  "marketplace-id",
  "package-name",
  "registry",
  "registry-ref",
  "repo",
  "site-name",
  "staging-dir",
  "templates-dir",
]);

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") args.help = true;
    else if (argument === "--list") args.list = true;
    else if (argument === "--force") args.force = true;
    else if (argument === "--json") args.json = true;
    else if (argument.startsWith("--")) {
      const name = argument.slice(2);
      if (!VALUE_OPTIONS.has(name)) {
        throw new Error(`Unknown option ${argument}.`);
      }
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`Option ${argument} requires a value.`);
      }
      args[name] = value;
      index += 1;
    }
    else args._.push(argument);
  }
  return args;
}

const HELP = `
create-gh-pages-site: scaffold a GitHub Pages site from a template.

Usage:
  node scripts/new-site.mjs <template> --repo <owner/name> [options]

Templates are fetched from the jongio/gh-pages-templates registry. Run --list to
see them, or use --templates-dir <path> for a local copy.

Options:
  --repo <owner/name>      Target GitHub repo (drives base path and URLs)
                           Defaults to the current repo's "origin" remote
  --base </path/>          Override base path (for example, "/my-repo/" or "/")
  --dir <path>             Output directory (default: ./<repo-name>)
  --site-name <title>      Human title (default: from repo name)
  --description <text>     Site description
  --default-branch <id>    Repository default branch (default: main)
  --author <name>          Author display name (default: repository owner)
  --package-name <id>      Package identifier (default: repository name)
  --marketplace-id <id>    Marketplace identifier (default: owner-repository)
  --registry <owner/repo>  Template registry repo (default: jongio/gh-pages-templates)
  --registry-ref <sha>     Full 40-character registry commit SHA
  --templates-dir <path>   Local templates folder to use instead
  --staging-dir <path>     Validate into a new directory without applying to a target
  --force                  Write into a non-empty directory
  --json                   Print a machine-readable result
  --list                   List templates and exit
  --help                   Show this help

If neither --repo nor --base is given, the current repo is assumed from its
"origin" remote.

Examples:
  node scripts/new-site.mjs astro
  node scripts/new-site.mjs astro --repo octocat/my-astro-site
  node scripts/new-site.mjs react-vite --repo octocat/dashboard --site-name "Dashboard"
  node scripts/new-site.mjs static-html --base / --dir ./site
`;

export function runNewSiteCli(argv, api) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
    return;
  }
  if (args.help) {
    console.log(HELP);
    return;
  }
  if (args.list) {
    let root;
    try {
      root = api.resolveTemplatesSource({
        registry: args.registry,
        registryRef: args["registry-ref"],
        templatesDir: args["templates-dir"],
      });
    } catch (error) {
      console.error(`Error: ${error.message}`);
      process.exitCode = 1;
      return;
    }
    for (const name of api.listTemplates(root)) {
      const manifest = api.readManifest(join(root, name));
      console.log(`  ${name.padEnd(14)} ${manifest.tagline}`);
    }
    return;
  }

  const template = args._[0];
  if (!template) {
    console.error(`Error: missing <template>.\n${HELP}`);
    process.exitCode = 1;
    return;
  }

  let repo = args.repo;
  if (!repo && !args.base) {
    repo = api.detectCurrentRepo();
    if (repo && !args.json) console.log(`Using current repo from origin remote: ${repo}`);
  }

  try {
    const result = api.stampTemplate({
      template,
      dir: args.dir,
      repo,
      base: args.base,
      siteName: args["site-name"],
      description: args.description,
      defaultBranch: args["default-branch"],
      author: args.author,
      packageName: args["package-name"],
      marketplaceId: args["marketplace-id"],
      registry: args.registry,
      registryRef: args["registry-ref"],
      templatesDir: args["templates-dir"],
      stagingDir: args["staging-dir"],
      force: args.force,
    });

    if (args.json) {
      console.log(JSON.stringify({
        mode: result.staged ? "staged" : "applied",
        directory: result.dir,
        template,
        registry: args["templates-dir"] ? null : (args.registry || api.DEFAULT_REGISTRY),
        registryRef: args["templates-dir"] ? null : (args["registry-ref"] || api.DEFAULT_REGISTRY_REF),
        replacements: result.replacements,
      }));
      return;
    }

    if (result.staged) {
      console.log(`\nStaged and validated ${result.manifest.title} in ${result.dir}`);
      console.log("No target files were read or written. The caller owns conflict detection and final copying.");
      return;
    }

    printApplyResult(result, repo);
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  }
}

function printApplyResult({ dir, replacements, manifest }, repo) {
  console.log(`\nCreated ${manifest.title} site in ${dir}`);
  console.log(`  base path: ${replacements.__BASE_PATH__}`);
  console.log(`  site URL:  ${replacements.__SITE_URL__}\n`);
  console.log("Next steps:");
  let step = 1;
  if (manifest.needsBuild) {
    if (manifest.language === "Ruby") {
      console.log(`  ${step++}. cd ${dir} && bundle install   # local preview only, CI builds it for you`);
    } else {
      console.log(`  ${step++}. cd ${dir} && npm install --ignore-scripts --no-audit --no-fund && npm run build`);
    }
  }
  console.log(`  ${step++}. Commit and push to the repo's ${replacements.__DEFAULT_BRANCH__} branch.`);
  console.log(`  ${step++}. Settings > Pages > Source > "GitHub Actions".`);
  console.log(`  ${step++}. The deploy workflow publishes on push; the URL appears in the Actions run.`);
  if (repo) {
    console.log(`  ${step++}. Set the repo "Website" link to the Pages URL:`);
    console.log(`       gh repo edit ${replacements.__REPO_SLUG__} --homepage ${replacements.__SITE_URL__}`);
  }
  console.log();
}
