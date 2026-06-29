# create-gh-pages-site

Scaffold a working **GitHub Pages** website from a vetted template and wire it to
deploy automatically — packaged as a GitHub Copilot skill.

Pick a template (static, Astro, React + Vite, Eleventy, or Jekyll); the skill
injects the correct **base path** for your repo, adds the current official GitHub
Actions Pages workflow, drops it into your repo (current or new), and tells you how
to turn Pages on.

## Quickstart

**1. Install the skill** (global, for GitHub Copilot):

```sh
npx skills add jongio/skills --skill create-gh-pages-site -g --agent github-copilot
```

**2. Reload skills** — run `/skills reload`, or start a new session.

**3. Ask Copilot to build a site:**

```
/create-gh-pages-site an Astro blog for my repo octocat/blog
```

The agent picks the `astro` template, sets `site`/`base` for `octocat/blog`, lays
down the deploy workflow, and shows you how to enable Pages.

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

The generator stamps the same site the skill uses:

```sh
# An Astro site for a project repo (base = /blog/):
node scripts/new-site.mjs astro --repo octocat/blog --site-name "Octocat's Blog"

# A React SPA:
node scripts/new-site.mjs react-vite --repo octocat/dashboard

# A user site (served from "/") or a quick local scaffold:
node scripts/new-site.mjs static-html --base / --dir ./site

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

Templates live in `templates/<name>/`, each with a `template.json` manifest the
generator reads (and the [`jongio/gh-pages-templates`](https://github.com/jongio/gh-pages-templates)
registry gallery renders). Adding a template is a folder + a manifest — see
[`CONTRIBUTING.md`](CONTRIBUTING.md). The generator's `--registry owner/repo` flag
can fetch templates from that remote registry, so the browsable gallery + live
previews live there, not in this skill.

## Run the tests

```sh
npm test
# node test/generator.test.mjs && node test/workflow.test.mjs
```

No dependencies to install — the tests run on bare `node` (18+). They stamp every
template, assert the base path is injected with no leftover placeholders, and
validate each deploy workflow (permissions, concurrency, official actions, no
deprecated ones).

## Layout

```
SKILL.md                     The skill (authoring contract + workflow)
templates/                   The bundled, deployable templates
  static-html/  astro/  react-vite/  eleventy/  jekyll/
    template.json            Manifest (consumed by the generator)
    .github/workflows/deploy.yml   Pages deploy workflow
scripts/
  new-site.mjs               Generator — stamp a site, inject the base path
  install-local.ps1          Install this skill into $COPILOT_HOME/skills
test/                        Generator and workflow tests (bare node)
```

## License

MIT — see [LICENSE](./LICENSE).
