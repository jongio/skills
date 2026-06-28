---
issue: pending
author: @jongio
status: approved
---

# create-gh-pages-site skill

## Problem

Standing up a GitHub Pages site is deceptively fiddly. The hard parts aren't the
HTML — they're the deployment plumbing that every framework does differently:
which of the (frequently-deprecated) Pages Actions to use, the `pages: write` /
`id-token: write` permission block, the `github-pages` environment, and above
all the **base-path trap**. A project site lives at
`https://<user>.github.io/<repo>/`, so a site built for `/` ships with broken CSS,
images, and links the moment it's a project page. Astro wants `base`, Vite wants
`base` plus a `404.html` SPA fallback, Eleventy wants `pathPrefix`, Jekyll wants
`baseurl` — each with its own gotchas. People burn an afternoon, get a blank page
with 404'd assets, and give up or paste a stale Stack Overflow workflow.

A user with a Copilot agent should be able to say "make me an Astro site on GitHub
Pages" and get a correct, building, deployable repo — base path wired, workflow
current, Pages-enable steps spelled out — without knowing any of the above.

## Goals

- Ship an installable Copilot skill, `create-gh-pages-site`, that scaffolds a
  working GitHub Pages site from a chosen template into the user's repo.
- Cover the real spread of approaches: zero-build static, a modern SSG (Astro),
  a React SPA (Vite), a data-driven SSG (Eleventy), and GitHub-native (Jekyll).
- Every template deploys via the current official GitHub Actions Pages flow
  (`configure-pages@v5` → `upload-pages-artifact@v3` → `deploy-pages@v4`) with
  correct permissions, a single `github-pages` concurrency group, and Source =
  "GitHub Actions" (no `gh-pages` branch to manage).
- Solve the base-path trap automatically: a generator injects the repo name into
  each framework's base/pathPrefix/baseurl and detects `<user>.github.io` user
  sites (base `/`).
- Ship a static **gallery** site that lets a user browse and pick a template, and
  that is itself one of the deployable templates (dogfooding).
- Be self-contained and offline: no network needed to scaffold, tests run on bare
  `node`, matching the repo's `create-canvas-app` conventions.

## Non-Goals

- A separately-hosted, live "pick a template" web app with a backend. The gallery
  is a static page; selection is "copy this template / run the generator."
- Maintaining a large theme marketplace. Five curated, correct templates — plus
  documented pointers to upstream galleries (astro.build/themes, jamstackthemes)
  for richer themes — not hundreds.
- Custom-domain DNS automation (documented, not automated).
- Next.js / Hugo / SvelteKit templates in this scope (the five chosen cover the
  static / SSG / SPA / data / native quadrants; more can follow the same pattern).

## Solution

