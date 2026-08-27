# Skill thumbnail prompts

How the `skills/<name>/thumbnail.png` images are generated, and the exact prompts
used, so every skill's thumbnail follows the same path and house style.

## The path: Azure OpenAI `gpt-image-2`

All skill thumbnails are generated with the **`gpt-image-2`** deployment on Azure
OpenAI (the same path used for the first batch of thumbnails in commit
`e41439f`, "add GPT Image 2 generated thumbnails for all shipped skills").

| Setting | Value |
|---|---|
| Resource | your Azure OpenAI resource (see the placeholders below) |
| Endpoint | `https://<your-aoai-resource>.openai.azure.com/` |
| Deployment | `gpt-image-2` |
| Operation | `POST /openai/deployments/gpt-image-2/images/generations` |
| api-version | `2025-04-01-preview` |
| Size | `1024x1024` |
| Quality | `high` |
| Auth | keyless: `az account get-access-token --resource https://cognitiveservices.azure.com` |
| Response | `data[0].b64_json` (decode to the PNG) |

### Reproduce

```powershell
$env:AOAI_TOKEN = az account get-access-token --resource https://cognitiveservices.azure.com --query accessToken -o tsv
$env:AOAI_ENDPOINT = "https://<your-aoai-resource>.openai.azure.com"
$env:OUT = "skills/<skill>/thumbnail.png"
$env:PROMPT = "<the prompt for this skill, see below>"
@'
import os, json, base64, urllib.request
tok=os.environ["AOAI_TOKEN"]; ep=os.environ["AOAI_ENDPOINT"].rstrip("/")
url=f"{ep}/openai/deployments/gpt-image-2/images/generations?api-version=2025-04-01-preview"
body=json.dumps({"prompt":os.environ["PROMPT"],"size":"1024x1024","n":1,"quality":"high"}).encode()
req=urllib.request.Request(url,data=body,headers={"Authorization":f"Bearer {tok}","Content-Type":"application/json"})
d=json.load(urllib.request.urlopen(req,timeout=240))
open(os.environ["OUT"],"wb").write(base64.b64decode(d["data"][0]["b64_json"]))
print("saved", os.environ["OUT"])
'@ | python -
```

The catalog site also keeps a PNG or SVG asset at
`site/public/images/thumb-<skill>.<ext>`, referenced from
`site/src/content/skills/<skill>.md` frontmatter.

## House style

Every thumbnail shares this visual language (hold it constant; vary only the scene and
the per-skill accent color):

- Flat vector illustration, **pure white background**, 1024x1024, centered composition.
- Clean modern rounded shapes, soft long shadows, subtle dashed guide lines, tiny sparkles.
- The **GitHub Octocat** appears as a small mark somewhere in the scene.
- Green check marks for "available / done"; a coherent per-skill accent palette.
- Minimal text, crisp and professional, no photorealism.

### The recurring structure

Reviewing the shipped set, four things repeat in every one of them and are worth
stating outright, because a prompt that omits them produces an image that looks
adjacent to the catalog rather than part of it.

1. **One hero surface holds the scene.** A browser window, a console panel, a
   card, or an open folder. The subject sits inside or on that surface rather
   than floating as loose icons. `create-canvas-app` and `create-gh-pages-site`
   use a browser chrome, `dns-doctor` and `deps-doctor` a dark console,
   `naming-is-hard` a swipe card, `repo-ready` an intake box.
2. **A left-to-right or top-to-bottom transformation.** Messy or old on one
   side, resolved or current on the other, joined by arrows or dashed
   connectors: tangle to clean grid in `eli5`, drafts to published globe in
   `create-gh-pages-site`, Octocat down into the folder in `repo-ready`, amber
   to green packages in `deps-doctor`. The reader should see a direction.
3. **Status is carried by badge, not by prose.** Small circular green checks,
   an amber warning, a red problem dot. This is what survives the downscale.
4. **The Octocat is a small mark with a dotted tether**, usually upper-right,
   never the subject of the image.

