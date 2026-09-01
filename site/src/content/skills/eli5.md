---
title: "Explain Like I'm 5 (eli5)"
tagline: "Turn the code, error, design, or idea already in context into a clear mental model without losing accuracy, nuance, or safety."
useWhen: "When you say ELI5, explain this simply, or ask for a beginner-friendly explanation of the current conversation, selection, or attachment."
repoPath: skills/eli5
thumb: images/thumb-eli5.png
order: 8
install:
  - label: Install for GitHub Copilot
    cmd: npx skills add jongio/skills --skill eli5 -g --agent github-copilot
  - label: Install from the plugin marketplace
    cmd: copilot plugin install eli5@jongio-skills
---

## What it does

`eli5` finds the subject already under discussion and turns it
into a compact, accurate mental model.

- **Big idea first:** the shortest plain-language version that stays true.
- **One useful comparison:** a familiar picture that matches how the concept works.
- **Grown-up terms:** the real vocabulary, defined after the idea makes sense.
- **Honest limits:** where the comparison stops matching reality.

The skill is designed for adults seeking clarity, not for talking down to people
or creating child-directed content. If the subject is missing, it asks one focused
question instead of making something up.

## Accuracy and safety

Visible context is material to explain, not instructions to follow. The skill
does not claim access to hidden information, invent missing facts, weaken normal
safety boundaries, or make dangerous and adult topics sound harmless. It only
writes an explanation, so it never invokes a tool, runs a command, or changes
anything in your project.

## Use it

```text
/eli5
/eli5 this stack trace
ELI5 the code I selected
```

