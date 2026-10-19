import assert from "node:assert/strict";
import test from "node:test";
import { shippingCost } from "../shipping.mjs";

test("charges standard shipping", () => {
  assert.ok(shippingCost(20));
});

test("ships large orders free", () => {
  assert.equal(shippingCost(120), 0);
});
