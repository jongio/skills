# Approved Change Management

DNS Doctor may apply a live provider change only after the user explicitly
approves the exact mutation. Audit and planning remain read-only.

## Approval boundary

Never infer approval from a request to audit, diagnose, fix, continue, or do
whatever is needed. Before each mutation, show:

| Field | Required detail |
|---|---|
| Provider | Provider, account, zone, and authenticated identity |
| Action | Create, edit, replace, or delete |
| Target | Stable provider record ID when available, plus owner name and type |
| Before | Exact current provider value, TTL, routing or proxy state, and metadata |
| After | Exact proposed value, TTL, routing or proxy state, and metadata |
| Impact | Dependencies, expected propagation, and service risk |
| Rollback | Exact inverse operation and value |
| Concurrency guard | Re-read immediately before execution; stop and reapprove on any drift |
| Verification | Provider, authoritative, recursive, and service checks |

Ask one focused approval question for that exact mutation. A single confirmation
may cover a displayed batch only when every operation is enumerated and the user
explicitly approves the whole batch. Approval for a plan, earlier record, audit,
or related zone does not authorize another mutation.

Deletion, DNSSEC changes, nameserver changes, mail-routing changes, and changes
that can interrupt certificate issuance require their own approval. Never hide
them inside a broader batch.

If approval is denied, changed, ambiguous, or missing, do not mutate anything.

## Prepare the change

1. Confirm that the authenticated provider account controls the intended zone.
2. Re-read the exact provider object immediately before presenting the change.
3. Identify it by stable provider ID. Do not select a record by list position or
   by a partial name match.
4. Capture the complete before state needed to restore the object.
5. Validate the desired value with the same hostname, address, mail, DNSSEC, and
   CAA rules used by the audit.
6. Check record coexistence constraints and dependent services.
7. Prefer the smallest partial edit. Do not replace a full object when one field
   can be edited safely.
8. Show the approval card and wait.

Immediately before execution, re-read the object and compare it with the
approved before state. If any field changed, stop and present a new plan for
fresh approval. This prevents overwriting concurrent provider changes.

## Provider tools and credentials

Prefer the provider's current official SDK. Use its REST API or official CLI
only when the SDK is unavailable or lacks the required operation.

- Use an existing authenticated session, environment variable, managed
  identity, workload identity, or secret store. Never request a token in chat.
- Scope write access to the intended account and zone. Use read plus the minimum
  record-edit permission needed for the approved action.
- Never print tokens, authorization headers, cookies, or full provider error
  payloads that may contain credentials.
- Do not install an SDK silently. If installation is required, show the package,
  version, publisher, license, and destination, then obtain approval.
- Do not use browser automation to change a provider when an official SDK, API,
  or CLI is available.

### Cloudflare

Use the official `cloudflare` TypeScript SDK. Initialize `Cloudflare` from
`CLOUDFLARE_API_TOKEN` or another secure environment source.

Use these methods:

| Operation | SDK method | Guidance |
|---|---|---|
| Inventory | `client.dns.records.list({ zone_id })` | Read-only discovery |
| Re-read | `client.dns.records.get(recordId, { zone_id })` | Required before mutation |
| Create | `client.dns.records.create({ zone_id, ...record })` | Use only after exact approval |
| Partial edit | `client.dns.records.edit(recordId, { zone_id, ...fields })` | Preferred for minimal changes |
| Full replace | `client.dns.records.update(recordId, { zone_id, ...record })` | Use only when every field is captured and approved |
| Delete | `client.dns.records.delete(recordId, { zone_id })` | Requires deletion-specific approval |
| Batch | `client.dns.records.batch({ zone_id, ...operations })` | Use only for an enumerated approved batch |

Cloudflare executes a batch transaction in a defined order, but propagation
through its distributed store is not atomic. Verify each record independently.

For other providers, map the same lifecycle to the official SDK's get, create,
partial-update, and delete operations. Avoid ambiguous upsert operations unless
the create-versus-replace outcome is known and displayed in the approval card.

## Execute

1. Execute only the approved provider call and exact payload.
2. Do not continue to the next mutation after an error or unexpected response.
3. Capture the provider request or audit ID, returned object, timestamp, and
   authenticated identity without recording secrets.
4. Re-read the object from the provider and compare every approved field.
5. Query each authoritative nameserver for the changed record.
6. Query at least two independent recursive resolvers after the relevant TTL.
7. Re-run affected HTTP, TLS, mail, DNSSEC, or CAA checks.
8. Report the outcome as applied, partially propagated, failed, or drifted.

Do not claim success from an accepted API response alone.

## Rollback

A rollback is another live mutation. Show its exact payload and obtain fresh
approval before executing it, unless the user explicitly pre-approved that
exact rollback payload and trigger with the original change.

After rollback, repeat provider, authoritative, recursive, and service
verification. Preserve both the failed-change and rollback evidence.

## Stop conditions

Stop without further writes when:

- the current state differs from the approved before state
- the provider, account, zone, or record ID is ambiguous
- the credential has broader access than the user accepts
- the provider response differs from the approved payload
- a dependency or coexistence constraint was missed
- verification exposes a service regression
- a rate limit, timeout, or partial batch result makes state uncertain

Present the observed state and a new explicit plan. Never improvise a repair.
