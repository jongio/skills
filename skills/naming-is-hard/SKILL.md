---
name: naming-is-hard
description: >-
  Interactive naming assistant: help the user land on a name for a project, product, repo,
  company, package, or feature they love AND can actually use. Use when the user
  says "name my project", "help me name this", "come up with a name", "brainstorm
  names", "what should I call it", "rename this project", "is this name taken",
  "check if a name is available", "check the domain / GitHub org / npm / handle",
  "is there a trademark", or "naming is hard". The skill profiles what the thing is,
  generates on-brief candidate names, then runs a swipe loop (Like / Pass /
  Super-like) where a preference model learns the user's taste and shows more of
  what they like, then scores the finalists against real availability (domains,
  GitHub, package registries, social handles) plus trademark, existing-business, and
  confusable-name screens. Every finalist gets one of three verdicts: Deal Breaker,
  It's Complicated, or Perfect Match. Do NOT use for renaming code identifiers or SEO
  keyword research.
---

# naming-is-hard

An interactive naming assistant for projects, CLIs, products, packages, and
organizations. It guides you from a blank slate to a validated name you can
actually ship.

The core insight: you rarely know what name you want until you see candidates and
react to them. This skill generates diverse on-brief names, learns your
preferences as you rank them, then validates your finalists against real-world
availability (domains, GitHub, npm/PyPI, social handles) and flags trademark or
confusable-name collisions before you commit.

## When to use it

Reach for this whenever a name needs to be chosen and checked: a new project,
product, startup, open-source library, npm/PyPI package, GitHub org or repo, app,
or feature. It is equally good at "brainstorm names for X" and "is "Foo" already
taken everywhere?".

Do not use it to rename variables or functions in code (that is ordinary editing),
or for SEO keyword research.

## On invocation

When the user invokes this skill (e.g. `/naming-is-hard`), **start the naming
flow immediately**. Do not ask "What can I help you with?" or wait passively.

- If the user provided context alongside the invocation (e.g. "name my CLI tool
  that does X"), proceed directly to Act 1 (the Profile) using that context.
- If the user invoked the skill bare with no context, look at the current working
  directory for a README, package.json, or other project files. If you find a
  project, ask one focused question: "I see you're working on [project]. Would you
  like to name this, or something else?" Then proceed to Act 1.
- If there's no project context at all, ask a single question to get started:
  "What are we naming? Tell me what it is and I'll kick off the process."

The skill exists to DO naming, not to explain itself. Get moving.

## How it works: five acts

1. **The Profile.** Read the user's context (a description, a repo path, or a URL)
   and write a Naming Brief: what the thing is and will be, who it is for, the
   tone, and any constraints. This anchors all candidate generation.
2. **The Deck.** Generate a diverse, on-brief pool of candidate names across many
   naming strategies. Each candidate is tagged so the model can learn from it.
3. **The Swipe.** Show one card at a time. The user swipes Like / Pass / Super-like.
   A preference model learns their taste and biases the next cards toward it, with
   enough exploration that it does not tunnel. It can state "your type" in words.
4. **The Match.** For the names the user liked, run a deep availability scan and a
   trademark/existing-business screen, roll each up into a verdict tier, and present
   the ranked matches with a compatibility scorecard and a winner.
5. **Next actions.** Hand the user the links to grab the GitHub org, register the
   domain, and claim the handles.

## Division of labor

You (the agent) do the creative work. The engine does the deterministic,
security-sensitive, and stateful work. Stay on your side of this line.

| You (this SKILL.md) | The engine (`scripts/naming.mjs`) |
|---|---|
| Write the Naming Brief from the context | Extract feature vectors from names |
| Generate creative candidate names + a one-line pitch each | Learn taste from swipes (score / rank / pick next) |
| Present swipe cards via `ask_user` | Explain the learned "type" in plain language |
| Decide when to refill the deck and generate more | Check availability (SSRF-safe, mocked in tests) |
| Run a live `web_search` per finalist for trademarks/businesses | Screen against the famous-marks list, compute verdict tiers |
| Narrate the matches and next actions | Persist all state across swipe turns |

**Never** hand-roll availability checks with raw `curl`, and never invent a swipe
score yourself. Call the engine. It is tested and safe.

## The engine CLI

The engine lives in `scripts/naming.mjs`. It needs no install and no network for
anything except `check`. Every command takes `--dir <state-dir>`, a working folder
where the run's state is persisted (use the session workspace, for example
`~/.copilot/session-state/<id>/files/naming-<slug>`). Node 18+.

