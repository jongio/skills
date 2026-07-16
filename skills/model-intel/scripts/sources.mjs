/**
 * Verified benchmark data and source citations for the model registry.
 *
 * Every number in this file has a source URL. The report links to these
 * so users can verify claims independently.
 *
 * Last updated: 2026-07-13
 */

/**
 * @typedef {Object} BenchmarkEntry
 * @property {string} benchmark - Benchmark name
 * @property {number|string} score - The score (% or Elo)
 * @property {string} source - Source URL
 * @property {string} sourceLabel - Short citation label
 * @property {string} [date] - Date of measurement
 */

/**
 * @typedef {Object} ModelBenchmarks
 * @property {string} modelId - Model identifier
 * @property {BenchmarkEntry[]} benchmarks - Verified benchmark results
 * @property {string[]} architectureSources - URLs for architecture claims
 * @property {string} announcementUrl - Official announcement URL
 */

/** @type {ModelBenchmarks[]} */
export const VERIFIED_BENCHMARKS = [
  // ─── Claude Sonnet 5 ─────────────────────────────────────────────────────
  {
    modelId: 'claude-sonnet-5',
    announcementUrl: 'https://www.anthropic.com/news/claude-sonnet-5',
    architectureSources: [
      'https://www.anthropic.com/news/claude-sonnet-5',
      'https://www.vellum.ai/blog/claude-sonnet-5-benchmarks-explained',
    ],
    benchmarks: [
      { benchmark: 'SWE-bench Verified', score: 85.2, source: 'https://www.vellum.ai/blog/claude-sonnet-5-benchmarks-explained', sourceLabel: 'Vellum (Anthropic system card)' },
      { benchmark: 'SWE-bench Pro', score: 63.2, source: 'https://www.morphllm.com/claude-benchmarks', sourceLabel: 'MorphLLM (Anthropic data)' },
      { benchmark: 'SWE-bench Multilingual', score: 78.3, source: 'https://www.vellum.ai/blog/claude-sonnet-5-benchmarks-explained', sourceLabel: 'Vellum' },
      { benchmark: 'Terminal-Bench 2.1', score: 80.4, source: 'https://www.vellum.ai/blog/claude-sonnet-5-benchmarks-explained', sourceLabel: 'Vellum' },
      { benchmark: 'OSWorld-Verified', score: 81.2, source: 'https://www.cosmicjs.com/blog/claude-sonnet-5-benchmarks-pricing-developers', sourceLabel: 'Cosmic JS' },
      { benchmark: 'BrowseComp', score: 84.7, source: 'https://www.vellum.ai/blog/claude-sonnet-5-benchmarks-explained', sourceLabel: 'Vellum' },
      { benchmark: "Humanity's Last Exam (tools)", score: 57.4, source: 'https://www.vellum.ai/blog/claude-sonnet-5-benchmarks-explained', sourceLabel: 'Vellum' },
      { benchmark: 'USAMO 2026', score: 79.5, source: 'https://www.morphllm.com/claude-benchmarks', sourceLabel: 'MorphLLM' },
    ],
  },

  // ─── Claude Sonnet 4.6 ───────────────────────────────────────────────────
  {
    modelId: 'claude-sonnet-4.6',
    announcementUrl: 'https://www.anthropic.com/news/claude-sonnet-4-6',
    architectureSources: [
      'https://www.anthropic.com/news/claude-sonnet-4-6',
      'https://www.nxcode.io/resources/news/claude-sonnet-4-6-complete-guide-benchmarks-pricing-2026',
    ],
    benchmarks: [
      { benchmark: 'SWE-bench Verified', score: 79.6, source: 'https://www.nxcode.io/resources/news/claude-sonnet-4-6-complete-guide-benchmarks-pricing-2026', sourceLabel: 'NxCode (Anthropic data)' },
      { benchmark: 'OSWorld', score: 72.5, source: 'https://www.digitalapplied.com/blog/claude-sonnet-4-6-benchmarks-pricing-guide', sourceLabel: 'Digital Applied' },
      { benchmark: 'ARC-AGI-2', score: 58.3, source: 'https://www.zbuild.io/resources/news/claude-sonnet-4-6-complete-guide-benchmarks-pricing-2026', sourceLabel: 'ZBuild' },
      { benchmark: 'GDPval-AA (Elo)', score: 1633, source: 'https://www.nxcode.io/resources/news/claude-sonnet-4-6-complete-guide-benchmarks-pricing-2026', sourceLabel: 'NxCode' },
      { benchmark: 'Finance Agent', score: 63.3, source: 'https://www.nxcode.io/resources/news/claude-sonnet-4-6-complete-guide-benchmarks-pricing-2026', sourceLabel: 'NxCode' },
    ],
  },

  // ─── Claude Opus 4.8 ─────────────────────────────────────────────────────
  {
    modelId: 'claude-opus-4.8',
    announcementUrl: 'https://www.anthropic.com/news/claude-opus-4-8',
    architectureSources: ['https://www.morphllm.com/claude-benchmarks'],
    benchmarks: [
      { benchmark: 'SWE-bench Verified', score: 88.6, source: 'https://www.morphllm.com/claude-benchmarks', sourceLabel: 'MorphLLM (Anthropic data)' },
      { benchmark: 'SWE-bench Pro', score: 69.2, source: 'https://www.morphllm.com/claude-benchmarks', sourceLabel: 'MorphLLM' },
      { benchmark: 'LMArena Elo', score: '~1520', source: 'https://www.swfte.com/ai/lm/leaderboard', sourceLabel: 'LMSYS/LMArena July 2026' },
    ],
  },

  // ─── GPT-5.5 ─────────────────────────────────────────────────────────────
  {
    modelId: 'gpt-5.5',
    announcementUrl: 'https://openai.com/index/introducing-gpt-5-5/',
    architectureSources: [
      'https://openai.com/index/introducing-gpt-5-5/',
      'https://felloai.com/openai-gpt-5-5/',
    ],
    benchmarks: [
      { benchmark: 'Terminal-Bench 2.0', score: 82.7, source: 'https://openai.com/index/introducing-gpt-5-5/', sourceLabel: 'OpenAI (official)' },
      { benchmark: 'OSWorld-Verified', score: 78.7, source: 'https://openai.com/index/introducing-gpt-5-5/', sourceLabel: 'OpenAI (official)' },
      { benchmark: 'BrowseComp', score: 84.4, source: 'https://openai.com/index/introducing-gpt-5-5/', sourceLabel: 'OpenAI (official)' },
      { benchmark: 'FrontierMath (T1-3)', score: 51.7, source: 'https://felloai.com/openai-gpt-5-5/', sourceLabel: 'FelloAI (OpenAI data)' },
      { benchmark: 'CyberGym', score: 81.8, source: 'https://felloai.com/openai-gpt-5-5/', sourceLabel: 'FelloAI' },
    ],
  },

  // ─── GPT-5.6 Sol ─────────────────────────────────────────────────────────
  {
    modelId: 'gpt-5.6-sol',
    announcementUrl: 'https://openai.com/index/gpt-5-6/',
    architectureSources: [
      'https://openai.com/index/gpt-5-6/',
      'https://techcrunch.com/2026/07/09/openai-launches-its-new-family-of-models-with-gpt-5-6/',
    ],
    benchmarks: [
      { benchmark: 'Terminal-Bench 2.1', score: 91.9, source: 'https://openai.com/index/gpt-5-6/', sourceLabel: 'OpenAI (official)' },
      { benchmark: 'CTF Cybersecurity', score: 96.7, source: 'https://openai.com/index/gpt-5-6/', sourceLabel: 'OpenAI (official)' },
      { benchmark: "Agents' Last Exam", score: 53.6, source: 'https://techcrunch.com/2026/07/09/openai-launches-its-new-family-of-models-with-gpt-5-6/', sourceLabel: 'TechCrunch (OpenAI data)' },
      { benchmark: 'Token Efficiency', score: '54% more efficient', source: 'https://www.cnbc.com/2026/07/09/open-ai-sam-altman-chatgpt-5-6-sol.html', sourceLabel: 'CNBC (Altman interview)' },
    ],
  },

  // ─── GPT-5.6 Terra ───────────────────────────────────────────────────────
  {
    modelId: 'gpt-5.6-terra',
    announcementUrl: 'https://openai.com/index/gpt-5-6/',
    architectureSources: ['https://openai.com/index/gpt-5-6/'],
    benchmarks: [
      { benchmark: "Agents' Last Exam", score: '>40.5 (beats Fable 5)', source: 'https://techcrunch.com/2026/07/09/openai-launches-its-new-family-of-models-with-gpt-5-6/', sourceLabel: 'TechCrunch' },
    ],
  },

  // ─── GPT-5.6 Luna ────────────────────────────────────────────────────────
  {
    modelId: 'gpt-5.6-luna',
    announcementUrl: 'https://openai.com/index/gpt-5-6/',
    architectureSources: ['https://openai.com/index/gpt-5-6/'],
    benchmarks: [
      { benchmark: "Agents' Last Exam", score: '>40.5 (beats Fable 5)', source: 'https://techcrunch.com/2026/07/09/openai-launches-its-new-family-of-models-with-gpt-5-6/', sourceLabel: 'TechCrunch' },
    ],
  },

  // ─── Gemini 3.5 Flash ────────────────────────────────────────────────────
  {
    modelId: 'gemini-3.5-flash',
    announcementUrl: 'https://blog.google/technology/google-deepmind/gemini-3-5-flash/',
    architectureSources: [
      'https://codingfleet.com/blog/gemini-3-1-pro-vs-gemini-3-5-flash/',
      'https://officechai.com/ai/gemini-flash-3-5-benchmarks/',
    ],
    benchmarks: [
      { benchmark: 'Terminal-Bench 2.1', score: 76.2, source: 'https://codingfleet.com/blog/gemini-3-1-pro-vs-gemini-3-5-flash/', sourceLabel: 'CodingFleet (Google data)' },
      { benchmark: 'GDPval-AA (Elo)', score: 1656, source: 'https://codingfleet.com/blog/gemini-3-1-pro-vs-gemini-3-5-flash/', sourceLabel: 'CodingFleet' },
      { benchmark: 'MCP Atlas', score: 83.6, source: 'https://codingfleet.com/blog/gemini-3-1-pro-vs-gemini-3-5-flash/', sourceLabel: 'CodingFleet' },
      { benchmark: 'SWE-bench Pro', score: 55.1, source: 'https://codingfleet.com/blog/gemini-3-1-pro-vs-gemini-3-5-flash/', sourceLabel: 'CodingFleet' },
      { benchmark: 'OSWorld-Verified', score: 78.4, source: 'https://officechai.com/ai/gemini-flash-3-5-benchmarks/', sourceLabel: 'OfficeChai' },
      { benchmark: 'MMMU-Pro', score: 83.6, source: 'https://officechai.com/ai/gemini-flash-3-5-benchmarks/', sourceLabel: 'OfficeChai' },
    ],
  },

  // ─── Gemini 3.1 Pro ──────────────────────────────────────────────────────
  {
    modelId: 'gemini-3.1-pro-preview',
    announcementUrl: 'https://blog.google/technology/google-deepmind/gemini-3-1-pro/',
    architectureSources: ['https://codingfleet.com/blog/gemini-3-1-pro-vs-gemini-3-5-flash/'],
    benchmarks: [
      { benchmark: 'Terminal-Bench 2.1', score: 70.3, source: 'https://codingfleet.com/blog/gemini-3-1-pro-vs-gemini-3-5-flash/', sourceLabel: 'CodingFleet (Google data)' },
      { benchmark: 'GDPval-AA (Elo)', score: 1314, source: 'https://codingfleet.com/blog/gemini-3-1-pro-vs-gemini-3-5-flash/', sourceLabel: 'CodingFleet' },
      { benchmark: 'SWE-bench Pro', score: 54.2, source: 'https://codingfleet.com/blog/gemini-3-1-pro-vs-gemini-3-5-flash/', sourceLabel: 'CodingFleet' },
      { benchmark: 'ARC-AGI-2', score: 77.1, source: 'https://codingfleet.com/blog/gemini-3-1-pro-vs-gemini-3-5-flash/', sourceLabel: 'CodingFleet' },
      { benchmark: 'GPQA Diamond', score: 94.3, source: 'https://codingfleet.com/blog/gemini-3-1-pro-vs-gemini-3-5-flash/', sourceLabel: 'CodingFleet' },
      { benchmark: 'MRCR v2 (128K)', score: 84.9, source: 'https://codingfleet.com/blog/gemini-3-1-pro-vs-gemini-3-5-flash/', sourceLabel: 'CodingFleet' },
    ],
  },
];

