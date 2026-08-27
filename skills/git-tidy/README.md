# git-tidy

Comprehensive git repository hygiene in one pass. Audit branches, worktrees,
stashes, tags, remotes, merge artifacts, ignored-but-tracked files, large
history blobs, and maintenance health, then tidy up only what you approve.

## What it does

`git-tidy` scans a repository and classifies every finding by confidence:

- 🟢 **Safe to delete** (HIGH): merged branches, remnant remote branches whose
  PRs merged, orphaned worktrees, ancient stashes, dead remotes, `.orig` merge
  artifacts.
- 🟡 **Review recommended** (MEDIUM): stale branches, orphaned tracking
  branches, interrupted rebases, ignored-but-tracked files, history bloat.
- 🔴 **Keep** (LOW): active work, dirty worktrees, recent stashes, release tags.

It reports large blobs and git maintenance health as information only, and it
never deletes anything, rewrites history, or touches a protected branch without
your explicit approval.

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
/git-tidy branches
/git-tidy --dry-run
git-tidy, my branch list is a mess
```

## Scope switches

```text
git-tidy              Full analysis (every category)
git-tidy branches     Local + remote branches only
git-tidy worktrees    Worktrees only
git-tidy remote       Remote branches only (GitHub)
git-tidy stashes      Stashes only
git-tidy tags         Tags only
git-tidy artifacts    Merge/rebase artifacts only
git-tidy blobs        Large blob detection only
git-tidy maintenance  Git housekeeping report only
git-tidy --dry-run    Analysis only, no cleanup phase
```

## Safety

Analysis is read-only. Cleanup runs only after you pick the items and confirm
the exact commands. The skill prefers `git branch -d` over `-D`, warns before
every remote deletion and `git rm --cached`, keeps protected branches and
release tags off the deletion list, and never rewrites history. Large-blob
findings are report-only: it points you at Git LFS or `git filter-repo` rather
than running them for you.

## Validation

```sh
npm install
npm run eval:lint
npm test
npm run eval
```

`npm test` checks that the skill stays registered across every catalog surface
and needs no dependencies. `npm run eval:lint` is the fast static schema check.
The full `npm run eval` drives a real agent and can consume Copilot usage.

## License

MIT. See [LICENSE](LICENSE).
