---
title: Hello from a content collection
date: 2026-01-20
description: Typed, validated Markdown loaded by Astro's content layer.
---

This post lives in `src/content/blog/` and is loaded by a **content collection**.
Its front matter is validated against a Zod schema, so a typo in a field is a build
error — not a runtime surprise.

Add another `.md` file next to this one and it shows up on the Blog index
automatically.