A new skill folder `skills/create-gh-pages-site/` mirroring the structure of
`create-canvas-app`: a `SKILL.md` authoring contract (the agent's brain), bundled
`templates/`, a generator, tests, a `README.md`, and manifest wiring.

**Templates** (`templates/<name>/`) — each a complete, buildable site with its own
`.github/workflows/deploy.yml`, README, and base-path handling:

| Template | Tier | Base-path mechanism | Build |
|---|---|---|---|
| `static-html` | zero-build static | relative URLs (immune) | none |
| `astro` | modern SSG | `base` in `astro.config.mjs` + `withastro/action` | astro build |
| `react-vite` | React SPA | `base` in `vite.config` + `404.html` + `BASE_URL` | vite build |
| `eleventy` | data-driven SSG | `pathPrefix` via `PATH_PREFIX` env + `url` filter | eleventy |
| `jekyll` | GitHub-native | `baseurl` in `_config.yml` | jekyll-build-pages |

All five use the **GitHub Actions** Pages source so there's one consistent mental
model and no branch juggling. The static, Vite, and Eleventy templates use the
canonical `configure-pages → upload-pages-artifact → deploy-pages` jobs; Astro
uses its official `withastro/action` (which produces the same Pages artifact) +
`deploy-pages`; Jekyll uses GitHub's official `jekyll-build-pages` + `deploy-pages`.

**Generator** (`scripts/new-site.mjs`): `node new-site.mjs <template> --dir <target>
[--repo owner/name] [--site-name "Title"]`. It copies the template, then rewrites
the base path everywhere it appears (config + workflow `env` + any `<base>`/router
basename), derives the project base from the repo name, and detects the
`<user>.github.io` user-site pattern to use base `/`. Placeholders in templates use
a single sentinel (`__BASE_PATH__`, `__SITE_NAME__`, `__REPO_URL__`) so injection
is deterministic and testable. The agent can also hand-edit after stamping.

**Gallery** (`gallery/`): a static site (built on the `static-html` template) that
renders the template catalog from a small `templates.json`, with a short "how to
use this with the skill" for each. It deploys to Pages like any other template, so
"a GitHub Pages site that lets you select a template" exists as a real artifact.

**Tests** (`test/`, bare `node`, no deps): stamp every template to a temp dir and
assert (a) expected files exist, (b) the base sentinel is fully replaced — no
`__BASE_PATH__` left, correct value injected, (c) each `deploy.yml` parses, names
the required Pages actions, declares `pages: write`/`id-token: write`, and has the
`github-pages` concurrency group. A separate check validates the catalog matches
the templates on disk.

New dependencies: none shipped. The skill's own dev `package.json` mirrors
`create-canvas-app` (tests are bare node; eval tooling optional). Templates carry
their own minimal deps (astro, vite/react, @11ty/eleventy) installed by their CI.

## Repo strategy (skill vs. registry)

The skill and the template registry are separable artifacts. The chosen path:
**skill lives in `jongio/skills`** (keeps brand + cross-skill discovery + the
marketplace listing), while the templates are authored as a **registry-shaped,
self-contained subtree** — each template carries a `template.json` manifest, a
`CONTRIBUTING.md` defines the contribution contract, the gallery auto-generates
from the manifests, and the generator accepts an optional `--registry owner/repo`
to fetch templates from a remote registry instead of the bundled copies.

This makes "graduate the templates into a standalone, community-contributable
`jongio/gh-pages-templates` repo that deploys itself to Pages" a lift-and-shift of
the subtree, not a rewrite: the skill already supports a remote registry, and the
manifest/gallery/CI contract is identical in-repo and out-of-repo. Until then the
bundled templates keep the skill fully offline and self-contained.

## Alternatives Considered

- **Split now into a separate live template-gallery repo.** Strong long-term shape,
  but creating/seeding a public repo under the org is a heavier, approval-worthy
  move; bundling first (registry-shaped) captures the architecture without that
  commitment and keeps the skill offline. The generator's `--registry` flag and the
  manifest contract leave the split a one-step migration.
- **Bundle templates with no manifest/registry shape.** Simpler, but forecloses the
  contribution flywheel and forces a rewrite to split later. The manifest contract
  is cheap now and is what the gallery + CI consume anyway.
- **"Deploy from a branch" + `peaceiris/actions-gh-pages`.** Popular and simple,
  but it's a third-party action, leaves a `gh-pages` branch to manage, and diverges
  from GitHub's own recommended flow. The Actions/artifact flow is the current
  first-party path and unifies all five templates.
- **One mega-template with toggles.** Rejected: the value is showing each
  framework's *idiomatic* correct setup; a switchboard hides exactly the
  per-framework base-path detail users get wrong.
- **No generator, just copy + manual edits.** Rejected: the base-path injection is
  the single most error-prone step; automating it (with a sentinel) is the point.

## Risks & Rabbit Holes

- **Action version drift.** Pages actions deprecate aggressively (v3/v4 cutover hit
  Jan 2025). Pin to the current majors and note in SKILL.md that the agent should
  confirm latest before shipping if the user reports a deploy failure.
- **Jekyll needs Ruby/Bundler locally** to fully build; CI uses GitHub's managed
  build. Tests must not hard-require a local Ruby — validate Jekyll structurally
  (config + workflow), build it only if Ruby is present.
- **User vs project site.** `<user>.github.io` repos must use base `/`, not
  `/repo/`. The generator must detect this or the user site ships double-prefixed.
- **SPA deep links.** Vite/React project sites 404 on refresh of a sub-route
  without the `404.html` copy trick; the template must include it and the test must
  assert it.
- **Scope creep into theming.** Keep templates minimal and correct; resist turning
  this into a theme gallery. Point outward for themes.

<!-- Pipeline tracking (auto-managed, not part of product spec) -->
## Pipeline Status
Phase: SHIPPING
