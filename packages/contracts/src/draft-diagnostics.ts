import { z } from "zod";
import { evidenceScore } from "./evaluations.ts";
export const config = z.strictObject({
  split: z.literal("development").default("development"),
  queryMode: z
    .enum(["current_question", "annotated_query"])
    .default("current_question"),
  limit: z.number().int().min(1).max(12).default(6),
  maxRules: z.number().int().min(1).max(40).default(20),
  maxChars: z.number().int().min(1000).max(48000).default(24000),
});
export const caseResult = z.object({
  caseId: z.string(),
  category: z.string(),
  severity: z.string(),
  hasHistory: z.boolean(),
  query: z.string(),
  tokens: z.array(z.string()),
  status: z.enum(["succeeded", "failed"]),
  errorCode: z.string().nullable(),
  hits: z.array(
    z.object({ alias: z.string(), rank: z.number(), score: z.number() }),
  ),
  contextAliases: z.array(z.string()),
  gaps: z.array(z.object({ alias: z.string(), code: z.string() })),
  searchScore: evidenceScore.nullable(),
  contextScore: evidenceScore.nullable(),
  durationMs: z.number().nonnegative(),
});
const group = z.object({
  total: z.number(),
  scorable: z.number(),
  unscored: z.number(),
  failed: z.number(),
  searchCompleteRate: z.number().nullable(),
  contextCompleteRate: z.number().nullable(),
  gapFreeContextCompleteRate: z.number().min(0).max(1).nullable(),
  meanSearchRecall: z.number().nullable(),
  meanContextRecall: z.number().nullable(),
  contextGapCases: z.number(),
});
export const report = z.object({
  runId: z.uuid(),
  kind: z.literal("draft-retrieval-diagnostic"),
  publishable: z.literal(false),
  answerQualityEvaluated: z.literal(false),
  labelsReviewed: z.literal(false),
  config,
  bundleHash: z.string(),
  sourceFingerprint: z.string(),
  developmentCasesHash: z.string(),
  algorithm: z.object({
    lexicalCore: z.string(),
    contextCore: z.string(),
    sqlHash: z.string(),
    nodeVersion: z.string(),
    icuVersion: z.string(),
    postgresVersion: z.string(),
    tieBreak: z.literal("deterministic-draft-chunk-uuid"),
  }),
  summary: group.extend({
    byCategory: z.record(z.string(), group),
    bySeverity: z.record(z.string(), group),
  }),
  results: z.array(caseResult),
  createdAt: z.iso.datetime(),
  finishedAt: z.iso.datetime(),
});