### Two legitimate text treatments, and nothing in between

The set splits cleanly, and a new thumbnail should commit to one side:

- **Wordmark.** The skill's name is the artwork, set large and deliberate.
  `naming-is-hard` and `eli5` do this; the words are the product, so they earn
  the space.
- **Diagram.** No readable characters at all. Labels are faked with short
  abstract dashes and rounded pills. `create-canvas-app`,
  `create-gh-pages-site`, `repo-ready`, `dns-doctor`, and `deps-doctor` do this.

The failure mode is landing between the two: many small real labels that are
neither the hero nor abstract. The catalog card renders a 1024x1024 square,
letterboxed by `object-fit: contain` into a 16:10 box, at roughly **175 pixels**.
At that size incidental text is texture. Before committing a thumbnail,
downscale it to 175 pixels and confirm the concept still reads.

### Drawing real-world objects

Image models reliably mangle objects with branching parts. A stethoscope is the
one in this catalog: it must be a single continuous instrument with exactly two
ear tubes meeting at one Y junction and exactly one tube continuing to the chest
piece. Spell that out and add "no extra tubes, no floating or disconnected tube
segments" to the negative list, or the result grows a spare tube.

More generally, close every prompt with an explicit negative list. The
`dns-doctor` and `deps-doctor` prompts below show the pattern: bar words,
letters, numerals, fake text, photorealism, 3D, and whatever specific artifact
that scene tends to attract.

Per-skill accent: `create-canvas-app` = purple/indigo, `create-gh-pages-site` =
blue/green, `repo-ready` = GitHub green, `naming-is-hard` = rose pink + green,
`eli5` = sky blue + warm amber.
`dns-doctor` = DNS blue + health green + warning amber.
`deps-doctor` = slate graphite + warning amber to health green.
`git-tidy` = git orange + GitHub green + navy.

## Prompts

> Provenance note: the verbatim prompt strings for the first three skills were sent to
> `gpt-image-2` and were not saved at the time (only the PNGs were committed). Azure kept
> no retrievable logs (no diagnostic settings on the resource) and the originating Copilot
> session could not be re-read (its stored rows embed the base64 images and time out).
> The three descriptions below are therefore **reconstructed from the committed images**
> to capture the same intent and style. The `naming-is-hard` prompt is the **exact** text
> used. When regenerating, prefer these as the source of truth going forward.

### create-canvas-app (reconstructed)

> Flat vector illustration app thumbnail, pure white background, 1024x1024. A modern app
> builder / canvas editor window with a dark navy left sidebar containing the GitHub
> Octocat and small tool icons (grid, branch, cube), an indigo tool rail, and a light
> canvas showing a selected area chart with resize handles, a small bar-chart card, a
> dashed drop zone with a plus, a floating component card, and a checklist plus a small
> kanban of colored sticky notes. Purple and indigo palette with soft lavender, clean
> flat design, rounded corners, subtle shadows, minimal text, no photorealism.

### create-gh-pages-site (reconstructed)

> Flat vector illustration app thumbnail, pure white background, 1024x1024, centered. A
> browser window mockup on the left showing a simple site (hero image, text lines, three
> content cards, a dashed add row) with small content-block cards feeding into it, and on
> the right a cloud with a blue globe (a published site) lit by a small sun. The GitHub
> Octocat at top right connects down with a green solid arrow and a blue dashed line
> (deploy). Blue and green palette, flat design, rounded shapes, dashed guide lines,
> minimal text, no photorealism.

### repo-ready (reconstructed)

> Flat vector illustration app thumbnail, pure white background, 1024x1024, centered. A
> green open folder / intake box holding a row of five white document cards, each with a
> distinct icon (license scales, people/community, a workflow with checkmarks, an issue
> template list, and a code file), each card with a small green check badge. The GitHub
> Octocat floats above with dashed arrows pointing down into the folder, and a git-branch
> icon sits in a white circle on the front of the box. GitHub-green palette, sparkles,
> flat design, rounded shapes, minimal text, no photorealism.

