# Skills

A statically-rendered **[Astro](https://astro.build)** site for GitHub Pages.

Site URL: https://jongio.github.io/skills/

## Why this template

- **Fast by default.** Astro ships zero JavaScript unless a component opts into
  hydration ("islands").
- **Base path solved.** `site` and `base` in `astro.config.mjs` are set from your
  repo, and links use `import.meta.env.BASE_URL`, so a project site at
  `/REPO/` and a user site at `/` both work unchanged.
- **Official deploy.** Uses `withastro/action` + `actions/deploy-pages` — the
  flow Astro itself documents.

## Develop locally

```sh
npm install
npm run dev      # http://localhost:4321
npm run build    # outputs to dist/
npm run preview  # serve the production build
```

## Deploy

1. Push to a GitHub repo's `main` branch.
2. **Settings → Pages → Source → GitHub Actions**.
3. `.github/workflows/deploy.yml` builds and publishes on every push to `main`.

> If you rename the repo, update `base` in `astro.config.mjs` to `/NEW-NAME/`.

## Structure

```
astro.config.mjs           site + base for GitHub Pages
src/
  pages/                   file-based routes (index.astro, about.astro)
  layouts/Layout.astro     HTML shell + base-aware nav
  components/Card.astro    example component
public/                    static assets copied verbatim (favicon.svg)
.github/workflows/deploy.yml
```
