import { lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { execFileSync } from "node:child_process";

const FULL_COMMIT_SHA_RE = /^[0-9a-f]{40}$/i;
const SENTINEL_RE = /__[A-Z][A-Z0-9_]*__/g;
const WORKFLOW_EXT_RE = /\.ya?ml$/i;
const ALLOWED_TRIGGERS = new Set(["push", "workflow_dispatch"]);
const MAX_JOB_TIMEOUT_MINUTES = 360;
const ALLOWED_ACTIONS = new Set([
  "actions/checkout",
  "actions/configure-pages",
  "actions/deploy-pages",
  "actions/jekyll-build-pages",
  "actions/setup-node",
  "actions/upload-pages-artifact",
  "withastro/action",
]);
const ALLOWED_PERMISSIONS = new Map([
  ["contents", new Set(["read"])],
  ["pages", new Set(["read", "write"])],
  ["id-token", new Set(["write"])],
]);
const LEGACY_ACTION_PINS = new Map([
  ["actions/checkout@v4", "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1"],
  ["actions/configure-pages@v5", "actions/configure-pages@45bfe0192ca1faeb007ade9deae92b16b8254a0d"],
  ["actions/upload-pages-artifact@v3", "actions/upload-pages-artifact@fc324d3547104276b827a68afc52ff2a11cc49c9"],
  ["actions/deploy-pages@v4", "actions/deploy-pages@cd2ce8fcbc39b97be8ca5fce6e763baed58fa128"],
  ["actions/setup-node@v4", "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020"],
  ["withastro/action@v2", "withastro/action@e84f40bd8d2caa9e768ec82ad30dd81f0b280853"],
  ["actions/jekyll-build-pages@v1", "actions/jekyll-build-pages@44a6e6beabd48582f863aeeb6cb2151cc1716697"],
]);

function looksBinary(buffer) {
  const limit = Math.min(buffer.length, 8192);
  for (let index = 0; index < limit; index++) {
    if (buffer[index] === 0) return true;
  }
  return false;
}

function indentation(line) {
  return line.match(/^\s*/)[0].length;
}

function yamlBlock(lines, start) {
  const baseIndent = indentation(lines[start]);
  const block = [];
  for (let index = start + 1; index < lines.length; index++) {
    const line = lines[index];
    if (!line.trim() || line.trimStart().startsWith("#")) {
      block.push(line);
      continue;
    }
    if (indentation(line) <= baseIndent) break;
    block.push(line);
  }
  return block;
}

function regularFiles(root) {
  const files = [];
  const stack = [resolve(root)];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) throw new Error(`Template contains a symbolic link: ${full}`);
      if (stat.isDirectory()) stack.push(full);
      else if (stat.isFile()) files.push(full);
    }
  }
  return files;
}

function parseInlineMap(value) {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;
  const entries = trimmed.slice(1, -1).split(",").map((part) => part.trim()).filter(Boolean);
  return entries.map((entry) => {
    const match = entry.match(/^([a-z-]+)\s*:\s*([a-z-]+)$/i);
    if (!match) throw new Error(`Unsupported inline permissions entry: ${entry}`);
    return [match[1], match[2]];
  });
}

function permissionsAt(lines, index, file) {
  const value = lines[index].slice(lines[index].indexOf(":") + 1).trim();
  if (value) {
    const entries = parseInlineMap(value);
    if (!entries) throw new Error(`Unsafe workflow ${file}: permissions must be an explicit mapping.`);
    return entries;
  }
  return yamlBlock(lines, index)
    .filter((child) => child.trim() && !child.trimStart().startsWith("#"))
    .map((child) => {
      const match = child.trim().match(/^([a-z-]+)\s*:\s*([a-z-]+)$/i);
      if (!match) throw new Error(`Unsafe workflow ${file}: unsupported permissions entry "${child.trim()}".`);
      return [match[1], match[2]];
    });
}

function assertSafePermissions(lines, file) {
  const permissionLines = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => /^\s*permissions\s*:/.test(line));
  if (!permissionLines.length) throw new Error(`Unsafe workflow ${file}: missing explicit permissions.`);
  if (!permissionLines.some(({ line }) => indentation(line) === 0)) {
    throw new Error(`Unsafe workflow ${file}: top-level permissions are required so every job is restricted.`);
  }

  for (const { line, index } of permissionLines) {
    const entries = permissionsAt(lines, index, file);
    if (!entries.length) throw new Error(`Unsafe workflow ${file}: permissions mapping is empty.`);
    for (const [scope, access] of entries) {
      if (!ALLOWED_PERMISSIONS.get(scope)?.has(access)) {
        throw new Error(`Unsafe workflow ${file}: permission ${scope}: ${access} is not allowed.`);
      }
    }
    if (
      indentation(line) === 0 &&
      entries.some(([scope, access]) => scope !== "contents" || access !== "read")
    ) {
      throw new Error(`Unsafe workflow ${file}: top-level permissions must be limited to contents: read.`);
    }
  }
}

