# Session progress runtime

This is the single bundled canvas implementation, not a per-session template.
The SDK adapter is `extension.mjs`; SDK-free current-session state/reporting is
in `progress.mjs`; viewer-gated cross-session discovery, worker-isolated
`$COPILOT_HOME` readers, and recovery controls are in `fleet-service.mjs`,
`fleet-worker.mjs`, `fleet-local-reader.mjs`, and `watchdog.mjs`; the
capability-protected canvas configuration is in `canvas.mjs`; Preact assets and
safe `ghapp://` deep-link helpers are in `web`. The generated feature-scoped
`canvas-kit` is maintained with `create-canvas-app` tooling, never hand-edited.

Use the skill's shared plugin loader or approved standalone setup. Session
state is stored separately from this bundle. See the parent README for
installation, attribution limits, recovery, and validation commands.