### naming-is-hard (exact prompt used)

> Flat vector illustration app thumbnail on a pure white background, 1024x1024, centered
> composition, clean modern rounded shapes with soft long shadows, subtle dashed guide
> lines and tiny sparkles. Theme: a playful dating app for naming a software project,
> promoting a tool called naming is hard. Center: a tilted rounded dating profile swipe
> card whose big bold headline reads the exact words 'naming is hard' on two or three
> lines, with a small heart between angle brackets logo above the words and two little
> vibe tags below them; a big soft green heart badge on the card right edge for swipe
> right to like a match, and a faint light gray X circle on the left; two more cards peek
> behind it like a deck to swipe through. Around the card, three small circular
> availability badges each with a green check mark: a globe dot com badge, the GitHub
> Octocat mark, and an at sign social handle badge. Below the card, a row of three small
> rounded verdict pills with the exact labels 'Deal Breaker' in red, 'Its Complicated' in
> amber, and 'Perfect Match' in green. Include the GitHub Octocat logo as a clean small
> mark. Palette warm rose pink and GitHub green with soft lavender accents on white,
> generous white space, crisp professional flat design, clean legible sans serif text, no
> photorealism.

### eli5 (exact prompt used)

> Flat vector illustration app thumbnail on a pure white background, 1024x1024,
> centered composition, clean modern rounded shapes with soft long shadows,
> subtle dashed guide lines and tiny sparkles. Theme: turning something
> complicated into a simple and honest explanation, promoting a tool called ELI5.
> Left third: a rounded light gray panel holding a tangled knot of overlapping
> wires, a jagged zigzag line chart and four dense unreadable gray text lines,
> representing the confusing original. Middle: a short thick amber arrow pointing
> right, with two tiny sparkles above it. Right two thirds: a rounded sky blue
> panel holding four evenly spaced white rounded tiles in a two by two grid, each
> tile carrying one simple icon and a small green check badge in its corner, in
> this order: a glowing light bulb for the big idea, two interlocking puzzle
> pieces for the familiar comparison, a small luggage style name tag for the real
> terms, and a dashed boundary line with one small amber dot for the point where
> the comparison stops working. Above the blue panel, a small rounded pill banner
> shows the exact word 'ELI5' in clean bold sans serif. Include the GitHub Octocat
> logo as a clean small mark in the top right corner, linked to the scene by a
> thin dashed guide line. Palette sky blue and warm amber with GitHub green check
> marks and soft neutral gray for the confusing side, generous white space, crisp
> professional flat design, clean legible sans serif text, no photorealism.
### dns-doctor (exact prompt used)

> Flat vector illustration app thumbnail on a pure white background, 1024x1024,
> centered composition, matching a polished GitHub developer-tools catalog.
> Create one cohesive DNS diagnostic workstation scene, not a generic icon
> panel. Center: a large dark-navy browser-style diagnostic console with rounded
> corners and soft long shadow. Inside it, show a luminous blue domain globe at
> the top branching through clean dashed routing lines to three distinct DNS
> record cards below: an A record card with a server icon, an MX record card
> with an envelope icon, and a TLS certificate card with a shield icon. Each
> record card has crisp layered details and a small status badge: two green
> checks and one amber warning. Wrap a teal stethoscope around the domain globe,
> with its chest piece becoming a blue magnifying lens inspecting the amber
> record. Add a tiny red broken-link indicator on one branch to suggest
> diagnosis without making the scene alarming. Place a small GitHub Octocat
> mark in a circular badge near the upper-right, connected to the console by a
> subtle dotted guide line. Palette: deep GitHub navy, Azure blue, teal and
> health green, amber warning, very restrained coral red. Rich but uncluttered
> flat vector detail, clean modern rounded geometry, consistent medium-weight
> outlines, subtle dashed guide lines, tiny sparkles, generous white space,
> crisp professional finish. No words, no letters, no fake text, no
> photorealism, no 3D render, no giant magnifying glass obscuring the
> composition, no ECG pulse line.