| Command | What it does |
|---|---|
| `init --dir D [--brief-json '{...}']` | Create (or open) state; optionally set the brief |
| `brief --dir D --json '{...}'` | Set/replace the Naming Brief |
| `add --dir D --json '[{"name":..,"strategy":..,"tags":[..]}]'` | Add candidates (features extracted, ids assigned). Also reads the JSON array from stdin. |
| `next --dir D [--count N]` | Return the next card(s) to show, best first |
| `swipe --dir D --id ID --label like\|pass\|superlike\|skip` | Record a swipe and update the model |
| `rank --dir D [--limit N]` | Candidates ranked by learned fit |
| `profile --dir D` | The learned "type" in plain language |
| `suggest --dir D --name NAME [--count N]` | Morphological variants of a liked name |
| `check --dir D [--names a,b] [--github-token T]` | Availability scorecards (defaults to liked names) |
| `screen --dir D --names a,b,c [--preset P]` | Availability-FIRST: bucket names into clear / contested / blocked by key channels |
| `variants --name NAME` | Decorated handle/org variants (get<X>/<X>hq/<X>dev), screened for GitHub/npm/.dev |
| `similar --name NAME --against a,b,c` | Confusability report against a corpus you supply (from your live search) |
| `duel --dir D --winner ID --loser ID` | Decision mode: record a head-to-head result so the winner's traits outrank the loser's |
| `report --dir D [--names a,b] [--preset P] [--as-json]` | Ranked matches with verdict tiers (human text by default) |
| `state --dir D` | Dump the full state as JSON |
| `reset --dir D` | Clear the state |

All commands print JSON (so you can parse the result) except `report`, which prints
a human-readable card by default and JSON with `--as-json`.

## Act 1: the Profile (Naming Brief)

Never brainstorm from nothing. First understand the thing being named.

**Sources**, in order of richness:
- A **repo or directory path**: read the `README`, `package.json`/manifests, and a
  couple of entry files to infer what it does.
- A **URL** (a PRD, a landing page, a GitHub repo): fetch it with `web_fetch` and
  synthesise.
- **Free text**: use it directly.

Then fill the brief. Keep it tight:

```json
{
  "name": "working title or null",
  "what": "one sentence: what it is and does",
  "willBe": "where it is heading (the ambition)",
  "audience": "who it is for",
  "tone": ["playful", "trustworthy", "technical", ...],
  "keywords": ["concepts", "metaphors", "differentiators"],
  "constraints": [".com-able", "one word", "pronounceable", "<= 8 letters", ...]
}
```

If the context is thin, ask **at most two or three** quick `ask_user` questions to
fill the biggest gaps (usually audience and tone). Do not interrogate. Store it
with `init --brief-json` or `brief --json`.

**Ask what channel matters most** (one quick question): the npm/CLI/package name, the
domain, the GitHub org, or a social handle? Their answer picks the verdict `--preset`
passed to `report`/`screen`: `cli-first` (default: npm > `.dev` > org), `domain-first`,
`social-first`, or `balanced`. In practice the npm/CLI name and the `.dev` domain
matter far more than the always-parked `.com`, and a taken GitHub org can be decorated.
Note that social handles are always reported `unknown` (they cannot be checked honestly),
so a `social-first` finalist stays "It's Complicated" until the user verifies the handle
by hand.

**Sunk-cost check.** If there is an incumbent or current name, do not over-favor it.
Put it through the same swipe and availability bar as every fresh candidate.

## Act 2: the Deck (generate candidates)

Generate about **20 to 30** candidates for the first deck, spanning many strategies
so the swipe deck has real range. See `references/naming-strategies.md` for the full
playbook (descriptive, compound, portmanteau, metaphor, coined, classical roots,
foreign words, playful, abstract, and more). Aim for variety across length, sound,
and style, not twenty variations of one idea.

For each candidate, attach:
- `strategy`: how you coined it (for example `portmanteau`, `metaphor`, `coined`).
- `tags`: a few semantic tags from the brief (for example `speed`, `nature`,
  `trust`). These let the model learn "this founder likes nature metaphors".

Add them:

```bash
node scripts/naming.mjs add --dir D --json '[
  {"name":"Brightloom","strategy":"compound","tags":["light","craft"]},
  {"name":"Flowly","strategy":"suffix","tags":["ease"]},
  {"name":"Verdant","strategy":"real-word","tags":["nature","growth"]}
]'
```

Quality bar: on-brief, pronounceable, and genuinely varied. Skip anything that is a
near-duplicate of another candidate or an obvious throwaway.

**Generation modes** (offer these when the user wants range or a direction):
- **By language / etymology**: Greek, Latin, French, or Spanish roots for a core
  concept (the user often asks for this).
