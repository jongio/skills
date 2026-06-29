# __SITE_NAME__

A data-driven **[Eleventy](https://www.11ty.dev)** (11ty) static site for GitHub
Pages — Markdown + structured data rendered to fast HTML.

Site URL: __SITE_URL__

## Why this template

- **Content as data.** Posts are Markdown with front matter; collections list them
  automatically. Drive sections from JSON/YAML/JS in `src/_data/`.
- **Base path solved the idiomatic way.** `pathPrefix` comes from the
  `PATH_PREFIX` env var the deploy workflow sets, and every link/asset uses the
  `url` filter — so the prefix is applied in one place, correctly.
- **Official deploy.** Builds `_site/` in CI and publishes via
  `configure-pages` + `upload-pages-artifact` + `deploy-pages`.

## Develop locally

```sh
npm install
npm run dev      # http://localhost:8080 (served at "/")
npm run build    # outputs _site/
```

To preview the project base path locally, set it before building:

```sh
PATH_PREFIX="/my-repo/" npm run build
```

## Deploy

1. Push to a GitHub repo's `main` branch.
2. **Settings → Pages → Source → GitHub Actions**.
3. `.github/workflows/deploy.yml` builds with the right `PATH_PREFIX` and publishes.

> Renamed the repo? Update `PATH_PREFIX` in `.github/workflows/deploy.yml`.

## Structure

```
eleventy.config.js    input/output dirs + pathPrefix (from PATH_PREFIX)
src/
  index.njk           home
  about.njk           about
  posts.njk           posts listing (collections.posts)
  posts/              Markdown posts + posts.json (layout + tag)
  _includes/base.njk  layout (base-aware nav via the url filter)
  _data/site.json     site-wide data
  assets/styles.css   styling (passthrough-copied)
.github/workflows/deploy.yml
```
