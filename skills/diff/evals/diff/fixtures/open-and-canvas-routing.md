# Scenario: Visual Diff in Copilot App Canvas

- Repository: `example-org/api-gateway`
- Active branch: `feat/token-refresh` (default branch `origin/main`)
- Git state:
  - 2 committed commits ahead of `origin/main` modifying `src/router.ts` and `src/auth.ts`
  - Unstaged working-tree edits in `src/auth.ts` and `docs/notes.md`
- Host environment: GitHub Copilot App with `open_canvas` and the native `diff` canvas registered
- User request:
  > Open a side-by-side visual diff of my `src/router.ts` and `src/auth.ts` changes in the app canvas so I can leave inline comments before we run `/diff review`.
