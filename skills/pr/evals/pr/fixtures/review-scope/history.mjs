export function historicalScore(groups) {
  return groups.reduce((sum, group) => sum + group.score, 0) / groups.length;
}
