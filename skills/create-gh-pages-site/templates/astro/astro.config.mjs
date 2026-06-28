// @ts-check
import { defineConfig } from "astro/config";

// https://docs.astro.build/en/guides/deploy/github/
//
//   site  — the origin of your deployed site (no path), e.g. https://USER.github.io
//   base  — the subpath the site is served from. For a *project* site this is
//           "/REPO/"; for a *user* site (USER.github.io) it is "/".
//
// The generator fills these in from your repo. Internal links use
// `import.meta.env.BASE_URL` so they stay correct at any base.
export default defineConfig({
  site: "__SITE_ORIGIN__",
  base: "__BASE_PATH__",
});
