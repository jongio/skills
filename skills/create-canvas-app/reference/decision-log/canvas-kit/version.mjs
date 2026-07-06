// canvas-kit/version.mjs
//
// A single version stamp for the kit. A vendored copy (canvas-kit/) is a literal
// snapshot of this folder, so there is no package manager to tell you whether the
// copy you shipped is the one you think it is. This constant gives the sync +
// freshness tooling (scripts/sync-kit.mjs, scripts/check-kit-freshness.mjs) a
// stable value to record and compare against.
//
// Bump it whenever the kit's files or API surface change. An ISO date is the
// convention (the skill ships as files, not an npm version); a commit short-sha
// works too. Re-exported from client.mjs so a canvas can read it at runtime.

export const KIT_VERSION = "2026-07-05.1";
