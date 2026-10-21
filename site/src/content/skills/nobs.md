---
title: nobs
tagline: "Give the shortest complete answer for supplied or current context without filler or loss of essential facts."
useWhen: "nobs, no fluff, cut the fluff, concise answer, shorten this response"
repoPath: skills/nobs
thumb: images/thumb-nobs.png
install:
  - label: Install for GitHub Copilot
    cmd: "npx skills add jongio/skills --skill nobs -g --agent github-copilot"
---

## What it does

Give the shortest complete answer for supplied or current context without filler or loss of essential facts.

## Use it

```text
/nobs
/nobs <text to shorten>
/nobs off
/nobs on
```

The full jongio-skills plugin enables concise responses by default in Copilot
CLI. The standalone skill is on demand; it does not install the automatic rule.
Say `nobs off` to opt out for the conversation. Persistent opt-out is unsupported;
a new conversation starts with the default on again while the full plugin is enabled.

Essential facts, risks, blockers, and uncertainty stay visible. Requests for
detail and required output formats override brevity.
