# __SITE_NAME__

A **[Jekyll](https://jekyllrb.com)** site for GitHub Pages — GitHub's native
static site generator, built and deployed by GitHub Actions.

Site URL: __SITE_URL__

## Why this template

- **GitHub-native.** Jekyll is the generator GitHub Pages was built around. This
  template uses the official `actions/jekyll-build-pages` action.
- **Base URL solved.** `baseurl` in `_config.yml` is set from your repo, and links
  use the `relative_url` filter, so a project site at `/REPO` works correctly.
- **Markdown posts.** Drop files in `_posts/` and they list automatically.

## Develop locally

Requires Ruby + Bundler.

```sh
bundle install
bundle exec jekyll serve   # http://localhost:4000
```

> No Ruby? You can skip local builds — GitHub Actions builds it on push.

## Deploy

1. Push to a GitHub repo's `main` branch.
2. **Settings → Pages → Source → GitHub Actions**.
3. `.github/workflows/deploy.yml` builds with Jekyll and publishes on every push.

> Renamed the repo? Update `baseurl` in `_config.yml` to `/NEW-NAME`.

## Structure

```
_config.yml             site config + baseurl
index.html              home (lists site.posts)
about.md                about page (permalink: /about/)
_layouts/default.html   layout (base-aware nav via relative_url)
_posts/                 Markdown posts (YYYY-MM-DD-title.md)
assets/styles.css       styling
Gemfile                 local-dev Jekyll
.github/workflows/deploy.yml
```
