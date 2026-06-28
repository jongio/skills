# __SITE_NAME__

A **React + [Vite](https://vite.dev)** single-page app for GitHub Pages, with the
base path and SPA deep-link fallback wired correctly.

Site URL: __SITE_URL__

## Why this template

- **Real SPA routing.** React Router with a `basename` derived from
  `import.meta.env.BASE_URL`, so links work at `/` or `/REPO/`.
- **Deep links survive refresh.** The build copies `index.html` → `404.html`
  (`copy-404.mjs`, run by the `postbuild` hook), so GitHub Pages hands unknown
  paths back to the app instead of showing its own 404.
- **Base path solved.** `base` in `vite.config.js` is set from your repo, and Vite
  rewrites every asset URL accordingly.

## Develop locally

```sh
npm install
npm run dev      # http://localhost:5173
npm run build    # outputs dist/ (and dist/404.html)
npm run preview  # serve the production build at the configured base
```

## Deploy

1. Push to a GitHub repo's `main` branch.
2. **Settings → Pages → Source → GitHub Actions**.
3. `.github/workflows/deploy.yml` installs, builds, and publishes on every push.

> Renamed the repo? Update `base` in `vite.config.js` to `/NEW-NAME/`.

## Structure

```
vite.config.js       base path for GitHub Pages
index.html           Vite entry HTML
copy-404.mjs         postbuild SPA fallback (dist/index.html → dist/404.html)
src/
  main.jsx           React + Router bootstrap (basename from BASE_URL)
  App.jsx            routes
  pages/             Home.jsx, About.jsx
  index.css          styling
public/favicon.svg   static asset (rewritten with base)
.github/workflows/deploy.yml
```
