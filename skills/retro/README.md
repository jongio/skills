# retro

An evidence-backed session closeout: reconcile every request and correction,
finish authorized gaps, improve the skills actually used, and clean up only
branches and worktrees proved safe and separately approved.

## Use

```text
/retro
/retro fix
```

Use it when a session is done, or when you think it is. No need to reconstruct
your task list first: the agent checks the available session history, task
records, delegated results, deliverables, and associated review feedback.
If history is incomplete, it says so and asks for the missing context.

`/retro` audits and reports without project, skill, task-status, Git, or remote
changes. `/retro fix` also fixes outstanding work already within scope and
improves used skills. An explicit current natural-language request to fix work or
update skills also selects fix mode; a question about completion selects audit.

## What happens

1. Build a request-by-request ledger with evidence and explicit statuses.
2. Identify gaps; in fix mode, finish authorized work and validate the current
   result, not an earlier draft.
3. Review each used skill for reusable lessons. In fix mode, create a dedicated
   branch and worktree in the skill's source repository, not an installed cache
   or the session's application repository. Ask where the source lives when unknown.
   After making and validating the fix, retro asks whether you want a PR and
   runs `/pr` from that worktree only if you agree. Declining leaves the fix in
   its worktree without committing, pushing, or deleting it.
4. Check PR completion; in fix mode, continue the standard `/pr` workflow,
   preserving current-head expected-review gates and repository policy.
5. Identify cleanup candidates; in fix mode, use `git-tidy` after separate approval,
   preserving current, dirty, active, unproven, and still-needed worktrees.
   Include existing branches/worktrees used by the session, not just newly
   created ones. Preview eligible cleanup and explicitly ask for confirmation;
   audit mode proposes it without granting deletion permission.
6. Report **Complete**, **Complete with explicit deferrals**, or **Incomplete**
   in a short summary (normally at most 200 words), covering material findings,
   remaining work, and branch/worktree dispositions. Keep the full ledger and
   routine evidence details out of the default output; show exact cleanup
   identities and proof separately when requesting approval.

Every summary ends with a concrete recommendation: **Run `/retro fix`** when
it can advance identified in-scope work; **Not yet - `/retro fix` is blocked**
when a prerequisite must come first; or **No need to run `/retro fix`** when
no actionable remediation remains. Explicit deferrals, deliberately retained
worktrees, or cleanup confirmation alone do not warrant another fix run.
Pending approval remains unfinished, not completed cleanup.

Correct skills need no edits. A source edit is not a release or installation;
the report distinguishes those states. Missing sibling skills or unavailable
proof leave work blocked or retained, never silently bypassed.

## Boundaries

This is not automatic deletion, merge permission, a whole-machine cleanup,
or a replacement for `pr`, `git-tidy`, or `create-skill`. It does not turn
one-session preferences into global rules or copy private incidents into
shared skills. Commits, pushes, paid evals, and other separately gated actions
retain their approval requirements.

See [SKILL.md](SKILL.md) for the workflow and
[closeout safety](references/closeout-safety.md) for PR and cleanup gates.

## Install

```sh
npx skills add jongio/skills --skill retro
```

Reload your agent skills, then invoke `/retro`.

## Development

```sh
npm ci --ignore-scripts
npm test
npm run eval:lint
```

Deterministic tests check the portable skill shape, required safety contracts,
local documentation links, and eval case coverage. They do not prove agent
behavior. The [capability evals](evals/README.md) cover representative closeout
failures; running them requires separate approval for agent usage.

## License

MIT. See [LICENSE](LICENSE).
