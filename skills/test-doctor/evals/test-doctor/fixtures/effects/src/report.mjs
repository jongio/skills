export function summarize(store, ids) {
  const counts = {};
  for (const id of ids) {
    const state = store.state(id);
    counts[state] = (counts[state] ?? 0) + 1;
  }
  return Object.keys(counts)
    .sort()
    .map((state) => `${state}: ${counts[state]}`)
    .join(", ");
}
