#!/usr/bin/env node
/**
 * naming.mjs: the naming-is-hard engine CLI.
 *
 * The agent (driven by SKILL.md) does the creative work: writing the brief,
 * generating candidate names, presenting swipe cards. This CLI owns the
 * deterministic, security-sensitive, and stateful parts: feature extraction,
 * the preference model, availability checks, verdicts, and persistence.
 *
 * Each subcommand loads state from --dir, does its job, and saves. Functions are
 * exported so tests can drive them with an injected fetch (no network).
 *
 * Subcommands:
 *   init    --dir D [--brief-json '{...}']          fresh (or existing) state
 *   brief   --dir D --json '{...}'                   set the Naming Brief
 *   add     --dir D --json '[{"name":..}]'           add candidates (features extracted)
 *   next    --dir D [--count N]                      next card(s) to show
 *   swipe   --dir D --id ID --label like|pass|superlike|skip
 *   rank    --dir D [--limit N]                      candidates by learned fit
 *   profile --dir D                                  the learned "type"
 *   suggest --dir D --name NAME                      morphological variants
 *   check   --dir D [--names a,b] [--github-token T] availability scorecards
 *   report  --dir D [--names a,b] [--as-json]        ranked matches + verdicts
 *   state   --dir D                                  dump state
 *   reset   --dir D                                  clear state
 */

import { readFileSync } from 'node:fs';
import * as store from './store.mjs';
import { pickNext, rank, profile, score, normalized, suggestVariants, duel } from './model.mjs';
import {
  check as availabilityCheck,
  suggestHandleVariants,
  checkDomain,
  checkGithubHandle,
  checkRegistry,
} from './availability.mjs';
import { rankByVerdict, computeVerdict } from './verdict.mjs';
import { confusableAgainst } from './similarity.mjs';

