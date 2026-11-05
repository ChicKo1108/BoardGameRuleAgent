// Application-owned contracts; no framework or database dependencies.
export type AnswerStatus =
  "answered" | "needs_context" | "insufficient_evidence";
export interface SourceReference {
  blockId: string;
  pdfPageIndex: number;
  printedPageLabel?: string;
}
export interface RetrievalContext {
  rulesetId: string;
  releaseId: string;
  indexBuildId: string;
  requestId: string;
}
export interface SearchRulesInput {
  query: string;
  topic?: string;
}
export interface EvidenceBundle {
  retrievalRunId: string;
  releaseId: string;
  interpretedQuery: string;
  evidence: Array<{
    evidenceId: string;
    ruleUnitId: string;
    text: string;
    role: "primary" | "condition" | "exception" | "example";
    sourceRefs: SourceReference[];
  }>;
  gaps: string[];
}
export type RuleAnswer = import("./answering.ts").VerifiedAnswer;

export * as adminSchemas from "./admin.ts";

export * as knowledgeSchemas from "./knowledge.ts";
export type { KnowledgeManifest } from "./knowledge.ts";

export * as vectorSchemas from "./vectors.ts";
export type { EmbeddingProfile } from "./vectors.ts";

export * as evaluationSchemas from "./evaluations.ts";
export type { EvalCase, EvalConfig, CaseResult } from "./evaluations.ts";

export * as answeringSchemas from "./answering.ts";
export type {
  AnswerDraft,
  VerifiedAnswer,
  AnswerBudgets,
  ChatModelProfile,
} from "./answering.ts";

export * as answerEvaluationSchemas from "./answer-evaluations.ts";
export type { AnswerEvalOutcome, AnswerReview } from "./answer-evaluations.ts";
