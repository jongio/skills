import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";

// One entry per skill in this repo. The catalog pages and home grid render from
// this collection, so adding a skill is just dropping a Markdown file in
// src/content/skills/.
const skills = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "./src/content/skills" }),
  schema: z.object({
    title: z.string(),
    tagline: z.string(),
    useWhen: z.string(),
    repoPath: z.string(), // path within the repo, e.g. skills/create-canvas-app
    thumb: z.string(), // image under public/, base-relative (e.g. images/...)
    install: z.array(z.object({ label: z.string(), cmd: z.string() })),
    order: z.number().default(99),
  }),
});

export const collections = { skills };
