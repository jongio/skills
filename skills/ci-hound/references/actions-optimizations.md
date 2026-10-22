# GitHub Actions Reliability & Performance Playbook

Use these verified patterns when `ci-hound` wakes on a `JOB_FAILED`, `WORKFLOW_FAILED`, or `optimize` pass.

## 1. Masked Subshell Exit Codes in `$GITHUB_OUTPUT`

- **Symptom**: `actions/cache` or downstream steps fail with `Input required and not supplied: path` after a network timeout in `echo "path=$(pnpm store path --silent)" >> "$GITHUB_OUTPUT"`.
- **Root Cause**: `echo "..."` succeeds with exit code `0` even when the inner `$(...)` command fails or times out, writing `path=` (blank).
- **Fix**: Assign `store_path="$(...)"` on a standalone line under `set -euo pipefail`, retry transient bootstrap downloads (e.g., 3 attempts with 5s backoff), verify `[[ -n "${store_path//[[:space:]]/}" ]]`, and only then append to `$GITHUB_OUTPUT`.

## 2. Unused Subprocess `stdin` `EPIPE` Races on Linux

- **Symptom**: Short-lived preflight commands (`node --version`, `--help`, linter checks) intermittently fail on Linux with `write EPIPE`.
- **Root Cause**: Spawning with `stdio: ["pipe", "pipe", "pipe"]` and calling `child.stdin.end("")` races with fast child exit on Linux kernels.
- **Fix**: Use `stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"]` and only write/end `stdin` when input is explicitly supplied.

## 3. GitHub Actions Job/Step Metadata & Search-Index Lag

- **Symptom**: Release admission or publication checks fail with `Required source CI job did not succeed` or `No trusted exact-SHA default-branch CI run exists` right after a CI run finishes.
- **Root Cause**:
  1. Top-level workflow runs often transition to `completed`/`success` seconds or minutes before nested job/step objects settle from `in_progress`/`queued` to `completed`/`success`.
  2. Filtered run queries (`?head_sha=...&branch=main`) intermittently return `[]` during search-index blips.
- **Fix**: Treat validated `queued`/`in_progress`/`waiting`/`pending` job and step states (with no failed steps) and transient empty filtered run responses as retryable pending states rather than terminal failures.

## 4. Windows NTFS `EPERM` During Concurrent Lock/Temp File Cleanup

- **Symptom**: Intermittent `EPERM: operation not permitted, unlink/stat/read` on `windows-latest`.
- **Root Cause**: NTFS marks unlinked files with `STATUS_DELETE_PENDING` while another handle briefly inspects the path.
- **Fix**: Handle `EPERM` and `EACCES` alongside `ENOENT` in lock-slot and temp-file cleanup/inspection helpers, using bounded retries.

## 5. Superseded Workflow Runs & Critical-Path Bottlenecks

- **Symptom**: Rapid merges to `main` queue multiple 30–40 minute prerelease or validation runs in parallel, starving runners.
- **Fix**:
  - Use `concurrency` groups with `cancel-in-progress: true` for PR and non-publishing preview workflows (while keeping `cancel-in-progress: false` for state-mutating release publication jobs).
  - Reuse verified artifact/check outputs across stages instead of re-running identical test matrices on the same SHA.

## 6. Local Workflow Verification Before Pushing Fixes

- **Static validation**: Run `actionlint` and `shellcheck` (ensuring LF line endings on `.sh` scripts).
- **Local job execution**: When Docker or Podman is available (`act workflow_dispatch --job <job>`), verify workflow wiring locally before opening the PR.
