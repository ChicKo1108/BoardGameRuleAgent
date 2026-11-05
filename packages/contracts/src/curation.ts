import { z } from "zod";
import * as a from "./admin.ts";
import * as e from "./evaluations.ts";
const alias = z
    .string()
    .regex(/^[a-zA-Z0-9_-]{1,80}$/)
    .refine(
      (v) => !["__proto__", "constructor", "prototype", "toJSON"].includes(v),
      "Reserved alias",
    ),
  sha = z.string().regex(/^[a-f0-9]{64}$/),
  text = (max: number) => z.string().trim().min(1).max(max),
  unique = (x: unknown[]) => new Set(x).size === x.length;
export const source = z.object({
  documentSha256: sha,
  parserConfig: z.json(),
  pipelineVersion: z.string(),
  parserVersion: z.string().nullable(),
  blocks: z.array(a.sourceBlock).min(1).max(2000),
});
export const rule = z.strictObject({
  alias,
  kind: a.createRule.shape.kind,
  reviewedText: text(8000),
  sectionPath: a.createRule.shape.sectionPath,
  applicability: a.createRule.shape.applicability,
  explanation: a.createRule.shape.explanation,
  sourceOrdinals: z
    .array(z.number().int().nonnegative())
    .min(1)
    .max(100)
    .refine(unique, "Duplicate source ordinal"),
});
export const labelCase = z
  .strictObject({
    ...e.evalCase.shape,
    acceptableEvidenceSets: z.never().optional(),
    acceptableEvidenceAliases: z
      .array(z.array(alias).min(1).max(40).refine(unique))
      .max(10),
  })
  .omit({ acceptableEvidenceSets: true })
  .refine(
    (c) =>
      c.acceptableEvidenceAliases.length > 0 ||
      ["abstain", "clarify"].includes(c.expectedBehavior),
    "Answer cases require evidence aliases",
  );
export const bundle = z
  .strictObject({
    schemaVersion: z.literal(1),
    name: text(200),
    revision: text(100),
    sourceFingerprint: sha,
    rules: z.array(rule).min(1).max(2000),
    relations: z
      .array(
        z.strictObject({
          from: alias,
          to: alias,
          kind: a.relationInput.shape.kind,
        }),
      )
      .max(4000)
      .default([]),
    cases: z.array(labelCase).max(100).default([]),
  })
  .superRefine((b, c) => {
    const aliases = new Set(b.rules.map((r) => r.alias));
    if (aliases.size !== b.rules.length)
      c.addIssue({ code: "custom", message: "Duplicate rule aliases" });
    if (!unique(b.cases.map((x) => x.id)))
      c.addIssue({ code: "custom", message: "Duplicate case IDs" });
    if (!unique(b.relations.map((r) => `${r.from}:${r.to}:${r.kind}`)))
      c.addIssue({ code: "custom", message: "Duplicate relations" });
    for (const r of b.relations)
      if (r.from === r.to || !aliases.has(r.from) || !aliases.has(r.to))
        c.addIssue({ code: "custom", message: "Invalid relation aliases" });
    for (const row of b.cases)
      for (const set of row.acceptableEvidenceAliases)
        for (const id of set)
          if (!aliases.has(id))
            c.addIssue({ code: "custom", message: "Unknown evidence alias" });
  });
export const importInput = z.strictObject({
  idempotencyKey: z.uuid().toLowerCase(),
  bundle,
});
export const template = z.object({
  revisionId: z.uuid(),
  sourceFingerprint: sha,
  source,
});
export const importResult = z.object({
  id: z.uuid(),
  revisionId: z.uuid(),
  bundleHash: sha,
  sourceFingerprint: sha,
  bundle,
  ruleMap: z.record(alias, z.uuid()),
  createdAt: z.iso.datetime({ offset: true }),
});
export const materializeInput = z.strictObject({
  releaseId: z.uuid().toLowerCase(),
  name: text(200),
  revision: text(100),
  annotationReviewNote: text(4000).min(10),
});

export const annotationReviewResult = z.object({
  datasetId: z.uuid(),
  note: z.string(),
  requestId: z.uuid(),
  createdAt: z.iso.datetime({ offset: true }),
});
