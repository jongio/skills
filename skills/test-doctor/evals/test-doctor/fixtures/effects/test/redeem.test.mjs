import assert from "node:assert/strict";
import test from "node:test";
import { redeem } from "../src/redeem.mjs";
import { RejectedError } from "../src/transport.mjs";
import { VoucherStore } from "../src/vouchers.mjs";

test("applied redemption spends the voucher", async () => {
  const store = new VoucherStore(["v1"]);
  const result = await redeem(store, "v1", { amount: 5 }, { primary: async () => {} });
  assert.equal(result.state, "applied");
  assert.equal(store.state("v1"), "spent");
});

test("spent vouchers are busy", async () => {
  const store = new VoucherStore(["v1"]);
  await redeem(store, "v1", {}, { primary: async () => {} });
  assert.deepEqual(await redeem(store, "v1", {}, { primary: async () => {} }), { state: "busy" });
});

test("receiver rejection makes the voucher available again", async () => {
  const store = new VoucherStore(["v1"]);
  const primary = async () => {
    throw new RejectedError("declined");
  };
  const result = await redeem(store, "v1", {}, { primary });
  assert.equal(result.state, "rejected");
  assert.equal(store.state("v1"), "available");
});
