# Canvas Workspace App

Canvas Workspace App — a canvas built on the Canvas Kit.

A GitHub Copilot App **canvas extension** generated with the `create-canvas-app`
skill (list template). The agent and the user share the same live
state through the same action handlers; the view renders with Preact + htm and a
vendored kit — no build step, no `package.json`.

## Layout

```
extension.mjs   the ONLY file that imports the Copilot SDK (thin adapter)
canvas.mjs      canvas config: state load/save + action handlers (SDK-free)
canvas-kit/     vendored kit (copied verbatim; do not edit)
web/index.html  shell that loads /kit/theme.css and ./app.mjs
web/app.mjs     your Preact view
test/smoke.test.mjs  boots the runtime over HTTP and exercises the actions
```

This is a user-entered **list** canvas: add / toggle / remove items, persisted per user and shared live across every open panel.

## Validate

```
node test/smoke.test.mjs
```

## Install

Copy this folder into `.github/extensions/canvas-app` (in-repo),
`$COPILOT_HOME/extensions/canvas-app` (personal), or
`$COPILOT_HOME/session-state/<sessionId>/extensions/canvas-app` (current session
only — disappears with the session), then run `extensions_reload` and open it
with `open_canvas` (`canvasId: "canvas-app"`).

## Keeping the kit current

`canvas-kit/` is a vendored snapshot of the create-canvas-app `kit/`. Re-sync it
with the skill's `scripts/sync-kit.mjs`, and gate drift in CI with
`scripts/check-kit-freshness.mjs`.
