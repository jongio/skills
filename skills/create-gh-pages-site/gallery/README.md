# Template gallery

A zero-build static site that lists the available GitHub Pages templates and how
to use them. It renders from `templates.json`, which is generated from each
template's `template.json` manifest by `scripts/build-catalog.mjs`.

## Regenerate the catalog

```sh
node scripts/build-catalog.mjs
```

A test (`test/catalog.test.mjs`) fails if `templates.json` drifts from the
manifests, so the gallery always matches the templates on disk.

## Run locally

```sh
npx serve gallery
# or open gallery/index.html
```

## Deploy as its own site

This folder is self-contained. If the templates graduate into a standalone
registry repo, copy `gallery/` to the repo root and the included
`.github/workflows/deploy.yml` publishes it to GitHub Pages.