/**
 * Independent leaderboard sources (not provider-published).
 */
export const INDEPENDENT_SOURCES = [
  {
    name: 'Aider Polyglot Leaderboard',
    url: 'https://llm-stats.com/benchmarks/aider-polyglot',
    description: '225 coding tasks across 6 languages (C++, Go, Java, JS, Python, Rust)',
    lastUpdated: '2026-07',
  },
  {
    name: 'LMSYS Chatbot Arena (LMArena)',
    url: 'https://www.swfte.com/ai/lm/leaderboard',
    description: 'Crowdsourced ELO from millions of blind A/B comparisons',
    lastUpdated: '2026-07',
  },
  {
    name: 'SWE-bench Verified',
    url: 'https://www.swebench.com/',
    description: 'Real GitHub issue resolution (2,294 tasks from 12 Python repos)',
    lastUpdated: '2026-07',
  },
  {
    name: 'Terminal-Bench',
    url: 'https://terminal-bench.com/',
    description: 'Agentic coding in terminal environments (multi-step, tool use)',
    lastUpdated: '2026-07',
  },
  {
    name: 'Artificial Analysis',
    url: 'https://artificialanalysis.ai/',
    description: 'Independent speed, quality, and price benchmarking',
    lastUpdated: '2026-07',
  },
  {
    name: 'LiveCodeBench',
    url: 'https://livecodebench.github.io/',
    description: 'Continuously updated coding benchmark from fresh competition problems',
    lastUpdated: '2026-07',
  },
];