- **In the style of a corpus**: "name it like a YC startup" or "like cloud-native
  projects (radius, terraform)". Study the naming pattern, then generate within it.
- **More like a liked name**: `suggest --name <liked>` for morphological variants, then
  regenerate creatively in that direction.

**Availability-FIRST (recommended for a name you will commit to).** Before swiping, run
`screen --names <batch>` and add only the **`clear`** names to the deck. This is the
pattern that actually works: it stops the user falling in love with a name that turns
out to be taken. Generate a large batch, screen it, swipe only the survivors.

## Act 3: the Swipe (the loop)

This is the heart of the skill. Show one card at a time and let the model learn.

1. Get the next card: `node scripts/naming.mjs next --dir D`. It returns the best
   unseen candidate for this user based on what they have liked so far.
2. Present it as a **card** with `ask_user`. Put the name, its vibe, and a one-line
   pitch in the question text; use these exact swipe choices:

   > **Brightloom**  (compound, warm, 2 syllables)
   > "A warm, growing-light name for a calm productivity app."
   > How it fits: light plus a loom that weaves your tasks together.
   >
   > Choices: `["❤️ Like", "👎 Pass", "⭐ Super-like", "ℹ️ Details / check it now", "✅ Done, show my matches"]`

3. Record the swipe and update the model:
   - "❤️ Like" -> `swipe --id <id> --label like`
   - "👎 Pass" -> `swipe --id <id> --label pass`
   - "⭐ Super-like" -> `swipe --id <id> --label superlike`
   - "ℹ️ Details" -> do NOT swipe yet. Say more about the name, optionally run
     `check --names <name>` for a quick availability peek, then re-ask the same card.
   - "✅ Done" -> leave the loop and go to Act 4.
