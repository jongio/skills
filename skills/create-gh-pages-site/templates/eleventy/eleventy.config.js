// Eleventy config — https://www.11ty.dev/docs/
export default function (eleventyConfig) {
  // Copy static assets through verbatim (src/assets → _site/assets).
  eleventyConfig.addPassthroughCopy({ "src/assets": "assets" });

  // Tiny date filter so templates can print a clean YYYY-MM-DD.
  eleventyConfig.addFilter("date", (value) =>
    new Date(value).toISOString().slice(0, 10),
  );

  return {
    dir: { input: "src", output: "_site", includes: "_includes", data: "_data" },
    markdownTemplateEngine: "njk",
    htmlTemplateEngine: "njk",
    // For a GitHub *project* site this is "/REPO/"; the deploy workflow passes
    // it via the PATH_PREFIX env var. Locally it defaults to "/". Always wrap
    // internal links and asset URLs in the `url` filter so this prefix is
    // applied automatically: href="{{ '/about/' | url }}".
    pathPrefix: process.env.PATH_PREFIX || "/",
  };
}
