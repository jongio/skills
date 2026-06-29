# Images to supply

These are **placeholders** for the jongio/skills site. Replace each file in
`site/public/images/` with real art, keep the filename (or update the reference),
and aim for the listed size. Delete this file once every image is real.

| File | Used by | Purpose | Recommended size |
| --- | --- | --- | --- |
| `og.svg` | `<meta og:image>` | Social share card. Replace with a raster `og.png` (scrapers ignore SVG) and update the meta tag in `src/layouts/Layout.astro`. | 1200×630 |
| `favicon.svg` | _(not referenced — the root `public/favicon.svg` is used)_ | Optional. | 64×64 |
| `hero.svg` | _(spare)_ | Optional hero banner if you add one. | 1280×640 |
| `thumb-create-gh-pages-site.svg` | `create-gh-pages-site` card/detail | Skill thumbnail. | 640×400 |
| `item-thumb.svg` | _(spare)_ | Generic per-skill thumbnail to copy when you add a skill. | 640×400 |

## Already real (no action needed)

| File | Used by | Notes |
| --- | --- | --- |
| `invoke-create-canvas-app.png` | `create-canvas-app` card/detail | Copied from `skills/create-canvas-app/docs/invoke.png`. |

Tips:
- Export at 2× for crisp display on high-DPI screens, then keep the file small.
- PNG for screenshots/photos, SVG for logos/diagrams.
- A placeholder left in place still deploys fine; it just visibly says "replace me".
- Adding a skill? Drop a `thumb-<skill>.svg` here (copy `item-thumb.svg`) and set
  `thumb:` in the skill's Markdown frontmatter under `src/content/skills/`.
