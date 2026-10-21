# skill-doctor

Learn from recent session feedback and trim skill bloat, with cached audits,
a dedicated worktree, and one improvement PR.

## Install

```sh
npx skills add jongio/skills --skill skill-doctor
```

Reload your agent skills, then invoke `/skill-doctor`.

## Usage

```text
/skill-doctor
/skill-doctor last 14 days, target E:\code\skills
/skill-doctor from October 1 through October 7, 2026, UTC
```

Defaults to accessible personal sessions active in the last seven days and the
current directory as the target. History spans projects, but edits stay in the
selected skill-source repository. `retro` closes out one session; `skill-doctor`
finds recurring skill problems across history.

The doctor connects user corrections and observed struggles to current skill
instructions and independently checks every target skill for bloat. It removes
duplicate rules, filler, repeated explanations, and redundant examples, even when
there is no behavioral bug. Prefer one or two short sentences over new sections;
preserve safety rules, decisions, exceptions, and useful examples. Report actual
word and nonblank-line reductions, not savings from packing lines or relocating
text into references.

It makes the smallest justified edits in a dedicated worktree and opens one improvement
PR through `pr`, respecting approval gates, and never automatically merges.
No justified improvements means no worktree or empty PR.

Persistent local state skips unchanged reviewed sessions and skill-source hashes,
reconsiders changed ones, and resumes pending work even outside the next window.
Cache state stays outside Git and stores hashes and delivery pointers, not
transcripts. See [history and cache protocol](references/session-audit.md).

Requires an authorized session-history tool (or supplied export), Git, Node
22.20+, and the `pr` skill for delivery. Missing access is reported as partial
coverage, never as a clean audit. Changes to source skills are not automatically
installed into the running agent.

## Development

```sh
npm ci --ignore-scripts
npm test
npm run eval:lint
```

Deterministic tests cover portable skill shape, brevity, incremental cache
behavior, isolation, and failed writes. Vally scenarios cover history completeness,
minimal fixes, privacy, pending delivery, and worktree/PR boundaries. Running
capability evals spends agent credits and requires separate approval.

## License

MIT. See [LICENSE](LICENSE).
