---
title: Islands, not bundles
date: 2026-02-05
description: Ship HTML by default; hydrate only the interactive parts.
---

Astro renders everything to static HTML at build time. The only JavaScript that
reaches the browser is the components you explicitly hydrate — the **island**
counter on the home page is the one interactive piece, loaded with
`client:visible`.

That's the whole idea: fast pages by default, interactivity where you ask for it.
