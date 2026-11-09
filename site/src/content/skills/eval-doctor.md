---
title: eval-doctor
tagline: "Audit, author, and harden AI skill and prompt evaluations with Vally, github/evals, deterministic graders, and safe github/evals-action CI workflows."
useWhen: "eval doctor, eval-doctor, audit evals, create eval.yaml, vally lint, github/evals, github/evals-action CI"
repoPath: skills/eval-doctor
thumb: images/thumb-eval-doctor.png
install:
  - label: Install for GitHub Copilot
    cmd: "npx skills add jongio/skills --skill eval-doctor"
---

## What it does

Audit, author, and harden AI skill and prompt evaluations with Vally, `github/evals`, deterministic graders, and safe `github/evals-action` CI workflows.

- **Evaluable surface discovery:** scans skills (`skills/*/SKILL.md`), prompts (`*.prompt.md`), agents (`*.agent.md`), `.vally.yaml` configurations, `evals/**/eval.yaml` suites, and `.github/workflows/*eval*.yml` pipelines to flag missing coverage or orphan fixtures.
- **Deterministic-first grader hierarchy (`vally lint --strict`):** prioritizes behavioral and workspace graders (`skill-invocation`, `tool-calls`, `diff-empty`, `file-contains`, `file-matches`, custom AST/code graders with unit tests) ahead of `prompt` LLM-as-judge rubrics.
- **Decisive scoring arithmetic:** audits `scoring.weights` and `scoring.threshold` so failing any mandatory behavioral or safety grader drops the trial score below threshold—preventing high rubric scores from outvoting broken guardrails.
- **Author, run, and compare (`github/evals` / `copilot-evals`):** coordinates `author`, `run`, and `analyze` / `compare` workflows across baseline and candidate skill revisions, gating paid live model trials on explicit user approval.
- **5 mandatory CI security invariants (`github/evals-action`):** enforces untrusted fork protection, 40-char SHA-pinned actions and `--ignore-scripts` locked toolchains, step-scoped `COPILOT_GITHUB_TOKEN` with `contents: read` top-level permissions, cost/concurrency/timeout caps, and zero raw transcript leakage in public artifacts.

## Use it

```text
/eval-doctor
/eval-doctor audit
/eval-doctor author skills/my-skill
/eval-doctor harden-ci .github/workflows/skill-eval.yml
```
