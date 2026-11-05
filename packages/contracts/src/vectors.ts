import { z } from "zod";
import { uuid } from "./admin.ts";
export const embeddingProfile = z.strictObject({
  protocol: z.literal("openai-compatible-v1"),
  providerId: z.string().min(1).max(100),
  endpointHash: z.string().regex(/^[a-f0-9]{64}$/),
  model: z.string().min(1).max(200),
  revision: z.string().min(1).max(200),
  dimensions: z.number().int().min(1).max(4096),
  sendDimensions: z.boolean(),
  documentPrefix: z.string().max(1000),
  queryPrefix: z.string().max(1000),
  maxInputChars: z.number().int().min(1).max(16000),
  distance: z.literal("cosine"),
});
export type EmbeddingProfile = z.infer<typeof embeddingProfile>;
export const vectorIndexResult = z.object({
  id: uuid,
  indexBuildId: uuid,
  releaseId: uuid,
  state: z.enum(["queued", "running", "retrying", "failed", "ready"]),
  profile: embeddingProfile,
  profileHash: z.string(),
  attempts: z.number().int(),
  errorCode: z.string().nullable(),
  completedChunks: z.number().int(),
  totalChunks: z.number().int(),
  queueState: z.string().nullable(),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
});
export const vectorSearchInput = z
  .strictObject({
    query: z.string().trim().min(1).max(2000),
    mode: z.enum(["lexical", "vector", "hybrid"]).default("hybrid"),
    candidateLimit: z.number().int().min(1).max(50).default(20),
    limit: z.number().int().min(1).max(50).default(10),
    rrfK: z.number().int().min(1).max(200).default(60),
  })
  .refine(
    (v) => v.limit <= v.candidateLimit,
    "limit must not exceed candidateLimit",
  );
export const rankedHit = z.object({
  chunkId: uuid,
  ruleId: uuid,
  rank: z.number().int(),
  score: z.number(),
  lexicalRank: z.number().int().nullable(),
  vectorRank: z.number().int().nullable(),
  lexicalScore: z.number().nullable(),
  cosineDistance: z.number().nullable(),
});
export const vectorSearchResult = z.object({
  retrievalRunId: uuid,
  releaseId: uuid,
  indexBuildId: uuid,
  vectorIndexId: uuid,
  mode: z.enum(["lexical", "vector", "hybrid"]),
  query: z.string(),
  hits: z.array(rankedHit),
  candidates: z.object({
    lexical: z.array(
      z.object({
        chunkId: uuid,
        ruleId: uuid,
        rank: z.number(),
        score: z.number(),
      }),
    ),
    vector: z.array(
      z.object({
        chunkId: uuid,
        ruleId: uuid,
        rank: z.number(),
        distance: z.number(),
      }),
    ),
  }),
  durationMs: z.number().int().min(0),
  usageTokens: z.number().int().min(0).nullable(),
});
export const retrievalRunResult = z.object({
  id: uuid,
  requestId: uuid.nullable(),
  vectorIndexId: uuid,
  indexBuildId: uuid,
  releaseId: uuid,
  query: z.string(),
  mode: z.string(),
  config: z.record(z.string(), z.unknown()),
  status: z.enum(["succeeded", "failed"]),
  result: z.record(z.string(), z.unknown()),
  errorCode: z.string().nullable(),
  durationMs: z.number().int(),
  usageTokens: z.number().int().nullable(),
  createdAt: z.iso.datetime({ offset: true }),
});
