import { z } from "zod";
import { uuid as rawUuid } from "./admin.ts";
import * as a from "./answering.ts";
import * as e from "./evaluations.ts";
const uuid = rawUuid.toLowerCase(),
  count = z.number().int().nonnegative(),
  rate = z.number().min(0).max(1).nullable();
export const config = z.strictObject({
  split: z.enum(["development", "holdout"]),
  retrieval: a.retrievalConfig,
});
export const enqueueInput = z.strictObject({ idempotencyKey: uuid, config });
export const identity = z.object({
  evaluatorVersion: z.literal("answer-review-v1"),
  datasetHash: z.string(),
  releaseHash: z.string(),
  answerConfig: a.runResult.shape.config,
});
export const automatic = z.object({
  runtimeValid: z.boolean(),
  behaviorMatch: z.boolean(),
  citationIntegrity: z.boolean(),
  citationCoverage: e.evidenceScore.nullable(),
  pass: z.boolean(),
  failures: z.array(z.string()),
});
export const outcome = z.object({
  automatic,
  durationMs: count,
  usage: a.usage.nullable(),
  reasonCode: z.string().nullable(),
});
export const reviewFields = z.strictObject({
  conclusionCorrect: z.boolean(),
  conditionsAndExceptionsCorrect: z.boolean(),
  ambiguityHandled: z.boolean(),
  refusalAppropriate: z.boolean(),
  citationsSupportClaims: z.boolean(),
  requiredClaimsSatisfied: z.array(z.boolean()).max(30),
  forbiddenClaimsAbsent: z.array(z.boolean()).max(30),
  note: z.string().trim().min(1).max(4000),
});
export const reviewInput = z.strictObject({
  expectedRevision: count,
  review: reviewFields,
});
export const reviewResult = z.object({
  id: uuid,
  caseRowId: uuid,
  revision: count,
  actor: z.literal("admin"),
  review: reviewFields,
  createdAt: z.iso.datetime({ offset: true }),
});
export const caseResult = z.object({
  id: uuid,
  evaluationId: uuid,
  caseId: z.string(),
  executionKey: uuid,
  answerRunId: uuid.nullable(),
  testCase: e.evalCase,
  outcome: outcome.nullable(),
  answerRun: a.runResult.nullable(),
  latestReview: reviewResult.nullable(),
});
const group = z.object({
  total: count,
  generated: count,
  runtimeFailures: count,
  automaticPasses: count,
  reviewed: count,
  passed: count,
  correctRate: rate,
  behaviorMatchRate: rate,
  citationIntegrityRate: rate,
  citationCompleteRate: rate,
  citationDenominator: count,
});
export const summary = group.extend({
  evaluatorVersion: z.literal("answer-review-v1"),
  byCategory: z.record(z.string(), group),
  bySeverity: z.record(z.string(), group),
  missingReviews: z.array(z.string()),
  failures: z.array(z.string()),
  criticalFailures: z.array(z.string()),
  semanticQualityReviewed: z.boolean(),
  latencyMs: z.object({ p50: count.nullable(), p95: count.nullable() }),
  usage: z.object({
    knownReportedTokens: count,
    unknownUsageCalls: count,
    casesWithoutUsage: count,
    estimatedUsdReserved: z.number(),
    reportedTokenCostEstimateUsd: z.number(),
  }),
});
export const sealedReport = z.object({
  evaluationId: uuid,
  datasetId: uuid,
  releaseId: uuid,
  config,
  identity,
  identityHash: z.string(),
  summary,
  note: z.string(),
  sealedAt: z.iso.datetime({ offset: true }),
  cases: z.array(
    z.object({
      caseRowId: uuid,
      caseId: z.string(),
      answerRunId: uuid,
      reviewId: uuid,
      reviewRevision: count,
    }),
  ),
});
export const runResult = z.object({
  id: uuid,
  datasetId: uuid,
  releaseId: uuid,
  config,
  identity,
  identityHash: z.string(),
  state: z.enum([
    "assembling",
    "queued",
    "running",
    "retrying",
    "failed",
    "awaiting_review",
    "sealed",
  ]),
  queueState: z.string().nullable(),
  attempts: count,
  errorCode: z.string().nullable(),
  summary,
  report: sealedReport.nullable(),
  reportHash: z.string().nullable(),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
});
export const sealInput = z.strictObject({
  note: z.string().trim().min(1).max(4000),
});
export type AnswerEvalOutcome = z.infer<typeof outcome>;
export type AnswerReview = z.infer<typeof reviewFields>;
