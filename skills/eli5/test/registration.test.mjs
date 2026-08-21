import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const skillDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.resolve(skillDir, "..", "..");
const skillId = "eli5";
const vallyPkg = "@microsoft/vally-cli";

const read = (...parts) => readFile(path.join(root, ...parts), "utf8");
const parse = async (...parts) => JSON.parse(await read(...parts));

const [
  readme,
  marketplace,
  plugin,
  siteEntry,
  evalWorkflow,
  lintWorkflow,
  packageJson,
  lockfile,
  images,
  skillDoc,
] = await Promise.all([
    read("README.md"),
    parse("marketplace.json"),
    parse("plugin.json"),
    read("site", "src", "content", "skills", `${skillId}.md`),
    read(".github", "workflows", "skill-eval.yml"),
    read(".github", "workflows", "skill-lint.yml"),
    parse("skills", skillId, "package.json"),
    parse("skills", skillId, "package-lock.json"),
    read("site", "public", "images", "IMAGES.md"),
    read("skills", skillId, "SKILL.md"),
  ]);

// Anchored to the catalog table row, not a bare substring, so prose or a code
// fence that happens to mention the path cannot satisfy the check.
assert.match(
  readme,
  new RegExp(`\\|\\s*\\[\`${skillId}\`\\]\\(skills/${skillId}/\\)`),
  "README.md is missing the catalog table row for the skill",
);

assert.match(
  skillDoc,
  new RegExp(`^name:\\s*${skillId}\\s*$`, "m"),
  "SKILL.md frontmatter name must match the skill directory",
);

const marketplaceEntry = marketplace.plugins.find(({ name }) => name === skillId);
assert.ok(marketplaceEntry, "marketplace entry must exist");
assert.equal(
  marketplaceEntry.source,
  `./skills/${skillId}`,
  "marketplace source must point at the skill directory",
);

assert.equal(plugin.skills, "skills/", "plugin.json skills root changed");
assert.ok(
  plugin.keywords.includes(skillId),
  "plugin.json keywords must include the skill id",
);

assert.match(
  siteEntry,
  new RegExp(`repoPath: skills/${skillId}`),
  "site catalog entry must declare the skill repoPath",
);
assert.match(
  siteEntry,
  new RegExp(`--skill ${skillId}`),
  "site catalog entry must document the install command",
);

// The Astro schema types `thumb` as a plain string, so a missing image still
// builds green. Resolve the declared path and prove the file is really there.
const thumb = siteEntry.match(/^thumb:\s*(\S+)\s*$/m);
assert.ok(thumb, "site catalog entry must declare a thumb");
assert.ok(
  existsSync(path.join(root, "site", "public", thumb[1])),
  `site thumbnail ${thumb[1]} is declared but missing`,
);
const installedThumb = path.join(root, "skills", skillId, "thumbnail.png");
assert.ok(
  existsSync(installedThumb),
  "installable skill is missing its thumbnail.png",
);

// The catalog image is a copy of the installed one. It is binary, so compare
// bytes rather than text.
const [installedArt, catalogArt] = await Promise.all([
  readFile(installedThumb),
  readFile(path.join(root, "site", "public", thumb[1])),
]);
const digest = (buffer) => createHash("sha256").update(buffer).digest("hex");
assert.equal(
  digest(catalogArt),
  digest(installedArt),
  "catalog thumbnail drifted from the installed skill thumbnail",
);

// House style: every skill thumbnail is a 1024x1024 PNG. Width and height live
// in the IHDR chunk at fixed offsets, so this needs no image library.
assert.equal(
  installedArt.subarray(0, 8).toString("hex"),
  "89504e470d0a1a0a",
  "thumbnail must be a PNG",
);
assert.equal(installedArt.readUInt32BE(16), 1024, "thumbnail width must be 1024");
assert.equal(installedArt.readUInt32BE(20), 1024, "thumbnail height must be 1024");

assert.ok(
  images.includes(path.basename(thumb[1])),
  "IMAGES.md must document the skill thumbnail",
);

// The matrix is hand-written JSON embedded in YAML, so tolerate whitespace
// rather than failing on a harmless reformat.
assert.match(
  evalWorkflow,
  new RegExp(`"skill"\\s*:\\s*"skills/${skillId}"`),
  "skill-eval.yml matrix must include the skill",
);
assert.match(
  evalWorkflow,
  new RegExp(`"eval_spec"\\s*:\\s*"evals/${skillId}/eval\\.yaml"`),
  "skill-eval.yml matrix must point at the eval spec",
);

assert.equal(packageJson.name, skillId, "package.json name must match the skill id");

// Exact pins by design: the lockfile records an installed version, so this
// comparison only holds while package.json pins an exact version.
const vallyPin = packageJson.devDependencies[vallyPkg];
assert.match(vallyPin, /^\d+\.\d+\.\d+$/, `${vallyPkg} must be pinned exactly`);
assert.equal(lockfile.lockfileVersion, 3, "lockfile format changed; revisit the pin parity checks below");
assert.equal(
  lockfile.packages[""].devDependencies[vallyPkg],
  vallyPin,
  "lockfile root devDependency pin drifted from package.json",
);
assert.equal(
  lockfile.packages[`node_modules/${vallyPkg}`].version,
  vallyPin,
  "installed vally version drifted from the declared pin",
);
assert.match(
  lintWorkflow,
  new RegExp(`${vallyPkg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}@${vallyPin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
  "skill-lint.yml global vally version drifted from the skill pin",
);

console.log("registration parity passed");
