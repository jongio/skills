export function shippingCost(subtotal) {
  if (!Number.isFinite(subtotal) || subtotal < 0) {
    throw new RangeError("subtotal must be finite and nonnegative");
  }
  return subtotal >= 100 ? 0 : 10;
}
