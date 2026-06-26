# jongio/skills

Jon Gallant's collection of [GitHub Copilot](https://docs.github.com/copilot)
skills — a general-purpose monorepo. Each skill lives in its own folder under
[`skills/`](skills/) with a `SKILL.md` authoring contract, and can be installed
individually or all at once.

## Skills

| Skill | What it does |
|---|---|
| [`create-canvas-kit`](skills/create-canvas-kit/) | Build GitHub Copilot App canvas extensions fast — a no-build Preact + htm kit with live SSE state, durable storage, Primer theming, official GitHub Lucide icons, a generator, and an installable skill. |

A skill is invoked straight from the Copilot composer &mdash; here `create-canvas-kit`
turns a one-line prompt into a working canvas:

![Invoking create-canvas-kit from the Copilot composer: "/create-canvas-kit customized stock ticker"](skills/create-canvas-kit/docs/invoke.png)

## Install

Uses the [`vercel-labs/skills`](https://github.com/vercel-labs/skills) CLI
(`skills.sh`) — note the binary is **`skills`** (plural).

```sh
# List the skills available in this repo:
npx skills add jongio/skills --list

# Install one skill globally for GitHub Copilot:
npx skills add jongio/skills --skill create-canvas-kit -g --agent github-copilot

# Install into the current project instead of globally (drop -g):
npx skills add jongio/skills --skill create-canvas-kit

# Install every skill in the repo:
npx skills add jongio/skills --all

# Pin to a branch or tag:
npx skills add jongio/skills#main --skill create-canvas-kit
```

After any install, reload skills with `/skills reload` or start a new session.
Each skill is then available as `/<skill-name>` (e.g. `/create-canvas-kit`).

### Add as a marketplace, or install as a plugin

`jongio/skills` also plugs into the GitHub Copilot **plugin** system (works in both
the Copilot app and the [Copilot CLI](https://docs.github.com/copilot/how-tos/copilot-cli)).
There are two ways to use it.

**Add it as a marketplace** — browse and install individual skills. The repo ships a
root [`marketplace.json`](marketplace.json) that indexes its skills:

```sh
# Register the marketplace:
copilot plugin marketplace add jongio/skills

# See what's available:
copilot plugin marketplace browse jongio-skills

# Install one skill from it (form: <plugin>@<marketplace>):
copilot plugin install create-canvas-kit@jongio-skills
```

**In the Copilot app** — no commands needed:

1. Open **Settings** and select **Plugins**.

   ![Plugins in the settings sidebar](docs/images/app-plugins-nav.png)

2. Click **Install &#9662; &rarr; Add marketplace**, enter `jongio/skills`, and click **Add marketplace**.

   ![Add marketplace dialog with jongio/skills entered](docs/images/app-add-marketplace.png)

3. The marketplace's skills appear grouped under **jongio-skills** &mdash; click **Install** on the one you want.

   ![Browse the jongio-skills marketplace and install create-canvas-kit](docs/images/app-browse-install.png)

4. The skill installs and is enabled, ready to use right away.

   ![create-canvas-kit installed and enabled](docs/images/app-installed.png)

**Or install the whole repo as a single plugin** — gets every skill under `skills/`
at once (uses the root [`plugin.json`](plugin.json)):

```sh
copilot plugin install jongio/skills
```

## Layout

```
marketplace.json             Copilot marketplace manifest (indexes skills as plugins)
plugin.json                   Copilot plugin manifest (skills: "skills/")
skills/
  create-canvas-kit/          One self-contained skill
    SKILL.md                  Authoring contract the agent reads
    README.md                 Human docs for the skill
    kit/  reference/  scripts/  test/  docs/
```

Add a new skill by creating `skills/<name>/SKILL.md` (plus any bundled assets in
the same folder); the `skills` CLI auto-discovers it.

## License

MIT — see [skills/create-canvas-kit/LICENSE](skills/create-canvas-kit/LICENSE).
