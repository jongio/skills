import assert from "node:assert/strict";
import test from "node:test";

import {
  carrierState,
  findCarrierState,
  initializeCarrierState,
  updateCarrierState,
} from "../scripts/lib/carrier-state.mjs";

test("carrier state is private, explicit, and initialized once", () => {
  const carrier = { id: "carrier" };
  const units = [{ id: "unit" }];

  assert.equal(findCarrierState(carrier), null);
  initializeCarrierState(carrier, units);
  assert.deepEqual(carrierState(carrier), {
    units,
    reportUnits: [],
  });
  assert.deepEqual(Object.keys(carrier), ["id"]);
  assert.throws(
    () => initializeCarrierState(carrier, units),
    /initialized once/u,
  );
});

test("carrier state updates collector values without serialization", () => {
  const carrier = {};
  initializeCarrierState(carrier, []);
  updateCarrierState(carrier, {
    reportUnits: [{ id: "report" }],
  });

  assert.deepEqual(carrierState(carrier).reportUnits, [{ id: "report" }]);
  assert.equal(JSON.stringify(carrier), "{}");
});

test("carrier state rejects malformed and uninitialized inputs", () => {
  assert.throws(() => findCarrierState(null), /carrier object/u);
  assert.throws(() => carrierState({}), /not initialized/u);
  assert.throws(() => initializeCarrierState({}, null), /initialized once/u);
  const carrier = {};
  initializeCarrierState(carrier, []);
  assert.throws(() => updateCarrierState(carrier, null), /must be an object/u);
});
