# Contributing

This repo has two kinds of contribution, in two places.

## Templates → the registry

Templates are **not** in this skill. They live in the
**[`jongio/gh-pages-templates`](https://github.com/jongio/gh-pages-templates)**
registry, which also renders the browsable gallery + live previews. To add or fix a
template (a new framework, a base-path fix, an action-version bump), open a PR there
and follow that repo's `CONTRIBUTING.md`. The generator fetches templates from the
registry at runtime, so a merged template is immediately available to the skill — no
change here required.

## The skill (this repo)

This skill owns the **generator** (`scripts/new-site.mjs`) and the **agent workflow**
(`SKILL.md`). Work here when you're changing how sites are stamped, how the base path
is computed, repo detection, or the interview/validation guidance.

### The generator's substitution contract

The generator replaces these sentinels when stamping a template. Templates in the
registry rely on them, so treat the set as a stable contract:

| Sentinel | Replaced with | Use for |
| --- | --- | --- |
| `__BASE_PATH__` | `/repo/` (or `/`) — trailing slash | Vite/Astro `base`, Eleventy `pathPrefix`, the workflow's `PATH_PREFIX` |
| `__BASE_URL__` | `/repo` (or ``) — no trailing slash | Jekyll `baseurl` |
| `__SITE_NAME__` | the human title | page titles, headings |
| `__SITE_URL__` | `https://user.github.io/repo/` | meta, README |
| `__SITE_ORIGIN__` | `https://user.github.io` | Astro `site`, Jekyll `url` |
| `__REPO_SLUG__` | `owner/repo` | links to the repo |
| `__PKG_NAME__` | npm-safe name | `package.json` `name` |

Values derive from `--repo` (the current repo's `origin` remote when omitted), and
the generator detects `USER.github.io` user sites (base collapses to `/`).

## Images & content authoring

After stamping, the skill **digests the target repo and rewrites the demo content**
to match it (`scripts/digest-repo.mjs`), and drops placeholder images plus an
`IMAGES.md` via `scripts/make-placeholder.mjs`. When authoring a generated site:

- Write placeholders into the folder the template serves static files from —
  `public/images/` for build tools (Astro/Vite), `assets/images/` for static/Jekyll,
  `src/assets/images/` for Eleventy.
- Reference images through the same base-path mechanism as other assets (so they
  don't 404 on a project site).
- Reuse real images the digest already found before generating a placeholder.

Template requirements (how a framework should expose those static folders and the
base path) live in the registry's `CONTRIBUTING.md`, not here.

### Run the tests

```sh
npm test   # node test/generator.test.mjs && node test/digest.test.mjs — bare node, fully offline
```

The tests cover base-path math, repo-slug parsing, and stamping a local fixture
template (sentinels replaced, `template.json`/`node_modules` skipped, user-site
collapse), plus the repo-digest classifier and the placeholder generator. They never
hit the network — template/workflow validation lives in the registry. If you change
the substitution contract or the resolver, update the tests.
