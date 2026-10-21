# refactor

Plan behavior-preserving refactoring with explicit scope, depth and risk choices.

## Install

```sh
npx skills add jongio/skills --skill refactor
```

Reload your agent skills, then invoke `/refactor`.

## Use

Invoke `/refactor` with a path or existing ledger. A fresh assessment does not
need a ledger. Choose inspection breadth, refactoring depth, and risk boundaries
separately; choices already in the request are reused.

| Level | What it proposes | Evidence and approval |
| --- | --- | --- |
| **1. Small wins (default)** | Local mechanical cleanup | Approve a coherent batch with independent equivalence checks |
| **2. Local restructuring** | Reorganize internals within one module | Approve the transformation and module; characterize behavior and check callers |
| **3. Cross-module restructuring** | Reorganize internal boundaries across a named subsystem | Approve the design, compatibility evidence, staged plan and rollback |

For example: `/refactor src/parser - Level 1, exclude sensitive contracts`, or
`/refactor src/reporting - Level 2, propose only`. These are natural-language
requests, not a separate command-line parser.

Repository-wide inspection must be explicit and can remain Level 1 throughout.
The skill works sequentially, reports coverage gaps, and does not spawn agents.
If interaction is unavailable, it keeps explicit choices and defaults missing choices
to Level 1 with sensitive contracts excluded.
Without a supplied scope, it proposes a module from a shallow inventory and waits
for scope selection rather than launching an unbounded audit.

Levels are scope ceilings, not safety ratings. Permissions, approval, execution,
concurrency, lifecycle, persistence, serialization, public/error contracts,
compatibility and dependency contracts are excluded by default at every level.
An exception needs item-specific authorization and stronger preservation evidence.
Missing evidence still blocks the item; authorization is not proof of preservation.

Product changes are excluded at every level: no feature removal, bug fixes,
changed errors, new defaults, upgrades, or altered user-visible behavior.
Record them separately rather than making them prerequisites for cleanup.
Exhausting the agreed backlog stops work; it does not authorize escalation.
Already-observed deeper opportunities can be listed, but expanding the assessment
requires explicit approval. Finding no justified cleanup is acceptable.

Each candidate includes a compact preservation ledger and proposed checks.
Questions concern the proposed cleanup, not unrelated product redesign.
Chunks share one transformation, verification boundary and rollback. Larger
homogeneous PRs are allowed; different risks or reasoning require separate chunks.
There is no arbitrary item/file cap and no safety score that can override a failed gate.

The skill remains review-only. An explicitly approved campaign can hand eligible
chunks to `go` within its approved scope, depth and risk boundaries without
repeated consent, one active PR at a time; otherwise seek batch approval.
The handoff includes exclusions, acceptance criteria and preservation evidence.
`go`/`pr` requires final merge approval unless auto-merge is explicitly selected
for that invocation. Advance only after verified merge.
Unverified work is not ready; tests and user approval are not absolute certainty.

All working instructions fit in `SKILL.md`, without a reference document or
orchestration code. Packaging and tests are development support.

## Development

```sh
npm ci --ignore-scripts
npm test
npm run eval:lint
```

Use the repository's npm lockfile and scripts for reproducible development;
avoid creating a second lockfile. Deterministic checks protect the instruction
contract and size, not agent correctness. Nine supplied-evidence Vally cases cover
fresh assessment, broad-but-shallow scope, feature preservation, error contracts,
test-helper equivalence, exhaustion, cross-module approval, sensitive Level 3 work,
and partial-coverage honesty. They require skill invocation and prohibit operational
tools or project edits; no repository-wide quality claim follows.
Lint validates definitions, not model behavior. Running subjects or judges requires
separate approval. No agent-behavior or coverage percentage is inferred from static tests.

## License

MIT. See [LICENSE](LICENSE).
