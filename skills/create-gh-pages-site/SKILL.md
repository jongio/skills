---
name: create-gh-pages-site
description: >-
  Scaffold a working GitHub Pages website from a vetted template and wire it to
  deploy automatically. Use when the user wants to create, scaffold, or publish a
  site on GitHub Pages — a static page, an Astro or Eleventy site, a React (Vite)
  SPA, or a Jekyll site. Picks the right template for the use case, injects the
  correct base path for the target repo (the #1 thing people get wrong), adds the
  current official GitHub Actions Pages deploy workflow, sets it up in the user's
  current repo or a new one, and explains how to turn Pages on. Do NOT use for
  non-Pages hosting (Vercel/Netlify/Azure), for deploying an existing app without
  a Pages target, or for plain web pages unrelated to GitHub Pages.
---

# Create GitHub Pages Site

Turn "put this on GitHub Pages" into a correct, building, auto-deploying repo. The
hard part of GitHub Pages isn't the HTML — it's the deploy plumbing and the
**base-path trap**. This skill owns both: it stamps a vetted template, sets the
base path for the exact repo, ships the current official Pages workflow, and walks
the user through enabling Pages.

## When to use which template

Pick by what the user is building. If unsure, ask one question (content vs. app)
and default to `static-html` for the simplest ask.

| Template | Reach for it when… | Tier | Build |
| --- | --- | --- | --- |
| `static-html` | A landing page, a few hand-made pages, "just put this HTML up". No toolchain. | static | none |
| `astro` | A content site, blog, docs, or marketing page that should be fast and mostly static. | SSG | `astro build` |
| `react-vite` | An interactive single-page app / dashboard with client-side routing. | SPA | `vite build` |
| `eleventy` | A data/Markdown-driven site (blog, docs) where content is files + structured data. | data SSG | `eleventy` |
| `jekyll` | The user wants the GitHub-native path, or is migrating an existing Jekyll site. | native | Jekyll |

These five cover the static / SSG / SPA / data / native quadrants. For richer
*themes*, point the user at upstream galleries (astro.build/themes,
jamstackthemes.dev, github.com/topics/github-pages-template) and adapt — don't try
to hand-build a theme from scratch.

## The base-path trap (the thing to get right)

A GitHub **project** site is served from a subpath:
`https://<user>.github.io/<repo>/`. A site built assuming root (`/`) ships with
broken CSS, images, and links the moment it's a project site — assets 404 and the
page looks blank. A **user/org** site (`<user>.github.io` repo) *is* served from
`/`, so it must NOT carry a subpath prefix.

Each framework fixes this differently. The generator handles all of it from the
repo name; you rarely set it by hand:

| Template | Mechanism | Project value | User-site value |
| --- | --- | --- | --- |
| `static-html` | relative URLs (`./assets/...`) | — (immune) | — (immune) |
| `astro` | `base` in `astro.config.mjs` | `/repo/` | `/` |
| `react-vite` | `base` in `vite.config.js` + `basename` + `404.html` | `/repo/` | `/` |
| `eleventy` | `pathPrefix` via `PATH_PREFIX` env + `url` filter | `/repo/` | `/` |
| `jekyll` | `baseurl` in `_config.yml` + `relative_url` | `/repo` (no slash) | `""` (empty) |

**The generator detects the `<user>.github.io` user-site pattern and uses `/`
automatically.** If the user hasn't named the repo yet, scaffold with the repo
they intend; if they truly don't know, use `--base /` and tell them to re-run (or
edit the base) once the repo exists.

## Deployment model — one consistent flow

