# create-gh-pages-site

Scaffold a working **GitHub Pages** website from a vetted template and wire it to
deploy automatically — packaged as a GitHub Copilot skill.

Pick a template (static, Astro, React + Vite, Eleventy, Jekyll, or skills catalog); the skill
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

```text
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
| `skills-catalog` | browsable catalogs for Copilot skills repositories | template base helper | registry-defined |

The built-in registry pin includes `skills-catalog`. Custom registries require a
full `--registry-ref`, and local checkouts use `--templates-dir`.

All templates deploy via the **GitHub Actions** Pages source. Every external action
must be pinned to a full commit SHA, checkout must disable persisted credentials,
and install steps must disable lifecycle scripts. No `gh-pages` branch is used.
Workflow scanning accepts a conservative block-style YAML subset and rejects
quoted keys, tags, anchors, aliases, merge keys, and unsupported flow mappings.

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

```text
/create-gh-pages-site a docs site with Eleventy in a new repo called octocat/docs
```

```text
/create-gh-pages-site put this folder of HTML on Pages
```

You don't have to name the skill — the agent routes to it whenever you ask to
create or publish a GitHub Pages site.

## Build it yourself (no agent)

The generator stamps the same site the skill uses. Templates are fetched from the
[`jongio/gh-pages-templates`](https://github.com/jongio/gh-pages-templates) registry
at an immutable commit, so it needs git + network unless you pass `--templates-dir`.
The built-in registry uses a reviewed pinned commit. A custom registry requires
`--registry-ref` with its full 40-character commit SHA:

Free-form metadata is limited to context-safe text because the same sentinel can
appear in HTML, JSON, YAML, and JavaScript. Markup, control characters, and
context-breaking quotes are rejected instead of being copied into generated code.

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

# A custom registry is always commit-pinned:
node scripts/new-site.mjs skills-catalog --repo octocat/skills \
  --author "Octo Cat" --marketplace-id octocat-skills --default-branch trunk \
  --registry octocat/templates --registry-ref 0123456789abcdef0123456789abcdef01234567

# List templates:
node scripts/new-site.mjs --list
```

## Safe staging for composition

`create-skills-repo` and other generators should stage the site instead of writing
into their target:

```sh
node scripts/new-site.mjs skills-catalog \
  --repo octocat/skills \
  --templates-dir ../gh-pages-templates/templates \
  --staging-dir ./.site-staging \
  --json
```

The staging contract is fail-closed:

1. `--staging-dir` must name a path that does not exist.
2. It cannot be combined with `--dir` or `--force`.
3. The generator copies and substitutes the template only in that directory.
4. It validates paths, symlinks, sentinels, and workflows before returning success.
5. It never reads or writes the consumer's final target. The consumer owns conflict
   detection and the final merge.
6. `--json` returns `mode`, `directory`, `template`, registry identity, and
   replacements so callers do not need to parse console prose.

Normal generation uses the same staging and validation pipeline internally, then
applies the validated tree to `--dir`. Existing `--force` behavior remains
available only for this explicit apply mode.

Earlier generator versions skipped symbolic links during rewriting. Current
versions reject every symbolic link before staging because templates can come from
an external registry.

The pinned built-in snapshot already uses immutable action commits. Compatibility
normalization remains restricted to that exact reviewed snapshot, rewrites only
known legacy forms, and always runs the same validator afterward. Custom registries
receive no migration and fail closed.

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
with each template in a folder containing a `template.json` manifest. The generator
fetches the built-in registry at a pinned commit. Override it with both
`--registry owner/repo` and `--registry-ref <full-sha>`, or scaffold offline with
`--templates-dir <path>`. The browsable gallery + live previews are hosted from the
registry too. Adding or fixing a template is a PR to that repo — see its
`CONTRIBUTING.md`. This skill owns the generator + the agent workflow, not the
templates.

## Run the tests

```sh
npm test
# node test/generator.test.mjs && node test/digest.test.mjs
```

No dependencies are needed. The tests run on bare `node` (18+) and never use the
network. They exercise base-path math, skills-catalog discovery, immutable local
registry checkout, staging, traversal and symlink rejection, sentinel validation,
workflow policy, repo digestion, and placeholder generation.

## Layout

```text
SKILL.md                     The skill (authoring contract + workflow)
scripts/
  new-site.mjs               Generator: fetch, stage, validate, and apply a template
  new-site-cli.mjs           Command-line parsing and machine-readable output
  template-registry.mjs      Immutable registry checkout and verification
  template-security.mjs      Path, symlink, sentinel, and workflow validation
  digest-repo.mjs            Analyze a repo → JSON signals + type classification
  make-placeholder.mjs       Generate placeholder images + an IMAGES.md checklist
  install-local.ps1          Install this skill into $COPILOT_HOME/skills
test/                        Generator and digest tests (bare node, offline fixture)
```

## License

MIT — see [LICENSE](./LICENSE).
