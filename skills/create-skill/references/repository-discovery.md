# Repository discovery

`create-skill` supports managed repositories and convention-based existing repositories.

## Managed repositories

The nearest version 1 `skills-repo.config.json` inside the current git boundary wins. The managed
repository contract supplies owner, repository, package, catalog, and GitHub settings. Generated
repositories use these canonical paths:

| Key | Default |
| --- | --- |
| `skills` | `skills` |
| `readme` | `README.md` |
| `marketplace` | `marketplace.json` |
| `plugin` | `plugin.json` |
| `vallyLock` | `.github/tools/vally/package-lock.json` |
| `evalWorkflow` | `.github/workflows/skill-eval.yml` |
| `dependabot` | `.github/dependabot.yml` |
| `catalogEntries` | `site/src/content/skills` |
| `catalogImages` | `site/public/images` |
| `thumbnailPrompts` | `docs/thumbnail-prompts.md` |

Example:

```json
{
  "schemaVersion": 1,
  "templateVersion": 1,
  "owner": {
    "login": "octocat",
    "name": "Octo Cat",
    "url": "https://github.com/octocat"
  },
  "repository": {
    "name": "skills",
    "url": "https://github.com/octocat/skills",
    "visibility": "public"
  },
  "package": {
    "name": "octocat-skills",
    "displayName": "Octocat Skills",
    "description": "Portable skills for compatible coding agents.",
    "version": "1.0.0"
  },
  "catalog": {
    "enabled": true,
    "template": "skills-catalog"
  },
  "github": {
    "defaultBranch": "main"
  }
}
```

When `catalog.enabled` is false, catalog entries, images, and thumbnail prompt records are not
required. When catalog is enabled, entry and image directories must exist before creation.
`docs/thumbnail-prompts.md` remains optional and is updated only when present. Managed repository
identity supplies the real `owner/repository` install command.

## Existing repositories

Without managed config, discovery searches for exactly one populated directory named `skills`.
It recognizes only established exact paths listed above. Missing optional surfaces are skipped.
Contradictory catalog entry and image paths, multiple populated skill roots, path traversal, and
symlinked write destinations stop the operation before writes.

The tool does not guess custom manifest formats. Add managed config when an existing repository
uses nonstandard locations or multiple registration systems.

## Apply contract

Planning renders the complete desired bytes first. Apply writes unique sibling temporary files,
backs up replaced files, then renames the staged files into place. A failure restores prior bytes
and removes only transaction files. Skill and catalog art both receive the same validated Buffer.
