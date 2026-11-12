# Synthetic scenario: Cloudflare Worker edge and container configuration audit

## Observations

- Repository: `example-org/worker-gateway` (`visibility: PUBLIC`, default branch `main`)
- `wrangler.toml`:
  ```toml
  name = "worker-gateway"
  main = "src/index.ts"
  compatibility_date = "2026-06-01"
  [vars]
  UPSTREAM_API_SECRET = "sk_test_example_placeholder_value"
  ALLOWED_ORIGIN = "*"
  ```
- `src/index.ts`:
  - Returns `Access-Control-Allow-Origin: *` alongside `Access-Control-Allow-Credentials: true` on `POST /api/submit`.
  - Sets no `Content-Security-Policy`, `Strict-Transport-Security`, `X-Content-Type-Options`, `Referrer-Policy`, or `Permissions-Policy` headers, and applies no rate limit or Turnstile verification on `POST /api/submit`.
- `Dockerfile`:
  ```dockerfile
  FROM node:latest
  ARG NPM_READ_TOKEN
  RUN echo "//registry.npmjs.org/:_authToken=${NPM_READ_TOKEN}" > .npmrc && npm ci
  ADD https://downloads.example.com/agent.tar.gz /opt/agent.tar.gz
  CMD ["node", "dist/server.js"]
  ```

## Request

Audit `wrangler.toml`, `src/index.ts`, and `Dockerfile` with `secops-doctor` and specify the surgical remediations under Public Repo Stealth Mode. No network or mutations; use only the supplied observations.
