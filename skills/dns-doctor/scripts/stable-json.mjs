export const compareText = (left, right) => left === right ? 0 : left < right ? -1 : 1;

export function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort(compareText)
      .map((key) => [key, stableValue(value[key])]),
  );
}

export function stableKey(value) {
  return JSON.stringify(stableValue(value));
}

export function stableJson(value) {
  return `${JSON.stringify(stableValue(value), null, 2)}\n`;
}

export function equivalent(left, right) {
  return stableKey(left) === stableKey(right);
}
