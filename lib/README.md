# lib/

Shared utilities used across multiple skills in this collection.

## Modules

| Module | Purpose | Consumers |
|--------|---------|-----------|
| `detect-stack.mjs` | Detect project tech stack from lockfiles and manifests | `repo-ready` |

## Convention

Each skill that imports from `lib/` keeps a thin re-export in its own
`scripts/` directory so that:

1. In-skill imports stay local (`./detect-stack.mjs`).
2. The CLI entry point lives in the skill, not the shared module.
3. Tests run against the skill's re-export, verifying the wiring.

If a skill needs to be distributed standalone (outside this repo), the
re-export can be replaced with a local copy. The shared module is the
source of truth while skills live in this repo.
