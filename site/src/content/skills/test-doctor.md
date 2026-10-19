---
title: test-doctor
tagline: "Audit test correctness, coverage, reliability, and maintenance; optionally repair material gaps without gaming the suite."
useWhen: "test doctor, test health, test audit, are my tests good, write missing tests, fix flaky tests, improve test coverage"
repoPath: skills/test-doctor
thumb: images/thumb-test-doctor.png
install:
  - label: Install for GitHub Copilot
    cmd: "npx skills add jongio/skills --skill test-doctor -g --agent github-copilot"
---

## What it does

Audit test correctness, coverage, reliability, and maintenance; optionally repair material gaps without gaming the suite.

Checks whether assertions protect intended behavior, finds missing branch and
error-path tests, and investigates isolation and flakiness. Uses the existing
test and E2E frameworks without imposing a coverage percentage or adding an
agent orchestration layer. Blocked checks remain visible.

## Use it

```text
/test-doctor
/test-doctor fix
/test-doctor fix packages/api
```

The default audit does not edit project content. Fix mode writes missing tests
and repairs material gaps in bounded batches, then verifies the relevant suites.
It never weakens assertions, coverage gates, or exclusions to manufacture green.
