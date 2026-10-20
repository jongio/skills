# Safe operations

## Authority and plan

Audit mode is read-only, including no local checkpoint writes. Keep a bounded
in-memory before-state and report a summary. Apply requires a reviewable plan
and approval bound to host, repositories, exact resource identities and desired
changes. Request distinct approval for destructive removal, Project creation,
global field changes, automation policy, consequential ownership and dates.
Batch related ordinary changes only when their exact scope is reviewable.

Every operation records: target ID/reference, operation kind, observed before
value/version, desired value, evidence, expected effect, approval class, and
postcondition. Re-discover fields, views, milestones, issues and relationships
before creation; reuse an exact existing resource with matching meaning/scope.
A name collision with different meaning is a decision, not a reason to duplicate.

Before any replacement-style write, read the full affected collection and retain
all values outside the approved change. Never send an empty replacement collection
unless clearing it was specifically approved. Preserve all assignees, shared
organization values, dates and release metadata outside exact scope.

## Inventory and serialization

1. Discover host, authenticated capabilities and actual schema/response types.
   Prefer existing authenticated GitHub tooling (for example `gh` where
   available), not new credentials, elevated tokens or browser extraction.
2. Follow pagination for every connection, including nested field values,
   relationships, PRs and project membership. Track cursors/page completion
   independently for each repository/connection; detect repeated cursors.
   Compare counts when available. A failed page leaves an incomplete inventory,
   never an empty or fully audited scope. Bound very large scans and disclose
   any user-approved limit; do not claim completeness beyond it.
3. Use structured JSON request bodies and GraphQL variables through the tool's
   JSON/file/stdin interface. Do not interpolate issue text into shell commands
   or concatenate GraphQL strings. Use host-appropriate paths and line endings.
   Do not hardcode repository/user names, refs, project/field/option IDs or status
   vocabulary. Opaque GitHub IDs are case-sensitive; never lowercase them.
4. Decode only known value wrappers from the discovered schema, including text
   `raw`/`html` shapes. Treat missing, null, empty and inaccessible distinctly.
   Normalize transport CRLF/LF where appropriate, not meaningful user content.
   Compare unordered field collections by exact IDs, not server array position;
   preserve meaningful order such as intentional view columns or sorting.
   If a shape is unsupported, stop that operation rather than guess or clear it.
5. Record observation time, source OIDs, relevant PR heads, field bindings,
   scope/access gaps and a minimal before-state. An API error is not proof that
   a resource does not exist.

## Automation is a separate policy decision

Prefer issue closure -> project Done and a relevant linked implementation PR ->
In Progress only when compatible with the user's status policy. Ask whether
moving a card to Done should close an issue; never enable card-driven auto-close
by default. An open issue/Done-card mismatch is a conflict to surface, not
authority to close the issue or override the user's card choice.

Review repository auto-add, sub-issue auto-add and archival independently.
Do not archive away Shipped history. New auto-add configuration does not prove
backfill of existing items; inventory and reconcile existing membership separately.
Do not imply that creating a rule has already executed it.

## Resumable apply loop

Use a minimal private checkpoint only after the user approves its local location
and content scope. Keep it outside tracked/public output; no credentials or
unnecessary issue bodies. If checkpoint persistence is declined, use in-memory
state and explain the loss of cross-session resumability, not a false guarantee.

Record scope identity, selected OIDs, observations, approval scope, plan entries,
confirmed postconditions and per-operation state: planned, pending, verified,
conflict, unknown or failed. Persist pending intent BEFORE a write when checkpoint
storage is authorized. The checkpoint is evidence, not new mutation authority;
revalidate approvals and current state when resuming.

For each operation:

1. Re-read direct issue/item/resource records and relevant source/PR state.
   Detect manual changes, new PRs, changed source heads, ownership and config.
   If the desired value is already present, verify and skip the write.
2. Compare relevant preconditions, preserving unrelated newer edits. Where the
   API offers conditional/versioned updates, use them. Otherwise minimize the
   read/write window and disclose that cross-call atomicity is unavailable.
   A changed precondition invalidates the affected plan: re-plan and obtain
   approval if effects changed; do not overwrite from a stale snapshot.
3. Apply only the authorized patch. On success or uncertainty, re-read the direct
   record and compare actual membership/values with the intended postcondition.
   A successful API response alone is not final verification.
4. After a timeout or partial mutation, mark the outcome unknown until direct
   verification. Re-discover using exact identity/confirmed scope before
   retrying any create. Do not blindly replay the campaign, duplicate a field/
   issue/view, or roll back over another person's changes.
5. Use a bounded recovery budget: at most three read/reconciliation attempts per
   operation, observing rate limit/reset or Retry-After guidance. Report waits.
   Do not keep an interaction waiting beyond its approved time budget; checkpoint
   and defer. Retry a write only after proving the original did not apply and
   its approval/preconditions still hold. If absence cannot be established, stop
   that write and report unknown. Permission/schema errors require correction,
   not transient retries.
6. Prefer authoritative direct item/issue records over an aggregate listing that
   may lag. Reconcile a stale aggregate within the budget, but do not add an issue
   again merely because a list omits it. Record direct verification separately
   from aggregate/UI verification still pending.
7. Record verified outcomes and conflicts after each batch. Re-inventory affected
   populations at the end and identify unprocessed pages/operations. Partial work
   is not full success.

## UI and final verification

Preserve view IDs and URLs. Do not recreate a view, silently drop columns or
guess UI-only settings to bypass unavailable native access. Do not terminate a
shared browser or take over an occupied session. Do not read browser credentials.

When UI is unavailable, name the exact Project/view, setting, expected value,
population and manual action/check, plus why it remains blocked. Configuration
success does not prove rendered behavior. Distinguish verified data from
unobserved nesting, field visibility, expand/collapse and person slicing.

Never publish a private checkpoint or borrow a private backlog for examples.

## Official capability references

Discover support on the actual host; these documentation routes are lookup aids,
not a guarantee of permissions, plan availability or deployed schema:

- GitHub Docs: `https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/using-the-built-in-automations`
- GitHub Docs: `https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/adding-items-automatically`
- GitHub Docs: `https://docs.github.com/en/issues/planning-and-tracking-with-projects/understanding-fields/about-issue-fields`
