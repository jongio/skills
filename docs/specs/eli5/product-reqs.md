---
title: "Product Requirements: Explain Like I'm Five"
status: approved
created: 2026-08-20
updated: 2026-08-20
---

# Product Requirements: Explain Like I'm Five

## 1. Problem

People often have enough context in a conversation to ask for a simpler
explanation, but general requests such as "explain this" can produce jargon,
invented context, patronizing language, or analogies that hide important limits.
They need a repeatable way to turn the subject already under discussion into a
clear mental model without sacrificing accuracy or safety.

## 2. Users

- Developers trying to understand unfamiliar code, errors, architecture, or tools.
- Non-specialists reading technical or domain-specific material.
- Experienced users who want a quick plain-language reset.

The intended user is an adult seeking a simple explanation. The skill is not a
child-directed product.

## 3. User Outcomes

- Invoke one memorable skill without restating the subject.
- Receive a short explanation using ordinary words and one useful analogy.
- Learn the correct grown-up terms after understanding the basic idea.
- Know where the analogy stops matching reality.
- Get one focused question instead of a fabricated answer when context is missing.

## 4. Functional Requirements

1. Resolve the subject from an explicit invocation argument, current selection or
   attachment, or the most recent substantive subject in visible conversation
   context, in that order.
2. Use only context available to the current agent session. Never claim access to
   hidden, omitted, private, or unavailable information.
3. Explain the big idea first, then a familiar analogy, the grown-up terms, and the
   analogy's limit.
4. Define necessary jargon in plain language and avoid baby talk.
5. Preserve uncertainty, nuance, and safety boundaries. Simplicity never overrides
   refusal, privacy, copyright, medical, legal, financial, or physical-safety rules.
6. Ask exactly one focused question when no subject can be grounded.
7. Produce explanation text only. Do not execute tools or mutate user state merely
   to explain context.

## 5. Non-Functional Requirements

- No runtime dependency, network call, persistence, or credential access.
- Installable through the repository's skills CLI and plugin marketplace paths.
- Capability evals cover grounded explanation, missing context, analogy limits,
  and sensitive-topic calibration.
- Catalog copy is consistent across README, plugin, marketplace, and site.

## 6. Acceptance Criteria

- AC-1: An invocation with technical context identifies and accurately explains
  the subject without requiring the user to repeat it.
- AC-2: The explanation uses plain respectful language, defines grown-up terms,
  and marks both the analogy and its limitation.
- AC-3: An invocation with no identifiable subject does not invent one and asks
  exactly one focused question.
- AC-4: Sensitive or dangerous topics retain clear risk language and all normal
  safety boundaries.
- AC-5: The skill is discoverable and installable from every established
  repository distribution surface.
- AC-6: Static skill and eval validation, the site build, and capability eval
  specification all pass.

## 7. Constraints

- Follow the repository's existing `SKILL.md`, Vally, marketplace, plugin, and
  Astro content conventions.
- Keep the skill prompt-only. Do not add a classifier, runtime engine, telemetry,
  or external service.
- Avoid Reddit branding or claims of affiliation.

## 8. Success and Rollback

Success means all acceptance criteria and quality gates pass, with zero critical
groundedness or safety failures in the eval scenarios. The feature is reversible
by removing its isolated skill directory and catalog registrations; it introduces
no persisted data or public API migration.

