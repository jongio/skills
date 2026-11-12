#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      fileConfig = JSON.parse(readFileSync(candidate, "utf8"));
      configSource = candidate;
      break;
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

  return {
    ...merged,
    maintainer,
    maintainerSource,
    configSource,
    visibility: normalizedVisibility,
    stealthMode,
    prDeliveryArgs: [
      `--merge=${merged.autoMerge ? "auto" : "approval"}`,
      ...(merged.copilotReview ? [] : ["--no-copilot"]),
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

export function writeReceipt(stateDir, repo, receipt) {
  const path = getReceiptPath(stateDir, repo);
  mkdirSync(dirname(path), { recursive: true });
  const payload = {
    ...receipt,
    repo,
    timestamp: receipt.timestamp || new Date().toISOString(),
  };
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return payload;
}

export function evaluateSkipGate({
  receipt = null,
  headSha = null,
  newAdvisories = 0,
  failingCiRuns = 0,
  untriagedItems = 0,
  force = false,
  stages = [],
} = {}) {
  if (force) {
    return { skip: false, reason: "forced run requested (--force)" };
  }
  if (Array.isArray(stages) && stages.length > 0) {
    return { skip: false, reason: `explicit stages requested (${stages.join(",")})` };
  }
  if (!receipt || !receipt.lastMaintainSha) {
    return { skip: false, reason: "no prior maintenance receipt found" };
  }
  if (receipt.incomplete || (Array.isArray(receipt.failedPhases) && receipt.failedPhases.length > 0)) {
    return {
      skip: false,
      reason: `prior maintenance receipt has unresolved failed phases (${(receipt.failedPhases || []).join(",") || "incomplete"})`,
    };
  }
  if (!headSha || receipt.lastMaintainSha !== headSha) {
    return {
      skip: false,
      reason: `default branch HEAD changed (${receipt.lastMaintainSha} -> ${headSha || "unknown"})`,
    };
  }
  const advisoriesCount = Number(newAdvisories);
  const failingCiCount = Number(failingCiRuns);
  const untriagedCount = Number(untriagedItems);
  if (
    !Number.isFinite(advisoriesCount) ||
    advisoriesCount < 0 ||
    !Number.isFinite(failingCiCount) ||
    failingCiCount < 0 ||
    !Number.isFinite(untriagedCount) ||
    untriagedCount < 0
  ) {
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

export function checkStealthViolations(
  text,
  { visibility = "PUBLIC", privateRepos = [], requireNonEmpty = false } = {},
) {
  const normalizedVisibility = String(visibility || "PUBLIC").toUpperCase();
  const stealthMode = normalizedVisibility !== "PRIVATE";
  const input = String(text || "");
  if (requireNonEmpty && !input.trim()) {
    return {
      ok: false,
      stealthMode,
      violations: ["missing-input: non-empty --text is required"],
    };
  }
  if (!stealthMode) {
    return { ok: true, stealthMode: false, violations: [] };
  }

  const violations = [];
  for (const { id, regex } of STEALTH_PATTERNS) {
    const match = input.match(regex);
    if (match) {
      violations.push(`${id}: "${match[0]}"`);
    }
  }
  for (const privRepo of privateRepos) {
    if (!privRepo) continue;
    if (input.toLowerCase().includes(String(privRepo).toLowerCase())) {
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

const COPYLEFT_LICENSES = /\b(?:AGPL|GPL|LGPL|SSPL|EUPL)\b/i;

export function classifyDependencyPr({
  companionSyncKind = null,
  semverBump = "patch",
  breakingChange = false,
  license = "MIT",
  repoLicense = "MIT",
  releaseAgeDays = 10,
  cooldownDays = 7,
  isKevActiveExploit = false,
  hasOlderPatchedVersion = false,
} = {}) {
  const permissiveRepo = /^(?:MIT|Apache-2\.0|BSD-[23]-Clause|ISC|0BSD)$/i.test(repoLicense);
  if (permissiveRepo && COPYLEFT_LICENSES.test(String(license || ""))) {
    return {
      action: "escalate-needs-attention",
      reason: `incompatible copyleft license (${license}) in ${repoLicense} repository`,
    };
  }

  if (breakingChange || String(semverBump).toLowerCase() === "major") {
    return {
      action: "escalate-needs-attention",
      reason: "semver-major or breaking dependency update requires maintainer decision",
    };
  }

  const cooldownPassed =
    Number(releaseAgeDays) >= Number(cooldownDays) ||
    (Boolean(isKevActiveExploit) && !hasOlderPatchedVersion);
  if (!cooldownPassed) {
    return {
      action: "hold-cooldown",
      reason: `release age (${releaseAgeDays}d) is below cooldownDays (${cooldownDays}d) without KEV bypass`,
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

function parseCliArgs(argv) {
  const flags = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith("--")) {
      const eqIdx = token.indexOf("=");
      if (eqIdx !== -1) {
        flags[token.slice(2, eqIdx)] = token.slice(eqIdx + 1);
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
        flags[token.slice(2)] = argv[i + 1];
        i += 1;
      } else {
        flags[token.slice(2)] = true;
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
        autoMerge:
          flags["auto-merge"] !== undefined
            ? String(flags["auto-merge"]) !== "false"
            : undefined,
        copilotReview:
          flags["copilot-review"] !== undefined
            ? String(flags["copilot-review"]) === "true"
            : undefined,
        repos: flags.repos ? String(flags.repos).split(",").filter(Boolean) : undefined,
      },
    });
  }
  if (command === "skip-check") {
    const receipt = flags.repo ? readReceipt(flags["state-dir"], flags.repo) : null;
    return evaluateSkipGate({
      receipt,
      headSha: flags["head-sha"] || null,
      newAdvisories: Number(flags["new-advisories"] || 0),
      failingCiRuns: Number(flags["failing-ci"] || 0),
      untriagedItems: Number(flags["untriaged"] || 0),
      force: Boolean(flags.force),
      stages: flags.stages ? String(flags.stages).split(",").filter(Boolean) : [],
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
    const privateRepos = flags["private-repos"]
      ? String(flags["private-repos"]).split(",").filter(Boolean)
      : [];
    return checkStealthViolations(flags.text || "", {
      visibility: flags.visibility || "PUBLIC",
      privateRepos,
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