function assertSafeTriggers(lines, file) {
  const onIndex = lines.findIndex((line) => /^on\s*:/.test(line));
  if (onIndex < 0) throw new Error(`Unsafe workflow ${file}: missing explicit trigger.`);
  const value = lines[onIndex].slice(lines[onIndex].indexOf(":") + 1).trim();
  let triggers;
  if (!value) {
    const block = yamlBlock(lines, onIndex).filter((line) => line.trim() && !line.trimStart().startsWith("#"));
    const directIndent = Math.min(...block.map(indentation));
    triggers = block
      .filter((line) => indentation(line) === directIndent && /^\s{1,}[a-zA-Z_][\w-]*\s*:/.test(line))
      .map((line) => line.trim().split(":")[0]);
  } else if (value.startsWith("[") && value.endsWith("]")) {
    triggers = value.slice(1, -1).split(",").map((item) => item.trim()).filter(Boolean);
  } else {
    triggers = [value];
  }

  if (!triggers.length || triggers.some((trigger) => !ALLOWED_TRIGGERS.has(trigger))) {
    throw new Error(`Unsafe workflow ${file}: allowed triggers are push and workflow_dispatch.`);
  }
}

function assertRunnerJobsHaveTimeouts(lines, file) {
  for (let index = 0; index < lines.length; index++) {
    if (!/^\s{4}runs-on\s*:\s*\S+/.test(lines[index])) continue;
    let start = index;
    while (start > 0 && !/^\s{2}[A-Za-z0-9_-]+\s*:\s*$/.test(lines[start])) start--;
    const block = yamlBlock(lines, start);
    const timeout = block
      .map((line) => line.match(/^\s{4}timeout-minutes\s*:\s*(\d+)\s*$/))
      .find(Boolean);
    if (
      !timeout ||
      Number(timeout[1]) < 1 ||
      Number(timeout[1]) > MAX_JOB_TIMEOUT_MINUTES
    ) {
      throw new Error(
        `Unsafe workflow ${file}: every runner job timeout-minutes must be between 1 and ${MAX_JOB_TIMEOUT_MINUTES}.`,
      );
    }
  }
}

function stepBlock(lines, usesIndex) {
  const usesIndent = indentation(lines[usesIndex]);
  const stepIndent = /^\s*-\s+/.test(lines[usesIndex]) ? usesIndent : Math.max(0, usesIndent - 2);
  const block = [lines[usesIndex]];
  for (let index = usesIndex + 1; index < lines.length; index++) {
    const line = lines[index];
    if (line.trim() && indentation(line) <= stepIndent && /^\s*-\s+/.test(line)) break;
    if (line.trim() && indentation(line) < stepIndent) break;
    block.push(line);
  }
  return block;
}

