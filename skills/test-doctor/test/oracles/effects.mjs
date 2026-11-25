// Reference tests for evals/test-doctor/fixtures/effects. They are copied into a
// temporary fixture as test/oracle.test.mjs and must kill every seeded mutant.
import assert from "node:assert/strict";
import test from "node:test";
import { redeem } from "../src/redeem.mjs";
import { NotSentError, RejectedError, TimeoutError } from "../src/transport.mjs";
import { VoucherStore } from "../src/vouchers.mjs";

const sent = () => {
  const calls = [];
  const send = async (request) => {
    calls.push(request);
  };
  return { calls, send };
};

test("concurrent redemptions deliver once", async () => {
  const store = new VoucherStore(["v1"]);
  const { calls, send } = sent();
  const results = await Promise.allSettled([
    redeem(store, "v1", {}, { primary: send }),
    redeem(store, "v1", {}, { primary: send }),
  ]);
  assert.deepEqual(results.map((item) => item.status), ["fulfilled", "fulfilled"]);
  assert.deepEqual(results.map((item) => item.value.state).sort(), ["applied", "busy"]);
  assert.equal(calls.length, 1);
  assert.equal(store.state("v1"), "spent");
});

test("an unclassified error after dispatch keeps the voucher uncertain", async () => {
  const store = new VoucherStore(["v1"]);
  const primary = async () => {
    throw new Error("connection reset");
  };
  const result = await redeem(store, "v1", {}, { primary });
  assert.equal(result.state, "unknown");
  assert.equal(store.state("v1"), "uncertain");
});

test("a timeout followed by a rejection stays uncertain", async () => {
  const store = new VoucherStore(["v1"]);
  let count = 0;
  const primary = async () => {
    count += 1;
    if (count === 1) throw new TimeoutError("slow");
    throw new RejectedError("duplicate");
  };
  const result = await redeem(store, "v1", {}, { primary, retries: 1 });
  assert.equal(count, 2);
  assert.equal(result.state, "unknown");
  assert.equal(store.state("v1"), "uncertain");
});

test("fallback is not used after an uncertain or rejected primary", async () => {
  for (const failure of [new Error("reset"), new RejectedError("declined")]) {
    const store = new VoucherStore(["v1"]);
    const fallback = sent();
    await redeem(store, "v1", {}, {
      primary: async () => {
        throw failure;
      },
      fallback: fallback.send,
    });
    assert.equal(fallback.calls.length, 0);
  }
});

test("cancellation during dispatch keeps the voucher uncertain", async () => {
  const store = new VoucherStore(["v1"]);
  const controller = new AbortController();
  const primary = async () => {
    controller.abort();
    throw new DOMException("aborted", "AbortError");
  };
  const result = await redeem(store, "v1", {}, { primary, signal: controller.signal });
  assert.equal(result.state, "unknown");
  assert.equal(store.state("v1"), "uncertain");
});

test("cancellation before dispatch releases the voucher", async () => {
  const store = new VoucherStore(["v1"]);
  const controller = new AbortController();
  controller.abort();
  const { calls, send } = sent();
  const result = await redeem(store, "v1", {}, { primary: send, signal: controller.signal });
  assert.equal(calls.length, 0);
  assert.equal(result.state, "not-sent");
  assert.equal(store.state("v1"), "available");
});

test("an audit failure after delivery keeps the voucher spent", async () => {
  const store = new VoucherStore(["v1"]);
  const result = await redeem(store, "v1", {}, {
    primary: async () => {},
    audit: async () => {
      throw new Error("audit offline");
    },
  });
  assert.equal(result.state, "applied");
  assert.equal(result.auditError, "audit offline");
  assert.equal(store.state("v1"), "spent");
});

test("a clean pre-dispatch failure releases the voucher or uses the fallback", async () => {
  const notSent = async () => {
    throw new NotSentError("no route");
  };
  const store = new VoucherStore(["v1"]);
  const result = await redeem(store, "v1", {}, { primary: notSent });
  assert.equal(result.state, "not-sent");
  assert.equal(store.state("v1"), "available");

  const withFallback = new VoucherStore(["v2"]);
  const fallback = sent();
  const recovered = await redeem(withFallback, "v2", {}, { primary: notSent, fallback: fallback.send });
  assert.equal(fallback.calls.length, 1);
  assert.equal(recovered.state, "applied");
  assert.equal(withFallback.state("v2"), "spent");
});
