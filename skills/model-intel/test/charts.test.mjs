/**
 * Tests for the chart generation module.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { barChart, table, radarChart, scatterPlot, timeline, headToHead, decisionTree, formatDimName } from '../scripts/charts.mjs';

test('barChart produces correct number of lines', () => {
  const data = [
    { name: 'Model A', value: 80 },
    { name: 'Model B', value: 60 },
    { name: 'Model C', value: 95 },
  ];
  const result = barChart(data);
  const lines = result.split('\n');
  assert.equal(lines.length, 3);
});

test('barChart respects max value', () => {
  const data = [{ name: 'Test', value: 50 }];
  const result = barChart(data, { width: 20, max: 100 });
  const barPart = result.split('Test')[1].trim();
  // 50/100 * 20 = 10 filled chars
  const filled = (barPart.match(/█/g) || []).length;
  assert.equal(filled, 10);
});

test('barChart shows values when showValue=true', () => {
  const data = [{ name: 'X', value: 42 }];
  const result = barChart(data, { showValue: true });
  assert.ok(result.includes('42'));
});

test('table generates box-drawing output', () => {
  const result = table({
    headers: ['Name', 'Score'],
    rows: [['Alice', '95'], ['Bob', '87']],
  });
  assert.ok(result.includes('┌'));
  assert.ok(result.includes('┘'));
  assert.ok(result.includes('│'));
  assert.ok(result.includes('Alice'));
  assert.ok(result.includes('87'));
});

test('table includes title when provided', () => {
  const result = table({
    title: 'My Table',
    headers: ['A'],
    rows: [['1']],
  });
  assert.ok(result.includes('### My Table'));
});

test('radarChart includes model name', () => {
  const result = radarChart({
    modelName: 'TestModel',
    scores: { codeGeneration: 90, reasoning: 70, speed: 50 },
  });
  assert.ok(result.includes('TestModel'));
});

test('radarChart shows indicators based on score', () => {
  const result = radarChart({
    modelName: 'X',
    scores: { codeGeneration: 95, reasoning: 40 },
  });
  assert.ok(result.includes('🟢'), 'High score should get green indicator');
  assert.ok(result.includes('🔴'), 'Low score should get red indicator');
});

test('scatterPlot includes axis labels', () => {
  const result = scatterPlot([
    { name: 'A', x: 50, y: 80 },
    { name: 'B', x: 90, y: 60 },
  ]);
  assert.ok(result.includes('Cost Efficiency'));
  assert.ok(result.includes('Quality'));
});

test('scatterPlot includes legend with point names', () => {
  const result = scatterPlot([
    { name: 'ModelX', x: 50, y: 80 },
  ]);
  assert.ok(result.includes('ModelX'));
});

test('timeline sorts events chronologically', () => {
  const result = timeline([
    { date: '2026-06', label: 'Later', provider: 'openai' },
    { date: '2025-02', label: 'Earlier', provider: 'anthropic' },
  ]);
  const lines = result.split('\n');
  const earlierIdx = lines.findIndex(l => l.includes('Earlier'));
  const laterIdx = lines.findIndex(l => l.includes('Later'));
  assert.ok(earlierIdx < laterIdx, 'Earlier event should appear first');
});

test('timeline shows provider symbols', () => {
  const result = timeline([
    { date: '2026-01', label: 'Test', provider: 'anthropic' },
  ]);
  assert.ok(result.includes('🟣'));
});

test('headToHead declares a winner', () => {
  const modelA = {
    name: 'Alpha',
    scores: { codeGeneration: 90, reasoning: 80, speed: 70 },
  };
  const modelB = {
    name: 'Beta',
    scores: { codeGeneration: 85, reasoning: 85, speed: 60 },
  };
  const result = headToHead(modelA, modelB);
  assert.ok(result.includes('Alpha'));
  assert.ok(result.includes('Beta'));
  assert.ok(result.includes('wins'));
});

test('decisionTree produces tree structure', () => {
  const decisions = [
    { task: 'Quick edit', recommended: 'Fast Model', fallback: 'Alt Model', reason: 'Speed matters' },
    { task: 'Deep review', recommended: 'Smart Model', fallback: 'Alt Model', reason: 'Quality matters' },
  ];
  const result = decisionTree(decisions);
  assert.ok(result.includes('├'));
  assert.ok(result.includes('└'));
  assert.ok(result.includes('Quick edit'));
  assert.ok(result.includes('✅ Best:'));
});

test('formatDimName converts camelCase to Title Case', () => {
  assert.equal(formatDimName('codeGeneration'), 'Code Generation');
  assert.equal(formatDimName('multiFile'), 'Multi File');
  assert.equal(formatDimName('speed'), 'Speed');
  assert.equal(formatDimName('costEfficiency'), 'Cost Efficiency');
});
