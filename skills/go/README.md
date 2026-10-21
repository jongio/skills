# go

Plan, test, and implement the current context, then hand verified changes to pr for delivery and merge.

## Install

```sh
npx skills add jongio/skills --skill go --skill test-doctor --skill pr --skill doc-doctor
```

Invoke `/go <context>` with an issue, conversation, code, or error.
`go` plans, tests with Test Doctor, implements, and reviews/fixes; `pr` reuses
valid preflight evidence and owns Git, remaining checks, CI, reviews, and merge.
Only `pr` invokes `doc-doctor`, so calling `go` does not run it twice.

## Worktree choice

By default, `go` works in a linked worktree. It detects and reuses an existing
worktree without prompting. In the main checkout, it asks **Create worktree
(default)** or **Stay here** before tests or edits, even in merge auto mode.
Creating uses the configured external worktree root (or asks for a location);
staying applies only to this invocation. Existing edits remain protected.

## Merge choice

The default is to ask for final merge approval once the PR is ready:

```text
/go <context>
/go --merge=approval <context>
/go --merge=auto <context>
```

Use `--merge=auto` (or "auto merge") to authorize merging after all CI, review,
and feedback gates pass, without a final merge prompt. Use `--merge=approval`
(or "ask me before merging") to require that prompt. The choice is passed to
`pr` for this invocation only; standing policies and reviewer approvals do not
override the default. Conflicting choices require clarification. Auto mode
does not enable GitHub's `--auto` queue or bypass other approval boundaries.
Without final confirmation in approval mode, delivery pauses as awaiting
merge approval, not merged.

Both modes default to **squash merge and delete the PR branch afterward**. Ask
for another strategy or to keep the branch explicitly if needed; `go` carries
those choices to `pr`. Unsafe local cleanup is reported, not forced.

## Development

```sh
npm ci --ignore-scripts
npm test
npm run eval:lint
```

The deterministic test checks the portable skill shape. The Vally capability eval verifies that
the agent follows the workflow.

## License

MIT. See [LICENSE](LICENSE).
