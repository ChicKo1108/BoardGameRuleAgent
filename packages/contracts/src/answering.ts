import { z } from "zod";
import { uuid as rawUuid } from "./admin.ts";
import { contextResult } from "./knowledge.ts";
const uuid = rawUuid.toLowerCase();
const text = (max: number) => z.string().trim().min(1).max(max);
export const answerDraft = z
  .strictObject({
    status: z.enum(["answered", "needs_context", "insufficient_evidence"]),
    ambiguity: text(1000).nullable(),
    assumedMeaning: text(1000).nullable(),
    answer: text(6000),
    basis: z.enum(["explicit", "inferred", "mixed"]).nullable(),
    citations: z
      .array(
        z.strictObject({
          evidenceId: uuid,
          quote: text(2000),
          supports: text(2000),
        }),
      )
      .max(12),
    followUp: text(1000).nullable(),
  })
  .superRefine((a, c) => {
    const issue = (message: string) => c.addIssue({ code: "custom", message });
    if (a.status === "answered" && (!a.citations.length || !a.basis))
      issue("Answers require citations and basis");
    if (a.ambiguity && (!a.assumedMeaning || !a.followUp))
      issue("Ambiguity requires an assumption and confirmation");
    if (a.assumedMeaning && !a.ambiguity)
      issue("Assumption requires stated ambiguity");
    if (a.status === "needs_context" && !a.followUp)
      issue("Missing context requires a follow-up");
  });
export const citation = answerDraft.shape.citations.element.extend({
  ruleId: uuid,
  sectionPath: z.array(z.string()),
  sources: contextResult.shape.evidence.element.shape.sources,
});
export const verifiedAnswer = z.object({
  ...answerDraft.shape,
  citations: z.array(citation),
});
export const history = z
  .array(
    z.strictObject({
      role: z.enum(["user", "assistant"]),
      content: text(12000),
    }),
  )
  .max(10);
export const retrievalConfig = z
  .strictObject({
    indexBuildId: uuid,
    vectorIndexId: uuid.nullable().default(null),
    mode: z.enum(["lexical", "vector", "hybrid"]),
    limit: z.number().int().min(1).max(12).default(6),
    candidateLimit: z.number().int().min(1).max(50).default(20),
    rrfK: z.number().int().min(1).max(200).default(60),
    maxRules: z.number().int().min(1).max(40).default(20),
    maxChars: z.number().int().min(1000).max(48000).default(24000),
  })
  .refine((c) => c.limit <= c.candidateLimit, "limit exceeds candidates")
  .refine(
    (c) =>
      c.mode === "lexical"
        ? c.vectorIndexId === null
        : c.vectorIndexId !== null,
    "Vector index must match retrieval mode",
  );
export const previewInput = z.strictObject({
  idempotencyKey: uuid,
  question: text(2000),
  history: history.default([]),
  retrieval: retrievalConfig,
});
export const modelProfile = z.strictObject({
  protocol: z.literal("pi-openai-completions-v1"),
  providerId: text(100),
  model: text(200),
  revision: text(200),
  endpointHash: text(64),
  contextWindow: z.number().int().min(4096).max(1000000),
  inputUsdPerMillion: z.number().finite().min(0),
  outputUsdPerMillion: z.number().finite().min(0),
});
export const budgets = z.strictObject({
  maxModelCalls: z.number().int().min(1).max(6).default(4),
  maxToolCalls: z.number().int().min(0).max(8).default(4),
  maxOutputTokens: z.number().int().min(128).max(4096).default(1500),
  maxTotalOutputTokens: z.number().int().min(128).max(16000).default(6000),
  maxInputBytes: z.number().int().min(1000).max(160000).default(96000),
  maxTotalInputBytes: z.number().int().min(1000).max(500000).default(192000),
  maxEvidenceChars: z.number().int().min(1000).max(96000).default(64000),
  timeoutMs: z.number().int().min(100).max(120000).default(60000),
  maxEstimatedUsd: z.number().finite().positive().max(10).default(0.1),
});
export const usage = z.object({
  modelCalls: z.number().int(),
  toolCalls: z.number().int(),
  inputBytes: z.number().int(),
  outputTokensReserved: z.number().int(),
  reportedTokens: z.number().int(),
  unknownUsageCalls: z.number().int(),
  estimatedUsdReserved: z.number(),
  reportedTokenCostEstimateUsd: z.number(),
});
export const runResult = z.object({
  id: uuid,
  requestId: uuid,
  releaseId: uuid,
  indexBuildId: uuid,
  vectorIndexId: uuid.nullable(),
  state: z.enum(["running", "completed", "failed"]),
  input: previewInput,
  config: z.object({
    model: modelProfile,
    budgets,
    promptHash: z.string(),
    promptVersion: z.string(),
    piVersion: z.literal("1.5.0"),
    runtimeVersion: z.string(),
    nodeVersion: z.string(),
    buildRevision: z.string().nullable(),
    indexConfigHash: z.string(),
    embeddingProfileHash: z.string().nullable(),
  }),
  answer: verifiedAnswer.nullable(),
  reasonCode: z.string().nullable(),
  usage: usage.nullable(),
  createdAt: z.iso.datetime({ offset: true }),
  finishedAt: z.iso.datetime({ offset: true }).nullable(),
  expiresAt: z.iso.datetime({ offset: true }),
});
export const eventResult = z.object({
  sequence: z.number().int(),
  kind: z.string(),
  data: z.json(),
  createdAt: z.iso.datetime({ offset: true }),
});
export type AnswerDraft = z.infer<typeof answerDraft>;
export type VerifiedAnswer = z.infer<typeof verifiedAnswer>;
export type AnswerBudgets = z.infer<typeof budgets>;
export type ChatModelProfile = z.infer<typeof modelProfile>;
