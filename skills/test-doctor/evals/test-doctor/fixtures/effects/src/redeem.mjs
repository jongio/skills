import { deliver } from "./transport.mjs";

export async function redeem(store, voucher, request, { primary, fallback, retries, signal, audit } = {}) {
  if (!store.reserve(voucher)) return { state: "busy" };
  let outcome;
  try {
    outcome = await deliver(request, { primary, fallback, retries, signal });
  } catch (error) {
    store.markUncertain(voucher);
    throw error;
  }
  if (outcome.state === "applied") {
    store.spend(voucher);
    try {
      await audit?.(voucher);
    } catch (error) {
      return { ...outcome, auditError: error.message };
    }
    return outcome;
  }
  if (outcome.state === "unknown") store.markUncertain(voucher);
  else store.release(voucher);
  return outcome;
}
