import type {
  EvalCase,
  AnswerDraft,
} from "../../packages/contracts/src/index.ts";
import { validDraft, contentText } from "./chat.js";
export const publicationPolicy = {
  minCases: 6,
  minCriticalCases: 1,
  minimumByCategory: {
    recall: 1,
    ambiguity: 1,
    inference: 1,
    multi_turn: 1,
    insufficient_evidence: 1,
  },
  minCorrectRate: 1,
  minEvidenceCompleteRate: 1,
};
export function publicationCases(
  ruleId: string,
  query = "工厂花砖",
): EvalCase[] {
  return (
    [
      "recall",
      "ambiguity",
      "inference",
      "multi_turn",
      "insufficient_evidence",
      "clarification",
    ] as const
  ).map((kind, i) => ({
    id: kind,
    category: kind === "clarification" ? "insufficient_evidence" : kind,
    split: "holdout",
    severity: i === 0 ? "critical" : "normal",
    messages: [
      ...(kind === "multi_turn"
        ? [
            { role: "user" as const, content: "请回忆刚才的规则" },
            { role: "assistant" as const, content: "我们在讨论花砖规则" },
          ]
        : []),
      { role: "user" as const, content: `${query} synthetic-case-${kind}` },
    ],
    query,
    expectedBehavior:
      kind === "ambiguity"
        ? "answer_with_assumption"
        : kind === "insufficient_evidence"
          ? "abstain"
          : kind === "clarification"
            ? "clarify"
            : "answer",
    requiredClaims: [],
    forbiddenClaims: [],
    acceptableEvidenceSets: ["insufficient_evidence", "clarification"].includes(
      kind,
    )
      ? []
      : [[ruleId]],
    reviewNote: "Synthetic fixture only, not a real game acceptance case",
  }));
}
export function publicationReply(body: any) {
  const text = body.messages.map((m: any) => contentText(m.content)).join("\n");
  const draft = validDraft(body) as AnswerDraft;
  if (text.includes("synthetic-case-ambiguity")) {
    draft.ambiguity = "合成歧义";
    draft.assumedMeaning = "按工厂拿取理解";
    draft.followUp = "你指的是工厂吗？";
  }
  if (
    text.includes("synthetic-case-insufficient_evidence") ||
    text.includes("synthetic-case-clarification")
  ) {
    draft.status = text.includes("synthetic-case-clarification")
      ? "needs_context"
      : "insufficient_evidence";
    draft.basis = null;
    draft.citations = [];
    draft.answer = "合成拒答";
    draft.followUp =
      draft.status === "needs_context" ? "你指的是哪个阶段？" : null;
  }
  return { text: JSON.stringify(draft) };
}
export const passingReview = {
  conclusionCorrect: true,
  conditionsAndExceptionsCorrect: true,
  ambiguityHandled: true,
  refusalAppropriate: true,
  citationsSupportClaims: true,
  requiredClaimsSatisfied: [],
  forbiddenClaimsAbsent: [],
  note: "Synthetic test of review storage; not real rule acceptance",
};
