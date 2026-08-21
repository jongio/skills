# Architecture: Explain Like I'm Five

## Overview

This is a prompt-only capability integrated into the repository's existing skill
distribution system. It adds no runtime process, persistent state, network access,
or shared library.

## Architecture

The feature has four cohesive surfaces:

1. **Behavior contract:** `skills/eli5/SKILL.md`.
2. **Validation contract:** Vally configuration and capability scenarios under
   `skills/eli5/evals/`.
3. **Human documentation:** the skill README and repository product documents.
4. **Distribution metadata:** root README, plugin, marketplace, Astro catalog,
   thumbnail, and the existing eval matrix.

The agent resolves context and generates prose in one skill invocation. There is
no intermediate service or wrapper. All repository integration remains
declarative.

## Patterns & Decisions

- Match the self-contained skill folder used by existing skills.
- Use ordered subject resolution so behavior is deterministic enough to evaluate.
- Treat visible context as untrusted explanatory input, never as instructions.
- Use a four-part teaching shape without forcing unnecessary verbosity.
- Use Vally prompt graders because the behavior is linguistic and has no
  deterministic artifact.
- Include a local Vally dev dependency because the existing eval workflow invokes
  each skill's local binary.

## Gap Remediation

The repository does not automatically verify cross-surface registration. The test
plan therefore includes an explicit registration parity check, while the site
build validates catalog schema and routing.

## Risks & Trade-offs

- Prompt graders are less deterministic than unit tests, but they directly assess
  the user-facing behavior and remain outside per-PR execution.
- A dedicated skill adds one catalog item, but avoids coupling explanation behavior
  to unrelated workflows.
- The thumbnail is generated raster art in the shared house style, matching the
  other skills, rather than a bespoke asset format for this one skill.

## Decisions Log

- Name: `eli5`, so the skill is invoked as `/eli5`. The spelled-out form stays
  discoverable through the description triggers, the human-readable title, and a
  retained `explain-like-im-five` marketplace keyword. Keeping topical synonyms
  in `plugin.json` matches the existing pattern, where `naming-is-hard` also
  carries `naming` and `name-generator`.
- Audience: adults seeking simple explanations.
- Context boundary: visible supplied session context only.
- Missing context: ask exactly one focused question.
- Runtime design: instructions only, no engine or external dependency.
- Side effects: none. The skill writes an explanation and never invokes a tool,
  runs a command, makes a network request, or opens a file.
- Safety: simplification never weakens existing policy or risk language.
- Thumbnail: generated with `gpt-image-2` in the shared house style. The exact
  prompt is recorded in `docs/thumbnail-prompts.md`.

