// SPA fallback for GitHub Pages.
//
// GitHub Pages serves 404.html for any path it can't find as a static file.
// For a single-page app, deep links like /REPO/about have no matching file, so
// we copy the built index.html to 404.html. Pages then serves the app shell,
// and the client router (React Router) renders the right route.
//
// Runs automatically after `npm run build` via the package.json "postbuild" hook.
import { copyFileSync, existsSync } from "node:fs";

const src = "dist/index.html";
const dest = "dist/404.html";

if (existsSync(src)) {
  copyFileSync(src, dest);
  console.log(`Created ${dest} (SPA deep-link fallback)`);
} else {
  console.error(`Expected ${src} to exist after build; 404 fallback not created.`);
  process.exit(1);
}
