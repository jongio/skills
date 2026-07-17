/**
 * Tests for the model registry module.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { MODEL_REGISTRY, PROVIDERS, groupByProvider, rankBy, recommendFor, TASK_PROFILES } from '../scripts/registry.mjs';

test('MODEL_REGISTRY is a non-empty array', () => {
  assert.ok(Array.isArray(MODEL_REGISTRY));
  assert.ok(MODEL_REGISTRY.length >= 10, `Expected at least 10 models, got ${MODEL_REGISTRY.length}`);
});

test('every model has required fields', () => {
  const requiredFields = ['id', 'name', 'llmStatsSlug', 'provider', 'family', 'contextTiers', 'effortLevels', 'releaseDate', 'contextWindow', 'architecture', 'tier'];
  for (const model of MODEL_REGISTRY) {
    for (const field of requiredFields) {
      assert.ok(field in model, `Model ${model.id || 'unknown'} missing field: ${field}`);
    }
    assert.ok(!('scores' in model), `Model ${model.id} should not include scores`);
  }
});

test('llmStatsSlug is derived from the model name', () => {
  for (const model of MODEL_REGISTRY) {
    const expected = model.name.toLowerCase().replaceAll(' ', '-').replaceAll('.', '-');
    assert.equal(model.llmStatsSlug, expected, `Unexpected llmStatsSlug for ${model.id}`);
  }
});

test('model IDs are unique', () => {
  const ids = MODEL_REGISTRY.map(m => m.id);
  const unique = new Set(ids);
  assert.equal(ids.length, unique.size, `Duplicate model IDs: ${ids.filter((id, i) => ids.indexOf(id) !== i)}`);
});

test('every model provider exists in PROVIDERS', () => {
  for (const model of MODEL_REGISTRY) {
    assert.ok(model.provider in PROVIDERS, `Model ${model.id} has unknown provider: ${model.provider}`);
  }
});

test('contextTiers is an array of valid values', () => {
  const validTiers = ['default', 'long_context'];
  for (const model of MODEL_REGISTRY) {
    assert.ok(Array.isArray(model.contextTiers), `${model.id}.contextTiers not an array`);
    assert.ok(model.contextTiers.length >= 1, `${model.id}.contextTiers is empty`);
    for (const tier of model.contextTiers) {
      assert.ok(validTiers.includes(tier), `${model.id} has invalid tier: ${tier}`);
    }
  }
});

test('tier is standard or premium', () => {
  for (const model of MODEL_REGISTRY) {
    assert.ok(['standard', 'premium'].includes(model.tier), `${model.id} has invalid tier: ${model.tier}`);
  }
});

test('groupByProvider returns all providers', () => {
  const groups = groupByProvider();
  assert.ok(groups.size >= 3, `Expected at least 3 providers, got ${groups.size}`);
  let total = 0;
  for (const models of groups.values()) total += models.length;
  assert.equal(total, MODEL_REGISTRY.length);
});

test('rankBy pricing sorts cheapest models first', () => {
  const ranked = rankBy('pricing');
  assert.ok(ranked.length > 0);
  for (let i = 1; i < ranked.length; i++) {
    const prevCost = ranked[i - 1].pricing.input + ranked[i - 1].pricing.output;
    const nextCost = ranked[i].pricing.input + ranked[i].pricing.output;
    assert.ok(prevCost <= nextCost, `Not sorted by pricing: ${ranked[i - 1].name} > ${ranked[i].name}`);
  }
});

test('rankBy contextWindow sorts largest context first', () => {
  const ranked = rankBy('contextWindow');
  assert.ok(ranked.length > 0);
  for (let i = 1; i < ranked.length; i++) {
    assert.ok(ranked[i - 1].maxContextWindow >= ranked[i].maxContextWindow,
      `Not sorted by context window: ${ranked[i - 1].name} < ${ranked[i].name}`);
  }
});

test('recommendFor quickEdit prioritizes standard lightweight models', () => {
  const profile = TASK_PROFILES.quickEdit;
  const result = recommendFor(profile.weights);
  assert.equal(result.length, MODEL_REGISTRY.length);
  const top = result[0];
  assert.equal(top.tier, 'standard');
  assert.equal(top.category, 'Lightweight');
});

test('recommendFor testGeneration prioritizes code-specialized models', () => {
  const result = recommendFor('testGeneration');
  const top = result[0];
  assert.ok(top.id === 'mai-code-1-flash-picker' || top.id === 'gpt-5.3-codex', `Unexpected testGeneration top pick: ${top.id}`);
});

test('TASK_PROFILES covers expected tasks', () => {
  const expected = ['quickEdit', 'complexRefactor', 'debugging', 'architectureReview', 'codeReview', 'documentation', 'testGeneration', 'securityAudit', 'longContext', 'bulkProcessing'];
  for (const task of expected) {
    assert.ok(task in TASK_PROFILES, `Missing task profile: ${task}`);
    assert.ok(TASK_PROFILES[task].label, `${task} missing label`);
    assert.ok(TASK_PROFILES[task].weights, `${task} missing weights`);
  }
});

test('releaseDate follows YYYY-MM format', () => {
  const datePattern = /^\d{4}-\d{2}$/;
  for (const model of MODEL_REGISTRY) {
    assert.ok(datePattern.test(model.releaseDate),
      `${model.id} releaseDate "${model.releaseDate}" does not match YYYY-MM`);
  }
});

test('contextWindow is a positive number', () => {
  for (const model of MODEL_REGISTRY) {
    assert.ok(typeof model.contextWindow === 'number' && model.contextWindow > 0,
      `${model.id} contextWindow should be positive, got ${model.contextWindow}`);
  }
});
