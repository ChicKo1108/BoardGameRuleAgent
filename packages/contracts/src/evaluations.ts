import { z } from "zod";
import { uuid as rawUuid } from "./admin.ts";
const uuid = rawUuid.toLowerCase();
import { searchResult, contextResult } from "./knowledge.ts";
import { vectorSearchResult, embeddingProfile } from "./vectors.ts";
const unique = (v: string[]) => new Set(v).size === v.length;
export const evalCase = z
  .strictObject({
    id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
    category: z.enum([
      "recall",
      "ambiguity",
      "inference",
      "multi_turn",
      "insufficient_evidence",
    ]),
    split: z.enum(["development", "holdout"]),
    severity: z.enum(["critical", "normal"]),
    messages: z
      .array(
        z.strictObject({
          role: z.enum(["user", "assistant"]),
          content: z.string().min(1).max(4000),
        }),
      )
      .min(1)
      .max(20),
    // Explicit retrieval input; multi-turn rewriting is a separate future evaluation.
    query: z.string().trim().min(1).max(2000),
    expectedBehavior: z.enum([
      "answer",
      "answer_with_assumption",
      "clarify",
      "abstain",
    ]),
    requiredClaims: z.array(z.string().min(1).max(2000)).max(30),
    forbiddenClaims: z.array(z.string().min(1).max(2000)).max(30),
    acceptableEvidenceSets: z
      .array(z.array(uuid).min(1).max(40).refine(unique, "Duplicate evidence"))
      .max(10),
    reviewNote: z.string().trim().min(1).max(2000),
  })
  .refine(
    (c) =>
      c.acceptableEvidenceSets.length > 0 ||
      ["abstain", "clarify"].includes(c.expectedBehavior),
    "Answer cases require evidence",
  );
export const datasetInput = z.strictObject({
  name: z.string().trim().min(1).max(200),
  revision: z.string().trim().min(1).max(100),
  cases: z
    .array(evalCase)
    .min(1)
    .max(100)
    .refine((cs) => unique(cs.map((c) => c.id)), "Duplicate cases"),
});
export const datasetResult = z.object({
  id: uuid,
  releaseId: uuid,
  manifestHash: z.string(),
  manifest: datasetInput,
  createdAt: z.iso.datetime({ offset: true }),
});
export const runConfig = z
  .strictObject({
    indexBuildId: uuid,
    vectorIndexId: uuid.nullable().default(null),
    mode: z.enum(["lexical", "vector", "hybrid"]),
    split: z.enum(["development", "holdout"]),
    limit: z.number().int().min(1).max(20).default(10),
    candidateLimit: z.number().int().min(1).max(50).default(20),
    rrfK: z.number().int().min(1).max(200).default(60),
    context: z
      .strictObject({
        maxRules: z.number().int().min(1).max(40).default(20),
        maxChars: z.number().int().min(1000).max(64000).default(32000),
      })
      .nullable()
      .default(null),
  })
  .refine((c) => c.limit <= c.candidateLimit, "limit exceeds candidateLimit")
  .refine(
    (c) =>
      c.mode === "lexical"
        ? c.vectorIndexId === null
        : c.vectorIndexId !== null,
    "Vector index required only for vector/hybrid",
  );
export const runInput = z.strictObject({
  idempotencyKey: uuid,
  config: runConfig,
});
export const evidenceScore = z.object({
  complete: z.boolean(),
  bestSetRecall: z.number().min(0).max(1),
  reciprocalRank: z.number().min(0).max(1),
  completeReciprocalRank: z.number().min(0).max(1),
});
export const caseResult = z.object({
  caseId: z.string(),
  category: evalCase.shape.category,
  severity: evalCase.shape.severity,
  status: z.enum(["succeeded", "failed"]),
  errorCode: z.string().nullable(),
  durationMs: z.number().int().nonnegative(),
  usageTokens: z.number().int().nonnegative().nullable(),
  search: z.union([vectorSearchResult, searchResult]).nullable(),
  context: contextResult.nullable(),
  searchScore: evidenceScore.nullable(),
  contextScore: evidenceScore.nullable(),
});
const count = z.number().int().nonnegative();
const rate = z.number().min(0).max(1).nullable();
const metrics = z.object({
  denominator: count,
  completeRate: rate,
  meanBestSetRecall: rate,
  mrr: rate,
  meanCompleteReciprocalRank: rate,
});
const group = z.object({
  total: count,
  succeeded: count,
  failed: count,
  pending: count,
  unscored: count,
  search: metrics,
  context: metrics.nullable(),
});
export const reportSchema = group.extend({
  scorerVersion: z.string(),
  byCategory: z.record(z.string(), group),
  bySeverity: z.record(z.string(), group),
  failures: z.array(z.string()),
  latencyMs: z.object({ p50: count.nullable(), p95: count.nullable() }),
  usage: z.object({ knownTokens: count, unknownCases: count }),
  answerQualityEvaluated: z.literal(false),
});
export const identitySchema = z.object({
  scorerVersion: z.string(),
  datasetHash: z.string(),
  releaseHash: z.string(),
  indexConfigHash: z.string(),
  embeddingProfileHash: z.string().nullable(),
  embeddingProfile: embeddingProfile.nullable(),
  nodeVersion: z.string(),
  retrieverVersion: z.string(),
  contextVersion: z.string(),
});
export const runResult = z.object({
  id: uuid,
  datasetId: uuid,
  releaseId: uuid,
  config: runConfig,
  identity: identitySchema,
  state: z.enum([
    "queued",
    "running",
    "retrying",
    "failed",
    "completed",
    "completed_with_errors",
  ]),
  queueState: z.string().nullable(),
  attempts: z.number().int(),
  errorCode: z.string().nullable(),
  completedCases: z.number().int(),
  totalCases: z.number().int(),
  report: reportSchema.nullable(),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
});
export type EvalCase = z.infer<typeof evalCase>;
export type EvalConfig = z.infer<typeof runConfig>;
export type CaseResult = z.infer<typeof caseResult>;
