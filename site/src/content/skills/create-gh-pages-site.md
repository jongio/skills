---
title: create-gh-pages-site
tagline: "Turn your repository into a GitHub Pages site with project-specific content and an automated deployment workflow."
useWhen: "When you want to publish a static page, an Astro/Eleventy site, a React (Vite) SPA, or a Jekyll site to GitHub Pages — with the base path and deploy pipeline wired correctly."
repoPath: skills/create-gh-pages-site
gallery: https://jongio.github.io/gh-pages-templates/
thumb: images/thumb-create-gh-pages-site.png
order: 2
install:
  - label: Install for GitHub Copilot
    cmd: npx skills add jongio/skills --skill create-gh-pages-site
  - label: Install from the plugin marketplace
    cmd: copilot plugin install create-gh-pages-site@jongio-skills
---

## What it does

`create-gh-pages-site` builds a site about your project and configures it for
GitHub Pages (targeting the **current repository by default**, or a named repository):

- **Picks the right template** — `static-html`, `astro`, `react-vite`, `eleventy`,
  `jekyll`, `skills-catalog` (browsable skills marketplace catalog), or `spectator`
  (reviewable VitePress specification) — for what you're building.
- **Configures links and assets** for your repository's Pages address, including its project-site subdirectory (`/<repo>/`) or user-site root (`/`).
- **Adds automated deployment** through a commit-pinned, least-privilege GitHub Actions workflow and sets the repository's Website homepage link.
- **Writes project-specific content** from your README, code, and documentation:
  a CLI reference, usage guide, feature tour, specification, or catalog.
- **Marks missing images** with labeled placeholders and an `IMAGES.md` checklist so you can replace them before publishing, while reusing existing repo images.
- **Supports fail-closed `--staging-dir` composition** for tools like `create-skills-repo`.

## When to reach for it

Use it to create or publish a GitHub Pages site. It is **not** for non-Pages hosting
(Vercel/Netlify/Azure) or for deploying an app that has no Pages target.

## Use it

Describe the site you want; the agent routes to the skill:

```text
/create-gh-pages-site an Astro docs site for my repo octocat/blog
```

Include the audience and purpose in your request: documentation for contributors,
a product overview, or a browsable catalog.
