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
 * BENCHMARK NOTE:
 * We no longer maintain internal benchmark scores in this registry.
 * Use each model's `llmStatsSlug` field to link to llm-stats.com
 * for public benchmark summaries and external comparisons.
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
 * @property {string} llmStatsSlug - llm-stats.com slug derived from the model name
 */

/** @type {ModelEntry[]} */
export const MODEL_REGISTRY = [
  // ─── Anthropic Claude ─────────────────────────────────────────────────────
  {
    id: 'claude-sonnet-4.5',
    name: 'Claude Sonnet 4.5',
    llmStatsSlug: 'claude-sonnet-4-5',
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
  },
  {
    id: 'claude-sonnet-4.6',
    name: 'Claude Sonnet 4.6',
    llmStatsSlug: 'claude-sonnet-4-6',
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
  },
  {
    id: 'claude-sonnet-5',
    name: 'Claude Sonnet 5',
    llmStatsSlug: 'claude-sonnet-5',
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
  },
  {
    id: 'claude-haiku-4.5',
    name: 'Claude Haiku 4.5',
    llmStatsSlug: 'claude-haiku-4-5',
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
  },
  {
    id: 'claude-opus-4.6',
    name: 'Claude Opus 4.6',
    llmStatsSlug: 'claude-opus-4-6',
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
  },
  {
    id: 'claude-opus-4.7',
    name: 'Claude Opus 4.7',
    llmStatsSlug: 'claude-opus-4-7',
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
  },
  {
    id: 'claude-opus-4.8',
    name: 'Claude Opus 4.8',
    llmStatsSlug: 'claude-opus-4-8',
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
  },

  // ─── OpenAI GPT ───────────────────────────────────────────────────────────
  {
    id: 'gpt-5-mini',
    name: 'GPT-5 mini',
    llmStatsSlug: 'gpt-5-mini',
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
  },
  {
    id: 'gpt-5.3-codex',
    name: 'GPT-5.3-Codex',
    llmStatsSlug: 'gpt-5-3-codex',
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
  },
  {
    id: 'gpt-5.4',
    name: 'GPT-5.4',
    llmStatsSlug: 'gpt-5-4',
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
  },
  {
    id: 'gpt-5.4-mini',
    name: 'GPT-5.4 mini',
    llmStatsSlug: 'gpt-5-4-mini',
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
  },
  {
    id: 'gpt-5.5',
    name: 'GPT-5.5',
    llmStatsSlug: 'gpt-5-5',
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
  },
  {
    id: 'gpt-5.6-sol',
    name: 'GPT-5.6 Sol',
    llmStatsSlug: 'gpt-5-6-sol',
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
  },
  {
    id: 'gpt-5.6-terra',
    name: 'GPT-5.6 Terra',
    llmStatsSlug: 'gpt-5-6-terra',
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
  },
  {
    id: 'gpt-5.6-luna',
    name: 'GPT-5.6 Luna',
    llmStatsSlug: 'gpt-5-6-luna',
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
  },

  // ─── Google Gemini ────────────────────────────────────────────────────────
  {
    id: 'gemini-3.1-pro-preview',
    name: 'Gemini 3.1 Pro',
    llmStatsSlug: 'gemini-3-1-pro',
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
  },
  {
    id: 'gemini-3.5-flash',
    name: 'Gemini 3.5 Flash',
    llmStatsSlug: 'gemini-3-5-flash',
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
  },

  // ─── Microsoft ────────────────────────────────────────────────────────────
  {
    id: 'mai-code-1-flash-picker',
    name: 'MAI-Code-1-Flash',
    llmStatsSlug: 'mai-code-1-flash',
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
 * Get all models sorted by a metadata dimension.
 * @param {'pricing'|'contextWindow'|'category'|'tier'|'release'} dimension
 * @returns {ModelEntry[]}
 */
const CATEGORY_RANK = {
  Powerful: 3,
  Versatile: 2,
  Lightweight: 1,
};

const TIER_RANK = {
  premium: 2,
  standard: 1,
};

function compareDescending(left, right) {
  return right - left;
}

function compareAscending(left, right) {
  return left - right;
}

function comparePreferred(valueA, valueB, preferred) {
  return compareDescending(Number(valueA === preferred), Number(valueB === preferred));
}

function compareListPreference(valueA, valueB, preferredValues) {
  const fallbackIndex = preferredValues.length;
  const indexA = preferredValues.indexOf(valueA);
  const indexB = preferredValues.indexOf(valueB);
  return compareAscending(indexA === -1 ? fallbackIndex : indexA, indexB === -1 ? fallbackIndex : indexB);
}

function compareBoolean(valueA, valueB) {
  return compareDescending(Number(Boolean(valueA)), Number(Boolean(valueB)));
}

function compareReleaseDate(left, right) {
  return right.localeCompare(left);
}

function getPricingValue(model, key = 'input') {
  if (key === 'total') {
    return model.pricing.input + model.pricing.output;
  }
  return model.pricing[key] ?? Number.POSITIVE_INFINITY;
}

function isCodeSpecialized(model) {
  return model.id.includes('codex')
    || model.id.startsWith('mai-code-')
    || /code-specialized|code model|code completions|code generation|multi-file edits/i.test(model.architecture);
}

function compareModels(left, right, comparators) {
  for (const comparator of comparators) {
    const result = comparator(left, right);
    if (result !== 0) {
      return result;
    }
  }
  return left.name.localeCompare(right.name);
}

export function rankBy(dimension) {
  const comparatorsByDimension = {
    pricing: [
      (left, right) => compareAscending(getPricingValue(left, 'total'), getPricingValue(right, 'total')),
      (left, right) => compareAscending(getPricingValue(left, 'input'), getPricingValue(right, 'input')),
      (left, right) => compareAscending(getPricingValue(left, 'output'), getPricingValue(right, 'output')),
      (left, right) => compareReleaseDate(left.releaseDate, right.releaseDate),
    ],
    contextWindow: [
      (left, right) => compareDescending(left.maxContextWindow, right.maxContextWindow),
      (left, right) => compareDescending(left.contextWindow, right.contextWindow),
      (left, right) => compareDescending(CATEGORY_RANK[left.category] ?? 0, CATEGORY_RANK[right.category] ?? 0),
      (left, right) => compareReleaseDate(left.releaseDate, right.releaseDate),
    ],
    category: [
      (left, right) => compareDescending(CATEGORY_RANK[left.category] ?? 0, CATEGORY_RANK[right.category] ?? 0),
      (left, right) => compareDescending(left.maxContextWindow, right.maxContextWindow),
      (left, right) => compareAscending(getPricingValue(left, 'input'), getPricingValue(right, 'input')),
      (left, right) => compareReleaseDate(left.releaseDate, right.releaseDate),
    ],
    tier: [
      (left, right) => compareDescending(TIER_RANK[left.tier] ?? 0, TIER_RANK[right.tier] ?? 0),
      (left, right) => compareDescending(CATEGORY_RANK[left.category] ?? 0, CATEGORY_RANK[right.category] ?? 0),
      (left, right) => compareReleaseDate(left.releaseDate, right.releaseDate),
    ],
    release: [
      (left, right) => compareReleaseDate(left.releaseDate, right.releaseDate),
      (left, right) => compareDescending(CATEGORY_RANK[left.category] ?? 0, CATEGORY_RANK[right.category] ?? 0),
      (left, right) => compareAscending(getPricingValue(left, 'input'), getPricingValue(right, 'input')),
    ],
  };

  const comparators = comparatorsByDimension[dimension];
  if (!comparators) {
    throw new Error(`Unsupported rank dimension: ${dimension}`);
  }

  return [...MODEL_REGISTRY].sort((left, right) => compareModels(left, right, comparators));
}

function resolveTaskProfile(input) {
  if (typeof input === 'string') {
    return TASK_PROFILES[input]?.weights ?? null;
  }
  if (input && typeof input === 'object' && 'weights' in input) {
    return input.weights;
  }
  return input ?? null;
}

function getProfileComparators(profile) {
  const comparators = [];

  if (profile?.preferStandardTier) {
    comparators.push((left, right) => comparePreferred(left.tier, right.tier, 'standard'));
  }

  if (profile?.preferPremiumTier) {
    comparators.push((left, right) => comparePreferred(left.tier, right.tier, 'premium'));
  }

  if (profile?.preferReasoning) {
    comparators.push((left, right) => compareBoolean(left.supportsReasoning, right.supportsReasoning));
  }

  if (profile?.prefer1MContext) {
    comparators.push((left, right) => compareBoolean(left.supports1MContext, right.supports1MContext));
  }

  if (profile?.preferCodeSpecialized) {
    comparators.push((left, right) => compareBoolean(isCodeSpecialized(left), isCodeSpecialized(right)));
  }

  if (profile?.categoryPreference?.length) {
    comparators.push((left, right) => compareListPreference(left.category, right.category, profile.categoryPreference));
  }

  if (profile?.sortByContextWindow) {
    comparators.push((left, right) => compareDescending(left.maxContextWindow, right.maxContextWindow));
    comparators.push((left, right) => compareDescending(left.contextWindow, right.contextWindow));
  }

  if (profile?.sortByPricing) {
    comparators.push((left, right) => compareAscending(getPricingValue(left, profile.sortByPricing), getPricingValue(right, profile.sortByPricing)));
  }

  if (profile?.sortByRelease !== false) {
    comparators.push((left, right) => compareReleaseDate(left.releaseDate, right.releaseDate));
  }

  comparators.push((left, right) => compareDescending(CATEGORY_RANK[left.category] ?? 0, CATEGORY_RANK[right.category] ?? 0));
  comparators.push((left, right) => compareAscending(getPricingValue(left, 'input'), getPricingValue(right, 'input')));

  return comparators;
}

/**
 * Find the best models for a given task profile.
 * @param {string|Object} profileInput
 * @returns {ModelEntry[]}
 */
export function recommendFor(profileInput) {
  const profile = resolveTaskProfile(profileInput);
  if (!profile) {
    throw new Error('Unknown task profile');
  }

  const comparators = getProfileComparators(profile);
  return [...MODEL_REGISTRY].sort((left, right) => compareModels(left, right, comparators));
}

/** Task profiles for metadata-based recommendations. */
export const TASK_PROFILES = {
  quickEdit: {
    label: 'Quick edits and completions',
    weights: {
      preferStandardTier: true,
      categoryPreference: ['Lightweight', 'Versatile', 'Powerful'],
      sortByPricing: 'input',
    },
  },
  complexRefactor: {
    label: 'Complex refactoring across files',
    weights: {
      prefer1MContext: true,
      categoryPreference: ['Powerful', 'Versatile', 'Lightweight'],
      preferReasoning: true,
      sortByContextWindow: true,
    },
  },
  debugging: {
    label: 'Debugging and root-cause analysis',
    weights: {
      preferReasoning: true,
      categoryPreference: ['Powerful', 'Versatile', 'Lightweight'],
      prefer1MContext: true,
      sortByContextWindow: true,
    },
  },
  architectureReview: {
    label: 'Architecture and design review',
    weights: {
      preferReasoning: true,
      categoryPreference: ['Powerful', 'Versatile', 'Lightweight'],
      prefer1MContext: true,
      sortByContextWindow: true,
    },
  },
  codeReview: {
    label: 'Code review (PR review)',
    weights: {
      preferReasoning: true,
      categoryPreference: ['Powerful', 'Versatile', 'Lightweight'],
      prefer1MContext: true,
      sortByContextWindow: true,
    },
  },
  documentation: {
    label: 'Writing documentation',
    weights: {
      categoryPreference: ['Versatile', 'Lightweight', 'Powerful'],
      preferStandardTier: true,
      sortByPricing: 'input',
    },
  },
  testGeneration: {
    label: 'Test generation',
    weights: {
      preferCodeSpecialized: true,
      preferStandardTier: true,
      preferReasoning: true,
      sortByPricing: 'input',
    },
  },
  securityAudit: {
    label: 'Security audit',
    weights: {
      preferReasoning: true,
      categoryPreference: ['Powerful', 'Versatile', 'Lightweight'],
      prefer1MContext: true,
      sortByContextWindow: true,
    },
  },
  creativeTask: {
    label: 'Creative/ideation tasks',
    weights: {
      categoryPreference: ['Versatile', 'Lightweight', 'Powerful'],
      preferReasoning: true,
      sortByPricing: 'input',
    },
  },
  longContext: {
    label: 'Large codebase analysis (long context)',
    weights: {
      prefer1MContext: true,
      sortByContextWindow: true,
      categoryPreference: ['Powerful', 'Versatile', 'Lightweight'],
      sortByPricing: 'input',
    },
  },
  bulkProcessing: {
    label: 'Bulk/batch processing (many files)',
    weights: {
      preferStandardTier: true,
      sortByPricing: 'input',
      categoryPreference: ['Lightweight', 'Versatile', 'Powerful'],
      prefer1MContext: true,
    },
  },
};
