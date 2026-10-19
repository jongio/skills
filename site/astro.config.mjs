// @ts-check
import { defineConfig } from "astro/config";
import preact from "@astrojs/preact";

// https://docs.astro.build/en/guides/deploy/github/
//   site  — origin of the deployed site (no path), e.g. https://USER.github.io
//   base  — subpath: "/REPO/" for a project site, "/" for a user site.
// The generator fills these in. Internal links use `import.meta.env.BASE_URL`.
export default defineConfig({
  site: "https://jongio.github.io",
  base: "/skills/",
  integrations: [preact()],
  vite: {
    optimizeDeps: {
      // Discover ClientRouter's runtime before the toolbar loads, avoiding a stale prebundle.
      include: [
        "astro/virtual-modules/transitions-router.js",
        "astro/virtual-modules/transitions-events.js",
        "astro/virtual-modules/transitions-types.js",
        "astro/virtual-modules/transitions-swap-functions.js",
      ],
    },
  },
});
