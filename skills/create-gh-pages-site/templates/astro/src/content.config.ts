import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";

// A type-checked content collection loaded from Markdown files.
// https://docs.astro.build/en/guides/content-collections/
const blog = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "./src/content/blog" }),
  schema: z.object({
    title: z.string(),
    date: z.coerce.date(),
    description: z.string().optional(),
  }),
});

export const collections = { blog };
