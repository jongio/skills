const states = new WeakMap();

function requireCarrier(carrier) {
  if (carrier === null || typeof carrier !== "object" || Array.isArray(carrier)) {
    throw new TypeError("carrier state requires a carrier object");
  }
}

export function initializeCarrierState(carrier, units) {
  requireCarrier(carrier);
  if (!Array.isArray(units) || states.has(carrier)) {
    throw new TypeError("carrier state must be initialized once with units");
  }
  states.set(carrier, {
    units,
    reportUnits: [],
  });
}

export function carrierState(carrier) {
  requireCarrier(carrier);
  const state = states.get(carrier);
  if (!state) throw new TypeError("carrier state is not initialized");
  return state;
}

export function findCarrierState(carrier) {
  requireCarrier(carrier);
  return states.get(carrier) ?? null;
}

export function updateCarrierState(carrier, values) {
  const state = carrierState(carrier);
  if (values === null || typeof values !== "object" || Array.isArray(values)) {
    throw new TypeError("carrier state update must be an object");
  }
  Object.assign(state, values);
}
