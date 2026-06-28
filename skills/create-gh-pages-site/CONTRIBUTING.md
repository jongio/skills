# Contributing a template

Templates are self-contained folders under `templates/<name>/`. Adding one is a
folder plus a manifest — the generator and gallery pick it up automatically. This
contract is identical whether the templates live here in `jongio/skills` or in a
standalone `jongio/gh-pages-templates` registry repo.

## Anatomy of a template

```
templates/<name>/
  template.json                 Manifest (required — see below)
  .github/workflows/deploy.yml  Pages deploy workflow (required)
  README.md                     Human docs for the stamped site (required)
  <site files…>                 index.html / src/ / _config.yml / etc.
  .gitignore                    What the user's repo should ignore (recommended)
```

`template.json`, `node_modules`, `dist`, `_site`, and `.git` are **never** copied
into a stamped site (the generator excludes them).

## The manifest (`template.json`)

```json
{
  "name": "my-template",              // must equal the folder name
  "title": "My Template",             // shown in the gallery
  "tagline": "One-line pitch.",       // short
  "description": "A sentence or two on what it is and when to pick it.",
  "framework": "Svelte",              // human-readable
  "tier": "ssg",                      // static | ssg | spa | data | native
  "language": "JavaScript",
  "needsBuild": true,                 // false for zero-build static
  "build": "vite build",              // build command, or null
  "output": "dist",                   // build output dir, or "." for static
  "basePathMechanism": "base in svelte.config.js",
  "deploy": "configure-pages + upload-pages-artifact + deploy-pages",
  "tags": ["svelte", "ssg"],
  "order": 6                          // sort order in the gallery
}
```

After editing manifests, regenerate the gallery catalog:

```sh
node scripts/build-catalog.mjs
```

(`test/catalog.test.mjs` fails if the catalog is out of sync.)

## Base-path handling (the important part)

A project site is served from `https://USER.github.io/REPO/`, so the template must
make its base path configurable. Use these sentinels — the generator replaces them
when stamping, deriving values from `--repo` (and detecting `USER.github.io` user
sites, where the base collapses to `/`):

| Sentinel | Replaced with | Use for |
| --- | --- | --- |
| `__BASE_PATH__` | `/repo/` (or `/`) — trailing slash | Vite/Astro `base`, Eleventy `pathPrefix`, the workflow's `PATH_PREFIX` |
| `__BASE_URL__` | `/repo` (or ``) — no trailing slash | Jekyll `baseurl` |
| `__SITE_NAME__` | the human title | page titles, headings |
| `__SITE_URL__` | `https://user.github.io/repo/` | meta, README |
| `__SITE_ORIGIN__` | `https://user.github.io` | Astro `site`, Jekyll `url` |
| `__REPO_SLUG__` | `owner/repo` | links to the repo |
| `__PKG_NAME__` | npm-safe name | `package.json` `name` |

If the framework needs no base path (all relative links), you don't need
`__BASE_PATH__` at all — see `static-html`.

## The deploy workflow

Use the official **GitHub Actions** Pages flow (Source = "GitHub Actions"):

```
actions/configure-pages@v5 → build → actions/upload-pages-artifact@v3 → actions/deploy-pages@v4
```

Every `deploy.yml` MUST declare:

- `permissions: { contents: read, pages: write, id-token: write }`
- `concurrency: { group: pages, cancel-in-progress: false }`
- the `github-pages` environment on the deploy job
- only first-party actions — no `peaceiris/actions-gh-pages`, no
  `actions/upload-artifact`, no pre-cutover `deploy-pages` majors

`test/workflow.test.mjs` enforces all of this.

## Validate

```sh
npm test                                   # generator + workflow + catalog
node scripts/new-site.mjs my-template --repo octocat/demo --dir /tmp/x
cd /tmp/x && npm install && npm run build  # if it builds
```

Confirm the built output's asset/link URLs carry the project prefix (`/repo/…`),
not bare `/…`. Then open a PR.
