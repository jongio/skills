# git-tidy

Git repository triage with content-aware proof for branches, worktrees, stashes,
and remote refs, plus protected read-only inventory for tags, remotes, merge
artifacts, ignored-but-tracked files, large history blobs, and maintenance
health. No refresh, save, cleanup, or GitHub write runs without its own explicit
approval.

## What it does

`git-tidy` separates work decisions from carrier cleanup:

1. Inventory carriers and coverage without mutating the repository.
2. Prove exact relationships from OIDs and complete change units, not age,
   names, stash messages, or branch-name-only PR matches.
3. Optionally review bounded sanitized text to explain intent. Review can make a
   result more conservative, never safer to delete.
4. Apply review through the no-Git `scripts/apply-review.mjs` adapter, which
   accepts exact UTF-8 JSON capped at 20 MiB and returns the original or a
   monotonically weakened result. It never authorizes an action.
5. Translate the internal outcome into one plain-language decision and one
   concrete next action.
6. Show any per-carrier action separately with proof, witnesses, drift checks,
   exact commands, and a dedicated approval or specialist handoff.
7. Present the familiar Git Clean audit with numbered **Safe to Remove**,
   **Needs Review**, **Keep**, and **Skipped** sections before asking the user to
   select anything.
8. Preserve each accepted result under a unique timestamp and `runId` artifact
   name so reruns never replace the evidence behind an earlier recommendation.

Every work item reports mechanical evidence, optional content review, required
user judgment, preservation witnesses, blockers, and coverage gaps. Pull
requests are evidence only and join by repository identity, exact head ref
name, and exact head OID. GitHub branches attach to remote carriers only by
exact repository ID, ref name, and tip OID.

A normal interactive run starts with a categorized audit, not an abstract
decision queue. Every visible branch, worktree, stash, and remote ref has a row,
a confidence category, a concrete reason, and a stable number. Safe-removal rows
also name the durable copy that remains. Active branches remain unchanged unless
the user chooses to review them. The complete audit appears inside the
interactive question, so its choices never become a context-free menu.

The interactive dashboard is mandatory for normal runs. A prose-only report is
complete only for `--dry-run` or an explicit report-only request.

Mechanically proven duplicates can be selected without a mandatory content
review round, but never without the categorized report. The user can select all
visible safe rows, enter specific row numbers, review medium items, keep
everything, or inspect full evidence. No redundant per-carrier card follows a
numbered safe selection. Batches contain at most ten destructive actions.
Selection is not authorization. Selected carriers are revalidated before exact
commands and separate mutation-class approvals are shown.

Active-work decisions use a three-line card: `Decision`, `Why`, and `Next
action`. Every card names the branch, stash, or worktree it concerns. Before a
destructive selection, the card names the exact removal target and the durable
copy that remains. OIDs, changed-file paths, proof mechanics, exclusions, risks,
and analyzer details appear only after `Show details`.

For a dirty linked worktree, the skill says not to delete yet and gives the
ordered path: save the changes, remove the worktree, then reconsider the branch.
Each mutation keeps its own approval and fresh revalidation.

## Install

```sh
npx skills add jongio/skills --skill git-tidy -g --agent github-copilot
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

Analysis and revalidation are read-only. Fetch and prune are mutations, so
remote refresh is a separately approved external workflow followed by a fresh
analysis. Unknown remote access never proves a remote dead. Dirty, conflicted,
locked, missing, or unknown worktrees aren't removal candidates.

Default-branch protection comes only from a valid local
`refs/remotes/origin/HEAD` target and its inventoried remote object. The analyzer
never guesses `main` or `master`; unresolved identity blocks destructive local
branch actions while retaining explicit policy protection.

Age only prioritizes review. A stash or branch is removable only when exact
mechanical proof shows every change unit survives on an unselected durable
carrier. Large blobs stay report-only. Reflog expiry, garbage collection, and
repack can destroy recovery paths, so they're never preselected or described as
ordinary non-destructive housekeeping.

The main worktree is always protected. Worktree evidence reports categorical
status counts, nullable sparse state, and an ignored-path count. Ignored entries
are counted from `! ` records only; names and payloads are not retained or read.
Conflicts, dirty submodules, intent-to-add, ignored content, or unknown ignored
state block removal.

Protected GitHub branches block remote deletion. Remote-only content absent
locally remains partial, `keep`, ineligible, and `defer` until a separately
approved isolated acquisition satisfies its deterministic prerequisite.

Selecting a work outcome doesn't authorize an operation. Each refresh, optional
read, save, checkout, rebase, merge, push, PR write, stash drop, ref deletion,
worktree removal, tag/remote removal, file action, and maintenance action gets
its own exact approval and fresh revalidation.

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
