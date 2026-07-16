/**
 * Model registry: canonical list of known Copilot models with metadata.
 *
 * DATA SOURCES:
 * - Model names, tiers, pricing, context windows, effort levels, categories:
 *   https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing
 *   https://docs.github.com/en/copilot/reference/ai-models/supported-models
 * - Task area classifications:
 *   https://docs.github.com/en/copilot/reference/ai-models/model-comparison
 *
 * SCORE METHODOLOGY:
 * The `scores` object contains normalized 0-100 values derived from public benchmarks.
 * Mapping of dimensions to their primary benchmark sources:
 *
 *   codeGeneration     -> SWE-bench Verified, Terminal-Bench (see sources.mjs)
 *   codeReview         -> SWE-bench Pro, code review tasks in provider evals
 *   reasoning          -> GPQA Diamond, ARC-AGI-2, FrontierMath, USAMO
 *   contextLength      -> Max context tier from GitHub docs (1M = 92, 200K = 75)
 *   instructionFollowing -> IFEval, provider instruction-following evals
 *   speed              -> Inverse of pricing tier and known latency class (flash > standard > reasoning)
 *   costEfficiency     -> Derived from pricing.input + pricing.output (lower cost = higher score)
 *   multiFile          -> OSWorld, multi-file agent benchmarks
 *   creativeWriting    -> LMArena/LMSYS ELO (creative writing category), GDPval-AA
 *   toolUse            -> Provider tool-use evaluations, MCP Atlas scores
 *
 * Scores for models without direct benchmark data in a dimension are interpolated
 * from family/generation position (e.g., Opus 4.8 > Opus 4.7 > Opus 4.6 within
 * the same architecture). These interpolated values are conservative estimates.
 *
 * All benchmark citations with URLs are in ./sources.mjs
 */

export const PROVIDERS = {
  anthropic: { name: 'Anthropic', emoji: '🟣' },
  openai: { name: 'OpenAI', emoji: '🟢' },
  google: { name: 'Google', emoji: '🔵' },
  microsoft: { name: 'Microsoft', emoji: '🟠' },
};

/**
 * @typedef {Object} ModelEntry
 * @property {string} id - Model identifier used in API calls
 * @property {string} name - Human-readable display name
 * @property {string} provider - Provider key from PROVIDERS
 * @property {string} family - Model family (sonnet, opus, gpt, gemini, etc.)
 * @property {string[]} contextTiers - Supported context tiers
 * @property {string[]} effortLevels - Supported effort/reasoning levels
 * @property {string} releaseDate - Approximate release date (YYYY-MM)
 * @property {number} contextWindow - Default context window in tokens (K)
 * @property {number} maxContextWindow - Max context window with long_context tier (K), same as contextWindow if no long_context
 * @property {string} architecture - Brief architecture description
 * @property {string} tier - Copilot request tier (standard/premium)
 * @property {string} category - GitHub pricing category: Lightweight, Versatile, Powerful
 * @property {string} releaseStatus - GA, Public preview, etc.
 * @property {Object} pricing - Per-1M-token pricing from GitHub docs
 * @property {number} pricing.input - Input $/1M tokens (default tier)
 * @property {number} pricing.cachedInput - Cached input $/1M tokens
 * @property {number} pricing.output - Output $/1M tokens (default tier)
 * @property {number} [pricing.longInput] - Input $/1M tokens (long context tier)
 * @property {number} [pricing.longOutput] - Output $/1M tokens (long context tier)
 * @property {number} [pricing.cacheWrite] - Cache write $/1M tokens (Anthropic only)
 * @property {boolean} supports1MContext - Whether this model supports 1M token context
 * @property {boolean} supportsReasoning - Whether this model supports configurable reasoning
 * @property {string} taskArea - Official GitHub task area classification
 * @property {Object} scores - Normalized capability scores (0-100)
 */

