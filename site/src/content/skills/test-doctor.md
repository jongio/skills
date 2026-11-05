---
title: test-doctor
tagline: "Audit test correctness, coverage, reliability, and maintenance; optionally repair material gaps without gaming the suite."
useWhen: "test doctor, test health, test audit, are my tests good, write missing tests, fix flaky tests, improve test coverage"
repoPath: skills/test-doctor
thumb: images/thumb-test-doctor.png
install:
  - label: Install for GitHub Copilot
    cmd: "npx skills add jongio/skills --skill test-doctor"
---

## What it does

Audit test correctness, coverage, reliability, and maintenance; optionally repair material gaps without gaming the suite.

- **Audits six dimensions:** Correctness (whether assertions fail for credible regressions), Coverage (material branches, boundaries, failure paths, and cross-module contracts), Reliability (async waits, cleanup, clocks, randomness, and order dependence), Maintenance, Compatibility, and Runtime/E2E evidence.
- **Works with your existing stack:** uses checked-in test and E2E frameworks without imposing a coverage percentage or adding an agent orchestration layer. Blocked checks remain visible.
- **Repairs in bounded batches:** in `fix` mode, writes missing cases and repairs weak assertions, isolation, and fixtures across at most three passes, then verifies the full relevant suites and configured coverage gates.

## Use it

```text
/test-doctor
/test-doctor src/payments
/test-doctor fix
/test-doctor fix packages/api
```

The default audit does not edit project content. Fix mode writes missing tests
and repairs material gaps in bounded batches, then verifies the relevant suites.
It never weakens assertions, coverage gates, or exclusions to manufacture green.
