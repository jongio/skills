#!/usr/bin/env node
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_CONFIG = Object.freeze({
  branch: "repo-maintain/automated",
  escalationLabel: "needs-maintainer-review",
  cooldownDays: 7,
  coverageThreshold: 80,
  autoMerge: true,
  copilotReview: false,
  trustedAuthors: [],
  repos: [],
});

export const DIMENSION_MAX = Object.freeze({
  ci: 20,
  coverage: 20,
  deps: 15,
  secops: 15,
  docs: 10,
  skillsEvals: 10,
  backlog: 10,
});

const STEALTH_PATTERNS = [
  { id: "cwe-id", regex: /\bCWE-\d+\b/i },
  { id: "cve-id", regex: /\bCVE-\d{4}-\d{4,}\b/i },
  { id: "ghsa-id", regex: /\bGHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}\b/i },
  { id: "cvss-score", regex: /\bCVSS\b/i },
  { id: "zero-day", regex: /\b(?:0-day|zero-day)\b/i },
  { id: "framework-label", regex: /\b(?:OWASP|STRIDE)\b/i },
  { id: "exploit-term", regex: /\b(?:exploit(?:able|ation|s)?|vulnerabilit(?:y|ies)|vulnerable|attack vector|payload)\b/i },
  { id: "vuln-class", regex: /\b(?:command injection|path traversal|sql injection|sqli|xss|ssrf|rce)\b/i },
];

export function parseCodeownersMaintainer(content) {
  if (typeof content !== "string" || !content.trim()) return null;
  let globalOwner = null;
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    if (parts[0] !== "*" || parts.length < 2) continue;
    const handles = parts
      .slice(1)
      .filter((token) => token.startsWith("@") && !token.includes("/"))
      .map((token) => token.slice(1));
    if (handles.length > 0) {
      globalOwner = handles[0];
    }
  }
  return globalOwner;
}

export function resolveConfig({
  cwd = process.cwd(),
  policyPath = null,
  cliFlags = {},
  repoOwner = null,
  authUser = null,
  visibility = "PUBLIC",
} = {}) {
  const candidates = policyPath
    ? [resolve(cwd, policyPath)]
    : [
        join(cwd, ".github", "repo-maintain.json"),
        join(cwd, ".github", "maintain.json"),
        join(cwd, ".maintain.json"),
      ];

  let fileConfig = {};
  let configSource = null;
  if (policyPath) {
    const explicitPath = resolve(cwd, policyPath);
    if (!existsSync(explicitPath)) {
      throw new Error(`Explicit policy file not found: ${policyPath}`);
    }
    fileConfig = JSON.parse(readFileSync(explicitPath, "utf8"));
    configSource = explicitPath;
  } else {
    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        fileConfig = JSON.parse(readFileSync(candidate, "utf8"));
        configSource = candidate;
        break;
      }
    }
  }

  let codeownersMaintainer = null;
  for (const coPath of [join(cwd, ".github", "CODEOWNERS"), join(cwd, "CODEOWNERS")]) {
    if (existsSync(coPath)) {
      codeownersMaintainer = parseCodeownersMaintainer(readFileSync(coPath, "utf8"));
      if (codeownersMaintainer) break;
    }
  }

  const merged = {
    ...DEFAULT_CONFIG,
    ...fileConfig,
    ...Object.fromEntries(Object.entries(cliFlags).filter(([, v]) => v !== undefined)),
  };

  let maintainer = null;
  let maintainerSource = null;
  if (cliFlags.maintainer) {
    maintainer = String(cliFlags.maintainer).replace(/^@/, "");
    maintainerSource = "cli";
  } else if (fileConfig.maintainer) {
    maintainer = String(fileConfig.maintainer).replace(/^@/, "");
    maintainerSource = "policy-file";
  } else if (codeownersMaintainer) {
    maintainer = codeownersMaintainer;
    maintainerSource = "codeowners";
  } else if (repoOwner) {
    maintainer = String(repoOwner).replace(/^@/, "");
    maintainerSource = "repo-owner";
  } else if (authUser) {
    maintainer = String(authUser).replace(/^@/, "");
    maintainerSource = "auth-user";
  }

  const normalizedVisibility = String(visibility || "PUBLIC").toUpperCase();
  const stealthMode = normalizedVisibility !== "PRIVATE";
  const strictAutoMerge = merged.autoMerge === true;
  const strictCopilotReview = merged.copilotReview === true;

  return {
    ...merged,
    autoMerge: strictAutoMerge,
    copilotReview: strictCopilotReview,
    maintainer,
    maintainerSource,
    configSource,
    visibility: normalizedVisibility,
    stealthMode,
    prDeliveryArgs: [
      `--merge=${strictAutoMerge ? "auto" : "approval"}`,
      ...(strictCopilotReview ? [] : ["--no-copilot"]),
    ],
  };
}