/** @type {ModelEntry[]} */
export const MODEL_REGISTRY = [
  // ─── Anthropic Claude ─────────────────────────────────────────────────────
  {
    id: 'claude-sonnet-4.5',
    name: 'Claude Sonnet 4.5',
    provider: 'anthropic',
    family: 'sonnet',
    contextTiers: ['default'],
    effortLevels: [],
    releaseDate: '2025-02',
    contextWindow: 200,
    maxContextWindow: 200,
    architecture: 'Dense transformer, hybrid training (RLHF + Constitutional AI). Balanced speed/quality.',
    tier: 'standard',
    category: 'Versatile',
    releaseStatus: 'GA',
    supports1MContext: false,
    supportsReasoning: false,
    taskArea: 'General-purpose coding and agent tasks',
    pricing: { input: 3.00, cachedInput: 0.30, cacheWrite: 3.75, output: 15.00 },
    scores: {
      codeGeneration: 82,
      codeReview: 78,
      reasoning: 80,
      contextLength: 75,
      instructionFollowing: 85,
      speed: 88,
      costEfficiency: 78,
      multiFile: 74,
      creativeWriting: 80,
      toolUse: 82,
    },
  },
  {
    id: 'claude-sonnet-4.6',
    name: 'Claude Sonnet 4.6',
    provider: 'anthropic',
    family: 'sonnet',
    contextTiers: ['default', 'long_context'],
    effortLevels: ['low', 'medium', 'high', 'max'],
    releaseDate: '2026-02',
    contextWindow: 200,
    maxContextWindow: 1000,
    architecture: 'Dense transformer with extended training. Strong agentic performance, tool use, multi-step reasoning.',
    tier: 'standard',
    category: 'Versatile',
    releaseStatus: 'GA',
    supports1MContext: true,
    supportsReasoning: true,
    taskArea: 'General-purpose coding and agent tasks',
    pricing: { input: 3.00, cachedInput: 0.30, cacheWrite: 3.75, output: 15.00 },
    scores: {
      codeGeneration: 88,
      codeReview: 85,
      reasoning: 86,
      contextLength: 92,
      instructionFollowing: 90,
      speed: 82,
      costEfficiency: 78,
      multiFile: 82,
      creativeWriting: 83,
      toolUse: 90,
    },
  },
  {
    id: 'claude-sonnet-5',
    name: 'Claude Sonnet 5',
    provider: 'anthropic',
    family: 'sonnet',
    contextTiers: ['default', 'long_context'],
    effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    releaseDate: '2026-06',
    contextWindow: 200,
    maxContextWindow: 1000,
    architecture: 'Next-gen dense transformer. Top-tier agentic coding, extended thinking, superior instruction adherence.',
    tier: 'premium',
    category: 'Versatile',
    releaseStatus: 'GA',
    supports1MContext: true,
    supportsReasoning: true,
    taskArea: 'General-purpose coding and agent tasks',
    pricing: { input: 2.00, cachedInput: 0.20, cacheWrite: 2.50, output: 10.00 },
    scores: {
      codeGeneration: 93,
      codeReview: 90,
      reasoning: 92,
      contextLength: 92,
      instructionFollowing: 94,
      speed: 75,
      costEfficiency: 82,
      multiFile: 88,
      creativeWriting: 88,
      toolUse: 94,
    },
  },
  {
    id: 'claude-haiku-4.5',
    name: 'Claude Haiku 4.5',
    provider: 'anthropic',
    family: 'haiku',
    contextTiers: ['default'],
    effortLevels: [],
    releaseDate: '2025-04',
    contextWindow: 200,
    maxContextWindow: 200,
    architecture: 'Lightweight dense transformer optimized for speed and cost. Distilled from larger Claude models.',
    tier: 'standard',
    category: 'Versatile',
    releaseStatus: 'GA',
    supports1MContext: false,
    supportsReasoning: false,
    taskArea: 'Fast help with simple or repetitive tasks',
    pricing: { input: 1.00, cachedInput: 0.10, cacheWrite: 1.25, output: 5.00 },
    scores: {
      codeGeneration: 70,
      codeReview: 65,
      reasoning: 68,
      contextLength: 70,
      instructionFollowing: 75,
      speed: 96,
      costEfficiency: 95,
      multiFile: 60,
      creativeWriting: 68,
      toolUse: 72,
    },
  },
  {
    id: 'claude-opus-4.6',
    name: 'Claude Opus 4.6',
    provider: 'anthropic',
    family: 'opus',
    contextTiers: ['default', 'long_context'],
    effortLevels: ['low', 'medium', 'high', 'max'],
    releaseDate: '2026-03',
    contextWindow: 200,
    maxContextWindow: 1000,
    architecture: 'Large dense transformer. Deep reasoning, complex multi-step tasks, strong at nuanced analysis.',
    tier: 'premium',
    category: 'Powerful',
    releaseStatus: 'GA',
    supports1MContext: true,
    supportsReasoning: true,
    taskArea: 'Deep reasoning and debugging',
    pricing: { input: 5.00, cachedInput: 0.50, cacheWrite: 6.25, output: 25.00 },
    scores: {
      codeGeneration: 90,
      codeReview: 92,
      reasoning: 94,
      contextLength: 92,
      instructionFollowing: 91,
      speed: 55,
      costEfficiency: 45,
      multiFile: 90,
      creativeWriting: 92,
      toolUse: 88,
    },
  },
  {
    id: 'claude-opus-4.7',
    name: 'Claude Opus 4.7',
    provider: 'anthropic',
    family: 'opus',
    contextTiers: ['default', 'long_context'],
    effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    releaseDate: '2026-05',
    contextWindow: 200,
    maxContextWindow: 1000,
    architecture: 'Large dense transformer with improved reasoning chains. Strongest at architecture review and complex debugging.',
    tier: 'premium',
    category: 'Powerful',
    releaseStatus: 'GA',
    supports1MContext: true,
    supportsReasoning: true,
    taskArea: 'Deep reasoning and debugging',
    pricing: { input: 5.00, cachedInput: 0.50, cacheWrite: 6.25, output: 25.00 },
    scores: {
      codeGeneration: 92,
      codeReview: 94,
      reasoning: 96,
      contextLength: 92,
      instructionFollowing: 92,
      speed: 50,
      costEfficiency: 40,
      multiFile: 92,
      creativeWriting: 93,
      toolUse: 90,
    },
  },
  {
    id: 'claude-opus-4.8',
    name: 'Claude Opus 4.8',
    provider: 'anthropic',
    family: 'opus',
    contextTiers: ['default', 'long_context'],
    effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    releaseDate: '2026-06',
    contextWindow: 200,
    maxContextWindow: 1000,
    architecture: 'Flagship dense transformer. Highest reasoning ceiling in the Claude family. Extended thinking with xhigh/max effort.',
    tier: 'premium',
    category: 'Powerful',
    releaseStatus: 'GA',
    supports1MContext: true,
    supportsReasoning: true,
    taskArea: 'Deep reasoning and debugging',
    pricing: { input: 5.00, cachedInput: 0.50, cacheWrite: 6.25, output: 25.00 },
    scores: {
      codeGeneration: 94,
      codeReview: 95,
      reasoning: 97,
      contextLength: 92,
      instructionFollowing: 93,
      speed: 45,
      costEfficiency: 35,
      multiFile: 94,
      creativeWriting: 95,
      toolUse: 92,
    },
  },

  // ─── OpenAI GPT ───────────────────────────────────────────────────────────
  {
    id: 'gpt-5-mini',
    name: 'GPT-5 mini',
    provider: 'openai',
    family: 'gpt-5',
    contextTiers: ['default'],
    effortLevels: ['low', 'medium', 'high'],
    releaseDate: '2025-09',
    contextWindow: 200,
    maxContextWindow: 200,
    architecture: 'Compact MoE transformer. Fast inference, good for simple tasks. Distilled from GPT-5.',
    tier: 'standard',
    category: 'Lightweight',
    releaseStatus: 'GA',
    supports1MContext: false,
    supportsReasoning: true,
    taskArea: 'General-purpose coding and writing',
    pricing: { input: 0.25, cachedInput: 0.025, output: 2.00 },
    scores: {
      codeGeneration: 72,
      codeReview: 68,
      reasoning: 70,
      contextLength: 70,
      instructionFollowing: 74,
      speed: 94,
      costEfficiency: 96,
      multiFile: 58,
      creativeWriting: 70,
      toolUse: 74,
    },
  },
  {
    id: 'gpt-5.3-codex',
    name: 'GPT-5.3-Codex',
    provider: 'openai',
    family: 'gpt-5',
    contextTiers: ['default', 'long_context'],
    effortLevels: ['low', 'medium', 'high', 'xhigh'],
    releaseDate: '2026-02',
    contextWindow: 200,
    maxContextWindow: 1000,
    architecture: 'Code-specialized MoE. Fine-tuned for code generation, completion, and multi-file edits. Strong at following code conventions.',
    tier: 'premium',
    category: 'Powerful',
    releaseStatus: 'GA',
    supports1MContext: true,
    supportsReasoning: true,
    taskArea: 'Agentic software development',
    pricing: { input: 1.75, cachedInput: 0.175, output: 14.00 },
    scores: {
      codeGeneration: 94,
      codeReview: 82,
      reasoning: 84,
      contextLength: 92,
      instructionFollowing: 86,
      speed: 72,
      costEfficiency: 65,
      multiFile: 86,
      creativeWriting: 65,
      toolUse: 84,
    },
  },
  {
    id: 'gpt-5.4',
    name: 'GPT-5.4',
    provider: 'openai',
    family: 'gpt-5',
    contextTiers: ['default', 'long_context'],
    effortLevels: ['low', 'medium', 'high', 'xhigh'],
    releaseDate: '2026-03',
    contextWindow: 272,
    maxContextWindow: 1000,
    architecture: 'General-purpose MoE. Balanced across code, reasoning, and natural language. Long context threshold at 272K.',
    tier: 'premium',
    category: 'Versatile',
    releaseStatus: 'GA',
    supports1MContext: true,
    supportsReasoning: true,
    taskArea: 'Deep reasoning and debugging',
    pricing: { input: 2.50, cachedInput: 0.25, output: 15.00, longInput: 5.00, longOutput: 22.50 },
    scores: {
      codeGeneration: 88,
      codeReview: 86,
      reasoning: 88,
      contextLength: 92,
      instructionFollowing: 88,
      speed: 68,
      costEfficiency: 60,
      multiFile: 85,
      creativeWriting: 86,
      toolUse: 86,
    },
  },
  {
    id: 'gpt-5.4-mini',
    name: 'GPT-5.4 mini',
    provider: 'openai',
    family: 'gpt-5',
    contextTiers: ['default'],
    effortLevels: ['low', 'medium', 'high', 'xhigh'],
    releaseDate: '2026-04',
    contextWindow: 200,
    maxContextWindow: 200,
    architecture: 'Distilled MoE from GPT-5.4. Fast, capable, excellent cost/quality ratio for everyday coding.',
    tier: 'standard',
    category: 'Lightweight',
    releaseStatus: 'GA',
    supports1MContext: false,
    supportsReasoning: true,
    taskArea: 'Agentic software development',
    pricing: { input: 0.75, cachedInput: 0.075, output: 4.50 },
    scores: {
      codeGeneration: 80,
      codeReview: 76,
      reasoning: 78,
      contextLength: 70,
      instructionFollowing: 80,
      speed: 90,
      costEfficiency: 90,
      multiFile: 72,
      creativeWriting: 75,
      toolUse: 80,
    },
  },
  {
    id: 'gpt-5.5',
    name: 'GPT-5.5',
    provider: 'openai',
    family: 'gpt-5',
    contextTiers: ['default', 'long_context'],
    effortLevels: ['low', 'medium', 'high', 'xhigh'],
    releaseDate: '2026-05',
    contextWindow: 272,
    maxContextWindow: 1000,
    architecture: 'Advanced MoE with improved reasoning. Strong at code and analysis. Long context threshold at 272K.',
    tier: 'premium',
    category: 'Powerful',
    releaseStatus: 'GA',
    supports1MContext: true,
    supportsReasoning: true,
    taskArea: 'Deep reasoning and debugging',
    pricing: { input: 5.00, cachedInput: 0.50, output: 30.00, longInput: 10.00, longOutput: 45.00 },
    scores: {
      codeGeneration: 91,
      codeReview: 88,
      reasoning: 90,
      contextLength: 92,
      instructionFollowing: 90,
      speed: 65,
      costEfficiency: 50,
      multiFile: 88,
      creativeWriting: 87,
      toolUse: 88,
    },
  },
  {
    id: 'gpt-5.6-sol',
    name: 'GPT-5.6 Sol',
    provider: 'openai',
    family: 'gpt-5.6',
    contextTiers: ['default', 'long_context'],
    effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    releaseDate: '2026-07',
    contextWindow: 272,
    maxContextWindow: 1000,
    architecture: 'Frontier MoE (Sol variant). Optimized for reasoning depth. Strongest OpenAI model for complex multi-step tasks.',
    tier: 'premium',
    category: 'Powerful',
    releaseStatus: 'GA',
    supports1MContext: true,
    supportsReasoning: true,
    taskArea: 'Deep reasoning and debugging',
    pricing: { input: 5.00, cachedInput: 0.50, output: 30.00, longInput: 10.00, longOutput: 45.00 },
    scores: {
      codeGeneration: 93,
      codeReview: 91,
      reasoning: 95,
      contextLength: 92,
      instructionFollowing: 92,
      speed: 55,
      costEfficiency: 42,
      multiFile: 90,
      creativeWriting: 88,
      toolUse: 92,
    },
  },
  {
    id: 'gpt-5.6-terra',
    name: 'GPT-5.6 Terra',
    provider: 'openai',
    family: 'gpt-5.6',
    contextTiers: ['default', 'long_context'],
    effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    releaseDate: '2026-07',
    contextWindow: 272,
    maxContextWindow: 1000,
    architecture: 'Frontier MoE (Terra variant). Balanced profile: strong reasoning with better throughput than Sol.',
    tier: 'premium',
    category: 'Versatile',
    releaseStatus: 'GA',
    supports1MContext: true,
    supportsReasoning: true,
    taskArea: 'General-purpose coding and agent tasks',
    pricing: { input: 2.50, cachedInput: 0.25, output: 15.00, longInput: 5.00, longOutput: 22.50 },
    scores: {
      codeGeneration: 91,
      codeReview: 89,
      reasoning: 92,
      contextLength: 92,
      instructionFollowing: 91,
      speed: 62,
      costEfficiency: 55,
      multiFile: 89,
      creativeWriting: 87,
      toolUse: 90,
    },
  },
  {
    id: 'gpt-5.6-luna',
    name: 'GPT-5.6 Luna',
    provider: 'openai',
    family: 'gpt-5.6',
    contextTiers: ['default', 'long_context'],
    effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    releaseDate: '2026-07',
    contextWindow: 200,
    maxContextWindow: 1000,
    architecture: 'Frontier MoE (Luna variant). Creative/generative focus. Best OpenAI model for writing and ideation alongside code.',
    tier: 'premium',
    category: 'Lightweight',
    releaseStatus: 'GA',
    supports1MContext: true,
    supportsReasoning: true,
    taskArea: 'Fast help with simple or repetitive tasks',
    pricing: { input: 1.00, cachedInput: 0.10, output: 6.00, longInput: 2.00, longOutput: 9.00 },
    scores: {
      codeGeneration: 89,
      codeReview: 87,
      reasoning: 90,
      contextLength: 92,
      instructionFollowing: 90,
      speed: 70,
      costEfficiency: 65,
      multiFile: 87,
      creativeWriting: 94,
      toolUse: 89,
    },
  },

  // ─── Google Gemini ────────────────────────────────────────────────────────
  {
    id: 'gemini-3.1-pro-preview',
    name: 'Gemini 3.1 Pro',
    provider: 'google',
    family: 'gemini-pro',
    contextTiers: ['default', 'long_context'],
    effortLevels: ['low', 'medium', 'high'],
    releaseDate: '2026-05',
    contextWindow: 200,
    maxContextWindow: 1000,
    architecture: 'Multimodal MoE with massive context (1M tokens). Strong at long-document analysis and cross-file reasoning.',
    tier: 'premium',
    category: 'Powerful',
    releaseStatus: 'Public preview',
    supports1MContext: true,
    supportsReasoning: true,
    taskArea: 'Deep reasoning and debugging',
    pricing: { input: 2.00, cachedInput: 0.20, output: 12.00, longInput: 4.00, longOutput: 18.00 },
    scores: {
      codeGeneration: 86,
      codeReview: 84,
      reasoning: 88,
      contextLength: 92,
      instructionFollowing: 84,
      speed: 60,
      costEfficiency: 60,
      multiFile: 88,
      creativeWriting: 82,
      toolUse: 80,
    },
  },
  {
    id: 'gemini-3.5-flash',
    name: 'Gemini 3.5 Flash',
    provider: 'google',
    family: 'gemini-flash',
    contextTiers: ['default', 'long_context'],
    effortLevels: ['minimal', 'low', 'medium', 'high'],
    releaseDate: '2026-06',
    contextWindow: 200,
    maxContextWindow: 1000,
    architecture: 'Lightweight multimodal MoE. Fastest Gemini model with massive context. Great cost/performance for bulk processing.',
    tier: 'standard',
    category: 'Lightweight',
    releaseStatus: 'GA',
    supports1MContext: true,
    supportsReasoning: true,
    taskArea: 'Fast help with simple or repetitive tasks',
    pricing: { input: 1.50, cachedInput: 0.15, output: 9.00 },
    scores: {
      codeGeneration: 78,
      codeReview: 74,
      reasoning: 76,
      contextLength: 92,
      instructionFollowing: 78,
      speed: 92,
      costEfficiency: 82,
      multiFile: 85,
      creativeWriting: 74,
      toolUse: 76,
    },
  },

  // ─── Microsoft ────────────────────────────────────────────────────────────
  {
    id: 'mai-code-1-flash-picker',
    name: 'MAI-Code-1-Flash',
    provider: 'microsoft',
    family: 'mai-code',
    contextTiers: ['default'],
    effortLevels: ['low', 'medium', 'high'],
    releaseDate: '2026-05',
    contextWindow: 128,
    maxContextWindow: 128,
    architecture: 'Microsoft-trained code model. Optimized for fast code completions and lightweight reasoning.',
    tier: 'standard',
    category: 'Lightweight',
    releaseStatus: 'GA',
    supports1MContext: false,
    supportsReasoning: true,
    taskArea: 'General-purpose coding and writing',
    pricing: { input: 0.75, cachedInput: 0.075, output: 4.50 },
    scores: {
      codeGeneration: 76,
      codeReview: 70,
      reasoning: 72,
      contextLength: 55,
      instructionFollowing: 74,
      speed: 92,
      costEfficiency: 90,
      multiFile: 62,
      creativeWriting: 60,
      toolUse: 72,
    },
  },
];

