# jongio/skills

Jon Gallant's collection of [GitHub Copilot](https://docs.github.com/copilot)
skills — a general-purpose monorepo. Each skill lives in its own folder under
[`skills/`](skills/) with a `SKILL.md` authoring contract, and can be installed
individually or all at once.

## Skills

| Skill | What it does |
|---|---|
| [`create-canvas-kit`](skills/create-canvas-kit/) | Build GitHub Copilot App canvas extensions fast — a no-build Preact + htm kit with live SSE state, durable storage, Primer theming, official GitHub Lucide icons, a generator, and an installable skill. |

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

### Install as a Copilot CLI plugin

The repo is also a [Copilot CLI plugin](https://docs.github.com/copilot/how-tos/copilot-cli),
so every skill under `skills/` is available namespaced under `jongio-skills`:

```sh
copilot plugin install jongio/skills
```

## Layout

```
plugin.json                   Copilot CLI plugin manifest (skills: "skills/")
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
