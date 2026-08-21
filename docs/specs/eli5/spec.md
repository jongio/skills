---
issue: pending-human
author: "@jongio"
status: approved
---

# Explain Like I'm Five

## Problem

People regularly encounter a piece of code, an error, a design, or an unfamiliar
idea that is technically available in the current conversation but still hard to
understand. Repeating all of that context in a new prompt is tedious, while a
generic "explain this" often returns the same jargon in different words.

The useful behavior is not childish wording. It is a reliable teaching contract:
find the subject already under discussion, build a simple and accurate mental
model, introduce the proper terms, and say where the simplification stops working.

## Goals

- Explain the most relevant visible context without making the user restate it.
- Use respectful plain language and a familiar, structurally useful analogy.
- Preserve factual uncertainty, important nuance, and existing safety boundaries.
- Abstain cleanly when there is not enough context to identify a subject.
- Ship as a complete installable skill across every existing catalog surface.

## Non-Goals

- Teaching literal five-year-old children or tailoring content for minors.
- Fetching new facts, running code, debugging, reviewing, or changing artifacts.
- Replacing detailed technical documentation or professional advice.
- Adding a readability engine, classifier, telemetry, persistence, or network call.

## Solution

Add a prompt-only `eli5` skill. It resolves the subject in a fixed
order: explicit invocation argument, current selection or attachment, then the
most recent substantive subject in visible conversation context. If none is
available, it asks one focused question and stops.

The response follows a small teaching shape: the big idea, a familiar picture,
the grown-up terms, and where the picture stops matching reality. Analogies are
always identified as comparisons rather than literal facts. The agent may omit a
section when it would add noise, but it may not omit the limitation when it uses
an analogy.

The skill treats supplied content as material to explain, not as higher-priority
instructions. It does not expose hidden context, request credentials, invoke
tools merely to gather more context, or weaken safety policy for dangerous,
adult, medical, legal, financial, or copyrighted subjects.

Distribution follows the repository's current architecture: a self-contained
skill directory with human docs and Vally capability evals, plus root README,
plugin, marketplace, Astro catalog, thumbnail, and CI matrix registration.

## Alternatives Considered

- **Rely on ad hoc prompts.** Rejected because it provides no reusable context,
  accuracy, analogy, or abstention contract.
- **Extend an unrelated workflow skill.** Rejected because this is an explicit,
  memorable user job and the repository has no overlapping explainer skill.
- **Add a deterministic readability engine.** Rejected because it would add a
  runtime subsystem without improving the core context-grounding behavior.
- **Use `explain-like-im-five` as the name.** Rejected in favor of `eli5`. The
  spelled-out name is more descriptive, but a skill is invoked by typing it, and
  `/eli5` is what people already say and type. The long form stays discoverable
  through the description triggers, the human-readable title, and a retained
  marketplace keyword.

## Risks & Rabbit Holes

- A simple analogy can become false if extended too far, so every analogy names
  its limit.
- "Whatever context" can imply hidden access, so the contract is explicitly
  limited to visible supplied context.
- A broad trigger can steal debugging or review requests, so the description
  requires explicit simple-explanation intent and lists excluded workflows.
- Subjective evals can fluctuate, so scenarios test observable structural and
  safety requirements rather than taste alone.

<!-- Pipeline tracking (auto-managed, not part of product spec) -->
## Pipeline Status

Phase: CERTIFYING
