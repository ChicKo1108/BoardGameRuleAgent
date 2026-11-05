import { z } from "zod";
export const uuid = z.uuid();
const text = (max: number) => z.string().trim().min(1).max(max);
export const pageQuery = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).max(100000).default(0),
});
export const createGame = z.strictObject({
  slug: text(100).regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
  name: text(200),
});
export const createRuleset = z.strictObject({
  gameId: uuid,
  name: text(200),
  language: text(40),
  scope: text(2000),
});
export const createDocument = z.strictObject({
  rulesetId: uuid,
  title: text(300),
  sourceType: z.enum(["rulebook", "official_faq", "editorial"]),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export const createRevision = z.strictObject({
  parserConfig: z.record(z.string().max(100), z.unknown()).default({}),
});
export const sourceBlock = z.strictObject({
  ordinal: z.number().int().min(0),
  kind: z.enum(["text", "heading", "table", "figure"]),
  rawText: z.string().max(50000),
  pdfPageIndex: z.number().int().min(0).max(10000),
  printedPageLabel: z.string().max(40).nullable().default(null),
  bbox: z
    .tuple([
      z.number().finite(),
      z.number().finite(),
      z.number().finite(),
      z.number().finite(),
    ])
    .nullable()
    .default(null),
});
export const parsedBlocks = z.strictObject({
  blocks: z.array(sourceBlock).min(1).max(2000),
});
const ruleFields = {
  kind: z.enum(["rule", "exception", "definition", "example"]),
  reviewedText: text(50000),
  sectionPath: z.array(text(300)).max(20).default([]),
  applicability: z.array(text(1000)).max(50).default([]),
  explanation: z.string().max(10000).nullable().default(null),
  reviewStatus: z.enum(["pending", "approved", "rejected"]).default("pending"),
};
export const createRule = z.strictObject({
  ...ruleFields,
  sourceBlockIds: z.array(uuid).min(1).max(100),
});
export const editRule = z
  .strictObject({
    kind: ruleFields.kind.optional(),
    reviewedText: ruleFields.reviewedText.optional(),
    sectionPath: ruleFields.sectionPath.optional(),
    applicability: ruleFields.applicability.optional(),
    explanation: ruleFields.explanation.optional(),
    reviewStatus: ruleFields.reviewStatus.optional(),
    sourceBlockIds: z.array(uuid).min(1).max(100).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, "At least one change is required");
export const relationInput = z.strictObject({
  fromRuleId: uuid,
  toRuleId: uuid,
  kind: z.enum(["condition", "exception", "example", "supplement"]),
});
export const empty = z.strictObject({});
const created = { id: uuid, createdAt: z.iso.datetime({ offset: true }) };
export const gameResult = z.object({
  ...created,
  slug: z.string(),
  name: z.string(),
});
export const rulesetResult = z.object({
  ...created,
  gameId: uuid,
  name: z.string(),
  language: z.string(),
  scope: z.string(),
});
export const documentResult = z.object({
  ...created,
  rulesetId: uuid,
  title: z.string(),
  sourceType: z.string(),
  objectKey: z.string(),
  sha256: z.string(),
});
export const revisionResult = z.object({
  ...created,
  documentId: uuid,
  number: z.number(),
  status: z.enum(["uploaded", "parsing", "awaiting_review", "approved"]),
  parserConfig: z.record(z.string(), z.unknown()),
});
export const blockResult = sourceBlock.extend({ id: uuid, revisionId: uuid });
export const ruleResult = z.object({
  id: uuid,
  revisionId: uuid,
  ...ruleFields,
});
export const listResult = (item: z.ZodType) =>
  z.object({
    items: z.array(item),
    total: z.number(),
    limit: z.number(),
    offset: z.number(),
  });
