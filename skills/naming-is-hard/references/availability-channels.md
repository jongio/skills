# Availability channels

How the engine decides whether a name is free on each channel, and how honest each
signal is. All checks go through the SSRF-safe fetch in `scripts/net.mjs`
(allowlisted host, timeout, no off-allowlist redirects) after the name is sanitised
to a strict `[a-z0-9-]` slug.

## Domains (DNS NS-delegation, primary; RDAP confirms)

The primary signal is **DNS NS-delegation**. A registered domain (parked OR live) has
NS records in the parent zone; an unregistered one has none. This is more reliable than
RDAP, which false-positives on parked domains, and than A-record resolution, which
misses parked domains that have NS but no A record. Verified in the field: a parked
`.dev` is registered (NS present) but RDAP reported it slow/available; a coined `.dev`
has no NS and is genuinely free.

The check:

- **NS records present** -> **taken** (registered, parked or live). Authoritative, fast.
- **NS absent, Google Registry TLD** (`.dev`/`.app`/`.page`) -> **available**. Their
  RDAP is slow and false-positives on parked domains, so NS is authoritative and RDAP
  is skipped entirely.
- **NS absent, other TLD** -> confirm with RDAP (`https://rdap.org/domain/<slug>.<tld>`,
  following its redirect to the authoritative registry **safely** via the SSRF guard):
  registry `404` -> available, `2xx` -> taken. If rdap.org has no coverage for the TLD
  (a direct `404`), the NS-absent signal stands (**available**). A timeout stays
  **unknown** (we do not guess).

Default TLDs, most useful first: `.dev`, `.io`, `.ai`, `.app`, `.co`, `.com`. `.dev`
leads because it is the common launch TLD; `.com` is last and flagged **low-signal**
because it is parked for essentially every candidate. NS/RDAP resolvers are injectable
(`opts.resolveNs`, `opts.resolveHost`) so unit tests never hit the real network.

## GitHub

`https://api.github.com/users/<slug>` covers both orgs and users (they share one
namespace). `404` = free, `2xx` = taken. Optionally `api.github.com/repos/<owner>/<slug>`
checks a specific repo. Unauthenticated calls are limited to 60/hour; pass a
`--github-token` (or set `GITHUB_TOKEN`) to get 5000/hour. A `403`/`429` (throttled)
maps to `unknown`, never a false answer.

## Package registries

Each exposes a clean public endpoint where `404` = free:

| Registry | Endpoint |
|---|---|
| npm | `https://registry.npmjs.org/<slug>` (a `taken` is inspected for a reclaimed tombstone: 200 with zero versions / an `unpublished` marker means blocked from reuse) |
| PyPI | `https://pypi.org/pypi/<slug>/json` |
| crates.io | `https://crates.io/api/v1/crates/<slug>` |
| RubyGems | `https://rubygems.org/api/v1/gems/<slug>.json` |
| NuGet | `https://api.nuget.org/v3-flatcontainer/<slug>/index.json` |

## Confusability (existing-name similarity)

Availability answers "is this exact name taken?"; `scripts/similarity.mjs` answers "is
it too close to something that already exists?" (a name one edit from an existing
project, or two names that are reorderings of the same parts). The engine cannot know
every existing name, so the agent supplies a corpus
(from its live search + the famous-marks list) and the engine scores each candidate via
edit distance, segment/token reorder (an anagram or half-swap), and a light phonetic
key. Confusability is a **caution**, never an automatic Deal Breaker (that is reserved
for famous-mark collisions). Use the `similar` CLI command.

## Social handles (best-effort, link-out only)

Social platforms block automated checks and return soft-404s, so scraping them
produces unreliable, sometimes dishonest results. The engine therefore does **not**
fetch them. Each platform entry is `status: unknown, bestEffort: true` with a verify
URL the user clicks: X, Instagram, TikTok, YouTube, Reddit, Bluesky, Threads. (Your
GitHub handle is checked reliably via the GitHub channel above.)

## Trademark and existing-business screening

Three honest layers, framed as a screening signal and never as legal advice:

1. **Famous-marks screen** (`scripts/marks.mjs` + `famous-marks.json`): a curated
   list of well-known global brands and companies, matched exact, dehyphenated,
   whole-word, and one-character-off. An exact / dehyphenated / whole-word hit is a
   confident collision and forces the **Deal Breaker** verdict with zero network (this is
   what reliably catches "you cannot name it Spotify"). A one-character near-miss is a
   soft **caution**, never a Deal Breaker: many distinct real words sit one edit from a
   brand ("Strive" vs "Stripe"), so it only surfaces a note for manual review.
2. **Link-outs**: every scorecard includes pre-filled searches for USPTO Trademark
   Search, EUIPO TMview, WIPO Global Brand Database, and OpenCorporates.
3. **Live web search** (done by the agent, not the engine): a `web_search` per
   finalist surfaces registered marks and active businesses that are not in the
   bundled list.

A clean screen means "no obvious collision", never "clear to use". The bundled list
is data; extend `famous-marks.json` freely.

## The verdict roll-up

`scripts/verdict.mjs` turns a scorecard into one of three tiers:

- 🚫 **Deal Breaker**: a confident famous-marks hit (exact / dehyphenated / whole-word)
  or a confirmed trademark/business collision. A near-miss alone does not qualify.
- 💛 **It's Complicated**: no legal blocker, but a key channel (primary domain,
  GitHub org, or primary registry) is taken or unconfirmable.
- 💚 **Perfect Match**: trademark-clear and every key channel is free.

Key channels default to the `cli-first` preset (npm, the `.dev` launch domain, then the
GitHub org), matching the priority most founders actually hold; `.com` is deliberately
NOT a key channel because it is parked for nearly every name. Presets (`cli-first`,
`domain-first`, `social-first`, `balanced`) and explicit key lists are configurable so a
consumer brand can weight social handles more heavily. A Deal Breaker is always sorted
last and can never be the crowned winner.