function checkoutDisablesCredentials(lines, usesIndex) {
  const block = stepBlock(lines, usesIndex);
  const usesIndent = indentation(lines[usesIndex]);
  const propertyIndent = /^\s*-\s+/.test(lines[usesIndex]) ? usesIndent + 2 : usesIndent;
  const withIndex = block.findIndex((line, index) => {
    if (index === 0) return false;
    const withoutComment = line.replace(/\s+#.*$/, "").trimEnd();
    return indentation(line) === propertyIndent && /^\s*with\s*:\s*$/.test(withoutComment);
  });
  if (withIndex < 0) return false;
  const values = [];
  for (let index = withIndex + 1; index < block.length; index++) {
    const line = block[index];
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    if (indentation(line) <= propertyIndent) break;
    const withoutComment = line.replace(/\s+#.*$/, "").trim();
    if (indentation(line) === propertyIndent + 2 && /^persist-credentials\s*:/.test(withoutComment)) {
      values.push(withoutComment.slice(withoutComment.indexOf(":") + 1).trim());
    }
  }
  return values.length === 1 && values[0].toLowerCase() === "false";
}

function runScripts(lines, file) {
  const scripts = [];
  for (let index = 0; index < lines.length; index++) {
    const match = lines[index].match(/^\s*(?:-\s*)?run\s*:\s*(.*)$/);
    if (!match) continue;
    const rawHeader = match[1].trim();
    if (rawHeader.includes("${{")) {
      throw new Error(`Unsafe workflow ${file}: direct GitHub context interpolation in run is not allowed.`);
    }
    const header = rawHeader.replace(/\s+#.*$/, "").trim();
    if (/^>/.test(header)) {
      throw new Error(`Unsafe workflow ${file}: folded run blocks are not supported.`);
    }
    if (header === "") {
      scripts.push(yamlBlock(lines, index).join("\n"));
    } else if (/^\|(?:[1-9][+-]?|[+-][1-9]?)?$/.test(header)) {
      scripts.push(yamlBlock(lines, index).join("\n"));
    } else if (/^[|>]/.test(header)) {
      throw new Error(`Unsafe workflow ${file}: unsupported run block scalar.`);
    } else {
      scripts.push(header);
    }
  }
  return scripts;
}

function assertSafeInstallCommands(script, file) {
  const lines = script.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  const lifecycleCommand = /\b(?:npm|pnpm|yarn|bun)\b.*\b(?:ci|install|i)\b/i;
  const safeCommands = [
    /^npm(?:\s+--prefix\s+[A-Za-z0-9._/-]+)?\s+(?:ci|install|i)\s+--ignore-scripts(?:=true)?(?:\s+--(?:no-audit|no-fund))*$/i,
    /^pnpm(?:\s+--dir\s+[A-Za-z0-9._/-]+)?\s+(?:install|i)\s+--ignore-scripts(?:=true)?(?:\s+--(?:no-audit|no-fund))*$/i,
    /^yarn\s+install\s+--mode(?:=|\s+)skip-builds$/i,
    /^bun\s+install\s+--ignore-scripts(?:=true)?(?:\s+--no-save)*$/i,
  ];
  for (const line of lines) {
    if (!lifecycleCommand.test(line)) continue;
    if (!safeCommands.some((pattern) => pattern.test(line))) {
      throw new Error(`Unsafe workflow ${file}: lifecycle-capable installs must be standalone and disable scripts.`);
    }
  }
}

function assertCanonicalWorkflowSyntax(lines, file) {
  for (const line of lines) {
    const content = line.replace(/\s+#.*$/, "");
    if (!content.trim()) continue;
    const structural = content.replace(/\$\{\{.*?\}\}/g, "");
    if (/\t/.test(content)) throw new Error(`Unsafe workflow ${file}: tabs are not allowed in YAML indentation.`);
    if (/^\s*(?:-\s*)?["'][^"']+["']\s*:/.test(content) || /^\s*\?\s/.test(content)) {
      throw new Error(`Unsafe workflow ${file}: quoted or explicit mapping keys are not allowed.`);
    }
    if (/[{}]/.test(structural) && !/^\s*permissions\s*:\s*\{[^{}]*\}\s*$/.test(structural)) {
      throw new Error(`Unsafe workflow ${file}: unsupported flow-style mappings are not allowed.`);
    }
    if (/(?:^|\s)(?:&|\*|!)[A-Za-z0-9_-]+/.test(content) || /^\s*<<\s*:/.test(content)) {
      throw new Error(`Unsafe workflow ${file}: YAML tags, anchors, aliases, and merge keys are not allowed.`);
    }
  }
}

export function assertFullCommitSha(ref) {
  if (!FULL_COMMIT_SHA_RE.test(String(ref || ""))) {
    throw new Error(`Registry revision must be a full 40-character commit SHA, got "${ref || ""}". Branches and tags are not allowed.`);
  }
  return String(ref).toLowerCase();
}

export function resolveInside(root, child, label = "Path") {
  const resolvedRoot = resolve(root);
  const resolvedChild = resolve(resolvedRoot, child);
  const rel = relative(resolvedRoot, resolvedChild);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`${label} resolves outside ${resolvedRoot}: ${child}`);
  }
  return resolvedChild;
}

export function assertNoSymlinks(root) {
  const stack = [resolve(root)];
  while (stack.length) {
    const current = stack.pop();
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error(`Template contains a symbolic link: ${current}`);
    if (!stat.isDirectory()) continue;
    for (const entry of readdirSync(current)) stack.push(join(current, entry));
  }
}

export function validateWorkflowFile(file) {
  const text = readFileSync(file, "utf8");
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  assertCanonicalWorkflowSyntax(lines, file);
  assertSafeTriggers(lines, file);
  assertSafePermissions(lines, file);
  assertRunnerJobsHaveTimeouts(lines, file);

  for (let index = 0; index < lines.length; index++) {
    if (!/^\s*(?:-\s*)?uses\s*:/.test(lines[index])) continue;
    const uses = lines[index].match(/^\s*(?:-\s*)?uses\s*:\s*([^#\s]+)\s*(?:#.*)?$/);
    if (!uses) throw new Error(`Unsafe workflow ${file}: unsupported uses syntax.`);
    const action = uses[1];
    const remote = action.match(/^([^@\s]+)@([0-9a-f]{40})$/i);
    if (!remote) throw new Error(`Unsafe workflow ${file}: action "${action}" is not pinned to a full commit SHA.`);
    const actionName = remote[1].toLowerCase();
    if (!ALLOWED_ACTIONS.has(actionName)) {
      throw new Error(`Unsafe workflow ${file}: action "${remote[1]}" is not allowed.`);
    }
    if (actionName === "actions/configure-pages") {
      let jobStart = index;
      while (jobStart > 0 && !/^\s{2}[A-Za-z0-9_-]+\s*:\s*$/.test(lines[jobStart])) jobStart--;
      const jobEnd = jobStart + yamlBlock(lines, jobStart).length + 1;
      const jobPermissionsIndex = lines.findIndex(
        (line, lineIndex) =>
          lineIndex > jobStart &&
          lineIndex < jobEnd &&
          /^\s{4}permissions\s*:/.test(line),
      );
      const workflowPermissionsIndex = lines.findIndex(
        (line) => indentation(line) === 0 && /^permissions\s*:/.test(line),
      );
      const effectivePermissionsIndex = jobPermissionsIndex >= 0
        ? jobPermissionsIndex
        : workflowPermissionsIndex;
      const hasPagesAccess = permissionsAt(lines, effectivePermissionsIndex, file).some(
        ([scope, access]) =>
          scope.toLowerCase() === "pages" &&
          /^(?:read|write)$/i.test(access),
      );
      if (!hasPagesAccess) {
        throw new Error(
          `Unsafe workflow ${file}: the job using actions/configure-pages must have effective pages read or write access.`,
        );
      }
    }
    if (actionName === "actions/checkout") {
      if (!checkoutDisablesCredentials(lines, index)) {
        throw new Error(`Unsafe workflow ${file}: actions/checkout must set persist-credentials: false.`);
      }
    }
  }

  for (const script of runScripts(lines, file)) {
    if (script.includes("${{")) {
      throw new Error(`Unsafe workflow ${file}: direct GitHub context interpolation in run is not allowed.`);
    }
    assertSafeInstallCommands(script, file);
  }
}

export function validateStagedTree(dir) {
  for (const file of regularFiles(dir)) {
    const rel = relative(dir, file).split(sep).join("/");
    if (rel.startsWith(".github/workflows/") && WORKFLOW_EXT_RE.test(rel)) validateWorkflowFile(file);
  }
}

export function validateTemplateSentinels(dir, allowedSentinels) {
  const allowed = new Set(allowedSentinels);
  for (const file of regularFiles(dir)) {
    const buffer = readFileSync(file);
    if (looksBinary(buffer)) continue;
    const sentinels = buffer.toString("utf8").match(SENTINEL_RE) || [];
    const unresolved = sentinels.find((sentinel) => !allowed.has(sentinel));
    if (unresolved) throw new Error(`Unresolved template sentinel ${unresolved} in ${file}.`);
  }
}

export function normalizePinnedLegacyWorkflows(dir) {
  for (const file of regularFiles(dir)) {
    const rel = relative(dir, file).split(sep).join("/");
    if (!rel.startsWith(".github/workflows/") || !WORKFLOW_EXT_RE.test(rel)) continue;
    let text = readFileSync(file, "utf8");
    for (const [tag, pin] of LEGACY_ACTION_PINS) text = text.replaceAll(tag, pin);
    const lines = text.replace(/\r\n?/g, "\n").split("\n");
    const topPermissionsIndex = lines.findIndex((line) => line === "permissions:");
    if (topPermissionsIndex >= 0) {
      let end = topPermissionsIndex + 1;
      while (end < lines.length && (!lines[end].trim() || indentation(lines[end]) > 0)) end++;
      for (let index = end - 1; index > topPermissionsIndex; index--) {
        if (/^  (?:pages|id-token):/.test(lines[index])) lines.splice(index, 1);
      }
    }
    const pageActionIndexes = lines
      .map((line, index) =>
        /^\s*(?:-\s+)?uses:\s+actions\/(?:configure|deploy)-pages@[0-9a-f]{40}(?:\s+#.*)?$/i.test(line)
          ? index
          : -1
      )
      .filter((index) => index >= 0);
    for (const actionIndex of [...pageActionIndexes].reverse()) {
      let jobStart = actionIndex;
      while (jobStart > 0 && !/^\s{2}[A-Za-z0-9_-]+\s*:\s*$/.test(lines[jobStart])) jobStart--;
      let jobEnd = actionIndex + 1;
      while (jobEnd < lines.length && !/^\s{2}[A-Za-z0-9_-]+\s*:\s*$/.test(lines[jobEnd])) jobEnd++;
      const deploys = lines
        .slice(jobStart, jobEnd)
        .some((line) => /uses:\s+actions\/deploy-pages@/i.test(line));
      const permissionsIndex = lines.findIndex(
        (line, index) => index > jobStart && index < jobEnd && line === "    permissions:",
      );
      if (permissionsIndex < 0) {
        const entries = [
          "    permissions:",
          "      contents: read",
          `      pages: ${deploys ? "write" : "read"}`,
        ];
        if (deploys) entries.push("      id-token: write");
        lines.splice(jobStart + 1, 0, ...entries);
      }
    }
    const runnerIndexes = lines
      .map((line, index) => (/^\s{4}runs-on\s*:\s*\S+/.test(line) ? index : -1))
      .filter((index) => index >= 0);
    for (const runnerIndex of [...runnerIndexes].reverse()) {
      let jobStart = runnerIndex;
      while (jobStart > 0 && !/^\s{2}[A-Za-z0-9_-]+\s*:\s*$/.test(lines[jobStart])) jobStart--;
      let jobEnd = runnerIndex + 1;
      while (jobEnd < lines.length && !/^\s{2}[A-Za-z0-9_-]+\s*:\s*$/.test(lines[jobEnd])) jobEnd++;
      const hasTimeout = lines
        .slice(jobStart, jobEnd)
        .some((line) => /^\s{4}timeout-minutes\s*:\s*[1-9]\d*\s*$/.test(line));
      if (!hasTimeout) lines.splice(runnerIndex + 1, 0, "    timeout-minutes: 10");
    }
    const checkoutIndexes = lines
      .map((line, index) =>
        /^\s*(?:-\s+)?uses:\s+actions\/checkout@[0-9a-f]{40}(?:\s+#.*)?$/i.test(line)
          ? index
          : -1
      )
      .filter((index) => index >= 0);
    for (const checkoutIndex of [...checkoutIndexes].reverse()) {
      const match = lines[checkoutIndex].match(/^(\s*)(-\s+)?uses:/i);
      const stepIndent = match[2]
        ? match[1]
        : match[1].slice(0, Math.max(0, match[1].length - 2));
      let stepEnd = lines.findIndex(
        (line, index) =>
          index > checkoutIndex &&
          new RegExp(`^${stepIndent.replaceAll(" ", "\\s")}-\\s+`).test(line),
      );
      if (stepEnd < 0) stepEnd = lines.length;
      const withIndex = lines.findIndex(
        (line, index) =>
          index > checkoutIndex &&
          index < stepEnd &&
          line === `${stepIndent}  with:`,
      );
      if (withIndex < 0) {
        lines.splice(
          checkoutIndex + 1,
          0,
          `${stepIndent}  with:`,
          `${stepIndent}    persist-credentials: false`,
        );
        continue;
      }
      const persistIndex = lines.findIndex(
        (line, index) =>
          index > withIndex &&
          index < stepEnd &&
          line.startsWith(`${stepIndent}    persist-credentials:`),
      );
      if (persistIndex < 0) {
        lines.splice(withIndex + 1, 0, `${stepIndent}    persist-credentials: false`);
      } else {
        lines[persistIndex] = `${stepIndent}    persist-credentials: false`;
      }
    }
    text = lines.join("\n");
    text = text.replace(/^(\s*run:\s*npm install)\s*$/gim, "$1 --ignore-scripts");
    text = text.replace(/^(\s*node-version:\s*)20\s*$/gim, (line, prefix) => `${prefix}24`);
    writeFileSync(file, text);
  }
}

export function assertRegistryTreeHasNoSymlinks(root) {
  let tree;
  try {
    tree = execFileSync("git", ["ls-tree", "-r", "--full-tree", "HEAD"], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
    }).toString();
  } catch (error) {
    const detail = error.stderr ? error.stderr.toString().trim() : error.message;
    throw new Error(`Failed to inspect registry tree: ${detail}`);
  }
  const symlink = tree.split(/\r?\n/).find((line) => line.startsWith("120000 "));
  if (symlink) {
    const path = symlink.split("\t")[1] || "(unknown)";
    throw new Error(`Registry contains a symbolic link: ${path}`);
  }
}
