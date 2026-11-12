# git-tidy

Run `git-tidy` to audit the whole repository, review the evidence, and confirm
the listed cleanup in the same run. Use `--dry-run` to preview or `--depth metadata` for inventory only.

The audit includes branches, all registered worktrees, stashes, remote refs,
tags, artifacts, ignored tracking, large blobs, and maintenance health. It uses
typed legacy inventory, records coverage gaps, and saves a run-specific JSON
artifact when session storage is available.

Cleanup aims for a clean primary checkout on the verified default branch,
that branch as the sole local branch, and zero stashes. One confirmation
covers the listed targets and prerequisites, including stale origin tracking
refs. The plan verifies private backups before removing or overwriting work,
and revalidates each target before acting. The final audit reports progress
toward the target and the reason for each retained item.

Exact ancestry and exact tree comparisons catch squash merges. Inactive work
outside the default branch can be retired after approval and verified recovery.
Operational worktrees can stay detached at their existing commit. Ignored
files need verified recovery or exact output proof before removal.

## Install

```sh
npx skills add jongio/skills --skill git-tidy
```

Or install it from the Copilot plugin marketplace:

```sh
copilot plugin marketplace add jongio/skills
copilot plugin install git-tidy@jongio-skills
```

Reload with `/skills reload`, then invoke:

```text
/git-tidy
/git-tidy branches --depth proof
/git-tidy stashes --depth review
/git-tidy --dry-run
node scripts/apply-review.mjs
node scripts/verify-remote.mjs
```

## Scopes and depth

```text
git-tidy              All scopes
git-tidy branches     Local and remote branches
git-tidy worktrees    Main and linked worktrees
git-tidy remote       Remote refs and pull request evidence
git-tidy stashes      Stashes
git-tidy tags         Tags
git-tidy artifacts    Merge/rebase artifacts and ignored tracking
git-tidy blobs        Large history blobs, report-only
git-tidy maintenance  Repository and recovery health
git-tidy --dry-run    Analysis only, no approvals or actions
```

The content-aware analyzer includes typed legacy inventory for `tags`,
`artifacts`, `blobs`, and `maintenance` in its closed result. Bare `git-tidy`
collects all four after carrier analysis. A collector failure is reported as a
coverage gap, never as an empty successful inventory.

Depths are `metadata`, `proof`, and opt-in `review`. `proof` is the shipped
default for work-bearing scopes, while `metadata` is an explicit compatibility
mode. The versioned analyzer requires Node.js 22 or newer; without it the skill
falls back to metadata-only and offers no destructive work-bearing action.

## Safety

Analysis and revalidation are read-only in the target repository. The isolated
remote verifier uses an exact HTTPS URL, disposable storage, disabled hooks and
credential helpers, and existing authentication when required. The verified
default tip must match the local tracking ref used as evidence. Unrelated
tracking drift is reported separately.

Primary worktrees, protected refs, active work, and unverified data are
preserved. Live remote branch deletion requires an
explicit remote cleanup request, protection evidence, and an expected-OID
lease. Tags, artifacts, large blobs, and maintenance are audited. Changing
those areas requires a separate request.

Detailed contracts:

- [Evidence model](references/evidence-model.md)
- [Bounded content review](references/content-review.md)
- [Approval and revalidation](references/approval-flow.md)
- [Read-only command recipes](references/command-recipes.md)

## Validation

The shipped dependency-free Node.js analyzer has deterministic unit,
integration, registration, and safety tests. Validate the analyzer, its
coverage threshold, the eval specification, capability behavior, and the site:

```sh
npm test --prefix skills/git-tidy
npm run test:coverage --prefix skills/git-tidy
npm run eval:lint --prefix skills/git-tidy
npm run eval --prefix skills/git-tidy
npm run build --prefix site
```

The capability eval drives a real agent and may require the configured eval
runtime and credentials.

## License

MIT. See [LICENSE](LICENSE).
