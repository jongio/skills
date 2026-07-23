# Test Plan: naming-is-hard

## Status: COVERED
## Spec: docs/specs/naming-is-hard/spec.md
## Created: 2026-07-20
## Updated: 2026-07-22

---

## Coverage Strategy

The creative surface (brief writing, name generation, card copy) is the agent's job
and is exercised by the **Vally capability eval**, not unit tests. Everything
deterministic and security-sensitive lives in `scripts/` and is covered by
**bare-`node` unit tests** (the repo convention: no test framework, just `node:assert`
with a small custom `test()` harness), run with `npm test`.

Coverage targets: >=80% on new/modified engine lines, >=90% on the security boundary
(`net.mjs` sanitization + host allowlist). The network and DNS are never touched in unit
tests: `net.mjs` and `availability.mjs` take an **injectable fetch** (`fetchImpl`), and
`availability.mjs` also takes injectable `resolveNs` / `resolveHost`; a separate
`scripts/smoke.mjs` hits the real endpoints and
resolvers on demand and is documented, not run in CI.

Test runner: `npm test` (chains `node test/<name>.test.mjs` per file; no framework).

## Planned Tests

| ID | Behavior to verify | Source | Level | Test file -> name | Status |
|----|--------------------|--------|-------|-------------------|--------|
| T1 | Feature extraction returns a stable vector for a given name (length bucket, syllables, style hints) | AC3 | unit | features.test.mjs -> "extracts a stable feature vector" | automated |
| T2 | Syllable estimate is correct on known words (edge: 1-syllable, silent-e, vowel runs) | AC3 | unit | features.test.mjs -> "estimates syllables" | automated |
| T3 | Morphology detects suffix families (-ly/-ify/-io/-ai/-hub) and prefixes | AC3 | unit | features.test.mjs -> "detects morphology" | automated |
| T4 | Sound flags: alliteration, hard consonants, sibilance | AC3 | unit | features.test.mjs -> "detects sound features" | automated |
| T5 | real-word-vs-coined heuristic classifies clear cases | AC3 | unit | features.test.mjs -> "classifies real vs coined" | automated |
| T6 | Empty/whitespace/1-char name does not throw and yields a valid vector | AC3 | unit | features.test.mjs -> "handles degenerate names" | automated |
| T7 | Model scores an unseen candidate sharing liked features above one sharing passed features | AC4 | unit | model.test.mjs -> "learns from likes and passes" | automated |
| T8 | Super-like moves weights more than a like | AC4 | unit | model.test.mjs -> "super-like weighs more than like" | automated |
| T9 | `profile()` names the learned type in plain language from top-weighted features | AC4 | unit | model.test.mjs -> "explains the learned type" | automated |
| T10 | `next()` never returns an already-swiped candidate | AC5 | unit | model.test.mjs -> "next skips swiped" | automated |
| T11 | `next()` prefers higher-scoring candidates once signal exists (exploit) | AC5 | unit | model.test.mjs -> "next exploits learned preference" | automated |
| T12 | `next()` surfaces feature variety during cold start (no immediate tunnelling) | AC5 | unit | model.test.mjs -> "next explores on cold start" | automated |
| T13 | `rank()` orders candidates by score descending and is stable | AC4 | unit | model.test.mjs -> "ranks by score" | automated |
| T14 | `suggest()` returns morphological variants of a liked name | AC4 | unit | model.test.mjs -> "suggests variants of liked names" | automated |
| T15 | `mapStatus`: HTTP 404 -> available, 2xx/redirect -> taken, 0/401/403/429 -> unknown | AC6 | unit | availability.test.mjs -> "maps registry results" | automated |
| T16 | GitHub check maps users/repos 404 -> available, 200 -> taken | AC6 | unit | availability.test.mjs -> "maps GitHub results" | automated |
| T17 | Registry checks (npm/PyPI/crates/RubyGems/NuGet) map 404 -> available, 200 -> taken | AC6 | unit | availability.test.mjs -> "maps registry results" | automated |
| T18 | Social checks are labelled best-effort and always include a verify URL | AC6 | unit | availability.test.mjs -> "social is best-effort with verify url" | automated |
| T19 | A failed/timed-out probe degrades to `unknown`, never a confident value | AC6 | unit | availability.test.mjs -> "degrades to unknown on failure" | automated |
| T20 | `check()` runs channels with bounded concurrency and returns one scorecard object | AC6 | unit | availability.test.mjs -> "builds a scorecard" | automated |
| T21 | Names are sanitized to `[a-z0-9-]` (spaces, unicode, dots, slashes stripped/rejected) before any request | AC7 | unit | net.test.mjs -> "sanitizes names to a safe slug" | automated |
| T22 | A hostile name (`../`, `@evil.com`, `javascript:`) cannot produce an off-allowlist URL | AC7 | unit | net.test.mjs -> "rejects host escapes" | automated |
| T23 | `safeFetch` only contacts allowlisted hosts; a non-allowlisted host throws | AC7 | unit | net.test.mjs -> "enforces host allowlist" | automated |
| T24 | `safeFetch` applies a timeout and does not follow redirects off-allowlist | AC7 | unit | net.test.mjs -> "times out and guards redirects" | automated |
| T25 | famous-marks matches exact and slugified brand names ("Spotify", "spot ify") | AC11 | unit | marks.test.mjs -> "matches exact and slug forms" | automated |
| T26 | famous-marks near-miss catches "Gooogle" but not a distinct short name | AC11 | unit | marks.test.mjs -> "near-miss is conservative" | automated |
| T27 | famous-marks records the matched mark + reason for override transparency | AC11 | unit | marks.test.mjs -> "reports why it matched" | automated |
| T28 | `check()` trademark/business channels include famous-marks result + pre-filled link-outs | AC12 | unit | availability.test.mjs -> "trademark and business channels" | automated |
| T29 | trademark lookup failure yields `unknown`, never false "clear" | AC12 | unit | availability.test.mjs -> "trademark degrades to unknown" | automated |
| T30 | verdict = Deal Breaker when famous-marks hit, regardless of open domains | AC13 | unit | verdict.test.mjs -> "famous-marks forces Deal Breaker" | automated |
| T31 | verdict = Perfect Match when trademark-clear and all key channels free | AC13 | unit | verdict.test.mjs -> "all clear yields Perfect Match" | automated |
| T32 | verdict = It's Complicated when a key channel is taken but no legal blocker | AC13 | unit | verdict.test.mjs -> "contested key channel yields It's Complicated" | automated |
| T33 | verdict carries label + emoji + one-line reason | AC13 | unit | verdict.test.mjs -> "verdict has label, emoji, reason" | automated |
| T34 | key-channel set is overridable (weight social for consumer brands) | AC13 | unit | verdict.test.mjs -> "key channels are configurable" | automated |
| T35 | `report()` ranks finalists by combined fit+availability and never crowns a Deal Breaker winner | AC8 | unit | verdict.test.mjs -> "report never crowns a Deal Breaker" | automated |
| T36 | State round-trips: brief, candidates+features, swipes, weights, results persist across loads | AC9 | unit | store.test.mjs -> "round-trips full state" | automated |
| T37 | Store writes atomically and tolerates a missing/corrupt state file (fresh init) | AC9 | unit | store.test.mjs -> "atomic write and recovery" | automated |
| T38 | Brief round-trips via store (what the app is/audience/tone/constraints) | AC1 | unit | store.test.mjs -> "persists the brief" | automated |
| T39 | CLI `add` extracts features and stores candidates from JSON/stdin | AC2 | unit | cli.test.mjs -> "add stores candidates with features" | automated |
| T40 | CLI `swipe` updates the model; `next` then reflects it | AC4 | unit | cli.test.mjs -> "swipe then next reflects learning" | automated |
| T41 | CLI `check`/`report` run against an injected fetch and emit JSON + human render | AC8 | unit | cli.test.mjs -> "check and report produce output" | automated |
| T42 | CLI `reset` clears state; unknown subcommand exits non-zero with usage | AC9 | unit | cli.test.mjs -> "reset and unknown-command handling" | automated |
| T43 | Vally eval spec for the skill lints clean (`vally lint --eval-spec`) | AC10 | integration | (CI: skill-lint) -> "eval.yaml lints" | automated |
| T44 | `checkDomains`/`checkGithubRepo`/`checkMany` map results (reconciliation) | AC6 | unit | availability.test.mjs -> "checkDomains, checkGithubRepo, checkMany" | automated |
| T45 | `runBrief` sets brief; `runSuggest` returns variants (reconciliation) | AC1 | unit | cli.test.mjs -> "runBrief, runSuggest, and report edge branches" | automated |
| T46 | `report` no-finalists and all-Deal-Breaker (no winner) branches | AC8 | unit | cli.test.mjs -> "runBrief, runSuggest, and report edge branches" | automated |
| T47 | Domain NS present -> `taken` (parked `.dev` caught) | AC14 | unit | availability.test.mjs -> "domain NS present means taken (no RDAP)" | automated |
| T48 | Google TLD (`.dev`/`.app`/`.page`) decides on NS alone, no RDAP call | AC14 | unit | availability.test.mjs -> "google TLDs use NS without RDAP" | automated |
| T49 | Non-google TLD: NS absent confirmed via RDAP (404 -> available, else taken) | AC14 | unit | availability.test.mjs -> "non-google TLD confirms NS-absent via RDAP" | automated |
| T50 | NS resolver error/ENODATA classified as absent, not a crash | AC14 | unit | availability.test.mjs -> "NS resolver errors are classified" | automated |
| T51 | `DEFAULT_TLDS` leads with `.dev`; `.com` last (low-signal) | AC15 | unit | availability.test.mjs -> "TLD order leads with .dev" | automated |
| T52 | Verdict uses the launch TLD (`.dev`), not `.com`, as the primary domain | AC15 | unit | verdict.test.mjs -> "cli-first preset order and resolveKeys" | automated |
| T53 | npm `200` + 0 versions + unpublished -> `taken` + `tombstone` note | AC16 | unit | availability.test.mjs -> "npm tombstone is taken with a note; free vs live" | automated |
| T54 | npm `404` -> available; `200` with versions -> taken (no tombstone) | AC16 | unit | availability.test.mjs -> "npm tombstone is taken with a note; free vs live" | automated |
| T55 | `similarity` edit-distance 1/2 detection | AC17 | unit | similarity.test.mjs -> "detects edit distance" | automated |
| T56 | segment/token reorder (a name and its end-for-end reversal) flagged | AC17 | unit | similarity.test.mjs -> "detects token reorder" | automated |
| T57 | phonetic near-match flagged; clearly distinct names not flagged | AC17 | unit | similarity.test.mjs -> "phonetic and no-false-positive" | automated |
| T58 | `confusableAgainst(name, corpus)` returns collisions with reasons | AC17 | unit | similarity.test.mjs -> "confusableAgainst reports collisions" | automated |
| T59 | `pronounceability` flags vowel-starved/cluster-heavy/digit-laden as hardToSay | AC18 | unit | features.test.mjs -> "flags hard-to-say names" | automated |
| T60 | normal names score easy; deterministic | AC18 | unit | features.test.mjs -> "easy names score easy" | automated |
| T61 | a `say:easy|hard` token appears in `extractFeatures` tokens | AC18 | unit | features.test.mjs -> "say token in features" | automated |
| T62 | `KEY_PRESETS.cli-first` = npm > primary domain (`.dev`) > github | AC19 | unit | verdict.test.mjs -> "cli-first preset order and resolveKeys" | automated |
| T63 | `resolveKeys` accepts a preset name or explicit keys; default cli-first | AC19 | unit | verdict.test.mjs -> "cli-first preset order and resolveKeys" | automated |
| T64 | verdict differs by preset (npm-taken vs domain-taken) | AC19 | unit | verdict.test.mjs -> "preset changes the verdict" | automated |
| T65 | `suggestHandleVariants` returns `get<X>`/`<X>hq`/`<X>dev`/..., excludes bare | AC20 | unit | availability.test.mjs -> "suggests decorated variants" | automated |
| T66 | `screen` buckets names into available/contested/taken by preset | AC21 | unit | cli.test.mjs -> "screen buckets by key channels" | automated |
| T67 | `variants` CLI checks decorated forms and returns their statuses | AC20 | unit | cli.test.mjs -> "variants command checks decorated forms" | automated |
| T68 | `similar` CLI reports confusability against a supplied corpus | AC17 | unit | cli.test.mjs -> "similar command reports collisions" | automated |
| T69 | `model.duel(winner, loser)` moves weights so winner outranks loser | AC22 | unit | model.test.mjs -> "duel moves winner above loser" | automated |
| T70 | tournament over finalists produces a ranked order from duels | AC22 | unit | model.test.mjs -> "tournament ranks from duels" | automated |
| T71 | `duel` CLI records a pairwise result and persists it | AC22 | unit | cli.test.mjs -> "duel command records result" | automated |
| T72 | RDAP redirect failure branches (non-https target, hop exhaustion, resolver throw) degrade to unknown | AC7 | unit | availability.test.mjs -> "RDAP redirect failure branches degrade to unknown" | automated |
| T73 | `isPlausiblePublicHost` rejects obfuscated IPv4 literals (dotted-octal/hex, 32-bit integer) | AC7 | unit | availability.test.mjs -> "isPlausiblePublicHost rejects obfuscated IP literals" | automated |
| T74 | `.com` low-signal note surfaces when `.com` reads available | AC15 | unit | availability.test.mjs -> "builds a scorecard" | automated |
| T75 | CLI handlers reject missing required inputs (screen/variants/similar/duel) | AC10 | unit | cli.test.mjs -> "CLI handlers reject missing required inputs" | automated |

