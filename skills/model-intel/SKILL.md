---
name: model-intel
description: >-
  Discover all AI models available in the user's Copilot environment, then
  research each model's architecture, strengths, weaknesses, benchmark
  performance, pricing tier, context window, and optimal use cases. Produces a
  rich interactive report with comparison matrices, radar charts (text/unicode),
  decision trees, and per-task recommendations. Use when the user wants to know
  which models they have access to, compare model capabilities, decide which
  model to pick for a task, or generate a model landscape overview. Do NOT use
  for changing the active model (use /model), for billing questions, or for
  non-Copilot model providers.
---

# Model Intel

Generate a comprehensive intelligence report on every AI model available in the
user's current Copilot environment. This is not a static list; it's a living
research document that pulls real benchmark data, architectural details, and
generates actionable guidance on when to use each model.

## What this skill produces

A single, richly formatted report (Markdown with embedded text charts) covering:

1. **Model Census**: Every model the user has access to, grouped by provider
   (Anthropic, OpenAI, Google, Microsoft) with version, context tier, effort
   levels, and release date.

2. **Architecture Cards**: For each model family, a summary of the underlying
   architecture (MoE vs dense, training approach, RLHF/RLAIF, distillation
   lineage).

3. **Benchmark Dashboard**: Performance on key benchmarks (SWE-bench, HumanEval,
   MBPP, MATH, MMLU, ARC, HellaSwag, BigBenchHard, Aider polyglot, LiveCodeBench)
   presented as comparison tables with visual bar indicators.

4. **Capability Radar**: Text-based radar/spider charts comparing models across
   dimensions: Code Generation, Code Review, Reasoning, Context Length,
   Instruction Following, Speed, Cost Efficiency, Multi-file Understanding,
   Creative Writing, Tool Use.

5. **Strengths and Weaknesses Matrix**: Per-model bullet lists of where each
   model excels and where it falls short, sourced from benchmarks and community
   consensus.

6. **Decision Tree**: A flowchart-style guide: "What are you doing?" leading to
   the optimal model pick. Covers: quick edits, complex refactors, debugging,
   architecture review, code review, documentation, test generation, security
   audit, creative tasks, multi-file changes, long-context analysis.

7. **Head-to-Head Comparisons**: Pairwise matchups for commonly confused model
   pairs (e.g., Sonnet 4.6 vs Sonnet 5, GPT-5.5 vs Opus 4.6, Gemini 3.5 Flash
   vs Haiku 4.5).

8. **Cost/Performance Frontier**: Which models give the best results per
   "premium request" unit, plotted as a text scatter chart.

9. **Context Window Guide**: Practical guidance on effective context utilization
   per model (advertised vs. effective, degradation curves, needle-in-haystack
   performance).

10. **Release Timeline**: A text timeline showing model release dates and the
    evolution of each family.

11. **Model Pairing Strategies**: Recommended combinations for multi-model
    workflows (e.g., fast model for exploration + strong model for final review).

12. **Emerging Patterns**: What's new, what's trending, which models are
    improving fastest based on recent changelog/release data.

## How it works

### Phase 1: Discovery

Detect available models from the runtime environment. The skill uses:

1. The model registry exposed in the agent's system prompt (the `model`
   parameter documentation listing available models).
2. `copilot model list` or equivalent introspection if available.
3. Fallback: a curated registry of known Copilot models updated with each skill
   release.

For each discovered model, extract: model ID, display name, provider, context
tier support, effort levels, and any known constraints.

### Phase 2: Research

For each model family, conduct web research to gather:

- Official benchmark scores (provider publications, papers, blog posts)
- Independent benchmark results (SWE-bench verified, LiveCodeBench, Aider
  leaderboard, LMSYS Chatbot Arena ELO)
- Architecture summaries (parameter count if public, MoE/dense, context length)
- Known limitations and failure modes
- Community sentiment and practical usage reports
- Pricing tier classification (standard vs premium request in Copilot)
- Release dates and version lineage

Use `web_search` for each provider/model family. Cache results in the report
so subsequent runs can skip research for unchanged models.

### Phase 3: Analysis

Synthesize research into:

- Normalized scoring (0-100) across capability dimensions
- Relative rankings within the available model set
- Task-to-model mapping (which tasks benefit most from which model)
- Cost-efficiency calculations (quality per premium-request unit)
- Pairing recommendations for multi-model workflows

### Phase 4: Report Generation

Produce the report as a Markdown file with:

- Unicode box-drawing charts and tables
- ASCII bar charts for benchmark comparisons
- Text-based radar chart approximations (or reference to mermaid if supported)
- Decision tree using indented bullet structure
- Color-coding via emoji indicators (green/yellow/red circles)

Output location: `./model-intel-report.md` in the current working directory
(or user-specified path).

## Invocation

The user triggers this skill by asking about available models, model comparison,
or which model to use. Examples:

- "What models do I have?"
- "Compare my available models"
- "Which model should I use for code review?"
- "Generate a model intel report"
- "model intel"
- "mi"

## Report freshness

The report includes a generation timestamp. Models and benchmarks evolve; the
skill always re-researches when invoked (no stale cache by default). The user
can request `--quick` to skip web research and use the built-in registry only.

## Output format

Default: Markdown file written to disk + summary printed to terminal.

The terminal summary includes:
- Model count by provider
- Top recommendation for the user's likely use case (inferred from repo context)
- Link to the full report file

## Constraints

- Research is best-effort; benchmark data may lag model releases by days/weeks.
- Scores are normalized for relative comparison, not absolute truth.
- The skill does not change the user's active model; it only recommends.
- Pricing/tier info reflects GitHub Copilot's model at time of generation.
