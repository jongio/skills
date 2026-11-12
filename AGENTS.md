# Agent Guidelines (`jongio/skills`)

`jongio/skills` is a **public** multi-host skills marketplace, Copilot CLI statusline suite, Canvas Kit runtime, and Astro catalog site. Every change in this repository is published publicly.

## Public Repository Confidentiality & Stealth Rules

- **Never reference private repositories:** Do not include private repository names, internal repository slugs, private URLs, internal project identifiers, or personal workstation paths (`C:\Users\...`, `/Users/...`) anywhere in source files, `SKILL.md` instructions, documentation, tests, eval fixtures (`evals/**/fixtures/**`), commit messages, branch names, or pull requests.
- **Use synthetic placeholders in tests and fixtures:** Always use neutral synthetic identifiers such as `example-org/*` and `sample-team/*` in tests, examples, and evaluation scenarios.
- **Enforce Public Repo Stealth Mode on security fixes:** Never include advisory identifiers, severity scores, taxonomy labels, or reproduction strings in commit messages, branch names, PR descriptions, code comments, or test names. Frame fixes neutrally (for example, `fix(validation): tighten path confinement and input bounds`), keep detailed audit notes in untracked private directories outside Git, and verify public text with:
  ```sh
  node skills/repo-maintain/scripts/repo-maintain.mjs stealth-check --visibility=PUBLIC --private-repos=<csv> --text "<text>"
  ```

## Repository Invariants

- **ASCII punctuation:** Do not introduce Unicode en-dash (`U+2013`) or em-dash (`U+2014`) characters in tracked text, manifests, workflows, or generated templates; use ASCII `-`.
- **Snapshot parity:** Keep `skills/create-skill` and `skills/create-skills-repo/templates/repository/skills/create-skill` byte-identical (excluding `node_modules` and `vally-results`). Keep `compose.mjs` byte-identical across all four `extensions/*-statusline/` packages, and re-sync vendored Canvas Kit consumers via `node skills/create-canvas-app/scripts/sync-kit.mjs` whenever `skills/create-canvas-app/kit/` changes.
- **Locked Vally & Evaluation Guards:** Install Vally from `.github/tools/vally` with `npm ci --prefix .github/tools/vally --ignore-scripts`. Every mandatory behavioral grader in `eval.yaml` must have a resolved name starting with `skill-invocation`, `diff-empty`, or `tool-calls`, and `scoring.weights` must be decisive so failing any mandatory guard drops the weighted trial score below `scoring.threshold`.

## Validation

- Root manifest, workflow, runtime, and parity suite:
  ```sh
  node --test --test-concurrency=1 test/*.test.mjs
  ```
- Skill and eval spec validation:
  ```sh
  .github/tools/vally/node_modules/.bin/vally lint skills/<skill-id>
  .github/tools/vally/node_modules/.bin/vally lint --eval-spec skills/<skill-id>/evals/<skill-id>/eval.yaml --strict
  ```
