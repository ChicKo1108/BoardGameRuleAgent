import { isDeepStrictEqual } from "node:util";
import type { z } from "zod";
import type {
  EvalCase,
  publicationSchemas as p,
  answerEvaluationSchemas as ae,
  evaluationSchemas as e,
} from "@boardgame/contracts";
export const PUBLICATION_GATE_VERSION = "publication-gate-v1" as const;
// Evidence UUIDs vary between knowledge snapshots; the behavioral contract must remain comparable.
function contract(c: EvalCase) {
  return {
    id: c.id,
    category: c.category,
    severity: c.severity,
    messages: c.messages,
    query: c.query,
    expectedBehavior: c.expectedBehavior,
    requiredClaims: c.requiredClaims,
    forbiddenClaims: c.forbiddenClaims,
  };
}
export function publicationGate(
  config: z.infer<typeof p.policyConfig>,
  cases: EvalCase[],
  answer: z.infer<typeof ae.summary>,
  retrieval: z.infer<typeof e.reportSchema>,
  baseline?: { cases: EvalCase[]; summary: z.infer<typeof ae.summary> },
) {
  const failures: string[] = [],
    regressedCases: string[] = [],
    incomparableCases: string[] = [];
  const check = (ok: boolean, code: string) => {
    if (!ok) failures.push(code);
  };
  check(cases.length >= config.minCases, "MINIMUM_CASES");
  const criticalCases = cases.filter((c) => c.severity === "critical").length;
  check(criticalCases >= config.minCriticalCases, "MINIMUM_CRITICAL_CASES");
  for (const [category, min] of Object.entries(config.minimumByCategory))
    check(
      cases.filter((c) => c.category === category).length >= min,
      `CATEGORY_COVERAGE:${category}`,
    );
  for (const behavior of [
    "answer",
    "answer_with_assumption",
    "clarify",
    "abstain",
  ])
    check(
      cases.some((c) => c.expectedBehavior === behavior),
      `BEHAVIOR_COVERAGE:${behavior}`,
    );
  check(
    cases.some(
      (c) =>
        c.category === "multi_turn" &&
        c.messages.slice(0, -1).some((m) => m.role === "assistant"),
    ),
    "MULTI_TURN_COVERAGE",
  );
  check(
    answer.total === cases.length &&
      answer.generated === cases.length &&
      answer.reviewed === cases.length &&
      answer.semanticQualityReviewed,
    "ANSWER_REVIEW_INCOMPLETE",
  );
  check(answer.runtimeFailures === 0, "ANSWER_RUNTIME_FAILURES");
  check(answer.criticalFailures.length === 0, "CRITICAL_ANSWER_FAILURES");
  check(answer.citationIntegrityRate === 1, "CITATION_INTEGRITY");
  check(
    answer.correctRate !== null && answer.correctRate >= config.minCorrectRate,
    "ANSWER_CORRECT_RATE",
  );
  check(
    retrieval.total === cases.length &&
      retrieval.failed === 0 &&
      retrieval.pending === 0,
    "RETRIEVAL_INCOMPLETE",
  );
  check(
    retrieval.context !== null &&
      retrieval.context.denominator > 0 &&
      retrieval.context.completeRate !== null &&
      retrieval.context.completeRate >= config.minEvidenceCompleteRate,
    "EVIDENCE_COMPLETE_RATE",
  );
  const scorableCritical = cases.filter(
    (c) => c.severity === "critical" && c.acceptableEvidenceSets.length,
  );
  check(
    !scorableCritical.some((c) => retrieval.failures.includes(c.id)),
    "CRITICAL_RETRIEVAL_FAILURES",
  );
  if (baseline) {
    const byId = new Map(cases.map((c) => [c.id, c]));
    for (const old of baseline.cases) {
      const current = byId.get(old.id);
      if (!current || !isDeepStrictEqual(contract(current), contract(old)))
        incomparableCases.push(old.id);
      else if (
        !baseline.summary.failures.includes(old.id) &&
        answer.failures.includes(old.id)
      )
        regressedCases.push(old.id);
    }
    check(!incomparableCases.length, "REGRESSION_SUITE_CHANGED");
    check(!regressedCases.length, "ANSWER_REGRESSION");
  }
  return {
    version: PUBLICATION_GATE_VERSION,
    passed: failures.length === 0,
    failures,
    regressedCases,
    incomparableCases,
    totalCases: cases.length,
    criticalCases,
  };
}
