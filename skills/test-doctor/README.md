# Test Doctor

Find gaps, weak assertions, and flaky tests. Fix them without gaming the suite.

Test Doctor checks whether your tests protect intended behavior, not just
whether they pass. It audits correctness, coverage, reliability, maintenance,
test-tool compatibility, and relevant runtime/E2E evidence across the repository.
It works with your existing language, package manager, and test frameworks.

## Install

```sh
npx skills add jongio/skills --skill test-doctor
```

Reload your agent's skills, then invoke:

```text
/test-doctor
/test-doctor src/payments
/test-doctor fix
/test-doctor fix packages/api
```

Natural-language requests such as "are my tests good?" select audit mode;
"write the missing tests" or "fix flaky tests" select repair mode.

## Two modes

**Audit** discovers and runs the existing suites, inspects meaningful coverage
and assertions, and reports prioritized findings. It does not edit project
files or install tooling. Normal test-runner artifacts may be produced.

**Fix** adds missing cases and repairs weak assertions, isolation, waits, and
fixtures in small batches. It runs focused checks, then the full relevant
suites and configured coverage gates. It stops after three repair passes or
sooner if progress stalls, reporting unresolved work instead of claiming success.

Neither mode requires DevX, an agent panel, a new framework, a universal coverage
percentage, or a fixed test count. Existing E2E frameworks are respected.
Production bugs are reported separately; production edits need authorization
unless the request already includes that fix. New dependencies/frameworks and
Git/GitHub writes also need separate approval.

## What the report tells you

- Scope and projects inspected, commands run, and checks that were blocked.
- Passing/failing/skipped tests, coverage gates, and observed repeat/retry results.
- Evidence-backed gaps in contracts, branches, boundaries, and failure paths.
- Assertions that could pass despite a real regression.
- Reliability and maintenance problems, with concrete repairs.
- Before/after evidence and remaining work in fix mode.

Unavailable coverage or browser checks are not reported as healthy. Repeated
passes do not establish that the suite is flake-free. A prior report can supply
comparison context, but cannot substitute for fresh evidence.

## Development

```sh
npm test
npm ci --ignore-scripts
npm run eval:lint
```

Deterministic tests check portable packaging, registration, instruction
boundaries, eval structure, and fixture behavior. They do not prove agent
compliance. The Vally capability cases exercise auditing and repair against a
small executable fixture, plus blocked checks and anti-gaming decisions.
Capability runs use agents and require separate acceptance:

```sh
npm run eval
```

## License

MIT. See [LICENSE](LICENSE).
