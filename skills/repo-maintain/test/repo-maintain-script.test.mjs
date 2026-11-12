import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  REQUIRED_CORE_PHASES,
  checkStealthViolations,
  classifyDependencyPr,
  computeHealthScore,
  evaluateSkipGate,
  evaluateSpdxExpression,
  parseCodeownersMaintainer,
  readReceipt,
  resolveConfig,
  runCli,
  scoreToGrade,
  writeReceipt,
} from "../scripts/repo-maintain.mjs";

test("parseCodeownersMaintainer extracts global * owner and ignores team slugs and comments", () => {
  const content = [
    "# Global owners",
    "* @example-org/core-team @maintainer-alpha # trailing comment",
    "docs/* @docs-owner",
  ].join("\n");
  assert.equal(parseCodeownersMaintainer(content), "maintainer-alpha");
  assert.equal(parseCodeownersMaintainer("docs/* @docs-owner\n"), null);
});

test("resolveConfig enforces exact maintainer precedence and fail-closed Stealth Public Mode", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "repo-maintain-cfg-"));
  try {
    mkdirSync(join(tempRoot, ".github"), { recursive: true });
    writeFileSync(join(tempRoot, ".github", "CODEOWNERS"), "* @codeowner-user\n", "utf8");

    // 1. CODEOWNERS beats repoOwner and authUser when no policy file exists
    const fromCodeowners = resolveConfig({
      cwd: tempRoot,
      repoOwner: "repo-owner-user",
      authUser: "auth-fallback-user",
      visibility: "PUBLIC",
    });
    assert.equal(fromCodeowners.maintainer, "codeowner-user");
    assert.equal(fromCodeowners.maintainerSource, "codeowners");
    assert.equal(fromCodeowners.stealthMode, true);
    assert.deepEqual(fromCodeowners.prDeliveryArgs, ["--merge=auto", "--no-copilot"]);

    // 2. .github/repo-maintain.json beats CODEOWNERS
    writeFileSync(
      join(tempRoot, ".github", "repo-maintain.json"),
      JSON.stringify({
        maintainer: "policy-maintainer",
        cooldownDays: 14,
        coverageThreshold: 85,
        autoMerge: false,
        copilotReview: true,
      }),
      "utf8",
    );
    const fromPolicy = resolveConfig({
      cwd: tempRoot,
      repoOwner: "repo-owner-user",
      visibility: "PRIVATE",
    });
    assert.equal(fromPolicy.maintainer, "policy-maintainer");
    assert.equal(fromPolicy.maintainerSource, "policy-file");
    assert.equal(fromPolicy.cooldownDays, 14);
    assert.equal(fromPolicy.coverageThreshold, 85);
    assert.equal(fromPolicy.stealthMode, false);
    assert.deepEqual(fromPolicy.prDeliveryArgs, ["--merge=approval"]);

    // 3. CLI flag beats policy file, and unknown visibility fails closed to stealthMode: true
    const fromCli = resolveConfig({
      cwd: tempRoot,
      cliFlags: { maintainer: "@cli-override" },
      visibility: "",
    });
    assert.equal(fromCli.maintainer, "cli-override");
    assert.equal(fromCli.maintainerSource, "cli");
    assert.equal(fromCli.stealthMode, true);

    // 4. repoOwner and authUser fallbacks when no policy file or CODEOWNERS exist
    const emptyRoot = mkdtempSync(join(tmpdir(), "repo-maintain-empty-"));
    try {
      const fromRepoOwner = resolveConfig({
        cwd: emptyRoot,
        repoOwner: "@owner-login",
        authUser: "@auth-login",
      });
      assert.equal(fromRepoOwner.maintainer, "owner-login");
      assert.equal(fromRepoOwner.maintainerSource, "repo-owner");

      const fromAuthUser = resolveConfig({
        cwd: emptyRoot,
        authUser: "@auth-login",
      });
      assert.equal(fromAuthUser.maintainer, "auth-login");
      assert.equal(fromAuthUser.maintainerSource, "auth-user");

      assert.throws(
        () => resolveConfig({ cwd: emptyRoot, policyPath: "missing-policy.json" }),
        /Explicit policy file not found/,
      );
      writeFileSync(
        join(emptyRoot, ".maintain.json"),
        JSON.stringify({ copilotReview: "true" }),
        "utf8",
      );
      assert.throws(
        () => resolveConfig({ cwd: emptyRoot }),
        /Invalid boolean setting for copilotReview/,
      );
    } finally {
      rmSync(emptyRoot, { recursive: true, force: true });
    }
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("evaluateSkipGate and receipt persistence enforce all 5 Phase 0 fast no-op conditions", () => {
  const tempState = mkdtempSync(join(tmpdir(), "repo-maintain-state-"));
  try {
    const repo = "example-org/payments-api";
    const sha = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";
    assert.equal(readReceipt(tempState, repo), null);
    assert.deepEqual(evaluateSkipGate({ receipt: null, headSha: sha }), {
      skip: false,
      reason: "no prior maintenance receipt found",
    });

    // Omitting phasesRun in writeReceipt marks partialRun: true and cannot fast no-op
    const partialSaved = writeReceipt(tempState, repo, {
      defaultBranch: "main",
      lastMaintainSha: sha,
      healthScore: 96,
      grade: "A",
    });
    assert.equal(partialSaved.partialRun, true);
    assert.equal(
      evaluateSkipGate({
        receipt: readReceipt(tempState, repo),
        headSha: sha,
        newAdvisories: 0,
        failingCiRuns: 0,
        untriagedItems: 0,
      }).skip,
      false,
    );

    const fullPhases = [...REQUIRED_CORE_PHASES, "skills", "evals"];
    const saved = writeReceipt(tempState, repo, {
      defaultBranch: "main",
      lastMaintainSha: sha,
      phasesRun: fullPhases,
      healthScore: 96,
      grade: "A",
    });
    assert.equal(saved.lastMaintainSha, sha);
    assert.equal(saved.partialRun, false);

    const loaded = readReceipt(tempState, repo);
    assert.deepEqual(
      evaluateSkipGate({
        receipt: loaded,
        headSha: sha,
        newAdvisories: 0,
        failingCiRuns: 0,
        untriagedItems: 0,
      }),
      { skip: true, reason: "fast no-op: HEAD unchanged and healthy" },
    );

    // Receipt without phasesRun array is rejected
    const { phasesRun: _omittedPhases, ...receiptWithoutPhases } = loaded;
    assert.equal(
      evaluateSkipGate({
        receipt: receiptWithoutPhases,
        headSha: sha,
        newAdvisories: 0,
        failingCiRuns: 0,
        untriagedItems: 0,
      }).skip,
      false,
    );

    // Omitted observation counts fail closed (skip: false)
    assert.equal(
      evaluateSkipGate({ receipt: loaded, headSha: sha }).skip,
      false,
    );
    assert.equal(
      evaluateSkipGate({
        receipt: loaded,
        headSha: "deadbeef",
        newAdvisories: 0,
        failingCiRuns: 0,
        untriagedItems: 0,
      }).skip,
      false,
    );
    assert.equal(
      evaluateSkipGate({
        receipt: loaded,
        headSha: sha,
        newAdvisories: 1,
        failingCiRuns: 0,
        untriagedItems: 0,
      }).skip,
      false,
    );
    assert.equal(
      evaluateSkipGate({
        receipt: loaded,
        headSha: sha,
        newAdvisories: 0,
        failingCiRuns: 1,
        untriagedItems: 0,
      }).skip,
      false,
    );
    assert.equal(
      evaluateSkipGate({
        receipt: loaded,
        headSha: sha,
        newAdvisories: 0,
        failingCiRuns: 0,
        untriagedItems: 2,
      }).skip,
      false,
    );
    assert.equal(
      evaluateSkipGate({
        receipt: loaded,
        headSha: sha,
        newAdvisories: 0,
        failingCiRuns: 0,
        untriagedItems: 0,
        force: true,
      }).skip,
      false,
    );
    assert.equal(
      evaluateSkipGate({
        receipt: loaded,
        headSha: sha,
        newAdvisories: 0,
        failingCiRuns: 0,
        untriagedItems: 0,
        stages: ["deps", "secops"],
      }).skip,
      false,
    );
    assert.equal(
      evaluateSkipGate({
        receipt: { ...loaded, failedPhases: ["refactor"] },
        headSha: sha,
        newAdvisories: 0,
        failingCiRuns: 0,
        untriagedItems: 0,
      }).skip,
      false,
    );
    assert.equal(
      evaluateSkipGate({
        receipt: { ...loaded, partialRun: "true" },
        headSha: sha,
        newAdvisories: 0,
        failingCiRuns: 0,
        untriagedItems: 0,
      }).skip,
      false,
    );
    const stringPartialSaved = writeReceipt(tempState, repo, {
      defaultBranch: "main",
      lastMaintainSha: sha,
      phasesRun: fullPhases,
      partialRun: "true",
      healthScore: 96,
      grade: "A",
    });
    assert.equal(stringPartialSaved.partialRun, true);
    assert.equal(
      evaluateSkipGate({
        receipt: { ...loaded, failedPhases: "secops" },
        headSha: sha,
        newAdvisories: 0,
        failingCiRuns: 0,
        untriagedItems: 0,
      }).skip,
      false,
    );
    assert.equal(
      evaluateSkipGate({
        receipt: { ...loaded, timestamp: "invalid-date" },
        headSha: sha,
        newAdvisories: 0,
        failingCiRuns: 0,
        untriagedItems: 0,
      }).skip,
      false,
    );
    assert.equal(
      evaluateSkipGate({
        receipt: { ...loaded, phasesRun: ["docs"] },
        headSha: sha,
        newAdvisories: 0,
        failingCiRuns: 0,
        untriagedItems: 0,
      }).skip,
      false,
    );
    assert.equal(
      evaluateSkipGate({
        receipt: loaded,
        headSha: sha,
        newAdvisories: -1,
        failingCiRuns: 0,
        untriagedItems: 0,
      }).skip,
      false,
    );
  } finally {
    rmSync(tempState, { recursive: true, force: true });
  }
});

test("computeHealthScore calculates deterministic Before/After scores and clamps dimensions", () => {
  // Matches the phase-isolation-and-health-score eval fixture
  const before = computeHealthScore({
    ci: { unpinnedActions: 1, missingLeastPrivilegePermissions: true },
    coverage: { diffBelowThreshold: true },
    deps: { unpatchedCriticalHigh: 1 },
    secops: {},
    docs: { brokenLinks: 1 },
    skillsEvals: { applicable: false },
    backlog: { unrespondedOver24h: 1 },
  });
  assert.equal(before.score, 70);
  assert.equal(before.grade, "C");
  assert.deepEqual(before.dimensions, {
    ci: 12,
    coverage: 12,
    deps: 7,
    secops: 15,
    docs: 7,
    skillsEvals: 10,
    backlog: 7,
  });

  const after = computeHealthScore({
    ci: {},
    coverage: {},
    deps: {},
    secops: {},
    docs: {},
    skillsEvals: { applicable: false },
    backlog: { unrespondedOver24h: 1 },
  });
  assert.equal(after.score, 97);
  assert.equal(after.grade, "A+");

  // Extreme deductions clamp at 0 per dimension, and skillsEvals deductions apply when applicable
  const degraded = computeHealthScore({
    ci: { defaultBranchFailing: true, unpinnedActions: 5, scriptInjectionSinks: true, missingConcurrencyOrCache: true },
    coverage: { overallBelowThreshold: true, untestedEntrypoints: 2, branchLineGapModules: 2, runtimeConsoleErrors: true },
    deps: { unpatchedKev: true, copyleftConflict: true, stalledCompanionPrs: 2, cooldownViolation: true },
    secops: { leakedSecrets: true, highConfidenceFindings: 3, repoSecuritySettingsDisabled: true, stealthViolation: true },
    docs: { brokenLinks: 2, staleFlags: 2, missingGovernanceFiles: true },
    skillsEvals: { applicable: true, skillLintFailed: true, evalLintFailed: true, nonDecisiveWeights: true, unsafeCiEvalWorkflow: true },
    backlog: { unrespondedOver24h: 2, untriagedExternalPrs: 2, staleBallInMaintainerCourt: 2 },
  });
  assert.equal(degraded.dimensions.ci, 0);
  assert.equal(degraded.dimensions.coverage, 0);
  assert.equal(degraded.dimensions.deps, 0);
  assert.equal(degraded.dimensions.secops, 0);
  assert.equal(degraded.dimensions.docs, 0);
  assert.equal(degraded.dimensions.skillsEvals, 0);
  assert.equal(degraded.dimensions.backlog, 0);
  assert.equal(scoreToGrade(59), "F");
  assert.equal(scoreToGrade(60), "D");
  assert.equal(scoreToGrade(70), "C");
  assert.equal(scoreToGrade(80), "B");
  assert.equal(scoreToGrade(90), "A");
  assert.equal(scoreToGrade(97), "A+");
});

test("checkStealthViolations blocks CWE/CVE/exploit terms and private fleet repo names on public repos without echoing matched text", () => {
  const badCommit = checkStealthViolations(
    "fix(secops): patch CWE-22 path traversal vulnerability from sample-team/internal-ledger",
    { visibility: "PUBLIC", privateRepos: ["sample-team/internal-ledger"] },
  );
  assert.equal(badCommit.ok, false);
  assert.equal(badCommit.stealthMode, true);
  assert.ok(badCommit.violations.includes("cwe-id: [redacted]"));
  assert.ok(badCommit.violations.includes("vuln-class: [redacted]"));
  assert.ok(badCommit.violations.includes("private-repo-leak: [redacted]"));
  assert.doesNotMatch(JSON.stringify(badCommit), /CWE-22|internal-ledger/i);

  // Bare private repository name leak is also caught (including trailing sentence period and .git URLs)
  const bareNameLeak = checkStealthViolations(
    "Port validation logic from internal-ledger.",
    { visibility: "PUBLIC", privateRepos: ["sample-team/internal-ledger"] },
  );
  assert.equal(bareNameLeak.ok, false);
  assert.ok(bareNameLeak.violations.includes("private-repo-leak: [redacted]"));

  const gitUrlLeak = checkStealthViolations(
    "Mirrored from https://github.com/sample-team/internal-ledger.git for testing",
    { visibility: "PUBLIC", privateRepos: ["sample-team/internal-ledger"] },
  );
  assert.equal(gitUrlLeak.ok, false);
  assert.ok(gitUrlLeak.violations.includes("private-repo-leak: [redacted]"));

  // Fleet mode requires a non-empty privateRepos inventory
  const missingFleetInventory = checkStealthViolations(
    "fix(repo-maintain): harden input validation and configuration defaults",
    { visibility: "PUBLIC", fleetMode: true, privateRepos: [] },
  );
  assert.equal(missingFleetInventory.ok, false);
  assert.ok(missingFleetInventory.violations.some((v) => v.includes("missing-private-repos")));

  const neutralCommit = checkStealthViolations(
    "fix(repo-maintain): harden input validation and configuration defaults",
    { visibility: "PUBLIC", fleetMode: true, privateRepos: ["sample-team/internal-ledger"] },
  );
  assert.deepEqual(neutralCommit, {
    ok: true,
    stealthMode: true,
    violations: [],
  });

  const privateCommit = checkStealthViolations(
    "fix(secops): remediate CWE-22 in internal handler",
    { visibility: "PRIVATE" },
  );
  assert.equal(privateCommit.ok, true);
  assert.equal(privateCommit.stealthMode, false);
});

test("classifyDependencyPr distinguishes companion syncs, cooldown holds, KEV bypasses, and license/major/missing-metadata escalations", () => {
  // Missing metadata fails closed to escalate-needs-attention
  assert.equal(classifyDependencyPr({}).action, "escalate-needs-attention");
  assert.equal(
    classifyDependencyPr({ semverBump: "patch", license: "MIT", repoLicense: "MIT" }).action,
    "escalate-needs-attention",
  );

  assert.equal(
    classifyDependencyPr({
      companionSyncKind: "required-azd-version",
      semverBump: "minor",
      license: "MIT",
      repoLicense: "MIT",
      releaseAgeDays: 12,
    }).action,
    "auto-companion-sync",
  );

  assert.equal(
    classifyDependencyPr({
      semverBump: "major",
      license: "MIT",
      repoLicense: "MIT",
      releaseAgeDays: 14,
    }).action,
    "escalate-needs-attention",
  );

  assert.equal(
    classifyDependencyPr({
      semverBump: "minor",
      license: "AGPL-3.0-only",
      repoLicense: "MIT OR Apache-2.0",
      releaseAgeDays: 14,
    }).action,
    "escalate-needs-attention",
  );
  assert.equal(
    classifyDependencyPr({
      semverBump: "patch",
      license: "MIT AND GPL-3.0-only",
      repoLicense: "MIT",
      releaseAgeDays: 14,
    }).action,
    "escalate-needs-attention",
  );
  assert.equal(
    classifyDependencyPr({
      semverBump: "patch",
      license: "UNLICENSED",
      repoLicense: "MIT",
      releaseAgeDays: 14,
    }).action,
    "escalate-needs-attention",
  );
  assert.equal(
    classifyDependencyPr({
      semverBump: "patch",
      license: "MIT WITH Classpath-exception-2.0",
      repoLicense: "MIT",
      releaseAgeDays: 14,
    }).action,
    "escalate-needs-attention",
  );
  assert.equal(
    classifyDependencyPr({
      semverBump: "patch",
      license: "(MIT OR GPL-3.0-only) AND ISC",
      repoLicense: "MIT OR Apache-2.0",
      releaseAgeDays: 14,
    }).action,
    "auto-merge-ready",
  );
  assert.deepEqual(evaluateSpdxExpression("(MIT OR GPL-3.0-only) AND ISC"), {
    valid: true,
    canBePermissive: true,
    hasCopyleft: true,
  });
  assert.equal(
    classifyDependencyPr({
      semverBump: "patch",
      license: "Apache-2.0",
      repoLicense: "GPL-2.0-only",
      releaseAgeDays: 14,
    }).action,
    "escalate-needs-attention",
  );
  assert.equal(
    classifyDependencyPr({
      semverBump: "patch",
      license: "GPL-99.0-only",
      repoLicense: "MIT",
      releaseAgeDays: 14,
    }).action,
    "escalate-needs-attention",
  );
  assert.equal(
    classifyDependencyPr({
      semverBump: "patch",
      license: "MIT OR GPL-2.1-only",
      repoLicense: "MIT",
      releaseAgeDays: 14,
    }).action,
    "escalate-needs-attention",
  );
  assert.equal(
    evaluateSpdxExpression(`${"(".repeat(25)}MIT${")".repeat(25)}`).valid,
    false,
  );
  assert.equal(
    classifyDependencyPr({
      semverBump: "patch",
      license: "MIT",
      repoLicense: "Custom-Proprietary-1.0",
      releaseAgeDays: 14,
    }).action,
    "escalate-needs-attention",
  );

  assert.equal(
    classifyDependencyPr({
      semverBump: "patch",
      license: "MIT",
      repoLicense: "MIT",
      releaseAgeDays: 2,
      cooldownDays: 7,
      isKevActiveExploit: false,
    }).action,
    "hold-cooldown",
  );

  // Omitted hasOlderPatchedVersion or string "false" isKevActiveExploit cannot bypass cooldown
  assert.equal(
    classifyDependencyPr({
      semverBump: "patch",
      license: "MIT",
      repoLicense: "MIT",
      releaseAgeDays: 1,
      cooldownDays: 7,
      isKevActiveExploit: true,
    }).action,
    "hold-cooldown",
  );
  assert.equal(
    classifyDependencyPr({
      semverBump: "patch",
      license: "MIT",
      repoLicense: "MIT",
      releaseAgeDays: 1,
      cooldownDays: 7,
      isKevActiveExploit: "false",
      hasOlderPatchedVersion: false,
    }).action,
    "hold-cooldown",
  );

  assert.equal(
    classifyDependencyPr({
      semverBump: "patch",
      license: "MIT",
      repoLicense: "MIT",
      releaseAgeDays: 1,
      cooldownDays: 7,
      isKevActiveExploit: true,
      hasOlderPatchedVersion: false,
    }).action,
    "auto-merge-ready",
  );
  assert.equal(
    classifyDependencyPr({
      companionSyncKind: "custom-breaking-hook",
      semverBump: "patch",
      license: "MIT",
      repoLicense: "MIT",
      releaseAgeDays: 10,
    }).action,
    "escalate-needs-attention",
  );
});

test("runCli exposes deterministic JSON subcommands", () => {
  const scoreRes = runCli(["score", "--json", JSON.stringify({ backlog: { unrespondedOver24h: 1 } })]);
  assert.equal(scoreRes.score, 97);
  assert.equal(scoreRes.grade, "A+");

  const stealthRes = runCli([
    "stealth-check",
    "--visibility=PUBLIC",
    "--private-repos=sample-team/internal-ledger",
    "--text",
    "fix(repo-maintain): harden input validation and configuration defaults",
  ]);
  assert.equal(stealthRes.ok, true);

  const stealthDashBody = runCli([
    "stealth-check",
    "--visibility=PUBLIC",
    "--text",
    "---\ntitle: CWE-79 exploit\n---",
  ]);
  assert.equal(stealthDashBody.ok, false);
  assert.ok(stealthDashBody.violations.includes("cwe-id: [redacted]"));

  // Missing flag value before --fleet does not consume --fleet
  const stealthMissingVisibilityVal = runCli([
    "stealth-check",
    "--visibility",
    "--fleet",
    "--text",
    "fix(repo-maintain): harden input validation and configuration defaults",
  ]);
  assert.equal(stealthMissingVisibilityVal.ok, false);
  assert.ok(
    stealthMissingVisibilityVal.violations.some((v) => v.includes("missing-private-repos")),
  );

  // Empty --stages= still counts as an explicit stage flag and does not fast no-op
  const emptyStagesSkip = runCli(["skip-check", "--stages="]);
  assert.equal(emptyStagesSkip.skip, false);

  assert.throws(
    () => runCli(["resolve-config", "--auto-merge="]),
    /Invalid boolean value/,
  );
  assert.throws(
    () => runCli(["resolve-config", "--cooldown-days", "--coverage-threshold"]),
    /Invalid numeric value/,
  );
  assert.throws(
    () => runCli(["resolve-config", "--policy"]),
    /Explicit policy file not found/,
  );
  assert.throws(
    () => runCli(["write-receipt", "--state-dir", "/tmp", "--json", "--repo", "example-org/one"]),
    /Invalid or empty string value for --json/,
  );
  assert.throws(
    () => runCli(["write-receipt", "--state-dir", "--json", "{}", "--repo", "example-org/one"]),
    /Invalid or empty string value for --state-dir/,
  );
  const stealthTextConsumingFlag = runCli([
    "stealth-check",
    "--text",
    "--fleet",
    "--text",
    "fix(repo-maintain): harden input validation and configuration defaults",
  ]);
  assert.equal(stealthTextConsumingFlag.ok, false);
  assert.ok(
    stealthTextConsumingFlag.violations.some((v) => v.includes("missing-private-repos")),
  );

  const cfgRes = runCli([
    "resolve-config",
    "--maintainer",
    "cli-maint",
    "--visibility",
    "PRIVATE",
    "--cooldown-days",
    "10",
    "--coverage-threshold",
    "85",
    "--auto-merge",
    "false",
    "--copilot-review",
    "true",
    "--repos",
    "example-org/one,example-org/two",
  ]);
  assert.equal(cfgRes.maintainer, "cli-maint");
  assert.equal(cfgRes.stealthMode, false);
  assert.equal(cfgRes.cooldownDays, 10);
  assert.equal(cfgRes.coverageThreshold, 85);
  assert.equal(cfgRes.autoMerge, false);
  assert.equal(cfgRes.copilotReview, true);
  assert.deepEqual(cfgRes.repos, ["example-org/one", "example-org/two"]);

  const tempState = mkdtempSync(join(tmpdir(), "repo-maintain-cli-"));
  try {
    const written = runCli([
      "write-receipt",
      "--state-dir",
      tempState,
      "--repo",
      "example-org/one",
      "--json",
      JSON.stringify({
        lastMaintainSha: "1234567890abcdef1234567890abcdef12345678",
        phasesRun: [...REQUIRED_CORE_PHASES, "skills", "evals"],
        healthScore: 98,
      }),
    ]);
    assert.equal(written.healthScore, 98);
    assert.equal(written.partialRun, false);
    const checkedMissingObs = runCli([
      "skip-check",
      "--state-dir",
      tempState,
      "--repo",
      "example-org/one",
      "--head-sha",
      "1234567890abcdef1234567890abcdef12345678",
    ]);
    assert.equal(checkedMissingObs.skip, false);
    const checked = runCli([
      "skip-check",
      "--state-dir",
      tempState,
      "--repo",
      "example-org/one",
      "--head-sha",
      "1234567890abcdef1234567890abcdef12345678",
      "--new-advisories",
      "0",
      "--failing-ci",
      "0",
      "--untriaged",
      "0",
    ]);
    assert.equal(checked.skip, true);

    const textFile = join(tempState, "draft.txt");
    const privFile = join(tempState, "priv.txt");
    writeFileSync(textFile, "Ported from internal-ledger.", "utf8");
    writeFileSync(privFile, "sample-team/internal-ledger\n", "utf8");
    const fileStealth = runCli([
      "stealth-check",
      "--visibility=PUBLIC",
      "--fleet",
      `--text-file=${textFile}`,
      `--private-repos-file=${privFile}`,
    ]);
    assert.equal(fileStealth.ok, false);
    assert.ok(fileStealth.violations.includes("private-repo-leak: [redacted]"));

    const missingTextFile = runCli([
      "stealth-check",
      "--visibility=PUBLIC",
      `--text-file=${join(tempState, "does-not-exist.txt")}`,
    ]);
    assert.equal(missingTextFile.ok, false);
    assert.ok(missingTextFile.violations.some((v) => v.includes("missing-text-file")));

    const missingPrivFile = runCli([
      "stealth-check",
      "--visibility=PUBLIC",
      `--text-file=${textFile}`,
      `--private-repos-file=${join(tempState, "missing-priv.txt")}`,
    ]);
    assert.equal(missingPrivFile.ok, false);
    assert.ok(missingPrivFile.violations.some((v) => v.includes("missing-private-repos-file")));
  } finally {
    rmSync(tempState, { recursive: true, force: true });
  }

  const skipRes = runCli(["skip-check", "--force"]);
  assert.equal(skipRes.skip, false);

  const depRes = runCli([
    "classify-dep-pr",
    "--json",
    JSON.stringify({
      companionSyncKind: "codeql-action-lockstep-sha",
      semverBump: "patch",
      license: "MIT",
      repoLicense: "MIT",
      releaseAgeDays: 10,
    }),
  ]);
  assert.equal(depRes.action, "auto-companion-sync");

  const helpRes = runCli(["help"]);
  assert.ok(Array.isArray(helpRes.commands));
});