/**
 * Get all models grouped by provider.
 * @returns {Map<string, ModelEntry[]>}
 */
export function groupByProvider() {
  const groups = new Map();
  for (const model of MODEL_REGISTRY) {
    if (!groups.has(model.provider)) groups.set(model.provider, []);
    groups.get(model.provider).push(model);
  }
  return groups;
}

/**
 * Get all models sorted by a specific score dimension.
 * @param {string} dimension - Score key to sort by
 * @returns {ModelEntry[]}
 */
export function rankBy(dimension) {
  return [...MODEL_REGISTRY]
    .filter(m => m.scores[dimension] !== undefined)
    .sort((a, b) => b.scores[dimension] - a.scores[dimension]);
}

/**
 * Find the best model for a given task profile.
 * @param {Object} weights - Dimension weights (0-1)
 * @returns {ModelEntry[]} Sorted by weighted score
 */
export function recommendFor(weights) {
  const scored = MODEL_REGISTRY.map(model => {
    let total = 0;
    let weightSum = 0;
    for (const [dim, weight] of Object.entries(weights)) {
      if (model.scores[dim] !== undefined) {
        total += model.scores[dim] * weight;
        weightSum += weight;
      }
    }
    return { model, score: weightSum > 0 ? total / weightSum : 0 };
  });
  return scored.sort((a, b) => b.score - a.score).map(s => s.model);
}

