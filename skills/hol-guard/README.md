# HOL Guard skill

Installs and operates HOL Guard around supported local AI coding harnesses before mutation-bearing tool work.

Install this skill with the repository's documented cross-agent installer:

```sh
npx skills add jongio/skills --skill hol-guard
```

Or install it from the `jongio-skills` GitHub Copilot marketplace after registering `jongio/skills` as described in the repository README.

The skill pins the current stable HOL Guard `3.0.0` runtime for reproducible installation, detects the exact supported local harness, verifies protection with Guard-owned dry-run/doctor/status evidence, fails closed on errors or review states, and keeps Guard Cloud opt-in.
