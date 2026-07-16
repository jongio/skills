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
  const requiredFields = ['id', 'name', 'provider', 'family', 'contextTiers', 'effortLevels', 'releaseDate', 'contextWindow', 'architecture', 'tier', 'scores'];
  for (const model of MODEL_REGISTRY) {
    for (const field of requiredFields) {
      assert.ok(field in model, `Model ${model.id || 'unknown'} missing field: ${field}`);
    }
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

test('scores are numbers between 0 and 100', () => {
  const DIMS = ['codeGeneration', 'codeReview', 'reasoning', 'contextLength', 'instructionFollowing', 'speed', 'costEfficiency', 'multiFile', 'creativeWriting', 'toolUse'];
  for (const model of MODEL_REGISTRY) {
    for (const dim of DIMS) {
      const val = model.scores[dim];
      assert.ok(typeof val === 'number', `${model.id}.scores.${dim} is not a number`);
      assert.ok(val >= 0 && val <= 100, `${model.id}.scores.${dim} = ${val} is out of range [0,100]`);
    }
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

test('rankBy returns models sorted descending', () => {
  const ranked = rankBy('codeGeneration');
  assert.ok(ranked.length > 0);
  for (let i = 1; i < ranked.length; i++) {
    assert.ok(ranked[i - 1].scores.codeGeneration >= ranked[i].scores.codeGeneration,
      `Not sorted: ${ranked[i - 1].name}(${ranked[i - 1].scores.codeGeneration}) < ${ranked[i].name}(${ranked[i].scores.codeGeneration})`);
  }
});

test('recommendFor returns models sorted by weighted score', () => {
  const profile = TASK_PROFILES.quickEdit;
  const result = recommendFor(profile.weights);
  assert.ok(result.length === MODEL_REGISTRY.length);
  // Top result should have high speed + cost efficiency + code gen
  const top = result[0];
  assert.ok(top.scores.speed >= 80 || top.scores.costEfficiency >= 80,
    `Top pick ${top.name} for quickEdit should be fast/cheap`);
});

test('TASK_PROFILES covers expected tasks', () => {
  const expected = ['quickEdit', 'complexRefactor', 'debugging', 'architectureReview', 'codeReview', 'documentation', 'testGeneration', 'securityAudit'];
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
      `${model.id} releaseDate "${model.releaseDate}" doesn't match YYYY-MM`);
  }
});

test('contextWindow is a positive number', () => {
  for (const model of MODEL_REGISTRY) {
    assert.ok(typeof model.contextWindow === 'number' && model.contextWindow > 0,
      `${model.id} contextWindow should be positive, got ${model.contextWindow}`);
  }
});
