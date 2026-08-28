---
name: hol-guard
description: >-
  Protect supported local AI coding harnesses with HOL Guard before tool execution.
  Installs the stable Guard runtime, detects the exact local harness integration,
  verifies protection with dry-run and doctor checks, routes blocked work through
  Guard approvals, and records receipts. USE FOR: hol guard, protect coding agent,
  AI runtime security, agent firewall, guarded Codex, guarded Claude Code, guarded
  Copilot CLI, runtime approvals. DO NOT USE FOR: claiming protection without Guard
  evidence, bypassing native harness controls, or silently enabling cloud sync.
---

# HOL Guard

Put HOL Guard in front of a supported local AI coding harness before mutation-bearing work. HOL Guard is an additional runtime-safety layer; keep the harness's own authentication, permissions, confirmations, sandboxing, and provider policies enabled.

## Safety contract

- Do not claim a harness is protected until HOL Guard itself reports a healthy result for the detected harness.
- Do not guess a harness identifier. Use `hol-guard detect --json` and use the exact supported identifier it returns.
- If Guard reports deny, review, unhealthy status, an unexpected mutation, or an error, stop mutation-bearing work. Never fall back to launching the raw harness binary.
- Never approve a blocked action without reading the Guard risk reason and understanding the requested scope.
- Keep HOL Guard Cloud optional. Do not run `hol-guard connect` or `hol-guard sync` unless the user explicitly asks for cloud connection or synchronization.
- Never weaken the harness's native safety, auth, sandbox, or confirmation controls because Guard is installed.

## Install stable HOL Guard

Probe the real CLI first:

```sh
hol-guard --version
```

If it is not available and the user asked to install Guard, use an isolated install of the verified stable release used by this skill:

```sh
pipx install --force "hol-guard==3.0.12"
hol-guard --version
```

The version pin is intentional so the installed runtime is reproducible. Do not substitute an alpha or prerelease unless the user explicitly asks to test one.

## Detect and protect the local harness

Start from the target workspace:

```sh
hol-guard status
hol-guard detect --json
```

Choose only an exact supported harness identifier returned by `detect`. Then use the Guard-owned protection path:

```sh
hol-guard bootstrap
hol-guard install <harness>
hol-guard run <harness> --dry-run
hol-guard doctor <harness> --json
hol-guard run <harness>
hol-guard status
```

The dry run and `doctor` must succeed before claiming protection. After the protected launch, keep the final `status` output as evidence of current posture.

If detection finds no supported harness, or bootstrap/install/dry-run/doctor fails, stop. Report the exact failure instead of starting an unprotected agent session.

## Handle blocked or approval-gated work

List and inspect Guard-owned decisions:

```sh
hol-guard approvals
hol-guard approvals open
hol-guard receipts
hol-guard diff <harness>
```

When Guard provides a request ID and a terminal decision is appropriate:

```sh
hol-guard approvals approve <request-id>
hol-guard approvals deny <request-id>
```

Approval is never implicit. A previous approval does not authorize a different request.

## Audit evidence

Use Guard's own evidence surfaces instead of inventing a success state:

```sh
hol-guard receipts
hol-guard inventory
hol-guard abom --format json
hol-guard events
```

Report only evidence actually returned by Guard.

## Data boundary

The local protection flow does not require a HOL Guard Cloud account. Detection, bootstrap, local install wiring, dry-run, doctor, protected launch, status, approvals, receipts, inventory, and events operate on the local Guard environment. Installing the Python package downloads the named distribution from PyPI.

Do not send prompts, completions, source files, `.env` contents, credentials, or secret stores to a third party merely to complete this skill. If the user explicitly asks for Guard Cloud connection or sync, inspect current connection state and explain the external synchronization boundary before enabling it.

## Remove HOL Guard

Third-party installation must remain reversible. To remove Guard-managed harness wiring, package shims, local Guard state, and the current HOL Guard package, use the product's documented removal command:

```sh
hol-guard uninstall --self
```

Do not manually delete harness configuration to simulate a clean uninstall when Guard owns that wiring. Verify the resulting state rather than claiming cleanup without evidence.

## Output

Return a concise protection report containing:

1. detected harness identifier;
2. HOL Guard version and install source;
3. bootstrap/install/dry-run/doctor/run results;
4. final `hol-guard status` evidence;
5. pending blocks or approvals, using request IDs only when Guard returned them;
6. whether optional cloud connect/sync remained disabled or was explicitly requested; and
7. the exact next safe command if work remains blocked.
