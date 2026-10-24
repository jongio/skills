# Portable GitHub runtime

Canonical source for the CI watcher, PR watcher, and statusline GitHub adapters.
Octokit performs REST/GraphQL requests; the Copilot SDK is only used by host
extensions for session integration.

## Build and verify

From the repository root:

```powershell
npm ci --prefix runtime\github-client --ignore-scripts
npm run build --prefix runtime\github-client
npm run check --prefix runtime\github-client
npm test --prefix runtime\github-client
```

Commit the generated `github-client.mjs` bundles and adjacent
`github-client.LICENSE` files together with source/lockfile changes. Never edit
bundles individually. Consumers do not need `node_modules`; build dependencies
belong only to this package.

## Contract

- Requests return structured status, headers, data, error, REST/GraphQL budget,
  and hashed host/credential cache identity.
- Default request deadlines cover authentication, retries, and response bodies.
  Only safe reads retry; GraphQL mutations and uncertain writes are not replayed.
- `gh` credential lookup is bounded. A 401 can refresh gh-derived credentials
  once, never override an explicit environment token or switch the active account.
- Enterprise host selection, secondary-account statusline access, proxy settings,
  and `NO_PROXY` are handled independently of Copilot credentials.
- Rate-limit headers return to the scheduler without hidden SDK sleeping.
- Failures cannot renew cached success evidence. Callers must check response
  validity and inventory completeness before reporting readiness.

The notification event writer strips control characters, excludes review bodies
and credentials, retains a bounded set of records, and never prompts a model.

To roll back, restore source and every generated bundle together, validate drift,
then use the normal repository/plugin release mechanism. Do not hot-patch an
installed CLI, rotate credentials, or alter user settings to mask a failure.
