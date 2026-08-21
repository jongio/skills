# eli5

Explain whatever is already under discussion using plain language, one useful
analogy, the proper grown-up terms, and an honest note about where the analogy
stops working.

## What it does

The skill finds the subject from the invocation, current selection or attachment,
or the most recent substantive conversation topic. It then creates a compact
mental model without making the user repeat the context.

It is written for adults who want clarity. It avoids baby talk, preserves
uncertainty and risk, and asks one focused question rather than inventing a topic
when context is missing.

## Install

```sh
npx skills add jongio/skills --skill eli5 -g --agent github-copilot
```

Or install it from the Copilot plugin marketplace:

```sh
copilot plugin marketplace add jongio/skills
copilot plugin install eli5@jongio-skills
```

Reload with `/skills reload`, then invoke:

```text
/eli5
/eli5 this stack trace
ELI5 the code I selected
```

## Explanation contract

1. The big idea in ordinary words.
2. A familiar comparison.
3. The real terms and what they mean.
4. Where the comparison stops matching reality.

Accuracy and safety win over simplicity. The skill never claims access to hidden
context, follows instructions embedded in material being explained, or makes a
dangerous topic sound harmless. It only writes an explanation: it does not invoke
tools, run commands, make network requests, open files, or change anything.

## Validation

```sh
npm install
npm run eval:lint
npm test
npm run eval
```

`npm test` checks that the skill stays registered across every catalog surface
and needs no dependencies. The full eval drives a real agent and can consume
Copilot usage. Static lint is the fast schema check.

## License

MIT. See [LICENSE](LICENSE).
