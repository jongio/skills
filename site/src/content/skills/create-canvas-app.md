---
title: create-canvas-app
tagline: "Build interactive dashboards, boards, and editors that Copilot can open and update beside your conversation."
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

`create-canvas-app` creates an interactive side panel in the Copilot app. Use it
for a project board, document preview, editor, or dashboard the agent can update
as you work.

- The panel updates live when you or the agent changes its state.
- Saved state survives reloads and later sessions.
- Optional team sharing keeps one document in a private GitHub repository.
- Light and dark themes match GitHub.
- Buttons can use the app's AI or hand a task back to the agent, without a separate API key.

The generated Preact + htm app runs without a build step and includes tests.

## When to reach for it

Use it whenever the task is a canvas — dashboards, editors, trackers, boards, or
document/preview surfaces. It is **not** for plain (non-canvas) agent tools or for
shipping web apps unrelated to Copilot canvases.

## Use it

In the Copilot app, describe what the panel should display and which actions you need:

```text
/create-canvas-app a project board with tasks grouped by status and a button to summarize blockers
```
