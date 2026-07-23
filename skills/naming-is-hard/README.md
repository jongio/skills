# naming-is-hard

An interactive naming assistant for projects, CLIs, and products. It profiles what
you're building, generates diverse candidate names, learns your preferences through
a swipe-card interface, and validates your finalists against real-world availability
(domains, GitHub, npm/PyPI/crates/RubyGems/NuGet, social handles) plus a trademark
and existing-business screen.

## What it does

1. **Profiles the thing.** Reads your context (a description, a repo path, or a URL)
   and writes a Naming Brief: what it is, who it is for, the tone, the constraints.
2. **Generates a deck.** Produces a diverse, on-brief pool of candidate names across
   many naming strategies.
3. **Learns your taste.** You swipe one card at a time (Like / Pass / Super-like). A
   transparent preference model learns your type and shows more of what you like,
   with enough variety that it never tunnels. It can tell you your type in words.
4. **Checks real availability.** For your finalists it scans domains (DNS
   NS-delegation, confirmed by RDAP), GitHub, npm / PyPI / crates.io / RubyGems /
   NuGet, and social handles, then screens for trademark and existing-business
   collisions.
5. **Gives a verdict.** Every finalist rolls up to one of three tiers:
   - 🚫 **Deal Breaker**: a famous trademark or company owns it. Walk away.
   - 💛 **It's Complicated**: no legal blocker, but a key channel is taken. Compromise.
   - 💚 **Perfect Match**: trademark-clear and the channels that matter are free. Grab it.

## Install

### As a Copilot skill (recommended)

```sh
# Install just this skill (global, for GitHub Copilot):
npx skills add jongio/skills --skill naming-is-hard -g --agent github-copilot

# Into the current project instead (drop -g):
npx skills add jongio/skills --skill naming-is-hard
```

Reload with `/skills reload` or start a new session, then invoke it as
`/naming-is-hard`.

### From the Copilot marketplace

```sh
copilot plugin marketplace add jongio/skills
copilot plugin install naming-is-hard@jongio-skills
```

## Use it

Just ask:

- "Help me name my new task runner."
- "Come up with names for a calm, privacy-first note app, then check what's free."
- "Is `Brightloom` taken? Domains, GitHub, npm, socials, trademark."
- "Naming is hard. Let's do the swipe thing."

The skill drives the conversation from there: brief, swipe cards, then your matches.

## How it is built

The creative work (writing the brief, generating names, presenting cards) is the
agent's job. The deterministic, security-sensitive, and stateful work lives in a
tested Node engine (`scripts/`), which the agent calls between turns.

| Module | Responsibility |
|---|---|
| `scripts/net.mjs` | SSRF-safe fetch: slug sanitisation, host allowlist, timeout, guarded redirects |
| `scripts/features.mjs` | Deterministic feature extraction from a name |
| `scripts/model.mjs` | The preference model: score, learn, rank, pick next, explain, suggest |
| `scripts/marks.mjs` + `famous-marks.json` | Famous-brand screen (the Deal Breaker source) |
| `scripts/similarity.mjs` | Confusability: edit-distance / reorder / phonetic vs a supplied corpus |
| `scripts/availability.mjs` | Channel checks (DNS-NS domains, GitHub, registries, social, trademark) |
| `scripts/verdict.mjs` | The three-tier roll-up |
| `scripts/store.mjs` | State persistence across swipe turns |
| `scripts/naming.mjs` | The CLI that wires it together |

The full authoring contract the agent follows is in [`SKILL.md`](SKILL.md); the
naming playbook and channel details are under [`references/`](references/).

## Engine CLI (for the curious)

```bash
# Setup and brief
node scripts/naming.mjs init   --dir ./run
node scripts/naming.mjs init   --dir ./run --brief-json '{"what":"a task runner"}'
node scripts/naming.mjs brief  --dir ./run --json '{"what":"a task runner","audience":"devs"}'

# Candidate management
node scripts/naming.mjs add    --dir ./run --json '[{"name":"Brightloom","strategy":"compound"}]'
node scripts/naming.mjs next   --dir ./run                # best unseen card
node scripts/naming.mjs next   --dir ./run --count 5      # batch of 5

# Swipe and learn
node scripts/naming.mjs swipe  --dir ./run --id brightloom --label like   # like|pass|superlike|skip|dislike
node scripts/naming.mjs rank   --dir ./run                # ranked list by score
node scripts/naming.mjs rank   --dir ./run --limit 5      # top 5
node scripts/naming.mjs profile --dir ./run               # explain learned type
node scripts/naming.mjs suggest --dir ./run --name Brightloom   # morphological variants

# Availability and verdict
node scripts/naming.mjs check  --dir ./run --names Brightloom
node scripts/naming.mjs screen --dir ./run --names Brightloom,Flowly --preset cli-first
node scripts/naming.mjs variants --dir ./run --name Brightloom  # decorated handle variants
node scripts/naming.mjs report --dir ./run --names Brightloom   # full verdict report
node scripts/naming.mjs report --dir ./run --names Brightloom --preset domain-first --as-json

# Decision and confusability
node scripts/naming.mjs similar --dir ./run --name Brightloom --against Bloomlight,Brightroom
node scripts/naming.mjs duel   --dir ./run --winner brightloom --loser flowly

# State management
node scripts/naming.mjs state  --dir ./run                # dump current state
node scripts/naming.mjs reset  --dir ./run                # clear state
```

`check`, `screen`, and `variants` are the commands that use the network. A real-network sanity check:

```bash
node scripts/smoke.mjs Brightloom Flowly     # optional: GITHUB_TOKEN for higher limits
```

## Privacy and honesty

- No credentials required. An optional `GITHUB_TOKEN` only raises a rate limit and
  is never logged.
- The engine never registers a domain, creates an org, or claims a handle. It checks
  and links out.
- Social handle checks are best-effort link-outs, never scraped, never claimed as
  free with false confidence.
- The trademark screen is a signal, not legal advice. A Perfect Match still warrants
  a lawyer before you bet the company on it.

## Tests

```sh
npm test
```

Bare-`node` unit tests, no framework, no network (availability is tested with an
injected fetch).

## License

MIT. See [LICENSE](LICENSE).
