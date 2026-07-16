# Data Sources and Provenance

Every data point in the model-intel skill is traceable to a public source.
This document maps each registry field to its origin.

## Fields from GitHub Public Documentation

| Field | Source | URL |
|-------|--------|-----|
| Model names | Supported AI models page | https://docs.github.com/en/copilot/reference/ai-models/supported-models |
| Provider | Supported AI models page | https://docs.github.com/en/copilot/reference/ai-models/supported-models |
| Release status (GA, Public preview) | Supported AI models page | https://docs.github.com/en/copilot/reference/ai-models/supported-models |
| Category (Lightweight/Versatile/Powerful) | Models and pricing page | https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing |
| Pricing (input/cached/output/cache write) | Models and pricing page | https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing |
| Long context pricing tiers | Models and pricing page (threshold column) | https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing |
| Task area classifications | AI model comparison page | https://docs.github.com/en/copilot/reference/ai-models/model-comparison |
| 1M context support (yes/no) | Extended capabilities table | https://docs.github.com/en/copilot/reference/ai-models/supported-models#models-with-extended-capabilities |
| Configurable reasoning (yes/no) | Extended capabilities table | https://docs.github.com/en/copilot/reference/ai-models/supported-models#models-with-extended-capabilities |
| Context window thresholds (272K, 200K) | Pricing page threshold column | https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing |

## Fields from Copilot User-Facing Product (visible to all users)

These fields are part of the Copilot product UI and visible to every subscriber.
They appear in VS Code model picker, CLI model selection, and product documentation.

| Field | Source | Notes |
|-------|--------|-------|
| Model IDs (e.g., `claude-sonnet-5`) | Copilot model selector UI | Visible in VS Code, CLI, and GitHub.com model picker |
| Effort/reasoning levels (low/medium/high/xhigh/max) | Copilot reasoning level dropdown | Visible in VS Code and CLI when selecting a model |
| Context tiers (default, long_context) | Copilot context window selector | User selects context tier in VS Code and CLI |
| Tier (standard/premium) | Copilot billing UI | Reflected in AI credits consumption; was explicit in legacy request-based billing |

## Fields from External Public Sources (editorial)

| Field | Source | Notes |
|-------|--------|-------|
| Family grouping (sonnet/opus/gpt-5/etc.) | Derived from model names | Editorial classification |
| Release dates | Provider blog posts, press coverage | Approximate; from public announcements |
| Architecture descriptions | Provider model cards, blog posts | Links in model-comparison page "Further reading" column |
| Capability scores (0-100) | Derived from public benchmarks | See methodology below |

## Benchmark Score Methodology

The `scores` object in `registry.mjs` contains normalized 0-100 values. These are
NOT raw benchmark numbers. They are composite assessments derived from public benchmarks.

Each dimension maps to specific public benchmarks:

| Dimension | Primary benchmarks | Sources in `sources.mjs` |
|-----------|-------------------|--------------------------|
| codeGeneration | SWE-bench Verified, Terminal-Bench | Provider system cards, Vellum, CodingFleet |
| codeReview | SWE-bench Pro | MorphLLM, CodingFleet |
| reasoning | GPQA Diamond, ARC-AGI-2, FrontierMath, USAMO | Provider announcements, OfficeChai |
| contextLength | Max context tier from GitHub docs | GitHub docs (factual, not editorial) |
| instructionFollowing | IFEval, provider evals | Provider model cards |
| speed | Inverse of pricing tier and latency class | GitHub pricing page + provider specs |
| costEfficiency | pricing.input + pricing.output | GitHub pricing page (factual) |
| multiFile | OSWorld, multi-file agent benchmarks | CosmicJS, OfficeChai, OpenAI |
| creativeWriting | LMArena/LMSYS ELO, GDPval-AA | NxCode, CodingFleet, LMArena |
| toolUse | Provider tool-use evaluations, MCP Atlas | CodingFleet, provider docs |

All individual benchmark citations with clickable source URLs are in `scripts/sources.mjs`.

Scores for models without direct benchmark coverage in a given dimension are
conservative interpolations from family/generation position (e.g., Opus 4.8 scores
slightly above Opus 4.7 within the same architecture line).

## What is NOT in this skill

- No internal/unpublished model data
- No models that aren't listed on GitHub's public supported-models page
- No pricing from internal sources
- No benchmark data from private evaluations
- No information about unannounced or unreleased models
