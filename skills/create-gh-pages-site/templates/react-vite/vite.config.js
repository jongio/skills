import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vite.dev/config/
//
// `base` is the public path the app is served from. For a GitHub *project*
// site this is "/REPO/"; for a *user* site (USER.github.io) it is "/".
// The generator fills it in from your repo. React Router reads it via
// `import.meta.env.BASE_URL` (see src/main.jsx).
export default defineConfig({
  base: "__BASE_PATH__",
  plugins: [react()],
});