export function sanitizeRepoKey(repo) {
  return String(repo || "unknown__repo")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "__");
}

export function getReceiptPath(stateDir, repo) {
  const baseDir = stateDir || join(homedir(), ".copilot", "repo-maintain");
  return join(baseDir, `${sanitizeRepoKey(repo)}.json`);
}

export function readReceipt(stateDir, repo) {
  const path = getReceiptPath(stateDir, repo);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

export const REQUIRED_CORE_PHASES = Object.freeze([
  "governance",
  "deps",
  "secops",
  "refactor",
  "coverage",
  "docs",
]);

export function writeReceipt(stateDir, repo, receipt = {}) {
  const path = getReceiptPath(stateDir, repo);
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const phasesRun = Array.isArray(receipt.phasesRun) ? receipt.phasesRun : [];
  const hasFailedPhases =
    receipt.incomplete === true ||
    (receipt.failedPhases !== undefined &&
      (!Array.isArray(receipt.failedPhases) || receipt.failedPhases.length > 0));
  const requiredPhases =
    receipt.skillsEvalsApplicable === false
      ? REQUIRED_CORE_PHASES
      : [...REQUIRED_CORE_PHASES, "skills", "evals"];
  const coversAllPhases =
    !hasFailedPhases &&
    Array.isArray(receipt.phasesRun) &&
    requiredPhases.every((phase) => phasesRun.includes(phase));
  const payload = {
    ...receipt,
    repo,
    phasesRun,
    partialRun: receipt.partialRun === true || !coversAllPhases,
    timestamp: receipt.timestamp || new Date().toISOString(),
  };
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  chmodSync(path, 0o600);
  return payload;
}

export function evaluateSkipGate({
  receipt = null,
  headSha = null,
  newAdvisories = null,
  failingCiRuns = null,
  untriagedItems = null,
  force = false,
  stages = [],
  stagesSpecified = false,
} = {}) {
  if (force) {
    return { skip: false, reason: "forced run requested (--force)" };
  }
  if (stagesSpecified || (Array.isArray(stages) && stages.length > 0)) {
    return {
      skip: false,
      reason: `explicit stages requested (${Array.isArray(stages) ? stages.join(",") : ""})`,
    };
  }
  if (!receipt || typeof receipt !== "object" || !receipt.lastMaintainSha) {
    return { skip: false, reason: "no prior maintenance receipt found" };
  }
  const parsedTimestamp =
    typeof receipt.timestamp === "string" && receipt.timestamp.trim() !== ""
      ? Date.parse(receipt.timestamp)
      : NaN;
  if (!Number.isFinite(parsedTimestamp) || parsedTimestamp > Date.now()) {
    return {
      skip: false,
      reason: "prior maintenance receipt has a missing, malformed, or future timestamp",
    };
  }
  const invalidOrNonEmptyFailedPhases =
    receipt.failedPhases !== undefined &&
    (!Array.isArray(receipt.failedPhases) || receipt.failedPhases.length > 0);
  if (receipt.incomplete || invalidOrNonEmptyFailedPhases) {
    return {
      skip: false,
      reason: `prior maintenance receipt has unresolved failed phases (${Array.isArray(receipt.failedPhases) ? receipt.failedPhases.join(",") : "incomplete"})`,
    };
  }
  const requiredPhases =
    receipt.skillsEvalsApplicable === false
      ? REQUIRED_CORE_PHASES
      : [...REQUIRED_CORE_PHASES, "skills", "evals"];
  const coversAllPhases =
    receipt.partialRun !== true &&
    Array.isArray(receipt.phasesRun) &&
    requiredPhases.every((phase) => receipt.phasesRun.includes(phase));
  if (!coversAllPhases) {
    return {
      skip: false,
      reason: "prior maintenance receipt only covered a partial stage subset",
    };
  }
  if (!headSha || receipt.lastMaintainSha !== headSha) {
    return {
      skip: false,
      reason: `default branch HEAD changed (${receipt.lastMaintainSha} -> ${headSha || "unknown"})`,
    };
  }
  const parseNonNegativeCount = (val) => {
    if (typeof val === "number") {
      return Number.isInteger(val) && val >= 0 ? val : null;
    }
    if (typeof val === "string" && val.trim() !== "") {
      const parsed = Number(val);
      return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
    }
    return null;
  };
  const advisoriesCount = parseNonNegativeCount(newAdvisories);
  const failingCiCount = parseNonNegativeCount(failingCiRuns);
  const untriagedCount = parseNonNegativeCount(untriagedItems);
  if (advisoriesCount === null || failingCiCount === null || untriagedCount === null) {
    return { skip: false, reason: "unverified or invalid observation counts" };
  }
  if (advisoriesCount > 0) {
    return { skip: false, reason: `${advisoriesCount} new security advisor${advisoriesCount === 1 ? "y" : "ies"} detected` };
  }
  if (failingCiCount > 0) {
    return { skip: false, reason: `${failingCiCount} failing default-branch CI run(s) detected` };
  }
  if (untriagedCount > 0) {
    return { skip: false, reason: `${untriagedCount} untriaged inbound issue(s)/PR(s) detected` };
  }
  return {
    skip: true,
    reason: "fast no-op: HEAD unchanged and healthy",
  };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function scoreToGrade(score) {
  if (score >= 97) return "A+";
  if (score >= 90) return "A";
  if (score >= 80) return "B";
  if (score >= 70) return "C";
  if (score >= 60) return "D";
  return "F";
}

export function computeHealthScore(findings = {}) {
  const ci = findings.ci ?? {};
  const ciDeductions =
    (ci.defaultBranchFailing ? 10 : 0) +
    Math.min(8, (Number(ci.unpinnedActions) || 0) * 4) +
    (ci.missingLeastPrivilegePermissions ? 4 : 0) +
    (ci.missingConcurrencyOrCache ? 3 : 0) +
    (ci.scriptInjectionSinks ? 5 : 0);
  const ciScore = clamp(
    typeof ci.score === "number" ? ci.score : DIMENSION_MAX.ci - ciDeductions,
    0,
    DIMENSION_MAX.ci,
  );

  const cov = findings.coverage ?? {};
  const covDeductions =
    (cov.overallBelowThreshold ? 8 : 0) +
    (cov.diffBelowThreshold ? 8 : 0) +
    Math.min(8, (Number(cov.untestedEntrypoints) || 0) * 4) +
    Math.min(8, (Number(cov.branchLineGapModules) || 0) * 4) +
    (cov.runtimeConsoleErrors ? 5 : 0);
  const covScore = clamp(
    typeof cov.score === "number" ? cov.score : DIMENSION_MAX.coverage - covDeductions,
    0,
    DIMENSION_MAX.coverage,
  );

  const deps = findings.deps ?? {};
  const depsDeductions =
    (deps.unpatchedKev ? 15 : 0) +
    Math.min(12, (Number(deps.unpatchedCriticalHigh) || 0) * 8) +
    (deps.copyleftConflict ? 10 : 0) +
    Math.min(6, (Number(deps.stalledCompanionPrs) || 0) * 3) +
    (deps.cooldownViolation ? 4 : 0);
  const depsScore = clamp(
    typeof deps.score === "number" ? deps.score : DIMENSION_MAX.deps - depsDeductions,
    0,
    DIMENSION_MAX.deps,
  );

  const sec = findings.secops ?? {};
  const secDeductions =
    (sec.leakedSecrets ? 15 : 0) +
    (Number(sec.highConfidenceFindings) || 0) * 8 +
    (sec.repoSecuritySettingsDisabled ? 4 : 0) +
    (sec.stealthViolation ? 15 : 0);
  const secScore = clamp(
    typeof sec.score === "number" ? sec.score : DIMENSION_MAX.secops - secDeductions,
    0,
    DIMENSION_MAX.secops,
  );

  const docs = findings.docs ?? {};
  const docsDeductions =
    Math.min(9, (Number(docs.brokenLinks) || 0) * 3) +
    Math.min(9, (Number(docs.staleFlags) || 0) * 3) +
    (docs.missingGovernanceFiles ? 4 : 0);
  const docsScore = clamp(
    typeof docs.score === "number" ? docs.score : DIMENSION_MAX.docs - docsDeductions,
    0,
    DIMENSION_MAX.docs,
  );

  const se = findings.skillsEvals ?? {};
  const seApplicable = se.applicable !== false;
  const seDeductions = seApplicable
    ? (se.skillLintFailed ? 5 : 0) +
      (se.evalLintFailed ? 5 : 0) +
      (se.nonDecisiveWeights ? 3 : 0) +
      (se.unsafeCiEvalWorkflow ? 3 : 0)
    : 0;
  const seScore = clamp(
    typeof se.score === "number" ? se.score : DIMENSION_MAX.skillsEvals - seDeductions,
    0,
    DIMENSION_MAX.skillsEvals,
  );

  const bg = findings.backlog ?? {};
  const bgDeductions =
    Math.min(6, (Number(bg.unrespondedOver24h) || 0) * 3) +
    Math.min(6, (Number(bg.untriagedExternalPrs) || 0) * 2) +
    Math.min(4, (Number(bg.staleBallInMaintainerCourt) || 0) * 2);
  const bgScore = clamp(
    typeof bg.score === "number" ? bg.score : DIMENSION_MAX.backlog - bgDeductions,
    0,
    DIMENSION_MAX.backlog,
  );

  const dimensions = {
    ci: ciScore,
    coverage: covScore,
    deps: depsScore,
    secops: secScore,
    docs: docsScore,
    skillsEvals: seScore,
    backlog: bgScore,
  };

  const total = Object.values(dimensions).reduce((sum, n) => sum + n, 0);
  const grade = scoreToGrade(total);

  return {
    score: total,
    maxScore: 100,
    grade,
    dimensions,
    skillsEvalsApplicable: seApplicable,
  };
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function checkStealthViolations(
  text,
  { visibility = "PUBLIC", privateRepos = [], fleetMode = false, requireNonEmpty = false } = {},
) {
  const normalizedVisibility = String(visibility || "PUBLIC").toUpperCase();
  const stealthMode = normalizedVisibility !== "PRIVATE";
  if (typeof text !== "string" || (requireNonEmpty && !text.trim())) {
    return {
      ok: false,
      stealthMode,
      violations: ["missing-input: non-empty string --text is required"],
    };
  }
  if (!stealthMode) {
    return { ok: true, stealthMode: false, violations: [] };
  }

  const violations = [];
  if (
    fleetMode &&
    (!Array.isArray(privateRepos) || privateRepos.filter((r) => String(r || "").trim()).length === 0)
  ) {
    violations.push("missing-private-repos: fleet mode requires a non-empty --private-repos inventory");
  }
  for (const { id, regex } of STEALTH_PATTERNS) {
    if (regex.test(text)) {
      violations.push(`${id}: [redacted]`);
    }
  }
  for (const privRepo of Array.isArray(privateRepos) ? privateRepos : []) {
    const raw = String(privRepo || "")
      .trim()
      .replace(/\.git$/i, "");
    if (!raw) continue;
    const bareName = raw.includes("/") ? raw.split("/").pop() : raw;
    const candidates = [raw, bareName].filter(Boolean);
    const leaked = candidates.some((candidate) => {
      const pattern = new RegExp(
        `(?<![a-z0-9_-])${escapeRegex(candidate)}(?=(?:\\.git\\b|[^a-z0-9_-]|$))`,
        "i",
      );
      return pattern.test(text);
    });
    if (leaked) {
      violations.push("private-repo-leak: [redacted]");
    }
  }

  return {
    ok: violations.length === 0,
    stealthMode: true,
    violations,
  };
}

const MECHANICAL_COMPANION_KINDS = new Set([
  "required-azd-version",
  "go-toolchain-govulncheck",
  "codeql-action-lockstep-sha",
]);

const PERMISSIVE_SPDX_TOKEN =
  /^(?:MIT|Apache-2\.0|BSD-2-Clause|BSD-3-Clause|ISC|0BSD|Unlicense|CC0-1\.0|BlueOak-1\.0\.0)$/i;
const COPYLEFT_SPDX_TOKEN =
  /^(?:(?:A|L)?GPL-(?:2\.0|2\.1|3\.0)(?:-(?:only|or-later))?|SSPL-1\.0|EUPL-1\.2)$/i;

export function evaluateSpdxExpression(expression) {
  if (typeof expression !== "string" || !expression.trim()) {
    return { valid: false, canBePermissive: false, hasCopyleft: false };
  }
  const tokens = [];
  const tokenRegex = /\s*(\(|\)|\bAND\b|\bOR\b|\bWITH\b|[A-Za-z0-9._+-]+)\s*/gy;
  let lastIndex = 0;
  let match;
  while ((match = tokenRegex.exec(expression)) !== null) {
    if (match.index !== lastIndex) {
      return { valid: false, canBePermissive: false, hasCopyleft: false };
    }
    tokens.push(match[1]);
    lastIndex = tokenRegex.lastIndex;
  }
  if (lastIndex !== expression.length || tokens.length === 0) {
    return { valid: false, canBePermissive: false, hasCopyleft: false };
  }
  if (tokens.some((t) => /^WITH$/i.test(t))) {
    return { valid: false, canBePermissive: false, hasCopyleft: false };
  }

  let pos = 0;
  let hasCopyleft = false;

  function parseOr() {
    let left = parseAnd();
    if (!left) return null;
    while (pos < tokens.length && /^OR$/i.test(tokens[pos])) {
      pos += 1;
      const right = parseAnd();
      if (!right) return null;
      left = { canBePermissive: left.canBePermissive || right.canBePermissive };
    }
    return left;
  }

  function parseAnd() {
    let left = parsePrimary();
    if (!left) return null;
    while (pos < tokens.length && /^AND$/i.test(tokens[pos])) {
      pos += 1;
      const right = parsePrimary();
      if (!right) return null;
      left = { canBePermissive: left.canBePermissive && right.canBePermissive };
    }
    return left;
  }

  function parsePrimary() {
    if (pos >= tokens.length) return null;
    const tok = tokens[pos];
    if (tok === "(") {
      pos += 1;
      const inner = parseOr();
      if (!inner || pos >= tokens.length || tokens[pos] !== ")") return null;
      pos += 1;
      return inner;
    }
    if (tok === ")" || /^(?:AND|OR|WITH)$/i.test(tok)) return null;
    pos += 1;
    if (PERMISSIVE_SPDX_TOKEN.test(tok)) {
      return { canBePermissive: true };
    }
    if (COPYLEFT_SPDX_TOKEN.test(tok)) {
      hasCopyleft = true;
      return { canBePermissive: false };
    }
    return null;
  }

  const ast = parseOr();
  if (!ast || pos !== tokens.length) {
    return { valid: false, canBePermissive: false, hasCopyleft: false };
  }
  return { valid: true, canBePermissive: ast.canBePermissive, hasCopyleft };
}

export function classifyDependencyPr({
  companionSyncKind = null,
  semverBump = null,
  breakingChange = false,
  license = null,
  repoLicense = null,
  releaseAgeDays = null,
  cooldownDays = 7,
  isKevActiveExploit = false,
  hasOlderPatchedVersion = null,
} = {}) {
  const validSemver =
    typeof semverBump === "string" && /^(?:patch|minor|major)$/i.test(semverBump.trim());
  const validLicense = typeof license === "string" && license.trim().length > 0;
  const validRepoLicense = typeof repoLicense === "string" && repoLicense.trim().length > 0;
  const parsedAge =
    typeof releaseAgeDays === "number" ||
    (typeof releaseAgeDays === "string" && releaseAgeDays.trim() !== "")
      ? Number(releaseAgeDays)
      : NaN;
  const validAge = Number.isFinite(parsedAge) && parsedAge >= 0;
  const parsedCooldown =
    typeof cooldownDays === "number" ||
    (typeof cooldownDays === "string" && cooldownDays.trim() !== "")
      ? Number(cooldownDays)
      : NaN;
  const validCooldown = Number.isFinite(parsedCooldown) && parsedCooldown >= 0;

  if (!validSemver || !validLicense || !validRepoLicense || !validAge || !validCooldown) {
    return {
      action: "escalate-needs-attention",
      reason:
        "missing or unverified dependency metadata (semverBump, license, repoLicense, releaseAgeDays, and cooldownDays are required)",
    };
  }

  const repoSpdx = evaluateSpdxExpression(repoLicense);
  if (!repoSpdx.valid) {
    return {
      action: "escalate-needs-attention",
      reason: `unrecognized or unsupported repository SPDX expression (${repoLicense}) requires maintainer review`,
    };
  }

  const depSpdx = evaluateSpdxExpression(license);
  if (!depSpdx.valid) {
    return {
      action: "escalate-needs-attention",
      reason: `unrecognized or unverified dependency SPDX expression (${license}) requires maintainer review`,
    };
  }

  if (!repoSpdx.canBePermissive) {
    return {
      action: "escalate-needs-attention",
      reason: `non-permissive repository license (${repoLicense}) requires maintainer review before automatic dependency merge`,
    };
  }

  if (!depSpdx.canBePermissive) {
    return {
      action: "escalate-needs-attention",
      reason: `incompatible copyleft license (${license}) in ${repoLicense} repository`,
    };
  }

  if (breakingChange !== false || semverBump.trim().toLowerCase() === "major") {
    return {
      action: "escalate-needs-attention",
      reason: "semver-major or breaking dependency update requires maintainer decision",
    };
  }

  const cooldownPassed =
    parsedAge >= parsedCooldown ||
    (isKevActiveExploit === true && hasOlderPatchedVersion === false);
  if (!cooldownPassed) {
    return {
      action: "hold-cooldown",
      reason: `release age (${parsedAge}d) is below cooldownDays (${parsedCooldown}d) without KEV bypass`,
    };
  }

  if (companionSyncKind) {
    if (MECHANICAL_COMPANION_KINDS.has(companionSyncKind)) {
      return {
        action: "auto-companion-sync",
        reason: `mechanical companion sync (${companionSyncKind}) eligible for zero-touch pr --merge=auto --no-copilot`,
      };
    }
    return {
      action: "escalate-needs-attention",
      reason: `non-mechanical companion failure (${companionSyncKind}) requires maintainer review`,
    };
  }

  return {
    action: "auto-merge-ready",
    reason: "vetted update passes cooldown and license gates",
  };
}

const BOOLEAN_FLAGS = new Set(["force", "fleet"]);
const RAW_VALUE_FLAGS = new Set(["text", "json"]);

function parseStrictBooleanFlag(name, rawValue) {
  if (rawValue === undefined) return undefined;
  if (typeof rawValue === "boolean") return rawValue;
  if (rawValue === "true") return true;
  if (rawValue === "false") return false;
  throw new Error(`Invalid boolean value for --${name}: ${String(rawValue)}`);
}

function parseCliArgs(argv) {
  const flags = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith("--")) {
      const eqIdx = token.indexOf("=");
      if (eqIdx !== -1) {
        flags[token.slice(2, eqIdx)] = token.slice(eqIdx + 1);
      } else {
        const key = token.slice(2);
        if (BOOLEAN_FLAGS.has(key)) {
          flags[key] = true;
        } else if (
          i + 1 < argv.length &&
          (RAW_VALUE_FLAGS.has(key) || !argv[i + 1].startsWith("--"))
        ) {
          flags[key] = argv[i + 1];
          i += 1;
        } else {
          flags[key] = null;
        }
      }
    } else {
      positionals.push(token);
    }
  }
  return { command: positionals[0] || "help", positionals: positionals.slice(1), flags };
}

export function runCli(argv = process.argv.slice(2)) {
  const { command, flags } = parseCliArgs(argv);
  if (command === "resolve-config") {
    return resolveConfig({
      cwd: flags.cwd || process.cwd(),
      policyPath: flags.policy || null,
      repoOwner: flags["repo-owner"] || null,
      authUser: flags["auth-user"] || null,
      visibility: flags.visibility || "PUBLIC",
      cliFlags: {
        maintainer: flags.maintainer,
        escalationLabel: flags["escalation-label"],
        cooldownDays:
          flags["cooldown-days"] !== undefined ? Number(flags["cooldown-days"]) : undefined,
        coverageThreshold:
          flags["coverage-threshold"] !== undefined
            ? Number(flags["coverage-threshold"])
            : undefined,
        autoMerge: parseStrictBooleanFlag("auto-merge", flags["auto-merge"]),
        copilotReview: parseStrictBooleanFlag("copilot-review", flags["copilot-review"]),
        repos: flags.repos ? String(flags.repos).split(",").filter(Boolean) : undefined,
      },
    });
  }
  if (command === "skip-check") {
    const receipt = flags.repo ? readReceipt(flags["state-dir"], flags.repo) : null;
    const stagesSpecified = flags.stages !== undefined;
    const parsedStages =
      typeof flags.stages === "string" ? flags.stages.split(",").filter(Boolean) : [];
    return evaluateSkipGate({
      receipt,
      headSha: flags["head-sha"] || null,
      newAdvisories: flags["new-advisories"],
      failingCiRuns: flags["failing-ci"],
      untriagedItems: flags["untriaged"],
      force: Boolean(flags.force),
      stages: parsedStages,
      stagesSpecified,
    });
  }
  if (command === "write-receipt") {
    const input = flags.json ? JSON.parse(String(flags.json)) : {};
    return writeReceipt(flags["state-dir"], flags.repo || input.repo, input);
  }
  if (command === "score") {
    const input = flags.json ? JSON.parse(String(flags.json)) : {};
    return computeHealthScore(input);
  }
  if (command === "stealth-check") {
    const normalizedVisibility = String(flags.visibility || "PUBLIC").toUpperCase();
    const stealthMode = normalizedVisibility !== "PRIVATE";
    if (flags["private-repos-file"] !== undefined) {
      if (
        typeof flags["private-repos-file"] !== "string" ||
        !flags["private-repos-file"].trim() ||
        !existsSync(flags["private-repos-file"])
      ) {
        return {
          ok: false,
          stealthMode,
          violations: ["missing-private-repos-file: specified --private-repos-file does not exist"],
        };
      }
    }
    if (flags["text-file"] !== undefined) {
      if (
        typeof flags["text-file"] !== "string" ||
        !flags["text-file"].trim() ||
        !existsSync(flags["text-file"])
      ) {
        return {
          ok: false,
          stealthMode,
          violations: ["missing-text-file: specified --text-file does not exist"],
        };
      }
    }
    const fileInventory = flags["private-repos-file"]
      ? readFileSync(String(flags["private-repos-file"]), "utf8")
          .split(/\r?\n|,/)
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
    const argInventory = flags["private-repos"]
      ? String(flags["private-repos"]).split(",").filter(Boolean)
      : [];
    const privateRepos = fileInventory.length > 0 ? fileInventory : argInventory;
    const textInput = flags["text-file"]
      ? readFileSync(String(flags["text-file"]), "utf8")
      : flags.text;
    return checkStealthViolations(textInput, {
      visibility: flags.visibility || "PUBLIC",
      privateRepos,
      fleetMode: Boolean(flags.fleet),
      requireNonEmpty: true,
    });
  }
  if (command === "classify-dep-pr") {
    const input = flags.json ? JSON.parse(String(flags.json)) : {};
    return classifyDependencyPr(input);
  }
  return {
    commands: [
      "resolve-config",
      "skip-check",
      "write-receipt",
      "score",
      "stealth-check",
      "classify-dep-pr",
    ],
  };
}

const isMain =
  process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);
if (isMain) {
  const result = runCli(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result && result.ok === false) {
    process.exitCode = 1;
  }
}
