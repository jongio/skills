# hol-guard eval

A Vally capability eval for fail-closed HOL Guard runtime protection around supported local AI coding harnesses. The scenarios cover the boundaries this skill is expected to preserve:

- **Protected setup:** detect the actual supported harness, bootstrap and install Guard, then require Guard-owned dry-run, doctor, protected launch, and status evidence before claiming protection.
- **Fail closed:** stop mutation-bearing work when no supported harness is detected or Guard cannot establish a healthy protection state; never fall back to an unprotected agent launch.
- **Approvals:** keep denied or review-gated work blocked until the actual Guard request is inspected, and never reinterpret a previous approval as permission for a different request.
- **Native boundaries:** keep the coding harness's own authentication, permissions, confirmations, and sandboxing enabled while Guard is active.
- **Cloud boundary:** keep HOL Guard Cloud connection and synchronization opt-in rather than silently enabling an external data path.

From the skill root:

```sh
npm install
npm run eval:lint
npm run eval
```

The full eval drives a real agent and is intended for on-demand or nightly use. A deterministic cross-surface registration test will be added with the remaining catalog-thumbnail packaging so it can enforce the repository's byte-identical image requirement rather than weakening that check.
