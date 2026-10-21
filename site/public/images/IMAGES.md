# Images

What lives in `site/public/images/`, what uses it, and which files are spare assets.

## Shared site artwork

| File | Used by | Purpose | Recommended size |
| --- | --- | --- | --- |
| `og.svg` / `og.png` | `<meta og:image>` uses the PNG | Collection overview social card; SVG is the editable source. | 1200×630 |
| `favicon.svg` | _(not referenced — the root `public/favicon.svg` is used)_ | Optional. | 64×64 |
| `hero.svg` | _(spare)_ | Optional hero banner if you add one. | 1280×640 |
| `item-thumb.svg` | _(spare)_ | Superseded by generated `thumb-<skill>.png` art. | 640×400 |

## Skill thumbnails

Every skill's card and detail page uses `thumb-<skill>.png`, set by the `thumb:`
frontmatter field in `site/src/content/skills/<skill>.md`. Provider and prompt
provenance is recorded in
[`docs/thumbnail-prompts.md`](../../../docs/thumbnail-prompts.md). The tracked
source is `skills/<skill>/thumbnail.png`; `npm run dev` and `npm run build`
validate all catalog mappings and generate byte-identical public copies.

| File | Used by | Notes |
| --- | --- | --- |
| `thumb-backlog-groom.png` | `backlog-groom` card/detail | Azure GPT Image 2 planning console with multi-repository issues, evidence checks, and pending work. |
| `thumb-create-canvas-app.png` | `create-canvas-app` card/detail | Canvas extension panel beside the Copilot composer. |
| `thumb-create-gh-pages-site.png` | `create-gh-pages-site` card/detail | Astro site scaffold deploying to GitHub Pages. |
| `thumb-create-skill.png` | `create-skill` card/detail | Azure OpenAI generated thumbnail for complete skill authoring and registration. |
| `thumb-create-skills-repo.png` | `create-skills-repo` card/detail | Azure OpenAI generated thumbnail for cross-agent repository setup. |
| `thumb-deps-doctor.png` | `deps-doctor` card/detail | Dependency graph on a slate console, amber packages upgrading left to right into green ones, inspected by a stethoscope lens. Byte parity with the skill copy is asserted by a test. |
| `thumb-dns-doctor.png` | `dns-doctor` card/detail | DNS diagnostic workstation, record cards, and stethoscope. |
| `thumb-git-tidy.png` | `git-tidy` card/detail | Git branch tree being tidied, merged branches swept up while protected branches are kept. Byte parity with the skill copy is asserted by a test. |
| `thumb-eli5.png` | `eli5` card/detail | Byte parity with the skill copy is asserted by a test. |
| `thumb-naming-is-hard.png` | `naming-is-hard` card/detail | Candidate names screened across registries. |
| `thumb-nobs.png` | `nobs` card/detail | Concise chat-panel wordmark; source and provider provenance live with the skill. |
| `thumb-repo-ready.png` | `repo-ready` card/detail | Repository health checklist with gap indicators. |
| `thumb-test-doctor.png` | `test-doctor` card/detail | Test diagnostic console transforms amber gaps into verified green test cards; generated source and provider provenance live with the skill. |
| `thumb-pr.png` | `pr` card/detail | Pull request checklist workflow from local commit and preflight checks through review resolution, CI, and merge. |
| `thumb-go.png` | `go` card/detail | Azure GPT Image 2 workflow dashboard from plan and tests through implementation, review, and merge. |
| `thumb-refactor.png` | `refactor` card/detail | Azure GPT Image 2 code cleanup diagram with three depth choices and a behavior-preservation shield. |

## Statusline diagrams

The four guides in `public/screenshots/` embed vector outlines of the actual
runtime icon code points, sourced from CaskaydiaCove Nerd Font. Readers do not
need that font installed. The guide tests compare icon mappings with the PR,
issue, and subagent trackers. The three standalone PNG diagrams and extension
copies are rendered from those SVGs. Close-up PNGs retain the original terminal
glyphs with their technical title bars removed.

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
- Adding a skill? Write a prompt in [`docs/thumbnail-prompts.md`](../../../docs/thumbnail-prompts.md)
  following the house style documented there, generate the art, save it as
  `skills/<skill>/thumbnail.png`, and point `thumb:` at
  `images/thumb-<skill>.png` in `src/content/skills/<skill>.md`. Run
  `npm run sync:thumbnails`; generated public copies are ignored by Git.
