---
issue: https://github.com/jongio/skills/issues/40
author: @jongio
status: shipped
---

# naming-is-hard skill

> "There are only two hard things in computer science: cache invalidation and
> naming things." This skill owns the second one.

## Problem

Naming a project is a genuinely hard, high-stakes decision that people make badly
under pressure. The good name has to clear four bars at once, and they fight each
other:

1. **It has to fit the thing.** The name should evoke what the product is, who
   it's for, and the vibe. This is a creative act, and a blank page is paralysing.
2. **It has to be available where it counts.** A perfect name is worthless if the
   `.com` is parked, the GitHub org is taken, the npm package exists, and every
   social handle is squatted. Checking that by hand means opening fifteen tabs per
   candidate across domains, GitHub, package registries, and a dozen social
   networks. Nobody does it thoroughly, so people fall in love with a dead name.
3. **It has to be a name the founder actually likes.** Taste is real but hard to
   articulate up front. People don't know they love short invented words ending in
   "-ly" until they've rejected twenty long compound ones. Asking "what kind of
   name do you want?" gets a shrug; showing names and watching reactions gets the
   truth.
4. **It has to survive comparison.** The best name rarely arrives first. You need
   to see a spread, react fast, and let a shortlist emerge.

The existing tools each solve one slice: domain registrars check domains (and
upsell), name generators spray random words with no availability signal and no
memory of your taste, and namechk-style sites check handles for a name you already
picked. None of them *learn what you like* while *filtering for what's actually
available* and *starting from what your product actually is*.

A user with a Copilot agent should be able to point at their project (a
description, a repo, or a URL) and, in one guided session, converge on a name they
love that is actually free to use, having done almost none of the tab-opening
themselves.

## The insight: naming is a matchmaking problem

Picking a name has the same shape as dating. You don't write a spec for your soul
mate; you react to candidates and your preferences reveal themselves. So this skill
is **a dating app for names**:

- Your project gets a **profile** (what it is, who it's for, the vibe).
- Candidate names show up as **cards**, one at a time, each with a little pitch.
- You **swipe**: right to like, left to pass, super-like for a strong yes.
- The app **learns your type** from every swipe and shows you more of what you like
  (with enough variety that you don't get stuck in a rut).
- Your **matches** are the names you liked that are also actually available, ranked
  by fit and availability, with a compatibility scorecard for each.

## Goals

- Ship an installable Copilot skill, `naming-is-hard`, that takes a project context
  (free text, a repo/dir path, or a URL) and guides the user to a chosen name.
- **Profile the thing being named.** Read the context and synthesise a Naming Brief:
  what the product is and will be, who it's for, the tone, key concepts, and naming
  constraints. Ask a few interview questions only when the context is thin.
- **Generate a diverse, on-brief candidate pool** across many naming strategies
  (descriptive, compound, portmanteau, metaphor, coined, classical roots, playful,
  and more), so the swipe deck has real range instead of one gimmick.
- **Learn the user's taste from swipes.** An explainable online preference model
  scores every candidate from its features (style, tone, length, syllables,
  morphology, sound) and biases the next cards toward what the user likes, while
  reserving some cards for exploration so it converges without tunnelling. The model
  can state the learned "type" in plain language.
- **Check real availability across the channels that matter**: domains via **DNS
  NS-delegation first** (the authoritative registration signal that also catches
  *parked* domains), confirmed by RDAP for non-Google TLDs, over a launch-first TLD
  set (`.dev`, `.io`, `.ai`, `.app`, `.co`, with `.com` last and labeled low-signal
  because it is parked for nearly every candidate); GitHub org/user and repo; package
  registries (npm, PyPI, crates.io, RubyGems, NuGet), with a reclaimed-name npm
  *tombstone* labeled so the user knows it is blocked from reuse; and social handles
  (X, Instagram, TikTok, YouTube, GitHub, Reddit, Bluesky, Threads) on a best-effort
  basis with an honest reliability label and a one-click verification link. When a bare
  org/handle is taken, propose and screen decorated variants (`get<X>`, `<X>hq`,
  `<X>dev`, `<X>labs`, `use<X>`) instead of just marking it red.
- **Screen for confusability** against a corpus the agent supplies from a mandatory
  per-finalist live web search: edit-distance, segment/token reorder, and phonetic
  near-matches flag a name that sits one step from an existing project. A caution,
  never an automatic Deal Breaker.
- **Score how easy a name is to say.** A deterministic pronounceability signal flags
  vowel-starved, cluster-heavy, or digit-laden names and feeds the preference model, so
  "easy to say" becomes something the user can weight.
- **Screen for names you legally cannot use.** Catch famous trademarks and
  well-known companies with a bundled, curated marks list (deterministic, zero
  network) so an obvious collision is flagged instantly, and add best-effort
  **trademark search** (USPTO / EUIPO / WIPO) and **existing-business search**
  (company registries) with pre-filled link-outs plus a live web search per
  finalist. Framed clearly as a screening signal, not legal advice.
- **Roll every finalist up to one of three verdict tiers** so "can I actually use
  this?" is answered at a glance:
  - **Deal Breaker** (hard stop): a famous trademark or well-known company owns it;
    do not proceed.
  - **It's Complicated** (middle ground): no legal blocker, but key channels are
    contested; usable only with a compromise.
  - **Perfect Match** (easy win): trademark-clear and the channels that matter are
    free; grab it.
- **Rank and present matches** with a color-coded compatibility scorecard per
  finalist, the verdict tier badge, and a combined fit-plus-availability score, then
  offer next actions (grab the GitHub org, register the domain, claim the handles).
  A Deal Breaker is never crowned the winner.
- Be a well-formed skill in this repo: `SKILL.md` brain, tested bare-`node` engine,
  `README.md`, references, a Vally eval, and manifest wiring. No secrets, no keys
  required (an optional GitHub token just raises the rate limit).

## Non-Goals

- **Legal trademark clearance or filing.** The skill *searches* for trademark and
  business collisions (bundled famous-marks screen, best-effort public lookups,
  pre-filled link-outs, and a live web search per finalist) and rolls the result into
  the verdict, but it is a screening signal, not legal advice. It does not perform a
  full clearance, does not read into international classes, and never files anything.
  A Perfect Match still warrants a lawyer before you bet the company on it.
- **Registering anything.** It checks and links out; it never buys a domain, creates
  an org, or claims a handle on the user's behalf.
- **A hosted web app with a real Tinder UI.** The "swipe" is delivered through the
  agent's `ask_user` cards in the terminal, not a separate front end. The metaphor is
  the UX, not a React app.
- **Guaranteed-accurate social handle checks.** Social platforms are hostile to
  automated checks (bot walls, soft 404s, JS-only pages). The skill gives a
  best-effort signal clearly labelled as such plus a link to verify, and never
  presents a social result with false confidence.
- **Heavyweight ML.** The preference model is a transparent linear feature model, not
  an embedding pipeline. Explainability and zero dependencies beat marginal accuracy.

## Solution

A new skill folder `skills/naming-is-hard/` mirroring the repo's `repo-ready` /
`create-gh-pages-site` shape: a `SKILL.md` authoring contract (the agent's brain), a
tested `scripts/` engine, `test/`, `references/`, `evals/`, `README.md`, and manifest
wiring in `marketplace.json` / `plugin.json` / root `README.md`.

### Division of labor (why some of this is code and some is the agent)

Name *generation* and *copywriting* are creative acts the LLM does best. Feature
extraction, preference learning, availability probing, and state are deterministic,
security-sensitive, and must be testable, so they live in code. The split:

- **Agent (LLM), driven by `SKILL.md`:** builds the Naming Brief, generates creative
  candidate names tagged by strategy, writes each card's one-line pitch, runs the
  `ask_user` swipe loop, and narrates matches. When the model asks for "more like the
  ones they liked," the agent generates targeted new candidates.
- **Engine (Node, `scripts/`, tested):** extracts a feature vector from each name,
  runs the online preference model (score / update / rank / pick-next with
  explore-exploit / explain), performs SSRF-safe availability checks, and persists all
  state to a JSON file so the model is authoritative across swipe turns.

### Engine modules

| Module | Responsibility |
|---|---|
| `scripts/net.mjs` | One SSRF-safe `fetch` helper: strict slug sanitization, fixed host allowlist, timeout, capped/validated redirects, User-Agent. Every network probe goes through it. |
| `scripts/features.mjs` | Deterministic feature extraction from a name string: length bucket, syllable estimate, morphology (prefix/suffix families like `-ly`/`-ify`/`-io`/`-ai`/`-hub`), sound (alliteration, hard consonants, sibilance), real-word vs coined heuristic, style/tone hints, and a `pronounceability` score + `hardToSay` flag surfaced as a `say:*` model feature. |
| `scripts/model.mjs` | Explainable online preference model. Per-feature-value weights updated on each swipe (like `+1`, super-like `+2`, pass `-1`), candidate score = squashed sum of its feature weights, `rank`, `next` (epsilon-greedy with cold-start feature-coverage exploration), `profile` (plain-language "your type"), `suggest` (morphological variants of liked names), and a decision mode: `duel` (pairwise A-beats-B, moving only the distinguishing features) feeding a `tournament` ranking for when the user stalls. |
| `scripts/availability.mjs` | Per-channel checks returning a structured scorecard: domains **NS-delegation first** via injectable `resolveNs`/`resolveHost` DNS helpers (NS present = taken, incl. parked; NS absent = available for Google Registry TLDs, else RDAP-confirmed through SSRF-safe per-hop redirect gates), GitHub (`api.github.com/users` + `/repos`), registries (npm, PyPI, crates.io, RubyGems, NuGet) with npm reclaimed-*tombstone* detection, social (always `unknown` + a verify URL; deliberately not scraped), and trademark/business (famous-marks screen + best-effort lookups + pre-filled link-outs). Also `suggestHandleVariants` for decorated forms and scorecard `notes` (tombstone, `.com` parked). Bounded concurrency, per-check timeout, graceful `unknown` on failure. |
| `scripts/similarity.mjs` | Pure confusability engine: `editDistance`, `phoneticKey`, `similarity(a,b)` (edit-distance, segment-swap, token-reorder, anagram, and phonetic levels), and `confusableAgainst(name, corpus)` that flags near-duplicates in an agent-supplied corpus with reasons. Deterministic, no I/O; a caution signal, never an automatic Deal Breaker. |
| `scripts/marks.mjs` + `scripts/famous-marks.json` | Curated list of well-known global brands and companies plus a normalizing matcher (exact, slug, and near-miss). Deterministic, zero-network source of the **Deal Breaker** signal for trademark/business collisions. |
| `scripts/verdict.mjs` | Pure roll-up of a scorecard into one of three tiers (**Deal Breaker** / **It's Complicated** / **Perfect Match**) with the tier label, emoji, one-line reason, named key-channel presets (`KEY_PRESETS` + `resolveKeys`, default `cli-first`: npm > primary domain (`.dev`) > GitHub org), and the rules that a famous-marks collision always forces Deal Breaker and a Deal Breaker is never the winner. No I/O; fully unit-tested. |
| `scripts/store.mjs` | JSON state persistence (brief, candidates + features, swipes, model weights, availability results) in a working dir under the session or repo, with atomic writes. |
| `scripts/naming.mjs` | CLI entry point wiring subcommands: `init`, `brief`, `add`, `next`, `swipe`, `rank`, `screen` (availability-first bucketing), `variants` (decorated-form screen), `similar` (confusability), `duel` (decision tournament), `check`, `report`, `profile`, `state`, `reset`. |

### The session flow the agent runs

1. **Intake** the context (text / path / URL). Read the repo or fetch the URL when
   given one. Write the Naming Brief; store it (`naming init` + `naming brief`). Ask
   what matters most (CLI/package name vs launch domain vs org vs social) and pass the
   matching key-channel preset to the verdict.
2. **Deal the deck, availability-first.** Generate ~24 diverse on-brief candidates with
   strategy tags; `naming add` extracts features and stores them. `naming screen`
   buckets the batch into available / contested / taken by the chosen preset so the deck
   leads with names that are actually free, not dead ends.
3. **Swipe loop (or conversation).** `naming next` returns the best unseen card; the
   agent presents it via `ask_user` (Like / Pass / Super-like / Details / Done);
   `naming swipe` records it and updates the model. The same engine backs a
   conversational mode: when the user throws out a name, instantly `add` + `check` +
   `similar` it, record the reaction as a swipe, and offer "more like this" without
   forcing the deck. When the deck runs low the agent generates more targeted candidates
   (optionally seeded by `naming suggest`); periodically it reveals "your type" from
   `naming profile`.
4. **Matchmaking.** On Done, `naming rank` produces the shortlist; `naming check` runs
   deep availability on the finalists (NS-first domains, registries, decorated
   `variants` for any taken org/handle) and the agent runs a **mandatory** live
   `web_search` per finalist for existing products, startups, and live sites, feeding
   the hits into `naming similar` (confusability) and the verdict; `naming report` rolls
   each into a verdict tier and renders the compatibility scorecard, the ranked winner
   (never a Deal Breaker), and runners-up.
5. **Decision mode when stuck.** If the user cannot converge, stop swiping and run a
   `naming duel` tournament over the finalists (pairwise "which wins?") to force a
   ranked decision instead of endless open swiping.
6. **Next actions + reservation handoff.** Output a concrete checklist to lock the name
   in: reserve the npm/package name, register the launch `.dev` domain, create the
   GitHub org (or a decorated variant), claim handles, and run a formal USPTO/WIPO
   trademark search in the right class. Link out for each; never register on the user's
   behalf. Offer to re-open the deck.

### Availability channels and honesty

Domains use **DNS NS-delegation as the primary registration signal**: a registered
domain (parked or live) has NS records in the parent zone; an unregistered one has none.
This is the authority that catches *parked* domains, which the older RDAP-only check
missed (`.dev` in particular reported parked domains as available). Google Registry TLDs
(`.dev`/`.app`/`.page`) decide on NS alone; for other TLDs an NS-absent result is
confirmed via **RDAP** (`https://rdap.org/domain/<name>.<tld>`, `404` = unregistered)
before ever reporting `available`, so a just-registered-not-yet-delegated domain is never
a false positive. `.com` is still checked but labeled low-signal because it is parked for
nearly every candidate. GitHub, npm, PyPI, crates.io, RubyGems, and NuGet expose clean
public JSON endpoints where `404` means the name is free; an npm `200` with zero versions
and an unpublished marker is a reclaimed **tombstone**, still taken and labeled as blocked
from reuse. Social platforms have no honest endpoint, so those checks are explicitly
**best-effort**: every social handle is reported as `unknown` with a reliability note and a
direct URL the user clicks to confirm. The skill deliberately does not scrape social sites
and never claims a social handle is free with false confidence.

**Trademark and existing-business screening** works in three honest layers:

1. **Bundled famous-marks screen (deterministic, zero-network).** `marks.mjs` matches
   the candidate against a curated `famous-marks.json` of well-known global brands and
   companies (exact, dehyphenated, and whole-word forms). A confident hit forces the
   **Deal Breaker** tier immediately, no network required. This is the layer that
   reliably catches "you can't call it Spotify." A one-character *near-miss* is treated
   as a soft caution (surfaced as a note), never a Deal Breaker, so legitimately distinct
   words that sit one edit from a brand ("Strive" vs "Stripe") are not nuked.
2. **Best-effort public lookups.** Where a free public endpoint exists, `check` probes
   it (through the same SSRF-safe fetch), degrading to `unknown` on any failure rather
   than guessing.
3. **Link-outs + live web search.** The report always includes pre-filled searches for
   USPTO Trademark Search, EUIPO eSearch, WIPO Global Brand Database, and OpenCorporates,
   and the agent runs a `web_search` per finalist to surface registered marks or active
   businesses that are not in the bundled list. Findings feed the verdict.

The framing is consistent everywhere: this is a *screening signal*, not legal advice.

### The three verdict tiers

`verdict.mjs` rolls a finalist's scorecard into exactly one tier (dating-app framing so
"can I use this?" reads at a glance):

| Tier | Meaning | Trigger |
|---|---|---|
| **Deal Breaker** | Hard stop: walk away. | Famous-marks hit, or a confident trademark/registered-business collision in a related field. |
| **It's Complicated** | Chemistry with baggage: usable only with a compromise. | No legal blocker, but a key channel (primary domain, GitHub org, or primary registry) is taken, or a minor unrelated business shares the name. |
| **Perfect Match** | Swipe right: grab it. | No famous-mark collision and every key channel is free. |

Key channels come from a named preset (`KEY_PRESETS` + `resolveKeys`), defaulting to
`cli-first`: the npm/package name, then the launch domain (`.dev`), then the GitHub org
(which a decorated variant can satisfy). `.com` and social handles are not key channels
by default. Presets are overridable so a consumer brand can weight social or `.com` more.
Non-key conflicts never by themselves push a name below Perfect Match; they surface as
notes. A Deal Breaker is always demoted below every other tier in `rank`/`report` and can
never be the crowned winner.

### Security

Every candidate name is sanitized to a strict slug (`[a-z0-9-]`, length-capped) before
it is interpolated into any URL, DNS query, or registry path, which closes SSRF and
path-injection. All probes target a fixed host allowlist, carry a timeout, and do not
follow redirects to off-allowlist hosts. No credentials are required or stored; an
optional `GITHUB_TOKEN` / `gh auth token` only raises the GitHub rate limit and is read
from the environment, never logged.

## Acceptance Criteria

- **AC1. Brief:** Given a context (text, repo path, or URL), the skill produces and
  stores a Naming Brief capturing what the app is/will be, audience, tone, and
  constraints; thin contexts trigger a short interview rather than a guess.
- **AC2. Diverse candidates:** The engine accepts a candidate pool and stores each
  name with an extracted feature vector; the pool spans multiple naming strategies.
- **AC3. Feature extraction is deterministic:** `features.mjs` returns the same stable
  feature vector for a given name (length bucket, syllables, morphology, sound, style
  hints), verified by tests.
- **AC4. Learning:** After swipes, `model.mjs` scores unseen candidates so that names
  sharing features with liked names outrank names sharing features with passed names;
  super-likes weigh more than likes; `profile` states the learned type in words.
- **AC5. Explore/exploit:** `next` never returns an already-swiped candidate, prefers
  high-scoring candidates, and still surfaces variety during cold start (no immediate
  tunnelling), verified by tests.
- **AC6. Availability scorecard:** `check` returns, per finalist, a structured result
  across domains (RDAP), GitHub, registries, and social, mapping HTTP outcomes to
  `available` / `taken` / `unknown` correctly, with social flagged best-effort. Network
  is mocked in tests; a real smoke check is documented.
- **AC7. SSRF-safe:** Names are sanitized before use in any request; only allowlisted
  hosts are contacted; malformed/hostile names cannot escape the slug or reach an
  off-allowlist host, verified by tests.
- **AC8. Report:** `report` ranks finalists by a combined fit-plus-availability score,
  renders a readable compatibility scorecard with each name's verdict tier badge, and
  crowns a winner and runners-up; a Deal Breaker is never crowned the winner.
- **AC9. State:** All of brief, candidates, swipes, model weights, and results persist
  across CLI invocations via `store.mjs`, verified by tests.
- **AC10. Skill hygiene:** `SKILL.md` frontmatter has `name` + a trigger-rich
  `description` broad enough to fire on "is X taken", "rename this", "what should I call
  it", and brainstorming asks; `vally lint` passes; the skill is wired into
  `marketplace.json`, `plugin.json`, and the root `README.md`; a Vally eval spec exists
  and lints.
- **AC11. Famous-marks screen:** `marks.mjs` matches candidates against the bundled
  famous-marks list (exact, dehyphenated, whole-word, and near-miss) with zero network.
  An exact/dehyphenated/whole-word hit is surfaced as a confident trademark/business
  collision (Deal Breaker); a one-character near-miss is surfaced as a soft caution that
  never forces Deal Breaker, verified by tests.
- **AC12. Trademark & business screening:** `check` produces trademark and business
  channel entries (famous-marks screen plus pre-filled USPTO / EUIPO / WIPO /
  OpenCorporates link-outs), degrading to `unknown` on network failure and never
  presenting a false-confident "clear", verified with mocked network.
- **AC13. Verdict tiers:** `verdict.mjs` maps a scorecard to exactly one of Deal
  Breaker / It's Complicated / Perfect Match by the documented rules (famous-marks
  forces Deal Breaker; all key channels free plus trademark-clear yields Perfect Match;
  otherwise It's Complicated), with tier label/emoji/reason, verified by tests.
- **AC14. NS-first domains:** `checkDomain` returns `taken` when NS records exist
  (parked included) and `available` only when NS is absent and, for non-Google TLDs,
  RDAP confirms free; Google Registry TLDs (`.dev`/`.app`/`.page`) decide on NS alone
  without calling RDAP; NS resolver errors are treated as absent, not a crash. Injected
  resolvers; verified including the parked-`.dev` case.
- **AC15. TLD order + `.com` label:** `DEFAULT_TLDS` leads with `.dev`; `.com` is
  present but flagged low-signal in the scorecard/report, verified by tests.
- **AC16. npm tombstone:** a `200` with zero versions and an unpublished marker maps to
  `taken` with a `tombstone` note; a truly-free name is `available`; a live package with
  versions is plain `taken`; verified with mocked responses.
- **AC17. Confusability:** `similarity` detects edit-distance 1/2, segment/token reorder
  (a name and its end-for-end reversal), and phonetic near-matches; `confusableAgainst`
  flags collisions in an agent-supplied corpus with reasons; clearly distinct names do
  not false-positive; verified by tests.
- **AC18. Pronounceability:** `pronounceability` scores vowel-starved / cluster-heavy /
  digit-laden names as `hardToSay` and normal names as easy, deterministically, and a
  `say:*` token appears in the extracted features, verified by tests.
- **AC19. Channel presets:** `verdict` supports named key-channel presets; the default
  `cli-first` ranks npm > launch domain (`.dev`) > GitHub org; changing the preset
  changes the verdict inputs, verified by tests.
- **AC20. Decorated variants:** `suggestHandleVariants` returns decorated forms
  (`get<X>`, `<X>hq`, `<X>dev`, `<X>labs`, `use<X>`) excluding the bare name, and the
  `variants` CLI screens their availability, verified by tests.
- **AC21. Availability-first screen:** the `screen` command buckets a batch into
  available / contested / taken by the key-channel preset for deck pre-filtering,
  verified with mocked network.
- **AC22. Decision duel:** `duel` records a pairwise winner and moves the model so the
  winner's features outrank the loser's, and a `tournament` produces a ranked order from
  duels, verified by tests.

## Alternatives Considered

- **Pure agent, no engine (let the LLM "remember" preferences in context).** Rejected:
  the learning would be non-deterministic, untestable, and would drift or forget across
  a long swipe session, and the security-sensitive availability checks would be ad-hoc
  `curl`s with no SSRF guard. A tested engine makes the learning and the network
  boundary real and reproducible.
- **Heavy ML recommender (embeddings, matrix factorization).** Rejected on
  proportionality: a single user in a single short session gives far too little signal
  to justify it, and it would be opaque. A transparent per-feature-weight model learns
  fast from a handful of swipes and can *explain itself*, which is core to the UX.
- **Batch selection ("here are 10, pick the ones you like") instead of one-at-a-time
  swipes.** Faster, but it loses the dating metaphor the user asked for and the crisp
  per-card signal that makes learning clean. The skill offers an optional rapid-fire
  mode but defaults to one card at a time.
- **RDAP-only, or DNS A-record resolution, as the domain signal.** Both rejected as the
  primary check. RDAP-only reported *parked* domains (especially `.dev`) as available and
  answered slowly; A-record resolution misses parked domains that delegate NS but publish
  no A record. **DNS NS-delegation** is the authoritative registration signal (present =
  registered, parked included), with RDAP kept as confirmation for non-Google TLDs where
  it is fast and correct.
- **Scrape social platforms for authoritative handle availability.** Rejected as
  dishonest: bot walls and soft-404s make scraped results unreliable, and shipping a
  check that lies is worse than no check. Best-effort-plus-verify-link is the truthful
  design.
- **Bundle a giant static word list / dictionary for generation.** Rejected: the LLM is
  a better, more on-brief generator than a word list, and bundling a dictionary bloats
  the skill. The engine's deterministic help is limited to morphological *variants* of
  names the user already liked.

## Risks & Rabbit Holes

- **Social-handle accuracy.** The single biggest honesty risk. Mitigation: label these
  checks best-effort, map ambiguous responses to `unknown` (never a confident false),
  and always provide the verify URL. Prefer under-claiming.
- **GitHub rate limits.** Unauthenticated `api.github.com` allows 60 requests/hour.
  Mitigation: only deep-check the shortlist (not every swiped card), read an optional
  token from the environment to raise the limit, and degrade to `unknown` with a note
  rather than failing when throttled.
- **RDAP coverage gaps and parked-domain false positives.** RDAP via `rdap.org` is slow
  or missing for some TLDs and, worse, reports parked `.dev` domains as available.
  Mitigation: NS-delegation is the primary signal (present = taken, parked included);
  Google Registry TLDs decide on NS alone, and for other TLDs an NS-absent result is
  RDAP-confirmed before reporting `available`, so a false `available` is never emitted.
- **NS-absent is not a 100% guarantee.** A just-registered, not-yet-delegated domain has
  no NS briefly. Mitigation: non-Google TLDs still confirm NS-absent via RDAP; for Google
  TLDs the negligible undelegated window is accepted (the old RDAP-only path was worse).
- **Filter-bubble collapse.** A naive greedy model tunnels onto the first liked feature
  and shows near-duplicates. Mitigation: epsilon exploration plus feature-coverage
  tracking during cold start, and a diversity guard in `next`.
- **Swipe fatigue / round-trip cost.** One `ask_user` per card is many turns.
  Mitigation: keep decks tight, converge quickly once signal is strong, offer a
  rapid-fire batch option, and always allow Done to jump straight to matches.
- **Network flakiness in tests.** Availability tests must never hit the real network.
  Mitigation: `availability.mjs` takes an injectable fetch; tests pass a mock; a
  separate documented smoke script exercises the real endpoints on demand.
- **Famous-marks list is never complete.** A bundled list catches the obvious giants
  but not every registered mark or regional company. Mitigation: treat the list as the
  fast-path for confident Deal Breakers, layer the agent's live `web_search` per
  finalist on top, and label a clean screen as "no obvious collision," never "clear to
  use." The list is data (`famous-marks.json`) so it is easy to extend.
- **Over-flagging from near-miss matching.** Fuzzy matching to catch "Gooogle" can also
  nuke legitimately distinct names ("Strive" is one edit from "Stripe"). Mitigation: a
  near-miss never forces Deal Breaker. Only exact, dehyphenated, and whole-word hits are
  confident collisions; a near-miss is a soft caution surfaced as a note ("worth a manual
  check") that leaves the verdict driven by the real channels, so the user judges it.
- **Trademark false confidence.** Presenting a screen as legal clearance would be
  harmful. Mitigation: consistent "screening signal, not legal advice" framing, `unknown`
  on any lookup failure, and always surfacing the official link-outs for the user (or
  their lawyer) to confirm.
- **Confusability over-flagging.** Token-reorder and phonetic matching can be noisy.
  Mitigation: conservative thresholds, always attach the reason, and treat confusability
  as a caution (never an automatic Deal Breaker) unless it collides with a famous mark.
- **DNS reliability in tests.** All NS/host resolution is injectable; unit tests never hit
  real DNS. A documented `smoke.mjs` exercises the live resolvers on demand.

## Gate Evidence

### GATE EVIDENCE: phase: 1

- **Scope**: P1 (full new skill with 8-module engine, 84 tests, eval spec, and security boundary)
- **Acceptance criteria**: 22 defined (AC1 through AC22), covering brief, candidates, features, learning, explore/exploit, availability, SSRF, report, state, hygiene, famous-marks, trademark, verdict tiers, NS-first domains, TLD order, npm tombstone, confusability, pronounceability, channel presets, decorated variants, availability-first screen, and decision duel
- **Test plan**: `docs/specs/naming-is-hard/test-plan.md`, Status COVERED, 75 planned tests (T1 through T75) mapping to all 22 ACs
- **Interview**: Retroactive pipeline. Spec is exhaustive: 22 ACs, 6 alternatives considered, 9 risks with mitigations. No open questions remain.
- **Architecture design**: Retroactive pipeline. Agent/engine separation documented in spec Solution Design. SSRF-safe network layer (`net.mjs`), injectable dependencies for testability, atomic state persistence. Proportional: no framework, no build step, zero runtime deps.
- **Open questions**: 0
- **Date**: 2026-07-22

### GATE EVIDENCE: phase: 2

- **Type-check**: N/A (pure JavaScript ESM, no TypeScript in this skill)
- **Lint**: N/A (no linter configured; matches repo convention for skills)
- **Test plan automated**: 75 planned tests (T1 through T75) all status `automated`
- **Tests**: 84 passing across 9 test files (`npm test`), zero failures
- **Date**: 2026-07-22

### GATE EVIDENCE: phase: 3

- **Test suite**: 84 passed, 0 failed (9 test files)
- **Test plan reconciled**: 46 functionality units (F1 through F46), zero GAP rows, Status COVERED
- **devx-code-review**: Invoked via MQ. 2 LOW findings found and fixed:
  - CR-001: Added `isValidShape()` guard in `store.mjs` to validate loaded state shape at boundary
  - CR-002: Replaced overly broad `endsWith('naming.mjs')` direct-invocation check with URL pathname comparison
- **devx-refactoring**: Invoked via MQ. 1 LOW finding found and fixed:
  - RF-001: Extracted shared test mock factories (`res`, `mockFetch`, `publicResolver`, `nsAbsent`, `nsMock`, `tmp`) to `test/helpers.mjs`
- **devx-dependencies**: Invoked via MQ. 0 findings. Zero runtime deps, one devDependency (`@microsoft/vally-cli`)
- **devx-idiomatic-audit**: Invoked via MQ. 1 LOW finding found and fixed:
  - IDIO-001: Added `"engines": {"node": ">=18"}` to `package.json`
- **devx-test-health**: Invoked via MQ. 0 findings. All 84 tests deterministic, no flaky/skip/pending
- **devx-secops**: Invoked via MQ. 0 CRITICAL/HIGH. SSRF-safe design verified (slug sanitization to `[a-z0-9-]`, host allowlist, DNS rebinding protection with both syntactic and resolution checks, redirect hop guard)
- **devx-smells**: Invoked via MQ. 0 findings
- **CRITICAL/HIGH remaining**: 0
- **Bloat check**: Clean. No orphan files, no speculative infrastructure, no single-impl abstractions
- **Feature surface completeness**: All 8 engine modules wired through CLI, all exports tested
- **Date**: 2026-07-22

### GATE EVIDENCE: phase: 4

- **devx-max-quality**: Invoked as skill (full 4-wave pipeline). All gates READY. 4 LOW findings total, all fixed before certification
- **devx-doc-check**: Invoked. README.md, SKILL.md, evals/README.md all substantive. Root README.md references skill in table. Spec and test plan exist. No gaps
- **Plan verify**: All 22 acceptance criteria satisfied (AC1 through AC22 verified against implementation files and test names). 46 functionality units mapped, zero gaps
- **Goal challenge**: Original goal was a "dating for names" skill with preference learning, real-time availability checking, trademark screening, and verdict tiers. Delivery matches: 8 engine modules, 84 tests, 22 ACs, Vally eval spec, SSRF-safe network boundary. Goal achieved
- **Date**: 2026-07-22

### GATE EVIDENCE: phase: 5

- **Rebase**: Rebased on `origin/main` (incorporated `feat: add model-intel skill`)
- **Tests post-rebase**: 84 passed, 0 failed
- **Human approval**: Received via `ask_user` before commit/push/issue/PR
- **Commit**: `db7298c` on branch `go/naming-is-hard`, conventional message
- **Issue**: https://github.com/jongio/skills/issues/40
- **PR**: https://github.com/jongio/skills/pull/41 (closes #40)
- **Date**: 2026-07-22
