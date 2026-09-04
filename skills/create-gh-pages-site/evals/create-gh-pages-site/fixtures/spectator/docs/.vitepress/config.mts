import { defineConfig } from "vitepress";

export default defineConfig({
  base: "__BASE_PATH__",
  themeConfig: {
    editLink: {
      pattern: "https://github.com/__REPO_SLUG__/edit/main/docs/:path",
    },
  },
});
