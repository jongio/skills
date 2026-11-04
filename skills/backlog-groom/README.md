# backlog-groom

Evidence-based GitHub backlog grooming across one or many issue and source
repositories, with or without a Project. Portable instructions, not a background
automation service or a new GitHub client.

## Install and use

```sh
npx skills add jongio/skills --skill backlog-groom
```

Reload your agent's skills, then invoke `/backlog-groom`. Default mode is a
read-only audit. `/backlog-groom apply` still requires an exact approved plan.

### Explicit unattended operation

`/backlog-groom unattended --policy <absolute-private-policy-path>` is the only
mode that accepts operator-approved bounded authority instead of interactive
approval for each plan. Follow the [policy contract](references/unattended-policy.md)
and adapt the [synthetic example](examples/unattended-policy.json) **outside this
repository**. All fields are required; invalid/missing/expired policy, wrong live
identity, unavailable private storage or exclusive lock blocks mutations.
Out-of-policy effects remain proposals, not silent exceptions.

The operator supplies the scheduler, authenticated tools, private policy,
checkpoint storage and atomic lock primitive. This skill does not create an
automation, enforce an API sandbox or implement a runtime client. A five-minute
schedule should have a shorter run deadline (the example uses 240 seconds),
no overlapping writer, resumable initial backfill and explicit partial coverage.
It never closes issues as completed or publishes private routing on public issues.

Before plugin installation, an agent with local file access can read the complete
`skills/backlog-groom/SKILL.md` from an explicitly selected source checkout,
follow its relative references, then execute the same unattended invocation.
This is source-file instruction loading, **not** slash-command registration:
the operator must explicitly select that trusted source path/revision, provide
policy authority separately, and ensure the automation host can read it.
An agent on a different host cannot assume a local checkout is accessible.
No installed-plugin edits are needed or supported.

Synthetic starting request:

```text
Audit issues in example-org/planning and example-org/support.
Source is example-org/service-api at its default branch and
example-org/web-client at a selected release branch. Ask me which one.
There is no Project and I do not want to create one.
```

The interview establishes authoritative refs/subpaths, many-to-many mappings,
policy and access limits instead of assuming the current checkout or `main`.
You receive an evidence ledger, contextual decisions, and changed/proposed,
preserved, unresolved, deferred and UI-blocked outcomes. Missing code or Project
permissions do not prevent independent issues-only organization.

## Boundaries

- Implementation, executed tests, installed-host qualification, live evaluation
  and released/publication-approved are separate evidence.
- Existing ownership, unknown health, dates, shared fields, view identities and
  unrelated metadata are preserved. Apply is not blanket authorization.
- Private checkpoints require an approved location outside tracked/public files;
  no checkpoints are written in audit. Reruns re-discover current state before
  creating resources or resuming partially completed operations.
- No code edits, installs, paid evaluations, releases, publishing, Git cleanup,
  credentials or visibility changes are implied.

See [SKILL.md](SKILL.md) and its focused
[evidence](references/evidence-ledger.md),
[organization](references/organization.md) and
[safe operations](references/safe-operations.md) references.

## Development and evidence limits

```sh
npm ci --ignore-scripts
npm test
npm run eval:lint
```

Node tests check portable instruction contracts, local links, all synthetic
scenario bindings, scoring gates, locked tooling, registration and PNG provenance.
They do **not** prove an agent obeys the instructions or that GitHub mutations
work. There is no runtime client to measure for line/branch/function coverage.
Policy tests validate the example and instruction boundaries, not runtime
authorization enforcement, locking implementations or live mutation safety.

The Vally capability cases stage frozen synthetic observations for offline
rehearsal. Their behavioral rubrics assess evidence, preservation, conflicts and
approval boundaries; `diff-empty` also guards workspace writes. They do not
exercise a live API, prove UI rendering, or test server-side race atomicity.
Live evaluations and any installed-host qualification require separate approval;
linting an eval is not executing it.

The thumbnail was generated with Azure OpenAI `gpt-image-2`. Its exact prompt,
provider and image digest are recorded in the repository thumbnail provenance.

## License

MIT. See [LICENSE](LICENSE).
