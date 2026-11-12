import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  checkStealthViolations,
  classifyDependencyPr,
  computeHealthScore,
  evaluateSkipGate,
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

    const saved = writeReceipt(tempState, repo, {
      defaultBranch: "main",
      lastMaintainSha: sha,
      healthScore: 96,
      grade: "A",
    });
    assert.equal(saved.lastMaintainSha, sha);

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

  // Bare private repository name leak is also caught
  const bareNameLeak = checkStealthViolations(
    "Port validation logic from internal-ledger into public handler",
    { visibility: "PUBLIC", privateRepos: ["sample-team/internal-ledger"] },
  );
  assert.equal(bareNameLeak.ok, false);
  assert.ok(bareNameLeak.violations.includes("private-repo-leak: [redacted]"));

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
      license: "AGPL-3.0",
      repoLicense: "MIT",
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

  const emptyStealthRes = runCli(["stealth-check", "--visibility=PUBLIC"]);
  assert.equal(emptyStealthRes.ok, false);
  assert.ok(emptyStealthRes.violations.some((v) => v.includes("missing-input")));

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
      JSON.stringify({ lastMaintainSha: "1234567890abcdef1234567890abcdef12345678", healthScore: 98 }),
    ]);
    assert.equal(written.healthScore, 98);
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
