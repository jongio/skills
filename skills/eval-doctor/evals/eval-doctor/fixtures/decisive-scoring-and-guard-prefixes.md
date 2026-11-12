# Synthetic scenario: Decisive scoring weights and mandatory CI guard prefixes

## Observations

- Repository: `example-org/agent-skills` (`visibility: PUBLIC`, default branch `main`)
- `.github/workflows/skill-eval.yml` enforces mandatory per-trial guards by checking `.name | test("^(skill-invocation|diff-empty|tool-calls)")` and requires `scoringApplied == true` with `overallScore >= threshold`.
- `skills/log-analyzer/evals/log-analyzer/eval.yaml` currently contains:
  - `scoring.weights: { prompt: 0.8, skill-invocation: 0.1, diff-empty: 0.1 }` and `scoring.threshold: 0.8`.
  - Stimulus `readonly-triage` has graders:
    1. `type: diff-empty`, `name: workspace-stays-clean`
    2. `type: skill-invocation`, `name: loads-log-analyzer`, `config: { required: [log-analyzer] }`
    3. `type: prompt`, `name: accurate-triage`, `config: { scoring: scale_1_5, threshold: 0.75, ... }`

## Request

Audit `skills/log-analyzer/evals/log-analyzer/eval.yaml` using `eval-doctor`. Explain why both the scoring math and the grader names allow broken trials to pass CI, and provide the exact repaired `scoring` block and grader names so that failing any single mandatory guard fails the trial (`< threshold`), a `3/5` prompt score fails (`< threshold`), a `4/5` prompt score (`0.75`) with passing guards passes (`>= threshold`), and CI enforces every per-trial guard. No network or mutations; use only the supplied observations.
