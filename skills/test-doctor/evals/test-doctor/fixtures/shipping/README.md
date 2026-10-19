# Shipping contract

This is a dependency-free Node.js project. Do not install packages.

`shippingCost(subtotal)` accepts a finite, nonnegative number.
Subtotals below 100 cost exactly 10 to ship; subtotals of 100 or more ship free.
Invalid input throws a RangeError. These amounts are public behavior, not
implementation details.

Use `npm test` and `npm run coverage`. Tests belong in `test/shipping.test.mjs`
and use `node:assert/strict` and `node:test`.
There is no browser application and no configured coverage percentage gate.
