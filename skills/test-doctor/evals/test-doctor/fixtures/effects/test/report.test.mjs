import assert from "node:assert/strict";
import test from "node:test";
import { summarize } from "../src/report.mjs";
import { VoucherStore } from "../src/vouchers.mjs";

test("summarizes voucher states", () => {
  const store = new VoucherStore(["a", "b"]);
  store.reserve("a");
  store.spend("a");
  assert.equal(summarize(store, ["a", "b"]), "available: 1, spent: 1");
});
