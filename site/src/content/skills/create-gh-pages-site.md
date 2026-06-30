---
title: create-gh-pages-site
tagline: "Scaffold a working GitHub Pages site from a vetted template (static, Astro, React + Vite, Eleventy, or Jekyll) — the correct base path, the official GitHub Actions deploy, and content authored from your repo."
useWhen: "When you want to publish a static page, an Astro/Eleventy site, a React (Vite) SPA, or a Jekyll site to GitHub Pages — with the base path and deploy pipeline wired correctly."
repoPath: skills/create-gh-pages-site
gallery: https://jongio.github.io/gh-pages-templates/
thumb: images/invoke-create-gh-pages-site.png
order: 2
install:
  - label: Install for GitHub Copilot
    cmd: npx skills add jongio/skills --skill create-gh-pages-site -g --agent github-copilot
  - label: Install from the plugin marketplace
    cmd: copilot plugin install create-gh-pages-site@jongio-skills
---

## What it does

The hard part of GitHub Pages isn't the HTML — it's the deploy plumbing and the
**base-path trap**: a project site is served from `https://USER.github.io/REPO/`, so a
site built for `/` ships with broken assets and links. `create-gh-pages-site` gets
both right:

- **Picks the right template** — `static-html`, `astro`, `react-vite`, `eleventy`,
  or `jekyll` — for what you're building.
- **Injects the correct base path** for the target repo (the #1 thing people get
  wrong), per framework.
- **Ships the official GitHub Actions Pages workflow** — no `gh-pages` branch.
- **Authors content from your repo.** It digests the repo (README, manifests,
  entry points, docs) and writes a site about *your* project — a CLI reference, an
  API/usage page, a feature tour, or a catalog — with image placeholders you swap in.

## When to reach for it

Use it to create or publish a GitHub Pages site. It is **not** for non-Pages hosting
(Vercel/Netlify/Azure) or for deploying an app that has no Pages target.

## Use it

Describe the site you want; the agent routes to the skill:

```text
/create-gh-pages-site an Astro docs site for my repo octocat/blog
```

This very site was built by the skill — `jongio/skills` digested as a *collection*,
rendered as a catalog of its skills.