### deps-doctor (exact prompt used)

> Generated against the `gpt-image-2` deployment on `jong-image-westus3`. The
> earlier thumbnail for this skill was a dense infographic carrying roughly
> twenty separate text labels, which is unreadable at the size the catalog card
> actually renders: a 1024x1024 square is letterboxed by `object-fit: contain`
> into a 16:10 card about 175 pixels tall, so every label became texture. This
> prompt follows the `dns-doctor` pattern instead, one hero object with a few
> supporting elements and no real words anywhere, and it was verified by
> downscaling the result to 175 pixels and confirming the concept still reads.
> The stethoscope anatomy is spelled out segment by segment because the first
> generation grew a spare tube that connected to nothing.

> Flat vector illustration app thumbnail on a pure white background, 1024x1024,
> centered composition, matching a polished GitHub developer-tools catalog.
> Create one cohesive dependency health-check scene, not a dashboard of panels.
> Center: a large rounded slate-graphite console with a soft long shadow holding
> a tidy branching dependency graph built from rounded package cubes. The left
> side of the graph is a cluster of warning-amber cubes, the right side is a
> cluster of health-green cubes, and clean dashed upgrade arcs sweep from left
> to right only, never right to left, so the direction of travel is
> unmistakable. Drape one single continuous stethoscope across the lower left of
> the scene. The stethoscope has exactly two short ear tubes at the top that
> curve together and meet at one Y junction, and exactly one single tube
> continuing from that junction down to one round chest piece. The chest piece
> is a magnifying lens resting over one amber cube. Draw exactly three tube
> segments in total and nothing else: two above the Y junction and one below it.
> Every tube end must terminate either at an ear tip or at the chest piece. Give
> one green cube a small shield badge, and give one amber cube a small hourglass
> badge to suggest a release deliberately held back. Add two small green check
> badges on green cubes. Place a small GitHub Octocat mark in a circular badge
> near the upper-right, connected to the console by a subtle dotted guide line.
> Suggest any labels only as short abstract dashes and rounded pills, never as
> readable characters. Palette: slate graphite base, warning amber, health
> green, one cool blue accent on the lens, generous white space. Rich but
> uncluttered flat vector detail, clean modern rounded geometry, consistent
> medium-weight outlines, subtle dashed guide lines, tiny sparkles, crisp
> professional finish. No extra tubes, no third tube, no floating or
> disconnected tube segments, no tube that loops around the console, no
> duplicated stethoscope, no words, no letters, no numerals, no version strings,
> no fake text, no checklist rows, no pause or play icons, no cartoon mascot or
> face, no photorealism, no 3D render.

### git-tidy (exact prompt used)

> Flat vector illustration app thumbnail on a pure white background, 1024x1024,
> centered composition, matching a polished GitHub developer-tools catalog.
> Create one cohesive git repository cleanup scene, not a generic icon panel.
> Center: a clean git branch graph as rounded nodes connected by smooth curved
> lines growing from a strong navy trunk on the left. The top two branches are
> tidy and kept, each ending in a small green check badge, and one carries a
> tiny navy padlock to mean protected. Two lower stale branches are faded gray
> and dashed, gently detaching from the trunk and being swept up by a friendly
> rounded broom whose bristles are git orange, with a small dustpan collecting
> three faded branch nodes and a couple of tiny sparkles for freshness. Include
> small supporting cards near the bottom edge: a worktree folder card, a stash
> card, and a tag card, each with a subtle status dot. Place a small GitHub
> Octocat mark in a circular badge near the upper-right, connected to the scene
> by a subtle dotted guide line. Palette: deep GitHub navy, git orange, and
> health green, with soft neutral gray for the stale branches. Rich but
> uncluttered flat vector detail, clean modern rounded geometry, consistent
> medium-weight outlines, subtle dashed guide lines, tiny sparkles, generous
> white space, crisp professional finish. No words, no letters, no fake text,
> no photorealism, no 3D render.
