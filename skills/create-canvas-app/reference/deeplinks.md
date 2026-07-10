# Deep links into github-app (schema reference)

This is the schema reference for the `kit/deeplinks.mjs` builders: the routes they
target, the parameters each accepts, and the validation they apply. The kit builds
these URLs so a canvas never hand-assembles one; this doc is for understanding the
contract behind the builders (and for adding a route if the app grows one).

**Sources of truth** (this doc tracks them):

- github-app `src/lib/deeplinks/registry.ts` and `src/lib/deeplinks/README.md` (the public route table).
- github-app `docs/adr/0016-external-deep-link-url-contract.md` (the URL contract).
- github-app `src-tauri/src/extension_canvas_webview.rs` (how a canvas webview routes a click).
- github-app `src/lib/helpers/{repositoryValidation,sessionModeValidation}.ts` (the validators the builders mirror).

## How a canvas link reaches the app

A canvas renders a deep link as an ordinary anchor with `target="_blank"`:

```html
<a href="ghapp://session/new?repo=owner/repo" target="_blank" rel="noopener noreferrer">Open</a>
```

The canvas webview injects a click handler that intercepts a trusted primary-button
click on a `target="_blank"` anchor. When the URL uses an accepted app scheme
(`ghapp:`, `github-app:`, `gh:`) it calls `window.open(...)`, which the app's
`on_new_window` handler routes into the deeplink pipeline (rather than the OS
browser). The pipeline is **confirmation-gated**: routes that clone a repo, create a
session, or install a plugin show an in-app dialog before acting, and never silently
mutate state. Opens are also throttled per canvas to prevent bursts.

Consequences for a canvas author:

- The anchor **must** be `target="_blank"`. Without it the webview does not route the click.
- No OS launcher, no IPC, no SDK call is needed. The canvas only builds the URL.
- A canvas that wants to handle a link itself can `preventDefault()`; the fallback yields.

## Schemes

| Scheme | Status |
|---|---|
| `ghapp://` | Official, documented. The builders emit this. |
| `github-app://` | Undocumented compatibility fallback (accepted by `safeDeepLinkUrl`). |
| `gh://` | Undocumented compatibility fallback (accepted by `safeDeepLinkUrl`). |

`APP_DEEP_LINK_SCHEME` is `"ghapp"`.

## Routes and parameters

All params are encoded with `URLSearchParams`, so untrusted text can neither inject
an extra query key nor change the route. Values that fail validation cause the
builder to return `null` (so a caller can withhold a control instead of rendering a
dead link), except where noted that an invalid optional value is dropped.

### `session/new`: create a session

`buildSessionDeepLink({ repo, prompt, pr, branch, sourceBranch, parent, mode })`
→ `ghapp://session/new?repo=owner/repo&…`

| Param | Required | Rule |
|---|---|---|
| `repo` | Yes | `owner/repo`. Owner `<=39` chars, `[A-Za-z0-9]` with internal hyphens (no leading/trailing hyphen). Repo `<=100` chars, `[A-Za-z0-9._-]`, not `.` or `..`. |
| `prompt` | No | Kickoff prompt. Wrap untrusted parts with `quoteUntrusted`. Never include secrets. |
| `pr` | No | Positive integer. Cannot be combined with `branch` or `sourceBranch`. |
| `branch` | No | Base branch for a freshly generated worktree branch. Cannot be combined with `pr` or `sourceBranch`. |
| `sourceBranch` | No | Emits `source_branch`: open an *existing* branch directly (no new branch is created) — for collaboration links. Cannot be combined with `pr` or `branch`. |
| `parent` | No | Workspace id of an existing session to nest the new one under (same token shape as `sessions/:sessionId`). Cannot be combined with `pr` or `sourceBranch`; may combine with `branch`. A malformed id returns `null`. |
| `mode` | No | `plan`, `interactive`, or `autopilot`. |

The three branch selectors (`pr`, `branch`, `sourceBranch`) are mutually exclusive:
at most one may be set. `parent` only applies when creating a new session from a repo
or base branch, so it cannot combine with `pr` or `sourceBranch`.