All rows (T1-T75) are `automated` and pass under `npm test` (84 tests across 9 files).

## Functionality Inventory (Phase 3 reconciliation)

Built from the actual engine after implementation. Every exported unit is mapped
to a covering test; zero GAP rows remain.

| # | Functionality introduced | Location | Covered by | Status |
|---|--------------------------|----------|------------|--------|
| F1 | `slugify` / `isUsableName` / `isAllowedHost` | net.mjs | T21, T22, T23 | covered |
| F2 | `safeFetch` (https, allowlist, timeout, manual redirect) | net.mjs | T23, T24 | covered |
| F3 | `mapWithConcurrency` (order + cap) | net.mjs | net.test "mapWithConcurrency" | covered |
| F4 | `extractFeatures` + `countSyllables` + `splitWords` | features.mjs | T1-T6, splitWords test | covered |
| F5 | `score` / `normalized` / `update` (clamped, super-like 2x) | model.mjs | T7, T8, T13 | covered |
| F6 | `pickNext` (explore/exploit, skips swiped) + `novelty`/`seenTokenCounts` | model.mjs | T10, T11, T12 | covered |
| F7 | `rank` / `profile` (notable-only) / `suggestVariants` | model.mjs | T9, T13, T14 | covered |
| F8 | `matchFamousMark` (exact/compact/word/near-miss) + `withinEditDistance1` | marks.mjs | T25, T26, T27 | covered |
| F9 | `computeVerdict` / `getStatus` / `availabilityScore` | verdict.mjs | T30-T33, availabilityScore test | covered |
| F10 | `rankByVerdict` (never crowns Deal Breaker) + key-channel override | verdict.mjs | T34, T35 | covered |
| F11 | `mapStatus` / `isPlausiblePublicHost` | availability.mjs | T15, T19, non-public-host test | covered |
| F12 | `checkDomain`/`checkDomains` + RDAP redirect follow + coverage-404 + DNS fallback | availability.mjs | T15, T44 | covered |
| F13 | `checkGithubHandle`/`checkGithubRepo`/`checkGithub` (+token) | availability.mjs | T16, T44 | covered |
| F14 | `checkRegistry`/`checkRegistries` | availability.mjs | T17 | covered |
| F15 | `socialChannels` / `markChannels` / `referenceLinks` | availability.mjs | T18, T28, T29 | covered |
| F16 | `check` / `checkMany` (scorecard build, unusable-name guard) | availability.mjs | T20, T44 | covered |
| F17 | `load`/`save`/`reset`/`statePath`/`defaultState` (atomic, corrupt-safe) | store.mjs | T36, T37 | covered |
| F18 | `addCandidates` (dedup, unique id) / `recordSwipe` (unknown-id throw) | store.mjs | T36, T38 | covered |
| F19 | `setBrief`/`setResult`/`likedCandidates`/`unseenCandidates`/`swipedIds` | store.mjs | T36, T38 | covered |
| F20 | `parseArgs` + all subcommand handlers | naming.mjs | T39-T42, T45 | covered |
| F21 | `renderReport` (winner, no-winner, no-finalists, caution note) + `channelLine` | naming.mjs | T41, T46 | covered |
| F22 | `model.revert` (undo a swipe delta) | model.mjs | model.test "revert undoes an update" | covered |
| F23 | `recordSwipe` idempotency (reverse prior swipe before applying) | store.mjs | store.test "re-swiping is idempotent" | covered |
| F24 | `markChannels` near-miss caution (not a collision) | availability.mjs | availability.test "near-miss is a caution" | covered |
| F25 | `computeVerdict` surfaces caution without forcing Deal Breaker | verdict.mjs | verdict.test "near-miss caution does not force Deal Breaker" | covered |
| F26 | `isPrivateAddress` / `normalizeHost` / `hostResolvesPublic` (SSRF hardening) | availability.mjs | availability.test "isPrivateAddress", "rejects redirect to a non-public host" | covered |
| F27 | `hasNsDelegation` + NS-first `checkDomain` (NS present/absent x google/non-google x rdap) | availability.mjs | T47, T48, T49, T50 | covered |
| F28 | `GOOGLE_REGISTRY_TLDS` / `LOW_SIGNAL_TLDS` / reordered `DEFAULT_TLDS` | availability.mjs | T48, T51 | covered |
| F29 | npm tombstone detection (`checkRegistry` body read) | availability.mjs | T53, T54 | covered |
| F30 | `check()` `notes` (npm tombstone, `.com` parked low-signal) | availability.mjs | availability.test "scorecard notes surface npm tombstone", T66 | covered |
| F31 | `suggestHandleVariants` (decorated forms, excludes bare) | availability.mjs | T65 | covered |
| F32 | `editDistance` / `phoneticKey` | similarity.mjs | T55, T57 | covered |
| F33 | `similarity` (edit / segment-swap / token-reorder / anagram / phonetic levels) | similarity.mjs | T55, T56, T57 | covered |
| F34 | `confusableAgainst` (sorted, reasons, empty corpus) | similarity.mjs | T58 | covered |
| F35 | `pronounceability` (score + hardToSay + reasons) | features.mjs | T59, T60 | covered |
| F36 | `say:easy|hard` token + detail | features.mjs | T61 | covered |
| F37 | `KEY_PRESETS` / `DEFAULT_PRESET` / `resolveKeys` | verdict.mjs | T62, T63 | covered |
| F38 | `computeVerdict` preset default (`.dev`/npm/github, not `.com`) | verdict.mjs | T52, T64 | covered |
| F39 | `duel` (moves only distinguishing tokens) | model.mjs | T69 | covered |
| F40 | `tournament` (ranked order from duels) | model.mjs | T70 | covered |
| F41 | `say:*` profile phrases | model.mjs | model.test profile path | covered |
| F42 | `runScreen` (clear/contested/blocked buckets) | naming.mjs | T66 | covered |
| F43 | `runVariants` (decorated + screened) | naming.mjs | T67 | covered |
| F44 | `runSimilar` (confusability CLI) | naming.mjs | T68 | covered |
| F45 | `runDuel` (decision CLI, unknown-id errors) | naming.mjs | T71 | covered |
| F46 | `availOpts` / `splitCsv` / `statusOf` / `channelLine` (object npm status, `.dev` primary) | naming.mjs | T66, T67, cli "check and report" | covered |

## Gaps & Additions

Reconciliation found these untested units (closed):
- [x] `checkDomains`/`checkGithubRepo`/`checkMany` not directly tested -> added T44, covered.
- [x] `runBrief`/`runSuggest` not directly tested -> added T45, covered.
- [x] `renderReport` no-finalists / all-Deal-Breaker branches -> added T46, covered.

Review-driven hardening (security-review + code-review), all covered:
- [x] SSRF: trailing-dot / IP-literal / DNS-rebinding redirect bypass -> hardened
  `isPlausiblePublicHost` + `isPrivateAddress` + `hostResolvesPublic`, F26.
- [x] Near-miss famous-marks nuking distinct words to Deal Breaker -> downgraded to a
  soft caution, F24/F25.
- [x] Re-swipe double-counting model weights -> idempotent `recordSwipe` via
  `model.revert`, F22/F23.

Field-driven improvements (NS-first domains, `.com` low-signal, npm tombstone,
confusability, pronounceability, channel presets, decorated variants, availability-first
`screen`, and the `duel`/`tournament` decision mode) are covered by T47-T71 / F27-F46;
the npm-tombstone scorecard note and the NS-resolver edge cases were added during
reconciliation, leaving no open GAP rows. Full suite: 84 tests across 9 files, green.
