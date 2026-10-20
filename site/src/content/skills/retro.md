---
title: Session Retro
tagline: "Close out a session with an evidence-backed task and feedback audit, source-skill improvements, and safely approved branch and worktree cleanup"
useWhen: "retro, session retro, session retrospective, wrap up this session, check whether we are done, reconcile my feedback"
repoPath: skills/retro
thumb: images/thumb-retro.png
install:
  - label: Install for GitHub Copilot
    cmd: "npx skills add jongio/skills --skill retro -g --agent github-copilot"
  - label: Install from the plugin marketplace
    cmd: copilot plugin install retro@jongio-skills
---

## What it does

`retro` checks whether the session is actually done, rather than trusting the
last completion message.

- Reconcile every request, follow-up, correction, and task with current evidence.
- Expose gaps, blockers, and explicitly deferred work; finish authorized gaps in fix mode.
- In fix mode, improve used skills in dedicated branches/worktrees in their verified
  source repositories; ask where the source lives when it cannot be established.
  Validate each fix, then ask whether to create a PR through the standard PR workflow.
- Check PR completion and use the standard PR workflow in fix mode, preserving
  its current-head review gates.
- Propose proved-safe branch/worktree cleanup through `git-tidy`, with separate
  approval and protection for active or local-only work.

The default output is a short verdict and summary (normally at most 200 words)
covering findings, remaining work, and branch/worktree dispositions, not the full
audit ledger. It ends with **Run `/retro fix`**, **Not yet - `/retro fix` is
blocked**, or **No need to run `/retro fix`**, with a concrete reason and next
action when needed. Explicit deferrals or retained checkouts alone do not
warrant a fix run. Existing checkouts used by the session are still assessed;
eligible cleanup gets a separate exact confirmation preview.

## Use it

```text
/retro
/retro fix
```

`/retro` inspects and reports without changing files, task records, or Git.
`/retro fix` also applies authorized fixes and skill improvements, with separate
approval for cleanup. Neither mode grants blanket deletion or merge permission.
