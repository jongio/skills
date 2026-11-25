# Voucher redemption

`redeem(store, voucher, request, options)` sends one redemption request and
settles a single-use voucher. The latest change added the voucher handling in
`src/redeem.mjs`; `src/transport.mjs` and `src/vouchers.mjs` were not edited.

## Contract

- A voucher may be redeemed once. While one call holds it, other calls return
  `{ state: "busy" }` without sending anything.
- The receiver applies a request at most once per voucher, so a retry or
  duplicate of an applied request is refused.
- `NotSentError` means nothing left the process. `RejectedError` means the
  receiver definitively refused and applied nothing. Any other failure after
  sending began, including a timeout or cancellation, has an unknown outcome.
- Timeouts may be retried. The fallback route may be used only when nothing
  could have reached the primary route.
- The call result is `applied`, `rejected`, `not-sent`, or `unknown`. An earlier
  unknown attempt stays unknown unless a later attempt is confirmed applied.
- The voucher becomes `spent` after an applied result, `available` again only
  when the whole call proves nothing was applied, and `uncertain` otherwise.
- The audit write runs after an applied result. Its failure is reported as
  `auditError`; it never makes the voucher reusable.

`src/report.mjs` formats a read-only summary of voucher states.
