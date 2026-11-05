// Alternatives are OR; every member within an evidence set is AND.
export function scoreEvidence(acceptable: string[][], rankedRuleIds: string[]) {
  if (!acceptable.length) return null;
  const rank = new Map([...new Set(rankedRuleIds)].map((id, i) => [id, i + 1]));
  const recalls = acceptable.map(
    (set) => set.filter((id) => rank.has(id)).length / set.length,
  );
  const completeRanks = acceptable
    .filter((set) => set.every((id) => rank.has(id)))
    .map((set) => Math.max(...set.map((id) => rank.get(id)!)));
  const relevantRanks = acceptable
    .flat()
    .filter((id) => rank.has(id))
    .map((id) => rank.get(id)!);
  return {
    complete: completeRanks.length > 0,
    bestSetRecall: Math.max(...recalls),
    reciprocalRank: relevantRanks.length ? 1 / Math.min(...relevantRanks) : 0,
    completeReciprocalRank: completeRanks.length
      ? 1 / Math.min(...completeRanks)
      : 0,
  };
}
