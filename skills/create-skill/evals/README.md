# create-skill evals

The capability eval checks repository discovery, dry-run approval, custom provider openness, and
strict image handling. Static lint is safe and deterministic:

```sh
npm run eval:lint
```

The full eval invokes an agent and may consume usage:

```sh
npm run eval
```
