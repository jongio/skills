# jongio/skills — site

The public site for [`jongio/skills`](https://github.com/jongio/skills), a
statically-rendered **[Astro](https://astro.build)** site deployed to GitHub Pages.
It presents the repo's skills as a browsable catalog and documents all four
composable Copilot CLI statusline extensions.

Live: https://jongio.github.io/skills/

## What's here

- **Home** (`/`) — hero, a grid of skill cards (each with an "install in your agent"
  snippet), install options, and an overview of the four statusline components.
- **Statuslines** (`/statuslines/`) — Branch and Worktree, Pull Requests, Issues,
  and Subagents, including a grouped-footer illustration, native branch-marker
  and upstream/base divergence legends, setup/refresh/clear/naming commands,
  Windows Terminal attention alerts (`/session-attention`), the optional CI/PR
  daemon timeline bridge (`daemon-notifications`), and links to the extension guides.
- **Skills** (`/catalog/`) — the catalog, one card per skill, with a delivery
  workflow overview, live search, and grid/list layout toggle.
- **Skill detail** (`/catalog/<skill>/`) — thumbnail, install commands, and the
  skill's write-up, generated from a content collection.
- **About** (`/about/`) — what the repo is, supported hosts, and how to install it.

Adding a skill is a single Markdown file in `src/content/skills/` — the home grid,
catalog, and detail pages all render from that collection.

## Develop locally

```sh
npm install
npm test             # run install-doc, guide, thumbnail-sync, and performance tests
npm run sync:thumbnails # validate catalog mappings and copy skill thumbnails to public/images/
npm run dev          # http://localhost:4321/skills/
npm run build        # outputs to dist/ and enforces performance budgets
npm run preview      # serve the production build at the /skills/ base
npm run bench        # repeatable catalog discovery timings and built-asset sizes
```

Production builds generate responsive WebP thumbnails from the canonical skill
PNGs without changing those source files or their public PNG mirrors. Each build
also enforces gzip budgets of 100 KiB per JS chunk, 300 KiB total JS and 50 KiB
total CSS, plus 200 KiB per generated image. The check rejects raw thumbnail PNG
references in rendered HTML.

## Base path

`site` and `base` in `astro.config.mjs` are set for this project site
(`base: "/skills/"`), and links use `import.meta.env.BASE_URL`, so assets and
internal links resolve under `https://jongio.github.io/skills/`.

> If you rename the repo, update `base` in `astro.config.mjs` to `/NEW-NAME/`.

## Deploy

1. Push to `main` (the site lives in the `site/` subfolder of the repo).
2. **Settings → Pages → Source → GitHub Actions**.
3. The repo's `.github/workflows/deploy.yml` builds `site/` with
   `withastro/action` and publishes on every push to `main`.

## Structure

```text
astro.config.mjs              site + base for GitHub Pages
scripts/
  sync-thumbnails.mjs         validates catalog mappings and copies skill thumbnails
  check-performance.mjs       enforces JS/CSS/WebP budgets on dist/
  benchmark.mjs               measures catalog discovery and asset budgets
test/
  install-docs.test.mjs       guards plugin/skill install commands across pages
  statusline-guides.test.mjs  validates SVG guides, icon codepoints, and accents
  sync-thumbnails.test.mjs    tests thumbnail mapping and path safety
  performance.test.mjs        tests asset budget enforcement
src/
  content.config.ts           the `skills` content collection schema
  thumbnails.ts               maps catalog thumb frontmatter to canonical skill PNGs
  content/skills/             one Markdown entry per skill (frontmatter + write-up)
  pages/
    index.astro               home: hero + skills grid + statuslines + install
    catalog/index.astro       the catalog list + workflow overview
    catalog/[slug].astro      per-skill detail page
    statuslines/index.astro   all four statuslines, session controls, attention alerts, and daemon bridge
    about.astro               about the repo
  layouts/Layout.astro        HTML shell, base-aware nav, theme toggle, copy buttons
  components/
    SkillCard.astro           skill card (thumbnail + install snippet)
    SkillGrid.astro           searchable grid/list toggle container
public/
  favicon.svg                 site icon
  images/                     thumbnails + screenshots (see images/IMAGES.md)
  screenshots/                statusline detail artwork and grouped-footer SVG
.github/workflows/deploy.yml  (at the repo root) Pages deploy
```

## Images

`public/images/IMAGES.md` records the used images, their sources, and spare assets.
The social card is authored as `og.svg` and published as `og.png`.

`public/screenshots/statusline-worktree-grouped.svg` is a labeled illustration,
not a live session screenshot. Both statusline showcases and the repository
READMEs reuse it. It shows blue external-checkout pills beside green passing PRs,
with an amber unassigned issue and purple all-merged subagent summary below. Three smaller
SVG guides explain PR, issue, and subagent status; cropped PNGs show individual
terminal symbols.
The legacy PNG diagram URLs and extension screenshot copies are generated from
the corresponding SVG guides and kept byte-identical.
The illustration also distinguishes upstream ahead/behind counts from missing
base commits, labels unavailable comparisons with `?`, and states that counts
use locally fetched refs rather than background network refreshes.
Feature accents are consistent throughout the site: blue for Branch and Worktree,
green for PRs, amber for Issues, and purple for Subagents. Each diagram heading
sits directly above its matching-color pill group. The examples use real states
that produce those colors; other live states are explained in the detail guides.
