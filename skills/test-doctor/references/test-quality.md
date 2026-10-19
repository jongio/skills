# Test quality checks

Use these questions while reviewing source and tests. A pattern is a lead to
investigate, not a verdict. Ground each finding in a credible missed regression.

## Does the assertion prove the contract?

- Compare expected values with requirements or an independent example. Importing
  the implementation's own computed value as the expectation may be tautological.
  Sharing a stable protocol constant can be legitimate; inspect what can regress.
- A truthiness assertion is appropriate for a truthiness contract. If a precise
  amount, identity, status, or boolean matters, assert that value instead.
- Stage inputs only. If setup creates the very output later asserted, the test
  can pass even when the subject does nothing.
- A mock must not implement the behavior the test claims to verify. Keep real
  collaboration when it is the contract; isolate genuinely external effects.
- A round trip proves self-consistency, not necessarily correct serialization.
  Assert the intermediate wire format or stored bytes when those are contracts.
- Test names must match observable evidence. Calling a cache path does not prove
  a hit; assert avoided work or another observable reuse signal.
- Exact messages and snapshots are valid when wording/layout is a public
  contract. Otherwise prefer stable error types, causes, fields, and behavior.
- Match sibling tests' relevant behaviors, not their raw case count. A new
  variant needs equivalent protection, not twenty mechanically copied tests.

## What behavior is missing?

Use coverage to locate candidates, then read the source and its callers:

| Area | Representative cases |
| --- | --- |
| Boundaries | Empty, zero, limit, just below/above limit, absent and malformed inputs. |
| Failures | Dependency rejection, timeout, cancellation, partial write, cleanup after errors. |
| Authorization | Missing/invalid/expired credentials, denial, cross-user access, no sensitive leakage. |
| Tool/CLI contracts | Input validation, output shape, error/exit behavior, protocol compatibility. |
| Collaboration | Real integration seams, persistence, serialization, retries/idempotency where relevant. |
| UI journeys | Important user actions, validation/error states, navigation, accessible interaction. |

Do not demand unreachable defensive branches, one test per source file, or
tests of type declarations merely to raise counts. Explain why a gap matters.
Also inspect coverage inclusion: omitted production code can inflate the result.

## Why might a test be unreliable?

- Missing awaits, promises that outlive the test, callbacks never observed.
- Polling/waits unrelated to the real completion event; arbitrary sleeps.
- Shared globals, modules, environment variables, filesystem paths, or ports.
- Cleanup that fails on exceptions, leaves handles open, or mutates other tests.
- Clocks, time zones, locales, random seeds, scheduler/concurrency assumptions.
- Live services and credentials without controlled fixtures or a declared
  integration boundary. Real filesystem/network use is not automatically wrong.

Use unique temporary resources; close servers and restore the exact prior state,
including removal of environment keys that did not previously exist. Prefer
completion signals, supported fake clocks, or bounded condition waits to sleeps.
Do not increase timeouts until the cause is understood.

Repeat the relevant cases both alone and with their neighbors when order
dependence is suspected. Record attempts and seeds, first failures, retry
successes, and environment conditions. A static smell is a risk, not an observed
flake; several passes are evidence only about those attempts.

## What is unnecessary maintenance?

Look for duplicate assertions of the same contract, giant incidental snapshots,
overly coupled internal-call checks, expensive duplicated setup, test-only
production seams, and focused/skipped cases. Preserve unique regression
protection even when removing a test would leave coverage percentages unchanged.
Do not rewrite valid tests simply to adopt parameterization or concurrency.

## Frontend and framework checks

Inspect configured unit/component/E2E tools before suggesting additions. Prefer
accessible, user-facing locators where the chosen tool supports them, but do
not blanket-ban CSS selectors needed for a genuine style or structural contract.
Check rendered content as well as console/network signals. Expected validation
errors or intentional failed requests are not automatically runtime defects.

Verify framework support/deprecation claims against current official sources.
Do not equate a different runner or an older supported major with poor tests.
