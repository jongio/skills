---
title: create-canvas-app
tagline: "Build interactive dashboards, boards, and editors that Copilot can open and update beside your conversation."
useWhen: "When you want to create, scaffold, or improve an interactive canvas — a side-panel UI the agent can open and drive: dashboards, editors, trackers, boards, or document/preview surfaces."
repoPath: skills/create-canvas-app
thumb: images/thumb-create-canvas-app.png
order: 1
install:
  - label: Install for GitHub Copilot
    cmd: npx skills add jongio/skills --skill create-canvas-app
  - label: Install from the plugin marketplace
    cmd: copilot plugin install create-canvas-app@jongio-skills
---

## What it does

`create-canvas-app` creates an interactive side panel in the Copilot app. Use it
for a project board, document preview, editor, or dashboard the agent can update
as you work.

- The panel updates live over SSE when you or the agent changes its state, without clobbering focus or in-progress typing.
- Saved state survives reloads and later sessions (with optional shared `githubStore` storage in a private repository).
- Light and dark themes match GitHub Primer tokens and ship the official GitHub Lucide icon set.
- Buttons can call the app's AI (`ctx.ai`) or hand a task back to the agent (`ctx.askAgent`), without a separate API key.
- Includes validated `ghapp://` deep-link builders, SSRF-safe `safeFetch` egress guards, and `sync-kit.mjs` / `check-kit-freshness.mjs` for scoped kit updates.

The generated Preact + htm app runs without a build step, offers `list`, `data`, and `ai` templates, and includes an HTTP smoke test.

## When to reach for it

Use it whenever the task is a canvas — dashboards, editors, trackers, boards, or
document/preview surfaces. It is **not** for plain (non-canvas) agent tools or for
shipping web apps unrelated to Copilot canvases.

## Use it

In the Copilot app, describe what the panel should display and which actions you need:

```text
/create-canvas-app a project board with tasks grouped by status and a button to summarize blockers
```
