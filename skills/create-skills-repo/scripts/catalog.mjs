import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { validateRelativeTemplatePath } from "./config.mjs";

async function walk(root, current = root) {
  const files = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const absolute = path.join(current, entry.name);
    const metadata = await lstat(absolute);
    if (metadata.isSymbolicLink()) {
      throw new Error(`Catalog output contains a symlink: ${absolute}.`);
    }
    if (metadata.isDirectory()) files.push(...await walk(root, absolute));
    else if (metadata.isFile()) files.push(absolute);
  }
  return files;
}

function patchCatalogWorkflow(source, relativePath) {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const uploadMatches = lines
    .map((line, index) => {
      const match = line.match(
        /^(\s*)(-\s+)?uses:\s+actions\/upload-pages-artifact@[a-f0-9]{40}(?:\s+#.*)?$/,
      );
      if (!match) return null;
      const stepIndent = match[2]
        ? match[1]
        : match[1].slice(0, Math.max(0, match[1].length - 2));
      return { index, stepIndent };
    })
    .filter(Boolean);
  if (uploadMatches.length !== 1) {
    throw new Error(
      `Catalog workflow ${relativePath} must contain one pinned upload-pages-artifact step.`,
    );
  }
  const { index: actionIndex, stepIndent: actionIndent } = uploadMatches[0];
  let stepEnd = lines.findIndex(
    (line, index) =>
      index > actionIndex &&
      new RegExp(`^${actionIndent.replaceAll(" ", "\\s")}-\\s+`).test(line),
  );
  if (stepEnd < 0) stepEnd = lines.length;
  const withIndex = lines.findIndex(
    (line, index) =>
      index > actionIndex &&
      index < stepEnd &&
      line === `${actionIndent}  with:`,
  );
  if (withIndex < 0) {
    throw new Error(
      `Catalog workflow ${relativePath} must configure upload-pages-artifact inputs.`,
    );
  }
  const pathIndexes = lines
    .map((line, index) =>
      index > withIndex &&
      index < stepEnd &&
      line.startsWith(`${actionIndent}    path:`)
        ? index
        : -1
    )
    .filter((index) => index >= 0);
  if (pathIndexes.length > 1) {
    throw new Error(
      `Catalog workflow ${relativePath} must have one standalone with.path value.`,
    );
  }
  if (pathIndexes.length === 0) {
    lines.splice(withIndex + 1, 0, `${actionIndent}    path: site/dist`);
  } else {
    if (
      !new RegExp(`^${actionIndent}\\s{4}path:\\s*["']?(?:\\./)?dist/?["']?\\s*$`).test(
        lines[pathIndexes[0]],
      )
    ) {
      throw new Error(
        `Catalog workflow ${relativePath} must have one standalone with.path value.`,
      );
    }
    lines[pathIndexes[0]] = `${actionIndent}    path: site/dist`;
  }

  const setupNodeMatches = lines.filter((line) =>
    /^\s*(?:-\s+)?uses:\s+actions\/setup-node@[a-f0-9]{40}(?:\s+#.*)?$/.test(line)
  );
  if (setupNodeMatches.length !== 1) {
    throw new Error(
      `Catalog workflow ${relativePath} must contain one pinned setup-node step.`,
    );
  }
  const cachePathIndexes = lines
    .map((line, index) =>
      /^\s*cache-dependency-path:\s*["']?(?:\.\/)?package-lock\.json["']?\s*$/.test(line)
        ? index
        : -1
    )
    .filter((index) => index >= 0);
  if (cachePathIndexes.length !== 1) {
    throw new Error(
      `Catalog workflow ${relativePath} must configure one package-lock cache path.`,
    );
  }
  lines[cachePathIndexes[0]] = lines[cachePathIndexes[0]].replace(
    /(?:\.\/)?package-lock\.json/,
    "site/package-lock.json",
  );

  const runIndexes = lines
    .map((line, index) =>
      /^\s*(?:-\s+)?run:\s+npm (?:ci\b|run build\b)/.test(line) ? index : -1
    )
    .filter((index) => index >= 0);
  if (runIndexes.length !== 2) {
    throw new Error(
      `Catalog workflow ${relativePath} must contain one npm install and one npm build step.`,
    );
  }
  for (const index of [...runIndexes].reverse()) {
    if (/(?:--prefix|--dir)\b/.test(lines[index])) {
      throw new Error(
        `Catalog workflow ${relativePath} must scope npm commands with working-directory.`,
      );
    }
    const runPrefix = lines[index].match(/^(\s*)(-\s+)?run:/);
    const indent = runPrefix[2] ? `${runPrefix[1]}  ` : runPrefix[1];
    const next = lines[index + 1] ?? "";
    if (/^\s*working-directory:/.test(next)) {
      if (!/^\s*working-directory:\s*["']?\.\/?["']?\s*$/.test(next)) {
        throw new Error(
          `Catalog workflow ${relativePath} has a non-root npm working-directory.`,
        );
      }
      lines[index + 1] = `${indent}working-directory: site`;
    } else {
      lines.splice(index + 1, 0, `${indent}working-directory: site`);
    }
  }
  return lines.join("\n");
}

function ensureJobTimeouts(source, relativePath) {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const jobStarts = [];
  const jobsIndex = lines.findIndex((line) => /^jobs:\s*$/.test(line));
  if (jobsIndex < 0) {
    throw new Error(`Catalog workflow ${relativePath} has no jobs mapping.`);
  }
  for (let index = jobsIndex + 1; index < lines.length; index += 1) {
    if (/^\S/.test(lines[index]) && lines[index].trim()) break;
    if (/^  [A-Za-z0-9_-]+:\s*$/.test(lines[index])) jobStarts.push(index);
  }
  if (jobStarts.length === 0) {
    throw new Error(`Catalog workflow ${relativePath} has no jobs.`);
  }
  for (const start of [...jobStarts].reverse()) {
    const next = lines.findIndex(
      (line, index) =>
        index > start &&
        (/^  [A-Za-z0-9_-]+:\s*$/.test(line) || (/^\S/.test(line) && line.trim())),
    );
    const end = next < 0 ? lines.length : next;
    const block = lines.slice(start, end);
    if (block.some((line) => /^    timeout-minutes:\s*\d+\s*$/.test(line))) {
      continue;
    }
    const runsOnOffset = block.findIndex((line) => /^    runs-on:\s*\S+/.test(line));
    if (runsOnOffset < 0) {
      throw new Error(
        `Catalog workflow ${relativePath} job at line ${start + 1} has no runs-on.`,
      );
    }
    lines.splice(start + runsOnOffset + 1, 0, "    timeout-minutes: 15");
  }
  return lines.join("\n");
}

export async function composeCatalog(catalogRoot, repositoryRoot) {
  const plan = [];
  for (const absolute of await walk(catalogRoot)) {
    const relativePath = path.relative(catalogRoot, absolute).replaceAll("\\", "/");
    validateRelativeTemplatePath(relativePath, "catalog output path");
    if (
      relativePath.startsWith("src/content/skills/") ||
      relativePath.startsWith("public/images/thumb-")
    ) {
      continue;
    }
    const isWorkflow = relativePath.startsWith(".github/workflows/");
    if (isWorkflow && relativePath !== ".github/workflows/deploy.yml") {
      throw new Error(`Unexpected catalog workflow: ${relativePath}.`);
    }
    const destinationRelative = isWorkflow
      ? ".github/workflows/deploy-pages.yml"
      : `site/${relativePath}`;
    validateRelativeTemplatePath(destinationRelative, "catalog destination path");
    const destination = path.join(repositoryRoot, destinationRelative);
    let content = await readFile(absolute);
    if (isWorkflow) {
      content = Buffer.from(
        ensureJobTimeouts(
          patchCatalogWorkflow(content.toString("utf8"), relativePath),
          relativePath,
        ),
        "utf8",
      );
    }
    const collision = await lstat(destination).then(
      () => true,
      (error) => {
        if (error.code === "ENOENT") return false;
        throw error;
      },
    );
    if (collision) {
      throw new Error(`Catalog destination already exists: ${destinationRelative}.`);
    }
    plan.push({ destination, destinationRelative, content });
  }
  const output = plan.map(({ destinationRelative }) => destinationRelative);
  for (const required of [
    "site/package.json",
    "site/package-lock.json",
    "site/astro.config.mjs",
    "site/src/pages/index.astro",
    ".github/workflows/deploy-pages.yml",
  ]) {
    if (!output.includes(required)) {
      throw new Error(`create-gh-pages-site did not produce ${required}.`);
    }
  }
  for (const { destination, content } of plan) {
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, content, { flag: "wx" });
  }
  await Promise.all([
    mkdir(path.join(repositoryRoot, "site", "src", "content", "skills"), {
      recursive: true,
    }),
    mkdir(path.join(repositoryRoot, "site", "public", "images"), {
      recursive: true,
    }),
  ]);
  return output.sort();
}