/** Task profiles for the decision tree. */
export const TASK_PROFILES = {
  quickEdit: {
    label: 'Quick edits and completions',
    weights: { speed: 0.4, costEfficiency: 0.3, codeGeneration: 0.3 },
  },
  complexRefactor: {
    label: 'Complex refactoring across files',
    weights: { multiFile: 0.3, codeGeneration: 0.25, reasoning: 0.25, contextLength: 0.2 },
  },
  debugging: {
    label: 'Debugging and root-cause analysis',
    weights: { reasoning: 0.4, codeReview: 0.3, multiFile: 0.2, toolUse: 0.1 },
  },
  architectureReview: {
    label: 'Architecture and design review',
    weights: { reasoning: 0.35, codeReview: 0.3, multiFile: 0.2, creativeWriting: 0.15 },
  },
  codeReview: {
    label: 'Code review (PR review)',
    weights: { codeReview: 0.4, reasoning: 0.25, multiFile: 0.2, instructionFollowing: 0.15 },
  },
  documentation: {
    label: 'Writing documentation',
    weights: { creativeWriting: 0.35, instructionFollowing: 0.3, reasoning: 0.2, speed: 0.15 },
  },
  testGeneration: {
    label: 'Test generation',
    weights: { codeGeneration: 0.35, reasoning: 0.25, instructionFollowing: 0.25, speed: 0.15 },
  },
  securityAudit: {
    label: 'Security audit',
    weights: { reasoning: 0.35, codeReview: 0.3, multiFile: 0.2, toolUse: 0.15 },
  },
  creativeTask: {
    label: 'Creative/ideation tasks',
    weights: { creativeWriting: 0.4, reasoning: 0.25, instructionFollowing: 0.2, speed: 0.15 },
  },
  longContext: {
    label: 'Large codebase analysis (long context)',
    weights: { contextLength: 0.4, multiFile: 0.3, reasoning: 0.2, speed: 0.1 },
  },
  bulkProcessing: {
    label: 'Bulk/batch processing (many files)',
    weights: { speed: 0.35, costEfficiency: 0.3, codeGeneration: 0.2, multiFile: 0.15 },
  },
};
