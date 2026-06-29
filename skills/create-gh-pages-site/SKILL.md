---
name: create-gh-pages-site
description: >-
  Scaffold a working GitHub Pages website from a vetted template and wire it to
  deploy automatically. Use when the user wants to create, scaffold, or publish a
  site on GitHub Pages — a static page, an Astro or Eleventy site, a React (Vite)
  SPA, or a Jekyll site. Picks the right template for the use case, injects the
  correct base path for the target repo (the #1 thing people get wrong), adds the
  current official GitHub Actions Pages deploy workflow, and sets it up in the
  user's current repo by default (the repo in context) — or a new one if asked —
  and explains how to turn Pages on. Crucially, it does not stop at the template's
  demo content: it digests the target repo (README, manifests, entry points, docs)
  and authors a site that is actually about that repo — a CLI reference, an
  API/usage page, a feature tour, or a catalog of parts as appropriate — with
  labeled image placeholders the user swaps in. Do NOT use for
  non-Pages hosting (Vercel/Netlify/Azure), for deploying an existing app without
  a Pages target, or for plain web pages unrelated to GitHub Pages.
---

# Create GitHub Pages Site

Turn "put this on GitHub Pages" into a correct, building, auto-deploying repo. The
hard part of GitHub Pages isn't the HTML — it's the deploy plumbing and the
**base-path trap**. This skill owns both: it stamps a vetted template, sets the
base path for the exact repo, ships the current official Pages workflow, and walks
the user through enabling Pages.

It also never stops at the template's demo content. A stamped template is a
**skeleton, not the deliverable** — the skill reads the target repo and authors a
site about *that* project: real name and pitch, the right kind of reference (CLI,
library, app, or catalog), real install/usage pulled from the repo, and labeled
image placeholders the user can drop real art into. Shipping a site that still says
"Hello, Astro" for someone's CLI is a failure, even if it deploys.

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

## Interview first — never scaffold on a guess

This skill produces a real repo with a live deploy pipeline, so getting the inputs
right matters more than speed. **Do not stamp anything until you know (a) which
template and (b) the target repo (or an explicit base path).** If the prompt is bare
("make me a GitHub Pages site") or names no framework/repo, interview the user — ask
only for what's missing, one focused question at a time, using the `ask_user` tool:

1. **What kind of site?** Map the answer to a template:
   - "a landing page / just some HTML / the simplest thing" → `static-html`
   - "a blog / docs / content / marketing site, fast" → `astro` (or `eleventy` if
     they say Markdown- or data-driven, or `jekyll` if they want the GitHub-native
     path or are migrating an existing Jekyll site)
   - "an app / dashboard / interactive / single-page app" → `react-vite`

   If they're unsure, ask the single discriminating question — *content site or
   interactive app?* — and default to `static-html` for the simplest ask.
2. **Which repo? Assume the current repo by default.** The site is for the repo in
   context unless the user says otherwise — don't ask "current or new." Detect the
   current repo from git (`git remote get-url origin`, parsed to `owner/name`); the
   generator does the same automatically when you omit `--repo`. The repo drives the
   base path, so you must resolve it before stamping:
   - **Current repo detected** → use it. State the assumption in one line
     (*"Scaffolding into this repo, octocat/blog → base `/blog/`"*) and proceed; no
     question needed.
   - **No git context, detached, or no `origin`** → then ask for the `owner/name`,
     and whether it's an existing repo or a **new** one to create.
   - Only treat it as a **new/different** repo when the user explicitly asks for one.
     For a user site, confirm the repo is named `<user>.github.io` (base `/`);
     otherwise it's a project site (base `/repo/`).
3. **Title?** Optional — default to the repo name; never block on it.

You usually don't need to ask "what should the site say?" — the **content comes from
the repo** (you digest it after stamping; see "Digest the repo, then author it").
When the target repo is the current/an existing one, run `digest-repo.mjs` early to
confirm the type and let it inform the template choice (e.g. a `cli` repo is a great
fit for `astro` or `static-html` with a command reference). If the repo is empty or
brand-new, fall back to asking what the site should cover.

Skip any question the prompt already answered: *"an Astro blog for octocat/blog"*
needs no interview (template `astro`, repo `octocat/blog`). For a bare *"put this on
Pages"* inside a repo, assume the current repo and ask only for the template. Ask
only for the gaps. When you **inferred** rather than were told, confirm in one line
before scaffolding — e.g. *"Astro site → octocat/blog (current repo), base `/blog/` —
go?"*

## The workflow you follow

1. **Interview / gather context.** Resolve the questions above via `ask_user`. You
   MUST end up with a chosen template and a target repo (or explicit `--base`) before
   stamping. **Default the target to the current repo** (detect it from
   `git remote get-url origin`); only ask when there's no git context or the user
   wants a different/new repo.
2. **Pick the template** from the table above.
3. **Stamp it** with the generator (next section). This injects the base path,
   site URL, and title, and lays down the deploy workflow.
4. **Place it in the repo:**
4. **Place it in the repo:**
   - *Current repo (default)*: stamp into the repo root (or a subfolder if it's a
     subdirectory site, adjusting the workflow's upload path). Pass `--dir .`
     `--force` to write in place, and reconcile an existing `deploy.yml` rather than
     blindly overwriting it.
   - *New repo (only when asked)*: create it (e.g. `gh repo create <name> --public`),
     stamp into it, and push. Match the repo name you used for the base path.
5. **Digest the repo and author the site** (see "Digest the repo, then author it"
   below). This is the step that makes the site *real*: run the digest, replace
   every default page/section with repo-derived content of the right kind, and add
   image placeholders + an `IMAGES.md`. Never skip to enabling Pages on the demo
   content.
6. **Enable Pages.** Tell the user (or do it with their approval):
   **Settings → Pages → Source → GitHub Actions**. By CLI:
   `gh api -X POST repos/<owner>/<repo>/pages -f build_type=workflow` (or PUT to
   update). After the first push to `main`, the workflow runs and the live URL
   appears in the Actions run summary and under Settings → Pages.
7. **Set the repo website link** to the Pages URL (the "Website" field in the repo
   header — same as ticking *Settings → "Use your GitHub Pages website"*). This is
   just the repo's `homepage`; point it at the site URL the generator prints:
   `gh repo edit <owner>/<repo> --homepage <site-url>` (or
   `gh api -X PATCH repos/<owner>/<repo> -f homepage=<site-url>`). Offer to set the
   exact URL, or let the user supply a custom domain instead. There's no separate
   "use Pages" boolean — setting `homepage` to the Pages URL *is* the checkbox.
8. **Verify it actually works** (see "Validate" below) — don't claim success on a
   green workflow alone, and don't claim success while template default copy or
   "Hello, world" demo content is still on the page.

## Stamp a site — the generator

```
node scripts/new-site.mjs <template> --repo <owner/name> [options]
```

| Option | Purpose |
| --- | --- |
| `--repo <owner/name>` | Target repo. Derives the base path + URLs (and detects user sites). **Defaults to the current repo's `origin` remote when omitted.** |
| `--base </path/>` | Override the base path (e.g. `/` for a user site or local preview). |
| `--dir <path>` | Output directory (default: `./<repo-name>`). |
| `--site-name "Title"` | Human title (default: derived from the repo name). |
| `--registry <owner/repo>` | Template registry repo to fetch from (default: `jongio/gh-pages-templates`; needs git + network). |
| `--templates-dir <path>` | Use a local `templates/` folder instead of fetching (offline). |
| `--force` | Write into a non-empty directory. |
| `--list` | List available templates. |

Templates are **not bundled in the skill** — the generator fetches them from the
`jongio/gh-pages-templates` registry (a shallow clone) on each run, so there's one
source of truth. The clone is reused within a run, so `--list` + a stamp clone once.
Pass `--templates-dir <path>` to scaffold from a local copy offline.

Examples:

```sh
# Scaffold for the CURRENT repo (base path inferred from its origin remote):
node scripts/new-site.mjs astro

# An Astro content site for a specific project repo:
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

## Digest the repo, then author it (never ship the template defaults)

Stamping gives you a working skeleton with **demo content**. The job is only half
done. Now make the site about the actual repo. This is not optional polish — it's
the deliverable.

### 1. Run the digest

```sh
node scripts/digest-repo.mjs --dir <path-to-repo> --json
```

It returns deterministic signals you build from: `name`, `description` (the pitch),
`repoSlug`, `license`, a `type` classification (`cli` | `library` | `app` |
`action` | `collection` | `docs` | `site`) with the reasons behind it, suggested
`install` commands, README `usageExamples` (code fences), `badges`, `docFiles`,
existing `images` (with role hints like `logo`/`hero`/`screenshot`), `languages`,
and `subProjects` (for monorepos/collections). Read the repo's README and key docs
yourself too — the digest points you at them; it doesn't replace judgment.

### 2. Build the right *kind* of site for the type

| Type | Tell-tale signals | Author the site around… |
| --- | --- | --- |
| `cli` | `bin`, console_scripts, `[[bin]]`, `--help` in README | Install + Quickstart, then a **command/flag reference** (a section or page per command), copy-paste examples, config/exit codes. Hero = terminal demo. |
| `library` | `main`/`exports`, `[lib]`, import examples | Install, an **import + usage** snippet, an **API reference** (exported functions/types from the README/docs), examples, badges. Hero = a concept diagram. |
| `app` | web-framework dep, `index.html`, `src/` | A **feature tour** with screenshots, a "Get started"/live-demo CTA. Hero = an app screenshot. |
| `action` | `action.yml` | A `uses:` snippet, an **inputs/outputs table**, an example workflow. |
| `collection` | `plugin.json`/`marketplace.json` + `skills/`, workspaces, `packages/` | A **catalog**: one card/detail per `subProject` (its pitch + install), plus a top-level install for the whole thing. Hero = a banner; per-item thumbnails. |
| `docs` | many Markdown docs, little code | A **docs nav + content**, pulling the existing Markdown in. |
| `site` / unknown | none of the above | A clean landing built from the repo's pitch and links. If the shape is unclear, ask the user what sections they want. |

### 3. Authoring rules

- **Replace every default.** No template demo copy survives — not the sample hero,
  not "Hello, Astro/world", not the example blog posts, not lorem. After building,
  grep the output for the template's stock phrases; none should remain.
- **Use real values from the digest:** the repo's name and `description` as the
  title/tagline, the `install` commands verbatim, the README `usageExamples` as
  real code blocks, `badges`, `license`, and links to the repo and each
  `subProject`. **Don't invent** features, commands, or APIs you can't see in the
  repo — if something's unclear, leave a visible `TODO` for the user rather than
  fabricate.
- **Fit the template's content model.** Use content collections (Astro/Eleventy:
  one entry per command/skill/post), pages (React/static), etc. Add or rename
  routes to match the content (e.g. a `commands/` or `catalog/` section) instead of
  forcing everything into the demo "blog". Keep the GitHub source link and the
  base-path-aware internal links the template already wires — never hand-write
  absolute `/...` links (use the template's base helper, or it breaks on a project
  site).

### 4. Add image placeholders the user can supply

Real sites need art the agent can't produce. Drop in **obvious placeholders** plus
a checklist so the user knows exactly what to provide:

```sh
node scripts/make-placeholder.mjs --out <site>/<images-dir> --preset <type> --repo owner/name
```

`--preset` is the repo type (`cli`/`library`/`app`/`collection`/`site`). It writes
labeled SVG placeholders (logo, social card, favicon, hero, and type-specific
shots) and an `IMAGES.md` manifest listing each file's purpose and recommended
dimensions. Then:

- **Reference them** from the pages you author — hero, top-bar logo, the OG/social
  meta tag, and per-item thumbnails for a catalog.
- **Reuse real images first.** If the digest found an existing logo or screenshot
  (e.g. a `docs/*.png`), use it instead of a placeholder.
- **Put images where the template serves static files:**
  - `astro`, `react-vite` → `public/images/` (served at `${BASE_URL}images/…`)
  - `static-html` → `assets/images/` (relative `./assets/images/…`)
  - `eleventy` → `src/assets/images/` (through the `url` filter)
  - `jekyll` → `assets/images/` (via `relative_url`)
- **Leave `IMAGES.md` in the images dir** as the hand-off, and tell the user it's
  there. A placeholder still deploys fine; it just visibly says "replace me".

### Helper scripts (alongside `new-site.mjs`)

- `scripts/digest-repo.mjs` — analyze a repo → JSON signals + a type classification.
- `scripts/make-placeholder.mjs` — generate placeholder images + an `IMAGES.md`.

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

- **Current repo (the default)**: assume the site is for the repo in context. The
  generator infers the base path from its `origin` remote when you omit `--repo`.
  Put the site at the root for a whole-repo site, or in a subfolder and point the
  workflow's `upload-pages-artifact` `path:` at it. If a `deploy.yml` already exists,
  reconcile — don't blindly overwrite.
- **New repo (only when asked)**: create with `gh repo create`, stamp, push to
  `main`. For a **user site**, the repo MUST be named `<user>.github.io` and the base
  is `/` — the generator handles the base when you pass that repo name.

## Custom domains (documented, not automated)

For a custom domain: add a `CNAME` file (for static/Jekyll, at the served root;
for Astro, `public/CNAME`), set DNS at the registrar, and in Astro set `site` to
the domain and drop `base`. Don't automate DNS — explain the steps.

## Template registry & contributing

Templates live in **one** place: the
**[`jongio/gh-pages-templates`](https://github.com/jongio/gh-pages-templates)**
registry. The skill does **not** bundle its own copy — the generator fetches
templates from the registry at runtime (override with `--registry <owner/repo>`, or
scaffold offline from a local checkout with `--templates-dir <path>`):

```
node scripts/new-site.mjs astro --repo octocat/blog            # default registry
node scripts/new-site.mjs astro --templates-dir ../gh-pages-templates/templates
```

Each template is a folder with a `template.json` manifest, a `deploy.yml`,
base-path handling via the sentinels, and a `README.md`. The registry also renders
the browsable gallery (live previews of every template) at
**https://jongio.github.io/gh-pages-templates/** — the single home for browsing and
previewing. Point users there to browse, and to the registry's `CONTRIBUTING.md` to
submit a new template. Template changes (add/fix a template, bump an action version)
land in the registry, not here.

## Validate — don't claim done on a green check

1. **Content check first.** Confirm the site is about the repo, not the template:
   the title/tagline, install commands, and examples are the repo's real values, and
   **no template demo copy survives** (grep the built output for the template's stock
   phrases — "Hello", "islands", "lorem", the sample post titles — and for leftover
   `__…__` sentinels). The page kind matches the repo type (CLI ref / API ref /
   feature tour / catalog). Image placeholders exist and `IMAGES.md` is present.
2. **Build it.** For `astro`/`react-vite`/`eleventy`, run `npm install` then
   `npm run build` and confirm it exits 0 and emits the output dir
   (`dist` / `_site`). For `jekyll`, `bundle exec jekyll build` if Ruby is present.
3. **Check the base path.** Open the built output and confirm asset/link URLs carry
   the project prefix (`/repo/...`) — not bare `/...`. This is the failure mode that
   "looks deployed but renders blank."
4. **After deploy**, load the live `page_url` from the Actions run; click an
   internal link and (for the SPA) refresh a sub-route to confirm the `404.html`
   fallback works.
5. Only then report it as working.

Run the skill's own tests with `npm test` (the generator + the repo-digest and
placeholder checks, offline via a fixture). Template/workflow validation lives in
the `jongio/gh-pages-templates` registry.

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
- **Don't** leave the repo "Website" link blank — set `homepage` to the Pages URL
  (`gh repo edit --homepage`) so visitors find the site; it's the same as the
  "Use your GitHub Pages website" checkbox.
- **Never** claim success because the workflow is green — load the URL and check an
  asset and an internal link actually resolve.
- **Never** ship the template's demo content. A stamped template that still says
  "Hello, Astro" (or lists the sample blog posts) for someone's CLI or library is a
  failure — digest the repo and author real content of the right kind.
- **Never** fabricate features, commands, or APIs to fill the page. Author only what
  the repo actually shows; leave a visible `TODO` when unsure.
- **Don't** leave bare image references with nothing behind them — add the
  placeholders + `IMAGES.md`, or reuse the repo's existing images.
- **Don't** hand-roll a base-path setup when the generator + sentinels already do
  it correctly per framework.