/**
 * Provider official documentation links.
 */
export const PROVIDER_DOCS = {
  anthropic: {
    models: 'https://docs.anthropic.com/en/docs/about-claude/models',
    pricing: 'https://www.anthropic.com/pricing',
    blog: 'https://www.anthropic.com/news',
  },
  openai: {
    models: 'https://platform.openai.com/docs/models',
    pricing: 'https://openai.com/pricing',
    blog: 'https://openai.com/index/',
  },
  google: {
    models: 'https://ai.google.dev/gemini-api/docs/models',
    pricing: 'https://ai.google.dev/pricing',
    blog: 'https://blog.google/technology/google-deepmind/',
  },
  microsoft: {
    models: 'https://learn.microsoft.com/en-us/azure/ai-services/',
    blog: 'https://blogs.microsoft.com/ai/',
  },
};

/**
 * Get benchmarks for a specific model.
 * @param {string} modelId
 * @returns {ModelBenchmarks|undefined}
 */
export function getBenchmarks(modelId) {
  return VERIFIED_BENCHMARKS.find(b => b.modelId === modelId);
}

/**
 * Get all unique benchmark names across all models.
 * @returns {string[]}
 */
export function allBenchmarkNames() {
  const names = new Set();
  for (const mb of VERIFIED_BENCHMARKS) {
    for (const b of mb.benchmarks) names.add(b.benchmark);
  }
  return [...names].sort();
}
