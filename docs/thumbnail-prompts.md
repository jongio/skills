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

The catalog site also keeps a copy at `site/public/images/thumb-<skill>.png`, referenced
from `site/src/content/skills/<skill>.md` frontmatter.

## House style

Every thumbnail shares this visual language (hold it constant; vary only the scene and
the per-skill accent color):

- Flat vector illustration, **pure white background**, 1024x1024, centered composition.
- Clean modern rounded shapes, soft long shadows, subtle dashed guide lines, tiny sparkles.
- The **GitHub Octocat** appears as a small mark somewhere in the scene.
- Green check marks for "available / done"; a coherent per-skill accent palette.
- Minimal text, crisp and professional, no photorealism.

Per-skill accent: `create-canvas-app` = purple/indigo, `create-gh-pages-site` =
blue/green, `repo-ready` = GitHub green, `naming-is-hard` = rose pink + green.

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