// ---------------------------------------------------------------------------
// arg parsing
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const nextArg = argv[i + 1];
      if (nextArg === undefined || nextArg.startsWith('--')) {
        flags[key] = true;
      } else {
        flags[key] = nextArg;
        i++;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function requireDir(opts) {
  const dir = opts.dir || (opts.flags && opts.flags.dir);
  if (!dir) throw new Error('missing --dir');
  return dir;
}

function parseJson(value, fallback) {
  if (value === undefined || value === true) return fallback;
  return JSON.parse(value);
}

// ---------------------------------------------------------------------------
// commands (each returns a plain result object; `main` prints it)
// ---------------------------------------------------------------------------

export function runInit(opts) {
  const dir = requireDir(opts);
  let state = store.load(dir);
  const brief = parseJson(opts.briefJson ?? opts['brief-json'], null);
  if (brief) state = store.setBrief(state, brief);
  state = store.save(dir, state);
  return { ok: true, dir, candidates: state.candidates.length, hasBrief: !!state.brief };
}

export function runBrief(opts) {
  const dir = requireDir(opts);
  const brief = parseJson(opts.json, null);
  if (!brief) throw new Error('brief: --json is required');
  const state = store.save(dir, store.setBrief(store.load(dir), brief));
  return { ok: true, brief: state.brief };
}

export function runAdd(opts) {
  const dir = requireDir(opts);
  const items = opts.items || parseJson(opts.json, null) || readStdinJson();
  if (!Array.isArray(items)) throw new Error('add: expected a JSON array of {name,strategy?,tags?}');
  const { state, added } = store.addCandidates(store.load(dir), items);
  store.save(dir, state);
  return { ok: true, added: added.map((c) => ({ id: c.id, name: c.name })), total: state.candidates.length };
}

export function runNext(opts) {
  const dir = requireDir(opts);
  const state = store.load(dir);
  const count = Math.max(1, Number(opts.count) || 1);
  const swiped = store.swipedIds(state);
  const swipedCands = store.swipedCandidates(state);
  const cards = [];
  const excluded = new Set(swiped);
  for (let i = 0; i < count; i++) {
    const pick = pickNext(state.candidates, {
      weights: state.weights,
      swipedIds: [...excluded],
      swipedCandidates: swipedCands,
    });
    if (!pick) break;
    excluded.add(pick.id);
    cards.push(cardView(pick, state.weights));
  }
  return { cards, remaining: store.unseenCandidates(state).length - cards.length };
}

export function runSwipe(opts) {
  const dir = requireDir(opts);
  const id = opts.id;
  const label = opts.label;
  if (!id) throw new Error('swipe: --id is required');
  if (!['like', 'pass', 'superlike', 'skip', 'dislike'].includes(label)) {
    throw new Error(`swipe: --label must be like|pass|superlike|skip (got ${label})`);
  }
  const state = store.recordSwipe(store.load(dir), id, label);
  store.save(dir, state);
  return { ok: true, id, label, profile: profile(state.weights), swiped: store.swipedIds(state).length };
}

export function runRank(opts) {
  const dir = requireDir(opts);
  const state = store.load(dir);
  const limit = Number(opts.limit) || state.candidates.length;
  const ranked = rank(state.candidates, state.weights)
    .slice(0, limit)
    .map((c) => ({ id: c.id, name: c.name, fit: round(c.fit), swipe: c.swipe }));
  return { ranked };
}

export function runProfile(opts) {
  const dir = requireDir(opts);
  return profile(store.load(dir).weights);
}

export function runSuggest(opts) {
  const name = opts.name;
  if (!name) throw new Error('suggest: --name is required');
  return { name, variants: suggestVariants(name, Number(opts.count) || 8) };
}

/** Shared availability options (injectable resolvers/fetch for tests; env token in prod). */
function availOpts(opts) {
  return {
    fetchImpl: opts.fetchImpl,
    resolveHost: opts.resolveHost,
    resolveNs: opts.resolveNs,
    githubToken: opts.githubToken ?? opts['github-token'] ?? process.env.GITHUB_TOKEN,
    tlds: opts.tlds ? String(opts.tlds).split(',').map((s) => s.trim()).filter(Boolean) : undefined,
  };
}

function splitCsv(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  return String(value).split(',').map((s) => s.trim()).filter(Boolean);
}

export async function runCheck(opts) {
  const dir = requireDir(opts);
  let state = store.load(dir);
  const names = resolveNames(opts, state);
  if (!names.length) throw new Error('check: no names (use --names a,b or swipe some cards first)');
  const scorecards = [];
  for (const name of names) {
    const card = await availabilityCheck(name, availOpts(opts));
    state = store.setResult(state, name, card);
    scorecards.push(card);
  }
  store.save(dir, state);
  return { checked: names, scorecards };
}

/**
 * Availability-FIRST screen: check a batch and bucket each name by its verdict tier
 * under the chosen channel preset, so the agent can add only `clear` names to the deck
 * (never letting the user fall for a taken name).
 */
export async function runScreen(opts) {
  const dir = opts.dir || (opts.flags && opts.flags.dir);
  const names = splitCsv(opts.names);
  if (!names.length) throw new Error('screen: --names a,b,c is required');
  let state = dir ? store.load(dir) : store.defaultState();
  const buckets = { clear: [], contested: [], blocked: [] };
  const cards = [];
  for (const name of names) {
    const card = await availabilityCheck(name, availOpts(opts));
    if (dir) state = store.setResult(state, name, card);
    const verdict = computeVerdict(card, { preset: opts.preset });
    const bucket = verdict.tier === 'perfect-match' ? 'clear' : verdict.tier === 'deal-breaker' ? 'blocked' : 'contested';
    buckets[bucket].push(name);
    cards.push({ name, tier: verdict.tier, reason: verdict.reason });
  }
  if (dir) store.save(dir, state);
  return { preset: opts.preset || 'cli-first', buckets, cards };
}

/**
 * Decorated variants for a taken handle/org/domain (get<X>/<X>hq/<X>dev). With a
 * network fetch available, screens each variant's GitHub org, npm, and `.dev`.
 */
export async function runVariants(opts) {
  const name = opts.name;
  if (!name) throw new Error('variants: --name is required');
  const variants = suggestHandleVariants(name);
  const ao = availOpts(opts);
  const checked = [];
  for (const v of variants) {
    const slug = v.toLowerCase();
    checked.push({
      name: v,
      github: await checkGithubHandle(slug, ao),
      npm: await checkRegistry(slug, 'npm', ao),
      dev: await checkDomain(slug, 'dev', ao),
    });
  }
  return { name, variants: checked };
}

/** Confusability report: is this name too close to any existing name in a corpus? */
export function runSimilar(opts) {
  const name = opts.name;
  if (!name) throw new Error('similar: --name is required');
  const corpus = splitCsv(opts.against);
  if (!corpus.length) throw new Error('similar: --against a,b,c is required');
  return { name, collisions: confusableAgainst(name, corpus) };
}

/**
 * Decision mode: record one head-to-head result (winner beats loser) and fold it into
 * the model so the winner's features outrank the loser's. Ids reference candidates.
 */
export function runDuel(opts) {
  const dir = requireDir(opts);
  const state = store.load(dir);
  const winnerId = opts.winner;
  const loserId = opts.loser;
  if (!winnerId || !loserId) throw new Error('duel: --winner ID --loser ID are required');
  const winner = state.candidates.find((c) => c.id === winnerId);
  const loser = state.candidates.find((c) => c.id === loserId);
  if (!winner) throw new Error(`duel: unknown winner id: ${winnerId}`);
  if (!loser) throw new Error(`duel: unknown loser id: ${loserId}`);
  const weights = duel(state.weights, winner.tokens, loser.tokens);
  store.save(dir, { ...state, weights });
  return { winner: winner.name, loser: loser.name, profile: profile(weights) };
}

export function runReport(opts) {
  const dir = requireDir(opts);
  const state = store.load(dir);
  const names = resolveNames(opts, state);
  const finalists = names
    .map((name) => {
      const scorecard = state.results[name];
      if (!scorecard) return null;
      const cand = state.candidates.find((c) => c.name === name);
      const fit = cand ? normalized(score(state.weights, cand.tokens)) : 0.5;
      return { name, fit, scorecard };
    })
    .filter(Boolean);
  const { ranked, winner } = rankByVerdict(finalists, { preset: opts.preset });
  return { text: renderReport(ranked, winner, state.brief), ranked, winner };
}

export function runState(opts) {
  return store.load(requireDir(opts));
}

export function runReset(opts) {
  const dir = requireDir(opts);
  store.reset(dir);
  return { ok: true, reset: true };
}

// ---------------------------------------------------------------------------
// views / rendering
// ---------------------------------------------------------------------------

function cardView(candidate, weights) {
  return {
    id: candidate.id,
    name: candidate.name,
    strategy: candidate.strategy,
    fit: round(normalized(score(weights, candidate.tokens))),
    detail: candidate.detail,
  };
}

function resolveNames(opts, state) {
  if (opts.names) {
    const arr = Array.isArray(opts.names) ? opts.names : String(opts.names).split(',');
    return arr.map((s) => s.trim()).filter(Boolean);
  }
  return store.likedCandidates(state).map((c) => c.name);
}

const GLYPH = { available: '✅', taken: '❌', unknown: '❔' };
function glyph(status) {
  return GLYPH[status] || '❔';
}

export function renderReport(ranked, winner, brief) {
  const lines = [];
  const title = brief && brief.name ? `Naming matches for ${brief.name}` : 'Your naming matches';
  lines.push(`\u{1F498} ${title}`);
  lines.push('');

  if (!ranked.length) {
    lines.push('No finalists yet. Swipe some cards and run `check`, then `report`.');
    return lines.join('\n');
  }

  if (winner) {
    lines.push(`Winner: ${winner.verdict.emoji} ${winner.name} (${winner.verdict.label})`);
    lines.push(`  ${winner.verdict.reason}`);
    if (winner.verdict.caution) lines.push(`  note: ${winner.verdict.caution}`);
    lines.push(`  ${channelLine(winner.scorecard)}`);
    for (const note of winner.scorecard.notes || []) lines.push(`  note: ${note}`);
    lines.push('');
  } else {
    lines.push('No clean winner: every finalist is a Deal Breaker. Back to swiping.');
    lines.push('');
  }

  const rest = ranked.filter((f) => f !== winner);
  if (rest.length) {
    lines.push('The rest of the field:');
    let n = winner ? 2 : 1;
    for (const f of rest) {
      lines.push(`  ${n}. ${f.verdict.emoji} ${f.name} (${f.verdict.label})`);
      lines.push(`     ${f.verdict.reason}`);
      if (f.verdict.caution) lines.push(`     note: ${f.verdict.caution}`);
      lines.push(`     ${channelLine(f.scorecard)}`);
      for (const note of f.scorecard.notes || []) lines.push(`     note: ${note}`);
      n++;
    }
  }
  lines.push('');
  lines.push('(* .com is parked for nearly every name; npm and .dev are the signals that matter.)');
  return lines.join('\n');
}

function statusOf(v) {
  return v && typeof v === 'object' ? v.status : v;
}

function channelLine(scorecard) {
  const c = scorecard.channels || {};
  return [
    `npm ${glyph(statusOf(c.registries?.npm))}`,
    `.dev ${glyph(statusOf(c.domains?.dev))}`,
    `gh ${glyph(statusOf(c.github?.org))}`,
    `.io ${glyph(statusOf(c.domains?.io))}`,
    `.com ${glyph(statusOf(c.domains?.com))}*`,
    'social ℹ️',
  ].join('  ');
}

function round(n) {
  return Math.round(n * 100) / 100;
}

function readStdinJson() {
  try {
    const raw = readFileSync(0, 'utf-8').trim();
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------

const COMMANDS = {
  init: runInit,
  brief: runBrief,
  add: runAdd,
  next: runNext,
  swipe: runSwipe,
  rank: runRank,
  profile: runProfile,
  suggest: runSuggest,
  check: runCheck,
  screen: runScreen,
  variants: runVariants,
  similar: runSimilar,
  duel: runDuel,
  report: runReport,
  state: runState,
  reset: runReset,
};

const USAGE = `naming-is-hard engine
usage: node naming.mjs <command> --dir <state-dir> [flags]
commands: ${Object.keys(COMMANDS).join(', ')}`;

export async function main(argv = process.argv.slice(2)) {
  const { positional, flags } = parseArgs(argv);
  const command = positional[0];
  const fn = COMMANDS[command];
  if (!fn) {
    process.stderr.write(`${USAGE}\n`);
    process.exitCode = 1;
    return;
  }
  try {
    const result = await fn(flags);
    if (command === 'report' && !flags['as-json']) {
      process.stdout.write(`${result.text}\n`);
    } else {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    }
  } catch (err) {
    process.stderr.write(`error: ${err.message}\n`);
    process.exitCode = 1;
  }
}

// run when invoked directly
const self = new URL(import.meta.url).pathname;
const invoked = process.argv[1] && new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).pathname;
if (self === invoked) {
  main();
}
