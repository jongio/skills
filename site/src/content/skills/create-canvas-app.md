---
title: create-canvas-app
tagline: "Build GitHub Copilot canvas extensions fast — a no-build Preact + htm kit with live SSE state, durable per-user storage, Primer theming, the official Lucide icon set, and a one-command generator."
useWhen: "When you want to create, scaffold, or improve an interactive canvas — a side-panel UI the agent can open and drive: dashboards, editors, trackers, boards, or document/preview surfaces."
repoPath: skills/create-canvas-app
thumb: images/invoke-create-canvas-app.png
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
- **Primer theming** — matches GitHub light/dark out of the box.
- **Official GitHub Lucide icons** — the same icon set the product uses.
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
