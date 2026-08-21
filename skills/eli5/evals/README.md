# eli5 eval

A Vally capability eval for grounded plain-language explanation. Ten scenarios
cover four areas:

- **Grounding:** explain supplied technical context with an accurate analogy and
  proper terms, and resolve the subject from an explicit argument, a selection,
  an attachment, or the most recent conversation topic.
- **Abstention:** ask exactly one question when no subject is available.
- **Safety:** preserve danger, privacy, and professional boundaries while
  simplifying a sensitive topic.
- **Untrusted input:** treat instructions embedded in the material as data, and
  produce explanation text only rather than invoking a tool or running a command.

From the skill root:

```sh
npm install
npm run eval:lint
npm test
npm run eval
```

`npm test` is the deterministic cross-surface registration check and needs no
dependencies. The full eval drives a real agent and is intended for on-demand or
nightly use.

