import type {
  EvalCase,
  VerifiedAnswer,
  AnswerEvalOutcome,
  AnswerReview,
} from "@boardgame/contracts";
import { scoreEvidence } from "./evidence.ts";
export const ANSWER_EVALUATOR_VERSION = "answer-review-v1" as const;
export function behaviorMatches(
  expected: EvalCase["expectedBehavior"],
  answer: VerifiedAnswer | null,
) {
  if (!answer) return false;
  switch (expected) {
    case "answer":
      return answer.status === "answered";
    case "answer_with_assumption":
      return (
        answer.status === "answered" &&
        !!answer.ambiguity &&
        !!answer.assumedMeaning &&
        !!answer.followUp
      );
    case "clarify":
      return answer.status === "needs_context" && !!answer.followUp;
    case "abstain":
      return answer.status === "insufficient_evidence";
  }
}
export function automaticAnswerScore(
  c: EvalCase,
  answer: VerifiedAnswer | null,
  runtimeValid: boolean,
  citationIntegrity: boolean,
) {
  const behaviorMatch = behaviorMatches(c.expectedBehavior, answer);
  const expectsAnswer = ["answer", "answer_with_assumption"].includes(
    c.expectedBehavior,
  );
  const citationCoverage = expectsAnswer
    ? scoreEvidence(
        c.acceptableEvidenceSets,
        answer?.citations.map((c) => c.ruleId) ?? [],
      )
    : null;
  const failures = [
    ...(!runtimeValid ? ["RUNTIME_FAILED_OR_REJECTED"] : []),
    ...(!behaviorMatch ? ["BEHAVIOR_MISMATCH"] : []),
    ...(!citationIntegrity ? ["CITATION_INTEGRITY_FAILED"] : []),
    ...(expectsAnswer && !citationCoverage?.complete
      ? ["CITATIONS_INCOMPLETE"]
      : []),
  ];
  return {
    runtimeValid,
    behaviorMatch,
    citationIntegrity,
    citationCoverage,
    pass: failures.length === 0,
    failures,
  };
}
export function manualReviewPasses(r: AnswerReview) {
  return (
    r.conclusionCorrect &&
    r.conditionsAndExceptionsCorrect &&
    r.ambiguityHandled &&
    r.refusalAppropriate &&
    r.citationsSupportClaims &&
    r.requiredClaimsSatisfied.every(Boolean) &&
    r.forbiddenClaimsAbsent.every(Boolean)
  );
}
export type AnswerReviewRow = {
  caseId: string;
  outcome: AnswerEvalOutcome | null;
  review: AnswerReview | null;
};
export function summarizeAnswers(cases: EvalCase[], rows: AnswerReviewRow[]) {
  const map = new Map(rows.map((r) => [r.caseId, r]));
  const passes = (id: string) => {
    const r = map.get(id);
    return (
      !!r?.outcome?.automatic.pass && !!r.review && manualReviewPasses(r.review)
    );
  };
  const fraction = (n: number, d: number) => (d ? n / d : null);
  const group = (cs: EvalCase[]) => {
    const outcomes = cs
      .map((c) => map.get(c.id)?.outcome)
      .filter((r) => r != null);
    const cited = cs.filter((c) =>
      ["answer", "answer_with_assumption"].includes(c.expectedBehavior),
    );
    return {
      total: cs.length,
      generated: outcomes.length,
      runtimeFailures: outcomes.filter((r) => !r.automatic.runtimeValid).length,
      automaticPasses: outcomes.filter((r) => r.automatic.pass).length,
      reviewed: cs.filter((c) => map.get(c.id)?.review).length,
      passed: cs.filter((c) => passes(c.id)).length,
      correctRate: fraction(cs.filter((c) => passes(c.id)).length, cs.length),
      behaviorMatchRate: fraction(
        outcomes.filter((r) => r.automatic.behaviorMatch).length,
        cs.length,
      ),
      citationIntegrityRate: fraction(
        outcomes.filter((r) => r.automatic.citationIntegrity).length,
        cs.length,
      ),
      citationCompleteRate: fraction(
        cited.filter(
          (c) => map.get(c.id)?.outcome?.automatic.citationCoverage?.complete,
        ).length,
        cited.length,
      ),
      citationDenominator: cited.length,
    };
  };
  const outcomes = rows.flatMap((r) => (r.outcome ? [r.outcome] : [])),
    times = outcomes.map((r) => r.durationMs).sort((a, b) => a - b);
  const percentile = (p: number) =>
    times.length ? times[Math.ceil(times.length * p) - 1] : null;
  const missingReviews = cases
    .filter((c) => !map.get(c.id)?.review)
    .map((c) => c.id);
  return {
    evaluatorVersion: ANSWER_EVALUATOR_VERSION,
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
    missingReviews,
    failures: cases.filter((c) => !passes(c.id)).map((c) => c.id),
    criticalFailures: cases
      .filter((c) => c.severity === "critical" && !passes(c.id))
      .map((c) => c.id),
    semanticQualityReviewed: cases.length > 0 && missingReviews.length === 0,
    latencyMs: { p50: percentile(0.5), p95: percentile(0.95) },
    usage: {
      knownReportedTokens: outcomes.reduce(
        (s, r) => s + (r.usage?.reportedTokens ?? 0),
        0,
      ),
      unknownUsageCalls: outcomes.reduce(
        (s, r) => s + (r.usage?.unknownUsageCalls ?? 0),
        0,
      ),
      casesWithoutUsage: outcomes.filter((r) => !r.usage).length,
      estimatedUsdReserved: outcomes.reduce(
        (s, r) => s + (r.usage?.estimatedUsdReserved ?? 0),
        0,
      ),
      reportedTokenCostEstimateUsd: outcomes.reduce(
        (s, r) => s + (r.usage?.reportedTokenCostEstimateUsd ?? 0),
        0,
      ),
    },
  };
}
