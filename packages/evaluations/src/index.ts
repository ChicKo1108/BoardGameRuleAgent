import type { EvalCase, CaseResult } from "@boardgame/contracts";
export const SCORER_VERSION = "evidence-set-v1";
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
function mean(values: number[]) {
  return values.length
    ? values.reduce((a, b) => a + b, 0) / values.length
    : null;
}
function quantile(values: number[], p: number) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length
    ? sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]
    : null;
}
export function summarize(
  cases: EvalCase[],
  results: CaseResult[],
  withContext: boolean,
) {
  const byId = new Map(results.map((r) => [r.caseId, r]));
  const group = (selected: EvalCase[]) => {
    const rows = selected.map((c) => byId.get(c.id));
    const scorable = selected.filter(
      (c) => c.acceptableEvidenceSets.length > 0,
    );
    const metrics = (field: "searchScore" | "contextScore") => ({
      denominator: scorable.length,
      completeRate: mean(
        scorable.map((c) => (byId.get(c.id)?.[field]?.complete ? 1 : 0)),
      ),
      meanBestSetRecall: mean(
        scorable.map((c) => byId.get(c.id)?.[field]?.bestSetRecall ?? 0),
      ),
      mrr: mean(
        scorable.map((c) => byId.get(c.id)?.[field]?.reciprocalRank ?? 0),
      ),
      meanCompleteReciprocalRank: mean(
        scorable.map(
          (c) => byId.get(c.id)?.[field]?.completeReciprocalRank ?? 0,
        ),
      ),
    });
    return {
      total: selected.length,
      succeeded: rows.filter((r) => r?.status === "succeeded").length,
      failed: rows.filter((r) => r?.status === "failed").length,
      pending: rows.filter((r) => !r).length,
      unscored: selected.length - scorable.length,
      search: metrics("searchScore"),
      context: withContext ? metrics("contextScore") : null,
    };
  };
  return {
    scorerVersion: SCORER_VERSION,
    ...group(cases),
    byCategory: Object.fromEntries(
      [...new Set(cases.map((c) => c.category))].map((k) => [
        k,
        group(cases.filter((c) => c.category === k)),
      ]),
    ),
    bySeverity: Object.fromEntries(
      ["critical", "normal"].map((k) => [
        k,
        group(cases.filter((c) => c.severity === k)),
      ]),
    ),
    failures: cases
      .filter((c) => {
        const r = byId.get(c.id);
        return (
          !r ||
          r.status === "failed" ||
          (c.acceptableEvidenceSets.length &&
            !(withContext ? r.contextScore : r.searchScore)?.complete)
        );
      })
      .map((c) => c.id),
    latencyMs: {
      p50: quantile(
        results.map((r) => r.durationMs),
        0.5,
      ),
      p95: quantile(
        results.map((r) => r.durationMs),
        0.95,
      ),
    },
    usage: {
      knownTokens: results.reduce((sum, r) => sum + (r.usageTokens ?? 0), 0),
      unknownCases: results.filter((r) => r.usageTokens === null).length,
    },
    answerQualityEvaluated: false,
  };
}
