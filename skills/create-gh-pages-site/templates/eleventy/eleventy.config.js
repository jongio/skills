// Eleventy config — https://www.11ty.dev/docs/
export default function (eleventyConfig) {
  // Copy static assets through verbatim (src/assets → _site/assets).
  eleventyConfig.addPassthroughCopy({ "src/assets": "assets" });

  // --- Filters ---
  eleventyConfig.addFilter("date", (value) =>
    new Date(value).toISOString().slice(0, 10),
  );
  eleventyConfig.addFilter("readableDate", (value) =>
    new Date(value).toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
    }),
  );
  eleventyConfig.addFilter("head", (array, n) =>
    Array.isArray(array) ? array.slice(0, n) : array,
  );

  // --- Shortcodes ---
  eleventyConfig.addShortcode("year", () => String(new Date().getFullYear()));
  // Paired: {% note %}...{% endnote %}
  eleventyConfig.addPairedShortcode(
    "note",
    (content) => `<div class="note">${content}</div>`,
  );

  return {
    dir: { input: "src", output: "_site", includes: "_includes", data: "_data" },
    markdownTemplateEngine: "njk",
    htmlTemplateEngine: "njk",
    // Project base path comes from PATH_PREFIX (set by the deploy workflow).
    // Wrap internal links/assets in the `url` filter so it is applied.
    pathPrefix: process.env.PATH_PREFIX || "/",
  };
}
