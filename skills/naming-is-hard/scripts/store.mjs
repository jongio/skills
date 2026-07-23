/**
 * store.mjs: the session state for a naming run.
 *
 * A single JSON file holds everything the model needs to stay authoritative
 * across CLI invocations (each swipe is a separate process): the Naming Brief,
 * every candidate with its extracted features and swipe, the learned weights,
 * and any availability results. Writes are atomic (temp + rename) so an
 * interrupted run never corrupts state; a missing or corrupt file loads as a
 * fresh state rather than throwing.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { extractFeatures } from './features.mjs';
import { update as updateWeights, revert as revertWeights } from './model.mjs';
import { slugify } from './net.mjs';

export const STATE_VERSION = 1;
const STATE_FILE = 'naming-state.json';

export function statePath(dir) {
  return join(dir, STATE_FILE);
}

/** A fresh, empty state. */
export function defaultState() {
  const now = new Date().toISOString();
  return {
    version: STATE_VERSION,
    brief: null,
    candidates: [],
    weights: {},
    results: {},
    createdAt: now,
    updatedAt: now,
  };
}

/** Load state from `dir`, tolerating a missing or corrupt file. */
export function load(dir) {
  const p = statePath(dir);
  if (!existsSync(p)) return defaultState();
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf-8'));
    if (!parsed || parsed.version !== STATE_VERSION) return defaultState();
    if (!isValidShape(parsed)) return defaultState();
    return { ...defaultState(), ...parsed };
  } catch {
    return defaultState(); // corrupt -> start clean rather than crash
  }
}

/** Minimal shape check so a malformed file fails at the boundary, not deep in a call stack. */
function isValidShape(s) {
  return (
    Array.isArray(s.candidates) &&
    (s.brief === null || typeof s.brief === 'object') &&
    typeof s.weights === 'object' && s.weights !== null &&
    typeof s.results === 'object' && s.results !== null
  );
}

/** Persist state to `dir` atomically. */
export function save(dir, state) {
  mkdirSync(dir, { recursive: true });
  const p = statePath(dir);
  const tmp = `${p}.${process.pid}.tmp`;
  const next = { ...state, updatedAt: new Date().toISOString() };
  writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf-8');
  renameSync(tmp, p);
  return next;
}

/** Delete any persisted state for `dir`. */
export function reset(dir) {
  const p = statePath(dir);
  if (existsSync(p)) rmSync(p, { force: true });
}

/** Set the Naming Brief. */
export function setBrief(state, brief) {
  return { ...state, brief };
}

function uniqueId(state, name) {
  const base = slugify(name) || 'name';
  const taken = new Set(state.candidates.map((c) => c.id));
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

/**
 * Add candidates (each `{ name, strategy?, tags? }`), extracting features and
 * assigning stable ids. Skips names already present (by slug). Returns
 * `{ state, added }`.
 */
export function addCandidates(state, items) {
  let next = { ...state, candidates: [...state.candidates] };
  const existingSlugs = new Set(next.candidates.map((c) => slugify(c.name)));
  const added = [];
  for (const item of items || []) {
    const name = typeof item === 'string' ? item : item?.name;
    if (!name || !slugify(name)) continue;
    if (existingSlugs.has(slugify(name))) continue;
    const meta = typeof item === 'object' ? item : {};
    const f = extractFeatures(name, { strategy: meta.strategy, tags: meta.tags });
    const candidate = {
      id: uniqueId(next, name),
      name: f.name,
      strategy: meta.strategy || null,
      tags: meta.tags || [],
      tokens: f.tokens,
      detail: f.detail,
      swipe: null,
    };
    next.candidates.push(candidate);
    existingSlugs.add(slugify(name));
    added.push(candidate);
  }
  return { state: next, added };
}

/**
 * Record a swipe for candidate `id` and fold it into the model weights. Idempotent
 * per candidate: if the candidate was already swiped, the previous swipe's effect is
 * reversed first, so re-swiping the same label is a no-op and changing a swipe
 * (like -> pass) reflects only the new label.
 */
export function recordSwipe(state, id, label) {
  const idx = state.candidates.findIndex((c) => c.id === id);
  if (idx === -1) throw new Error(`unknown candidate id: ${id}`);
  const candidates = state.candidates.map((c) => ({ ...c }));
  const previous = candidates[idx].swipe;
  let weights = state.weights;
  if (previous) weights = revertWeights(weights, candidates[idx].tokens, previous);
  candidates[idx].swipe = label;
  weights = updateWeights(weights, candidates[idx].tokens, label);
  return { ...state, candidates, weights };
}

/** Candidates the user liked or super-liked, most-liked first. */
export function likedCandidates(state) {
  const rankLabel = { superlike: 0, like: 1 };
  return state.candidates
    .filter((c) => c.swipe === 'like' || c.swipe === 'superlike')
    .sort((a, b) => rankLabel[a.swipe] - rankLabel[b.swipe]);
}

/** Candidates not yet swiped. */
export function unseenCandidates(state) {
  return state.candidates.filter((c) => !c.swipe);
}

export function swipedIds(state) {
  return state.candidates.filter((c) => c.swipe).map((c) => c.id);
}

export function swipedCandidates(state) {
  return state.candidates.filter((c) => c.swipe);
}

/** Store an availability scorecard for a name. */
export function setResult(state, name, scorecard) {
  return { ...state, results: { ...state.results, [name]: scorecard } };
}
