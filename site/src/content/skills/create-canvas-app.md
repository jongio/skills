---
title: create-canvas-app
tagline: "Build GitHub Copilot canvas extensions fast — a no-build Preact + htm kit with live SSE state, durable per-user storage, optional multiplayer state shared through a private GitHub repo, Primer theming, the official Lucide icon set, a one-command generator, and deep links into the app."
useWhen: "When you want to create, scaffold, or improve an interactive canvas — a side-panel UI the agent can open and drive: dashboards, editors, trackers, boards, or document/preview surfaces."
repoPath: skills/create-canvas-app
thumb: images/thumb-create-canvas-app.png
order: 1
install:
  - label: Install for GitHub Copilot
    cmd: npx skills add jongio/skills --skill create-canvas-app -g --agent github-copilot
  - label: Install from the plugin marketplace
    cmd: copilot plugin install create-canvas-app@jongio-skills
---

## What it does

`create-canvas-app` turns a one-line prompt into a working **Copilot App canvas** —
an interactive side-panel surface the agent can open and drive. It ships a
no-build **Preact + htm** kit so there's no bundler to fight, with the pieces a real
canvas needs already wired:

- **Live state over SSE** — the canvas and the agent stay in sync in real time.
- **Durable per-user storage** — state survives reloads and sessions.
- **Shared, multiplayer state (optional)** — back a canvas with a JSON file in a
  private GitHub repo so a team edits **one** live document and sees each other's
  changes within seconds. GitHub is both the store and the access control — no
  server to run. Writes are optimistic-locked; set a `stateSchema` and a bad remote
  edit is rejected instead of corrupting everyone's board.
- **Primer theming** — matches GitHub light/dark out of the box.
- **Official GitHub Lucide icons** — the same icon set the product uses.
- **Host AI, no API keys** — call the Copilot app's own model from an action with
  `ctx.ai(…)` (silent generation) or hand work to the main agent with `ctx.askAgent(…)`.
- **Deep links into github-app:** open a session (or any documented app surface) from a
  canvas with a validated `ghapp://` link that the app routes into its confirmation-gated pipeline.
- **A generator** that stamps a working canvas in one command, plus tests.

## When to reach for it

Use it whenever the task is a canvas — dashboards, editors, trackers, boards, or
document/preview surfaces. It is **not** for plain (non-canvas) agent tools or for
shipping web apps unrelated to Copilot canvases.

## Use it

Once installed, just describe the canvas you want from the Copilot composer:

```text
/create-canvas-app a customized stock ticker
```
