# create-gh-pages-site

Scaffold a working **GitHub Pages** website from a vetted template and wire it to
deploy automatically — packaged as a GitHub Copilot skill.

Pick a template (static, Astro, React + Vite, Eleventy, or Jekyll); the skill
injects the correct **base path** for your repo, adds the current official GitHub
Actions Pages workflow, drops it into your repo (the **current repo by default**, or
a new one), and tells you how to turn Pages on.

It doesn't stop at the template's demo content, either: it **digests your repo**
(README, manifests, entry points, docs) and authors a site that's actually about
your project — a CLI reference, an API/usage page, a feature tour, or a catalog of
parts — and drops in labeled image placeholders you swap for real art.

## Quickstart

**1. Install the skill** (global, for GitHub Copilot):

```sh
npx skills add jongio/skills --skill create-gh-pages-site -g --agent github-copilot
```

**2. Reload skills** — run `/skills reload`, or start a new session.

**3. Ask Copilot to build a site:**

```
/create-gh-pages-site put this repo on GitHub Pages as an Astro blog
```

By default the agent scaffolds for the **repo you're in** — it reads the current
repo from git, picks the `astro` template, sets `site`/`base` for it, lays down the
deploy workflow, and shows you how to enable Pages. Name a different repo
(`octocat/blog`) only when you want one.

## Why this exists

GitHub Pages' hard parts aren't the HTML — they're the deploy plumbing and the
**base-path trap**: a project site lives at `https://USER.github.io/REPO/`, so a
site built for `/` ships with broken assets and links. Every framework fixes this
differently (Astro `base`, Vite `base` + `404.html`, Eleventy `pathPrefix`, Jekyll
`baseurl`). This skill gets all of it right, every time.

## Templates

| Template | Use it for | Base path | Build |
| --- | --- | --- | --- |
| `static-html` | landing pages, a few hand-made pages | relative URLs (immune) | none |
| `astro` | content sites, blogs, docs, marketing | `base` in `astro.config.mjs` | `astro build` |
| `react-vite` | interactive SPAs / dashboards | `base` + `404.html` fallback | `vite build` |
| `eleventy` | data/Markdown-driven sites | `pathPrefix` via env + `url` filter | `eleventy` |
| `jekyll` | GitHub-native / existing Jekyll | `baseurl` in `_config.yml` | Jekyll |

All five deploy via the **GitHub Actions** Pages source using the current
first-party actions (`configure-pages@v5` → `upload-pages-artifact@v3` →
`deploy-pages@v4`; Astro/Jekyll use their official actions). No `gh-pages` branch.

Browse them in the live [gallery with previews](https://jongio.github.io/gh-pages-templates/),
hosted from the [`jongio/gh-pages-templates`](https://github.com/jongio/gh-pages-templates) registry.

## Tailored to your repo, not a demo

A stamped template is a skeleton, not the deliverable. After stamping, the skill
reads your repo and rewrites the content to match it:

- **`scripts/digest-repo.mjs`** analyzes the repo and classifies it — `cli`,
  `library`, `app`, `action`, `collection`, `docs`, or `site` — and pulls out the
  name, pitch, install commands, README usage examples, badges, docs, existing
  images, and sub-projects. That drives *which* kind of site gets built: a command
  reference for a CLI, an API/usage page for a library, a feature tour for an app, a
  catalog for a monorepo.
- **`scripts/make-placeholder.mjs`** drops labeled placeholder images (logo, social
  card, hero, screenshots) into the site plus an `IMAGES.md` checklist telling you
  what to supply and at what size. Real images the repo already has are reused
  instead.

```sh
node scripts/digest-repo.mjs --dir . --json          # see what the author sees
node scripts/make-placeholder.mjs --out site/public/images --preset cli --repo octocat/mytool
```

## Use it

Once installed, describe the site you want:

```
/create-gh-pages-site a docs site with Eleventy in a new repo called octocat/docs
```

```
/create-gh-pages-site put this folder of HTML on Pages
```

You don't have to name the skill — the agent routes to it whenever you ask to
create or publish a GitHub Pages site.

## Build it yourself (no agent)

The generator stamps the same site the skill uses. Templates are fetched from the
[`jongio/gh-pages-templates`](https://github.com/jongio/gh-pages-templates) registry
(a shallow clone), so it needs git + network unless you pass `--templates-dir`:

```sh
# Scaffold for the CURRENT repo (base path read from its origin remote):
node scripts/new-site.mjs astro

# An Astro site for a specific project repo (base = /blog/):
node scripts/new-site.mjs astro --repo octocat/blog --site-name "Octocat's Blog"

# A React SPA:
node scripts/new-site.mjs react-vite --repo octocat/dashboard

# A user site (served from "/") or a quick local scaffold:
node scripts/new-site.mjs static-html --base / --dir ./site

# Offline, from a local registry checkout:
node scripts/new-site.mjs astro --templates-dir ../gh-pages-templates/templates

# List templates:
node scripts/new-site.mjs --list
```

Then push to `main` and set **Settings → Pages → Source → GitHub Actions**. The
workflow publishes on every push; the live URL appears in the Actions run. Point
the repo's "Website" link at it with `gh repo edit OWNER/REPO --homepage <site-url>`
(the same as checking *"Use your GitHub Pages website"*).

## Install options

```sh
# Into the current project (.agents/skills/create-gh-pages-site/):
npx skills add jongio/skills --skill create-gh-pages-site

# Pin to a branch or tag:
npx skills add jongio/skills#main --skill create-gh-pages-site
```

**Copilot plugin marketplace:**

```sh
copilot plugin marketplace add jongio/skills
copilot plugin install create-gh-pages-site@jongio-skills
```

**Local install (no network):**

```sh
pwsh -File scripts/install-local.ps1
```

After any install, reload skills with `/skills reload` or a new session.

## A contributable registry

Templates live **only** in the
[`jongio/gh-pages-templates`](https://github.com/jongio/gh-pages-templates) registry
— each a folder with a `template.json` manifest. The generator fetches them from
there by default (override with `--registry owner/repo`, or scaffold offline with
`--templates-dir <path>`). The browsable gallery + live previews are hosted from the
registry too. Adding or fixing a template is a PR to that repo — see its
`CONTRIBUTING.md`. This skill owns the generator + the agent workflow, not the
templates.

## Run the tests

```sh
npm test
# node test/generator.test.mjs && node test/digest.test.mjs
```

No dependencies to install — the tests run on bare `node` (18+), fully offline. They
exercise the generator's base-path math, repo detection, and template stamping
against a local fixture (sentinels fully replaced, `template.json`/`node_modules`
skipped, user-site collapse to `/`), plus the repo-digest classifier and the
placeholder generator. Template + deploy-workflow validation lives in the registry.

## Layout

```
SKILL.md                     The skill (authoring contract + workflow)
scripts/
scripts/
  new-site.mjs               Generator — fetch a template, inject the base path
  digest-repo.mjs            Analyze a repo → JSON signals + type classification
  make-placeholder.mjs       Generate placeholder images + an IMAGES.md checklist
  install-local.ps1          Install this skill into $COPILOT_HOME/skills
test/                        Generator and digest tests (bare node, offline fixture)
```

## License

MIT — see [LICENSE](./LICENSE).
