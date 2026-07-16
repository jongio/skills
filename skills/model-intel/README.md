# model-intel

Discover every AI model available in your Copilot environment, research their
capabilities, and generate a comprehensive intelligence report with benchmarks,
comparison charts, decision guidance, and model pairing strategies.

## Quickstart

**1. Install the skill** (global, for GitHub Copilot):

```sh
npx skills add jongio/skills --skill model-intel -g --agent github-copilot
```

**2. Reload skills** and ask:

```
model intel
```

or

```
Which model should I use for code review?
```

## What you get

A rich Markdown report covering:

- **Model Census**: Every model you have access to, grouped by provider
- **Architecture Cards**: What's under the hood of each model family
- **Benchmark Dashboard**: Bar charts comparing key metrics
- **Capability Radar**: Multi-dimensional profiles per model
- **Strengths/Weaknesses**: Where each model excels and falls short
- **Decision Tree**: "What are you doing?" leading to the right model
- **Head-to-Head**: Pairwise comparisons for common "which one?" questions
- **Cost/Performance Frontier**: Best quality per premium request
- **Context Window Guide**: Practical advice on effective context use
- **Release Timeline**: When each model shipped
- **Pairing Strategies**: Multi-model workflow recommendations
- **Emerging Patterns**: What's new and what's coming next

## Use without the agent

Generate the report directly:

```sh
# Full report to stdout
node scripts/generate-report.mjs

# Write to file
node scripts/generate-report.mjs --output ./my-report.md

# Quick mode (skip web research, registry only)
node scripts/generate-report.mjs --quick
```

## Run the tests

```sh
npm test
# node test/registry.test.mjs && node test/charts.test.mjs
```

No dependencies. Tests run on bare Node.js 18+.

## Layout

```
SKILL.md                     The skill definition (agent contract)
scripts/
  registry.mjs              Model registry with metadata and scoring
  charts.mjs                Text-based chart generators (bar, radar, scatter, etc.)
  generate-report.mjs       Main report generator
test/
  registry.test.mjs         Registry module tests
  charts.test.mjs           Chart generator tests
```

## How scores work

Each model is scored 0-100 across 10 dimensions:

| Dimension | What it measures |
|-----------|-----------------|
| Code Generation | Raw code quality (SWE-bench, HumanEval proxy) |
| Code Review | Finding bugs, suggesting improvements |
| Reasoning | Complex logic, math, multi-step deduction |
| Context Length | Effective use of large context windows |
| Instruction Following | Adherence to complex prompts and constraints |
| Speed | Tokens per second / response latency |
| Cost Efficiency | Quality relative to premium request cost |
| Multi-file | Understanding relationships across files |
| Creative Writing | Prose quality, naming, documentation |
| Tool Use | Agentic performance, function calling |

Scores are composites from official benchmarks, independent evaluations (Aider,
LMSYS Arena, LiveCodeBench), and practical Copilot usage observations.

## License

MIT
