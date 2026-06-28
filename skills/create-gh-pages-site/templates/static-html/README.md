# __SITE_NAME__

A zero-build **static** site for GitHub Pages — plain HTML, CSS, and JS, deployed
by the official GitHub Actions Pages workflow.

Site URL: __SITE_URL__

## Why this template

- **No build step.** What you write is what ships.
- **Base-path proof.** Every link is relative (`./assets/...`), so it works at a
  user site (`/`) or a project site (`/repo/`) with zero configuration.
- **A working reference.** Demonstrates the web platform with no framework:
  a light/dark theme toggle (system default + persisted), accessible tabs, a fetch
  demo with loading/error states, constraint-based form validation, and a native
  `<dialog>` — plus a GitHub source link in the top bar.
- **Official deploy.** Uses `actions/configure-pages` + `upload-pages-artifact` +
  `deploy-pages` — no third-party action, no `gh-pages` branch.

## Develop locally

No tooling required. Open `index.html` in a browser, or serve the folder:

```sh
npx serve .
# or: python -m http.server
```

## Deploy

1. Push this folder to a GitHub repo's `main` branch.
2. In the repo, go to **Settings → Pages** and set **Source** to **GitHub Actions**.
3. The included workflow (`.github/workflows/deploy.yml`) runs on every push to
   `main` and publishes the site. The live URL appears in the Actions run summary
   and under Settings → Pages.

## Structure

```
index.html        Landing page + feature showcase
about.html        Second page (what the template demonstrates)
404.html          Custom not-found page
assets/
  styles.css      Styling + light/dark theme tokens
  main.js         Theme toggle, tabs, fetch, form, dialog
  data.json       Sample data for the fetch demo
.nojekyll         Serve files as-is (skip Jekyll)
.github/workflows/deploy.yml   Pages deploy workflow
```

