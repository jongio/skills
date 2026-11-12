# Public Repo Stealth Mode & Multi-Repo Fleet Isolation

## 1. Fail-Closed Public Repo Stealth Mode

Query `gh repo view --json visibility,isPrivate,defaultBranchRef` during Phase 0 before writing any commit, branch, PR description, issue comment, or log file.
- If `visibility == "PUBLIC"` **or** if repository visibility cannot be verified (offline rehearsal, missing field, or API error), enable **Public Repo Stealth Mode** automatically (fail-closed).
- Only disable Stealth Mode when `visibility` is explicitly verified as `"PRIVATE"` (or `"INTERNAL"` inside a private enterprise boundary when permitted by `.github/repo-maintain.json`).

### Redaction Rules When Stealth Mode Is Active

1. **Banned Public Terms:** Never emit any of the following in commit messages, branch names, PR titles, PR bodies, code comments, test names, or public GitHub issue comments:
   - Vulnerability identifiers: `CWE-\d+`, `CVE-\d{4}-\d+`, `GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}`
   - Severity/scoring labels: `CVSS`, `0-day`, `zero-day`, `OWASP`, `STRIDE`
   - Exploit terminology: `exploit`, `vulnerability`, `vulnerable`, `attack vector`, `payload`, `RCE`, `SSRF`, `XSS`, `SQLi`, `command injection`, `path traversal`
2. **Neutral Engineering Replacements:**
   - Instead of `fix(security): patch CWE-22 path traversal vulnerability in archive loader`, write:
     `fix(repo-maintain): harden input validation and configuration defaults` or `fix(validation): normalize archive entry paths before extraction`.
   - Instead of naming a regression test `test("blocks CWE-78 command injection payload")`, write:
     `test("rejects non-allowlisted shell metacharacters in argument parser")`.
3. **Private Local Operator Report:**
   - Write full technical details (`CWE-*` IDs, root cause, affected lines, and verification notes) only to `~/.copilot/repo-maintain/reports/<owner>__<repo>-secops.md` (or a gitignored local artifact outside the repository worktree).
   - Verify with `git status --ignored` and `node <skill-dir>/scripts/repo-maintain.mjs stealth-check --visibility=PUBLIC --text="<commit-or-pr-text>"` (adding `--fleet --private-repos="<owner/priv1,owner/priv2>"` in fleet mode; block publication if the private-repository inventory is unavailable) before every `git commit` and `gh pr create`/`gh pr edit`.

## 2. Multi-Repository Fleet Mode (`--all [--visibility all|public|private]`)

When iterating across multiple repositories locally:

1. **Discovery & Filtering:**
   - Read explicit fleet targets from `.github/repo-maintain.json#repos` (or `--repos <csv>`), or discover owned repositories via `gh repo list --json nameWithOwner,visibility,isArchived,isFork --jq '.[] | select(.isArchived == false and .isFork == false)'`.
   - Filter by `--visibility public`, `--visibility private`, or `--visibility all`.
2. **Strict Cross-Repository Context Partitioning:**
   - Process each repository sequentially with its own isolated worktree (`<worktree-root>/<repo>/repo-maintain-automated`) and its own state receipt (`~/.copilot/repo-maintain/<owner>__<repo>.json`).
   - **Zero Cross-Repo Leakage:** Never include private repository names, private issue/PR references, internal URLs, or fleet-wide summary tables containing private repo names inside a public repository's commit messages, PR descriptions, or workflow logs.
   - Keep the combined fleet summary table (`Public` + `Private` repositories, per-repo Health Scores, PR links, and `Needs My Attention` items) strictly in local terminal/session output.
3. **Public GitHub Actions Guard:**
   - Never commit personal multi-repo fleet schedules into a public repository where forks would inherit them.
   - If a target repository opts into a single-repo `.github/workflows/repo-maintain.yml`, guard every job with `if: github.event.repository.fork == false` and abort Phase 0 immediately if a public workflow context encounters `visibility != "PUBLIC"`.