Every template deploys via the **GitHub Actions** Pages source (not "deploy from a
branch"), using the current first-party actions:

```
actions/configure-pages@v5  →  build  →  actions/upload-pages-artifact@v3  →  actions/deploy-pages@v4
```

- `static-html`, `react-vite`, `eleventy` use that chain directly.
- `astro` uses the official `withastro/action@v2` (it builds + produces the Pages
  artifact) then `actions/deploy-pages@v4`.
- `jekyll` uses GitHub's official `actions/jekyll-build-pages@v1` then `deploy-pages`.

Every workflow declares `permissions: { contents: read, pages: write,
id-token: write }`, a single `concurrency: { group: pages }`, and the
`github-pages` environment. There is **no `gh-pages` branch** to manage.

> These action majors deprecate aggressively (the v3/v4 artifact cutover landed
> Jan 2025). If a user reports a deploy failure mentioning a deprecated action,
> check the latest majors and bump the `uses:` pins.

## The workflow you follow

1. **Gather context.** What kind of site (content / app / docs / landing)? Target
   repo: the **current repo** or a **new repo**? Repo name (drives the base path)?
   A human title for the site?
2. **Pick the template** from the table above.
3. **Stamp it** with the generator (next section). This injects the base path,
   site URL, and title, and lays down the deploy workflow.
4. **Place it in the repo:**
   - *Current repo*: stamp into the repo root (or a subfolder if it's a
     subdirectory site, adjusting the workflow's upload path). If a `deploy.yml`
     already exists, reconcile — don't blindly overwrite.
   - *New repo*: create it (e.g. `gh repo create <name> --public`), stamp into it,
     and push. Match the repo name you used for the base path.
5. **Enable Pages.** Tell the user (or do it with their approval):
   **Settings → Pages → Source → GitHub Actions**. By CLI:
   `gh api -X POST repos/<owner>/<repo>/pages -f build_type=workflow` (or PUT to
   update). After the first push to `main`, the workflow runs and the live URL
   appears in the Actions run summary and under Settings → Pages.
6. **Verify it actually works** (see "Validate" below) — don't claim success on a
   green workflow alone.

## Stamp a site — the generator

```
node scripts/new-site.mjs <template> --repo <owner/name> [options]
```

| Option | Purpose |
| --- | --- |
| `--repo <owner/name>` | Target repo. Derives the base path + URLs (and detects user sites). |
| `--base </path/>` | Override the base path (e.g. `/` for a user site or local preview). |
| `--dir <path>` | Output directory (default: `./<repo-name>`). |
| `--site-name "Title"` | Human title (default: derived from the repo name). |
| `--registry <owner/repo>` | Fetch the template from a remote registry repo (needs git + network). |
| `--force` | Write into a non-empty directory. |
| `--list` | List available templates. |

Examples:

```sh
# An Astro content site for a project repo:
node scripts/new-site.mjs astro --repo octocat/blog --site-name "Octocat's Blog"

# A React SPA dashboard:
node scripts/new-site.mjs react-vite --repo octocat/dashboard

# A user site (served from "/") or a quick local scaffold:
node scripts/new-site.mjs static-html --base / --dir ./site
```

The generator replaces a small set of sentinels (`__BASE_PATH__`, `__BASE_URL__`,
`__SITE_NAME__`, `__SITE_URL__`, `__SITE_ORIGIN__`, `__REPO_SLUG__`, `__PKG_NAME__`)
across the template — so injection is deterministic and the result has no
placeholders left. After stamping you may hand-edit content freely.

## Per-template notes

- **static-html** — Zero build. All links are relative, so it's base-path-proof.
  Ships `index.html`, `about.html`, `404.html`, `assets/`, and a `.nojekyll`.
- **astro** — `site` = origin, `base` = `/repo/`. Internal links use
  `import.meta.env.BASE_URL`. `public/` is copied verbatim. Node 24 in CI by default.
- **react-vite** — `base` in `vite.config.js`; React Router `basename` derived from
  `BASE_URL`; `copy-404.mjs` (a `postbuild` hook) copies `index.html` → `404.html`
  so deep-link refreshes work on Pages. Reference public assets as `/asset` so Vite
  rewrites them with the base.
- **eleventy** — `pathPrefix` comes from the `PATH_PREFIX` env the workflow sets;
  every link/asset uses the `url` filter. Posts live in `src/posts/`, listed via
  `collections.posts`. Locally it serves at `/`.
- **jekyll** — `baseurl` (no trailing slash) in `_config.yml`; links use
  `relative_url`. Built in CI by `jekyll-build-pages` (honors the `Gemfile`). Local
  dev needs Ruby + Bundler; CI does not.

## Current repo vs. new repo

- **Current repo**: simplest when the user already has the project. Confirm the
  repo name matches the base path. Put the site at the root for a whole-repo site,
  or in a subfolder and point the workflow's `upload-pages-artifact` `path:` at it.
- **New repo**: create with `gh repo create`, stamp, push to `main`. For a **user
  site**, the repo MUST be named `<user>.github.io` and the base is `/` — the
  generator handles the base when you pass that repo name.

## Custom domains (documented, not automated)

For a custom domain: add a `CNAME` file (for static/Jekyll, at the served root;
for Astro, `public/CNAME`), set DNS at the registrar, and in Astro set `site` to
the domain and drop `base`. Don't automate DNS — explain the steps.

## Template registry & contributing

Templates are bundled in `templates/<name>/`, each with a `template.json` manifest.
The gallery (`gallery/`) renders the catalog from those manifests
(`scripts/build-catalog.mjs` regenerates `gallery/templates.json`; a test gates
drift). New templates follow the contract in `CONTRIBUTING.md`: a folder with a
`deploy.yml`, base-path handling via the sentinels, a `README.md`, and a manifest.

The generator's `--registry <owner/repo>` flag fetches templates from a remote
registry instead of the bundled copies — so these templates can graduate into a
standalone, community-contributable `jongio/gh-pages-templates` repo (which can
deploy its own gallery to Pages) with no change to the skill.

## Validate — don't claim done on a green check

1. **Build it.** For `astro`/`react-vite`/`eleventy`, run `npm install` then
   `npm run build` and confirm it exits 0 and emits the output dir
   (`dist` / `_site`). For `jekyll`, `bundle exec jekyll build` if Ruby is present.
2. **Check the base path.** Open the built output and confirm asset/link URLs carry
   the project prefix (`/repo/...`) — not bare `/...`. This is the failure mode that
   "looks deployed but renders blank."
3. **After deploy**, load the live `page_url` from the Actions run; click an
   internal link and (for the SPA) refresh a sub-route to confirm the `404.html`
   fallback works.
4. Only then report it as working.

Run the skill's own tests with `npm test` (generator + workflow + catalog).

## Footguns

- **Never** ship a project site built for `/` — assets 404. Set the base path (the
  generator does this; verify it).
- **Never** put a subpath base on a **user site** (`<user>.github.io`) — it must be
  `/` (Jekyll: `baseurl: ""`).
- **Never** use `actions/upload-artifact` for Pages — it's `upload-pages-artifact`.
- **Never** reach for `peaceiris/actions-gh-pages` or a `gh-pages` branch — use the
  first-party Actions flow these templates ship.
- **Never** forget to set **Source → GitHub Actions** in Settings → Pages; the
  workflow can't publish until Pages is enabled for Actions.
- **Never** claim success because the workflow is green — load the URL and check an
  asset and an internal link actually resolve.
- **Don't** hand-roll a base-path setup when the generator + sentinels already do
  it correctly per framework.
