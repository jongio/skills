# Images

What lives in `site/public/images/`, what uses it, and what is still a
placeholder waiting on real art.

## Placeholders (replace these)

Keep the filename (or update the reference) and aim for the listed size.

| File | Used by | Purpose | Recommended size |
| --- | --- | --- | --- |
| `og.svg` | `<meta og:image>` | Social share card. Replace with a raster `og.png` (scrapers ignore SVG) and update the meta tag in `src/layouts/Layout.astro`. | 1200×630 |
| `favicon.svg` | _(not referenced — the root `public/favicon.svg` is used)_ | Optional. | 64×64 |
| `hero.svg` | _(spare)_ | Optional hero banner if you add one. | 1280×640 |
| `item-thumb.svg` | _(spare)_ | Superseded by generated `thumb-<skill>.png` art. | 640×400 |

## Skill thumbnails (all real)

Every skill's card and detail page uses `thumb-<skill>.png`, set by the `thumb:`
frontmatter field in `site/src/content/skills/<skill>.md`. Each one is generated
with `gpt-image-2` from the matching prompt in
[`docs/thumbnail-prompts.md`](../../../docs/thumbnail-prompts.md) and is a byte-identical
copy of `skills/<skill>/thumbnail.png`.

| File | Used by | Notes |
| --- | --- | --- |
| `thumb-create-canvas-app.png` | `create-canvas-app` card/detail | Canvas extension panel beside the Copilot composer. |
| `thumb-create-gh-pages-site.png` | `create-gh-pages-site` card/detail | Astro site scaffold deploying to GitHub Pages. |
| `thumb-deps-doctor.png` | `deps-doctor` card/detail | Dependency graph on a slate console, amber packages upgrading left to right into green ones, inspected by a stethoscope lens. Byte parity with the skill copy is asserted by a test. |
| `thumb-dns-doctor.png` | `dns-doctor` card/detail | DNS diagnostic workstation, record cards, and stethoscope. |
| `thumb-git-tidy.png` | `git-tidy` card/detail | Git branch tree being tidied, merged branches swept up while protected branches are kept. Byte parity with the skill copy is asserted by a test. |
| `thumb-eli5.png` | `eli5` card/detail | Byte parity with the skill copy is asserted by a test. |
| `thumb-naming-is-hard.png` | `naming-is-hard` card/detail | Candidate names screened across registries. |
| `thumb-repo-ready.png` | `repo-ready` card/detail | Repository health checklist with gap indicators. |

## Unreferenced (safe to delete)

Superseded when every skill moved to a generated `thumb-<skill>.png`. Nothing in
the repo links to these:

| File | Was used by |
| --- | --- |
| `invoke-create-canvas-app.png` | `create-canvas-app` card/detail |
| `invoke-create-gh-pages-site.png` | `create-gh-pages-site` card/detail |
| `invoke-repo-ready.svg` | `repo-ready` card/detail |

Tips:
- Export at 2× for crisp display on high-DPI screens, then keep the file small.
- PNG for screenshots/photos, SVG for logos/diagrams.
- A placeholder left in place still deploys fine; it just visibly says "replace me".
- Adding a skill? Write a prompt in [`docs/thumbnail-prompts.md`](../../../docs/thumbnail-prompts.md)
  following the house style documented there, generate the art, then save it as
  BOTH `skills/<skill>/thumbnail.png` and `site/public/images/thumb-<skill>.png`.
  The two copies must be byte-identical, and the skill's own test asserts it.
  Point `thumb:` at it in `src/content/skills/<skill>.md`.
