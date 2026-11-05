import { z } from "zod";
import { uuid as rawUuid } from "./admin.ts";
import * as a from "./answering.ts";
import * as ae from "./answer-evaluations.ts";
import * as e from "./evaluations.ts";
const uuid = rawUuid.toLowerCase(),
  count = z.number().int().nonnegative(),
  note = z.string().trim().min(1).max(4000);
const minimum = z.number().int().min(1).max(100);
export const policyConfig = z
  .strictObject({
    minCases: z.number().int().min(6).max(100),
    minCriticalCases: minimum,
    minimumByCategory: z.strictObject({
      recall: minimum,
      ambiguity: minimum,
      inference: minimum,
      multi_turn: minimum,
      insufficient_evidence: minimum,
    }),
    minCorrectRate: z.number().gt(0).max(1),
    minEvidenceCompleteRate: z.number().gt(0).max(1),
  })
  .refine(
    (c) => Object.values(c.minimumByCategory).reduce((a, b) => a + b, 0) <= 100,
    "Category minima exceed dataset limit",
  );
export const policyInput = z.strictObject({
  idempotencyKey: uuid,
  datasetId: uuid,
  expectedRevision: count,
  config: policyConfig,
  note,
});
export const policyResult = z.object({
  id: uuid,
  rulesetId: uuid,
  datasetId: uuid,
  baselinePublicationId: uuid.nullable(),
  regressionPublicationId: uuid.nullable(),
  baselineRevision: count,
  config: policyConfig,
  note: z.string(),
  policyHash: z.string(),
  createdAt: z.iso.datetime({ offset: true }),
});
export const assessmentInput = z.strictObject({
  idempotencyKey: uuid,
  policyId: uuid,
  answerEvaluationId: uuid,
  retrievalRunId: uuid,
});
export const gateResult = z.object({
  version: z.literal("publication-gate-v1"),
  passed: z.boolean(),
  failures: z.array(z.string()),
  regressedCases: z.array(z.string()),
  incomparableCases: z.array(z.string()),
  totalCases: count,
  criticalCases: count,
});
export const manifest = z.object({
  schemaVersion: z.literal(1),
  policy: policyResult,
  releaseId: uuid,
  releaseHash: z.string(),
  datasetHash: z.string(),
  retrieval: a.retrievalConfig,
  answerConfig: a.runResult.shape.config,
  answerEvaluationId: uuid,
  answerReportHash: z.string(),
  answerSummary: ae.summary,
  retrievalRunId: uuid,
  retrievalIdentity: e.identitySchema,
  retrievalReport: e.reportSchema,
});
export const publicationResult = z.object({
  id: uuid,
  rulesetId: uuid,
  releaseId: uuid,
  policyId: uuid,
  answerEvaluationId: uuid,
  retrievalRunId: uuid,
  manifest,
  manifestHash: z.string(),
  gate: gateResult,
  passed: z.boolean(),
  createdAt: z.iso.datetime({ offset: true }),
});
export const transitionInput = z
  .strictObject({
    idempotencyKey: uuid,
    expectedRevision: count,
    action: z.enum(["publish", "rollback", "deactivate"]),
    publicationId: uuid.nullable(),
    note,
  })
  .refine(
    (v) =>
      v.action === "deactivate"
        ? v.publicationId === null
        : v.publicationId !== null,
    "Publication must match action",
  );
export const eventResult = z.object({
  id: uuid,
  rulesetId: uuid,
  revision: count,
  action: z.enum(["publish", "rollback", "deactivate"]),
  publicationId: uuid.nullable(),
  previousPublicationId: uuid.nullable(),
  note: z.string(),
  createdAt: z.iso.datetime({ offset: true }),
});
export const headResult = z.object({
  rulesetId: uuid,
  revision: count,
  publicationId: uuid.nullable(),
  eventId: uuid.nullable(),
});
