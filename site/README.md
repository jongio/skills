# jongio/skills — site

The public site for [`jongio/skills`](https://github.com/jongio/skills), a
statically-rendered **[Astro](https://astro.build)** site deployed to GitHub Pages.
It presents the repo's skills as a browsable catalog.

Live: https://jongio.github.io/skills/

> Scaffolded by the `create-gh-pages-site` skill, then authored from a digest of
> this repo (classified as a *collection*) — so the content is the actual skills
> catalog, not template demo copy.

## What's here

- **Home** (`/`) — hero, a grid of skill cards (each with an "install in your agent"
  snippet), and the install options.
- **Skills** (`/catalog/`) — the catalog, one card per skill.
- **Skill detail** (`/catalog/<skill>/`) — thumbnail, install commands, and the
  skill's write-up, generated from a content collection.
- **About** (`/about/`) — what the repo is and how to install it.

Adding a skill is a single Markdown file in `src/content/skills/` — the home grid,
catalog, and detail pages all render from that collection.

## Develop locally

```sh
npm install
npm run dev      # http://localhost:4321/skills/
npm run build    # outputs to dist/
npm run preview  # serve the production build at the /skills/ base
```

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

```
astro.config.mjs              site + base for GitHub Pages
src/
  content.config.ts           the `skills` content collection schema
  content/skills/             one Markdown entry per skill (frontmatter + write-up)
  pages/
    index.astro               home: hero + skills grid + install
    catalog/index.astro       the catalog list
    catalog/[slug].astro      per-skill detail page
    about.astro               about the repo
  layouts/Layout.astro        HTML shell, base-aware nav, theme toggle, copy buttons
  components/SkillCard.astro   skill card (thumbnail + install snippet)
public/
  favicon.svg                 site icon
  images/                     thumbnails + placeholders (see images/IMAGES.md)
.github/workflows/deploy.yml  (at the repo root) Pages deploy
```

## Images

`public/images/IMAGES.md` is the hand-off checklist: which images are real vs.
placeholders, their purpose, and recommended sizes. Replace placeholders in place
(keep the filename, or update the reference) — placeholders still deploy fine.
