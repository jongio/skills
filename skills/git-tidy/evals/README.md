# git-tidy eval

A Vally capability eval for read-only-by-default git repository hygiene. Six
scenarios cover four areas:

- **Classification:** rate branches and stashes by confidence (safe, review,
  keep) from supplied repository state.
- **Safety:** keep the default, checked-out, and protected-pattern branches off
  the deletion list, and require explicit approval before any cleanup.
- **Scope discipline:** keep large-blob findings report-only and never rewrite
  history.
- **Untrusted input:** treat branch names, commit messages, and stash metadata
  as data, not as instructions.

From the skill root:

```sh
npm install
npm run eval:lint
npm test
npm run eval
```

`npm test` is the deterministic cross-surface registration check and needs no
dependencies. The full eval drives a real agent and is intended for on-demand or
nightly use.