If the repo is not yet a project, the app clones it first (after confirmation), then
opens the session.

### `sessions/:sessionId`: open an existing session

`buildSessionDetailDeepLink(sessionId)` → `ghapp://sessions/<id>`

`sessionId` must be a safe token (`[A-Za-z0-9._-]`, `<=256` chars) so it cannot add
path segments or query keys.

### `chats`: open Chats

`buildChatsDeepLink()` → `ghapp://chats`

### `automations/new`: pre-fill the new-automation dialog

`buildNewAutomationDeepLink({ name, prompt, trigger, time, day })`
→ `ghapp://automations/new?…`

The dialog is the confirmation step; this does not auto-create a workflow. Invalid
optional values are dropped rather than failing the whole link.

| Param | Rule |
|---|---|
| `name` | Free text. |
| `prompt` | Free text. Wrap untrusted parts with `quoteUntrusted`. |
| `trigger` | `manual`, `hourly`, `daily`, or `weekly`. |
| `time` | `HH:mm`, 24-hour (daily/weekly). |
| `day` | `0`-`6`, `0` = Sunday (weekly). |

### `github.com/:owner/:repo/issues/:number`: open an issue

`buildIssueDeepLink({ owner, repo, number })`
→ `ghapp://github.com/owner/repo/issues/123`

### `github.com/:owner/:repo/pull/:number`: open a pull request

`buildPullRequestDeepLink({ owner, repo, number })`
→ `ghapp://github.com/owner/repo/pull/123`

`owner`/`repo` follow the same rules as `session/new`; `number` must be a positive
integer. Opens in Inbox when the repo is already added as a project.

## Hosted dotcom launcher (web surfaces)

A canvas running inside the app can link `ghapp://` directly. For a link that might
be opened from a browser instead, wrap it:

`hostedLauncherUrl(deepLink, { entryPoint })`
→ `https://github.com/copilot/app/launch?entry_point=<ep>&open=<encoded ghapp://…>`

The launcher handles retry, fallback, and an app-missing install prompt. `entryPoint`
is optional, non-sensitive attribution only (sanitized to `[A-Za-z0-9_]`). Do not add
parallel query params for the payload; the encoded `open` value is the whole payload.

## Validators and helpers

| Export | Purpose |
|---|---|
| `APP_DEEP_LINK_SCHEME` | `"ghapp"`. |
| `isRepoFullName(value)` | True for a valid `owner/repo` (the same rule github-app applies). |
| `safeDeepLinkUrl(raw)` | Validate/normalize an accepted-scheme URL, or `null`. Rejects control chars and over-long input. |
| `quoteUntrusted(text)` | Wrap untrusted free text in guillemets so it reads as data in a prompt. Strips embedded guillemets so the boundary can't be forged. |

## Security notes

- **Encoding.** Every builder uses `URLSearchParams`, so a hostile value cannot add
  a query key or change the route. The tests assert this.
- **Untrusted prompt text.** Wrap it with `quoteUntrusted` before putting it in a
  `prompt`. The kit encodes the URL; `quoteUntrusted` marks the boundary for the agent.
- **No secrets in URLs.** A deep link is handed to the OS. Never put tokens or
  sensitive content in `prompt` or any param.
- **Fail closed.** A builder returns `null` on invalid input. Guard on it and hide
  the control rather than render a broken link.

## Adding a route

1. Confirm the route exists in github-app `registry.ts` and its README.
2. Add a builder to `kit/deeplinks.mjs` that validates inputs (mirror the app's
   helper), encodes with `URLSearchParams`, and funnels through `safeDeepLinkUrl`.
3. Re-export it from `kit/client.mjs`.
4. Cover it in `test/deeplinks.test.mjs` (valid, invalid, encoding).
5. Bump `KIT_VERSION` and re-sync vendored copies (`scripts/sync-kit.mjs`).
6. Document it here and in `SKILL.md`.
