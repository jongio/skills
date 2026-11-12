# 0-100 Repo Health Score Rubric

Compute the deterministic **0-100 Repo Health Score** (Grade `A+` to `F`) before PR delivery (and in read-only `status`/`audit` mode). Clamp every dimension score to `[0, weight]` so a single troubled area cannot drive its dimension below `0`.

## Dimension Weights & Deterministic Deductions

### 1. CI & Workflow Hygiene (`ci-doctor` — Max `20` pts)

Start at `20` points and deduct:
- `-10` if default branch `HEAD` has any failing required workflow run.
- `-4` for each unpinned third-party `uses:` action missing a 40-character commit SHA (up to `-8`).
- `-4` if any workflow lacks top-level least-privilege `permissions` (`contents: read` or narrower).
- `-3` if PR workflows lack `concurrency` (`cancel-in-progress: true`) or lockfile-keyed dependency caching.
- `-5` if any workflow contains a script-injection sink (`${{ github.event.* }}` inside `run:`).

### 2. Test & Branch Coverage (`test-doctor` — Max `20` pts)

Start at `20` points and deduct:
- `-8` if overall line or branch coverage is below `coverageThreshold` (`80%` default).
- `-8` if **Diff Coverage** on touched files in the maintenance pass is below `coverageThreshold` (`80%` default).
- `-4` for each critical entrypoint with `0%` direct test coverage (up to `-8`).
- `-4` for each module exhibiting a **Branch-vs-Line Gap** (`>80%` line coverage with `<50%` branch coverage, up to `-8`).
- `-5` if the Playwright Runtime Console Gate records any `console.error`, uncaught `pageerror`, or HTTP `500`.

### 3. Dependency & License Health (`deps-doctor` — Max `15` pts)

Start at `15` points and deduct:
- `-15` for any unpatched CISA KEV or actively exploited vulnerability.
- `-8` for each unpatched Critical/High advisory with an available compliant fix (up to `-12`).
- `-10` for any unresolved copyleft license conflict (`GPL`/`AGPL`/`SSPL` in a permissive `MIT`/`Apache-2.0` repo).
- `-3` for each open Dependabot/Renovate PR stalled `>7` days on a mechanical companion sync (up to `-6`).
- `-4` if unvetted releases younger than `cooldownDays` (`7` days) were installed without a KEV exception.

### 4. Security Posture (`secops-doctor` — Max `15` pts)

Start at `15` points and deduct:
- `-15` for any leaked secret, token, or private key in tracked files or commits.
- `-8` for each unresolved high-confidence OWASP/STRIDE code, container, or Cloudflare vulnerability.
- `-4` if GitHub repository security settings (Private Vulnerability Reporting, Secret Scanning, Push Protection, or Actions `read` default token permissions) are disabled.
- `-15` if a public repository (`visibility == "PUBLIC"`) has any **Stealth Public Mode** violation in commit messages, branch names, or PR text.

### 5. Documentation Accuracy (`doc-doctor` — Max `10` pts)

Start at `10` points and deduct:
- `-3` for each broken local or anchor link in `README.md` or `docs/` (up to `-9`).
- `-3` for each stale CLI flag, config key, or script documented in `README.md` that does not match code (up to `-9`).
- `-4` if missing required community governance files (`LICENSE`, `README.md`, `SECURITY.md`).

### 6. Skill & Eval Quality (`skill-doctor` + `eval-doctor` — Max `10` pts)

- **When `skills/`, `evals/`, or `.vally.yaml` are present:** Start at `10` points and deduct:
  - `-5` for any `vally skill lint` or cross-host plugin manifest parity failure.
  - `-5` for any `vally lint --strict` failure or missing mandatory behavioral guard prefix (`skill-invocation-*`, `diff-empty-*`, `tool-calls-*`).
  - `-3` if `scoring.weights` allow a `prompt` judge score to outvote a failed behavioral guard.
  - `-3` if a CI eval workflow violates any of the 5 `github/evals-action` security invariants.
- **When the repository has no skills, prompts, or eval suites:** Award `10/10` (`N/A — no skill/eval surfaces present`) and note `N/A` in the evidence column.

### 7. Backlog SLA (`backlog-groom` — Max `10` pts)

Start at `10` points and deduct:
- `-3` for each inbound issue or external PR unresponded `>24h` (up to `-6`).
- `-2` for each untriaged external PR missing Tier 1/2/3 disposition (up to `-6`).
- `-2` for each stale "ball in maintainer's court" PR awaiting maintainer review `>14d` (up to `-4`).

## Grade Scale & Reporting Format

| Score Range | Grade | Interpretation |
| --- | --- | --- |
| `97–100` | `A+` | Exemplary — zero open hygiene, security, coverage, or SLA debt |
| `90–96` | `A` | Healthy — minor non-blocking backlog or aging items only |
| `80–89` | `B` | Good — localized coverage, doc, or workflow gaps remaining |
| `70–79` | `C` | Fair — actionable CI, coverage, or dependency debt requires attention |
| `60–69` | `D` | Degraded — failing gates or high-severity debt |
| `<60` | `F` | Critical — failing default-branch CI, KEV/secret exposure, or major regressions |

Include both **Before** and **After** scores in the consolidated `repo-maintain/automated` PR summary table so maintainers can see the exact point gain delivered by the pass.