4. Repeat. Every few swipes, you can share "your type" from
   `node scripts/naming.mjs profile --dir D` ("You are leaning toward short, coined,
   techy names."). It makes the learning visible and is fun.
5. **Refill the deck** when `next` reports few remaining or the model has a clear
   type. Generate a fresh batch biased toward the learned preference: read
   `profile`, optionally seed with `suggest --name <a liked name>`, generate new
   on-brief candidates in that direction (plus a few wildcards so the user keeps
   discovering), and `add` them.
6. **Rapid-fire option**: if the user wants to go faster, offer to show a numbered
   batch of five cards in one message and let them reply with the ones they like.
   Record each as a swipe. The default remains one card at a time (true swiping).

**When to stop.** Stop when the user picks "Done", or when the top of `rank`
stabilises and the user has several likes. You do not need to exhaust the deck.

**Conversational mode (meet the user where they are).** Many people do not want a rigid
deck; they throw out names as they think of them ("what about brightloom?", "riverstack
might work", "or lumen?"). When that happens, react instantly: `add` the name, `check`
it, run `similar` against known names in the space, mention pronounceability, then
`suggest`/generate "more like that". Record their yes/no as a swipe so the model still
learns. The swipe deck and the conversation are the same engine; use whichever fits.

**Decision mode (when the user is stuck).** If the user cannot converge ("I don't like
any of these, help me decide"), stop swiping and run a **duel** tournament: present two
finalists head to head, ask which wins, and `duel --winner <id> --loser <id>`. A few
duels move the model decisively and produce a ranked order without endless swiping.

## Act 4: the Match (availability + verdict)

Now turn likes into a decision.

1. **Deep availability** on the finalists (the liked and super-liked names):
   `node scripts/naming.mjs check --dir D`. To raise the GitHub rate limit, pass
   `--github-token` or set `GITHUB_TOKEN` in the environment (optional; never
   required, never logged).
2. **Confusability + trademark + business (mandatory, not optional).** The engine
   screens against a bundled famous-marks list (that catches "you cannot call it
   Spotify"), but in practice the real collisions are live products and similarly-named
   startups in your own space, which no bundled list can know. So for **every finalist**
   you MUST run a live `web_search`, for example `"<name>" (trademark OR company OR
   startup OR product)`, and feed what you find into `similar --name <finalist> --against
   <comma-separated names you found>`. A high-confusability hit (a near-duplicate spelling
   or a reordering of the same parts) or a real product in a related field is a caution
   the user must see; a famous-mark hit is a Deal Breaker.
3. **Decorated variants for taken key channels.** If the bare GitHub org or a handle is
   taken, run `variants --name <finalist>` to screen `get<X>`/`<X>hq`/`<X>dev` forms.
   Offer the free variant instead of discarding the name.
4. **Render the matches**: `node scripts/naming.mjs report --dir D [--preset P]`. Each
   finalist rolls up to one of three verdicts:

   | Verdict | Meaning |
   |---|---|
   | 🚫 **Deal Breaker** | A famous trademark or company owns it. Walk away. |
   | 💛 **It's Complicated** | No legal blocker, but a key channel (npm, `.dev`, or the GitHub org) is taken. Usable only with a compromise (a decorated org, a tweaked handle). |
   | 💚 **Perfect Match** | No famous-mark collision and every key channel (per the chosen preset) is free. Grab it. |

   The report crowns a winner and lists the field. A Deal Breaker is never the
   winner. `.com` is shown but flagged low-signal (it is parked for nearly every
   name); npm and `.dev` are the signals that matter. Present it conversationally.

## Act 5: next actions

Once the user picks a winner, give them a concrete **reservation checklist** to lock it
down (do not do these for them; the skill only checks and links out):

1. **npm / package name** (usually the top priority): reserve it, or `npm publish` a
   placeholder. A tombstoned name flagged by the scorecard is blocked; pick another.
2. **`.dev` domain** (the launch TLD): register it at a registrar. `.com` is optional
   (it is parked for nearly every name).
3. **GitHub org / repo**: `https://github.com/organizations/new`. If the bare org is
   taken, use the decorated variant from `variants` (e.g. `<name>hq`).
4. **Social handles**: the verify URLs are in the scorecard (`channels.social`).
5. **Formal trademark clearance**: the screen is not legal advice. Point the user (or
   their lawyer) at the `channels.trademark.links` and note the relevant class (for
   software, US classes 9 and 42) before they invest in the brand.

If the name is replacing an existing one, offer to do the rename as a separate step.
Offer to reopen the deck if nothing felt like The One.

## Availability channels and honesty

| Channel | How it is checked | Reliability |
|---|---|---|
| Domains | **DNS NS-delegation** is the primary signal (NS records present = registered, even when parked; absent = free); RDAP confirms the free case for non-Google TLDs. `.dev`/`.app` decide on NS alone (RDAP false-positives on parked `.dev`). | High. Catches parked domains that RDAP misses. |
| GitHub | `api.github.com/users/<name>` (org and user share a namespace). `404` = free. | High. Rate-limited without a token. |
| Registries | npm, PyPI, crates.io, RubyGems, NuGet public JSON. `404` = free. npm `taken` is inspected for a reclaimed tombstone (blocked from reuse). | High. |
| Social | Best-effort **link-out only**. The scorecard gives a verify URL, status `unknown`. | Low by design. Never claim a handle is free. |
| Trademark / business | Famous-marks screen (confident collision) + `similar` confusability + search link-outs + your mandatory `web_search`. | A screening signal, not legal clearance. |

The rules that keep this honest:
- Social platforms block bots and return soft-404s, so the engine does **not**
  scrape them. It surfaces the handle URL for the user to click. Do not override this.
- A clean trademark screen means "no obvious collision", never "clear to use". Always
  point the user (or their lawyer) at the official search links.
- The engine never buys a domain, creates an org, or claims a handle. It checks and
  links out.

## Safety

- The engine sanitises every candidate name to a strict `[a-z0-9-]` slug before it
  touches any URL or query, contacts only an allowlisted set of hosts, applies
  timeouts, and refuses redirects to non-public hosts. Do not bypass it with ad-hoc
  network calls.
- No credentials are required. An optional GitHub token only raises a rate limit and
  is read from the environment, never logged.
- Any GitHub write on the user's behalf (creating the org or repo they chose) is a
  separate action that requires explicit user approval. This skill only checks and
  recommends.

## State and resuming

Everything lives in the `--dir` state file, so a run survives across turns and
sessions. To resume, point the same `--dir` at the existing state and continue with
`next`. `state --dir D` dumps everything; `reset --dir D` starts over.

## The workflow you follow

1. Intake the context; read the repo or fetch the URL if given one.
2. Write the Naming Brief; `init --brief-json` (or `brief`).
3. Generate ~20 to 30 diverse, on-brief candidates; `add` them.
4. Swipe loop: `next` -> `ask_user` card -> `swipe`; refill the deck as needed;
   share `profile` occasionally.
5. On Done: `check` the finalists; run a `web_search` per finalist for trademarks
   and businesses.
6. `report` the ranked matches with verdict tiers; present the winner and scorecards.
7. Offer next actions (grab org/domain/handles) and an option to keep swiping.

## Exit criteria

- A Naming Brief was written and stored.
- The user swiped through candidates and the model learned a preference (`profile`
  has signal).
- The finalists were checked for availability and screened for trademark/business
  collisions.
- A ranked report with verdict tiers was presented, with a winner that is not a Deal
  Breaker, and the user was given the links to lock the name down.
