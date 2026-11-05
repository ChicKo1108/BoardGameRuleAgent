import { z } from "zod";
import { uuid, sourceBlock } from "./admin.ts";
const named = z.string().trim().min(1).max(200);
export const createRelease = z.strictObject({
  name: named,
  revisionIds: z
    .array(uuid)
    .min(1)
    .max(100)
    .refine((v) => new Set(v).size === v.length, "Duplicate revisions"),
});
export const releaseResult = z.object({
  id: uuid,
  rulesetId: uuid,
  name: z.string(),
  state: z.literal("sealed"),
  manifestHash: z.string(),
  createdAt: z.iso.datetime({ offset: true }),
});
export const manifestSchema = z.object({
  schemaVersion: z.literal(1),
  ruleset: z.object({
    id: uuid,
    gameId: uuid,
    name: z.string(),
    language: z.string(),
    scope: z.string(),
  }),
  documents: z.array(
    z.object({
      id: uuid,
      revisionId: uuid,
      revisionNumber: z.number().int(),
      title: z.string(),
      sourceType: z.string(),
      sha256: z.string(),
    }),
  ),
  rules: z.array(
    z.object({
      id: uuid,
      revisionId: uuid,
      kind: z.enum(["rule", "exception", "definition", "example"]),
      reviewedText: z.string(),
      sectionPath: z.array(z.string()),
      applicability: z.array(z.string()),
      explanation: z.string().nullable(),
      sources: z.array(sourceBlock.extend({ id: uuid })).min(1),
    }),
  ),
  relations: z.array(
    z.object({
      fromRuleId: uuid,
      toRuleId: uuid,
      kind: z.enum(["condition", "exception", "example", "supplement"]),
    }),
  ),
});
export type KnowledgeManifest = z.infer<typeof manifestSchema>;
export const lexicalConfigSchema = z.strictObject({
  schemaVersion: z.literal(1),
  method: z.literal("lexical"),
  chunker: z.literal("complete-rule-v1"),
  tokenizer: z.literal("intl-zh-word-v1"),
  icuVersion: z.string(),
  maxRuleChars: z.literal(8000),
});
export const indexBuildResult = z.object({
  id: uuid,
  releaseId: uuid,
  state: z.literal("ready"),
  configHash: z.string(),
  config: lexicalConfigSchema,
  createdAt: z.iso.datetime({ offset: true }),
});
export const searchInput = z.strictObject({
  query: z.string().trim().min(1).max(2000),
  limit: z.number().int().min(1).max(50).default(20),
});
export const searchResult = z.object({
  releaseId: uuid,
  indexBuildId: uuid,
  query: z.string(),
  tokens: z.array(z.string()),
  hits: z.array(
    z.object({
      chunkId: uuid,
      ruleId: uuid,
      rank: z.number(),
      score: z.number(),
    }),
  ),
});
export const contextInput = z.strictObject({
  chunkIds: z
    .array(uuid)
    .min(1)
    .max(20)
    .refine((v) => new Set(v).size === v.length, "Duplicate chunks"),
  maxRules: z.number().int().min(1).max(40).default(20),
  maxChars: z.number().int().min(1000).max(64000).default(32000),
});
export const contextResult = z.object({
  releaseId: uuid,
  indexBuildId: uuid,
  rulesetId: uuid,
  evidence: z.array(
    z.object({
      evidenceId: uuid,
      ruleId: uuid,
      kind: z.string(),
      role: z.enum(["primary", "related"]),
      text: z.string(),
      sectionPath: z.array(z.string()),
      applicability: z.array(z.string()),
      editorialExplanation: z.string().nullable(),
      sources: z.array(
        z.object({
          blockId: uuid,
          documentId: uuid,
          documentTitle: z.string(),
          sourceType: z.string(),
          pdfPageIndex: z.number(),
          printedPageLabel: z.string().nullable(),
          bbox: sourceBlock.shape.bbox,
        }),
      ),
    }),
  ),
  relations: manifestSchema.shape.relations,
  gaps: z.array(
    z.object({
      code: z.enum(["PRIMARY_RULE_OMITTED", "RELATED_RULE_OMITTED"]),
      ruleId: uuid,
    }),
  ),
});
