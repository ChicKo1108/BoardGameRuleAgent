import { createHash, randomUUID } from "node:crypto";
import type { DataSource } from "typeorm";
import type { z } from "zod";
import {
  curationSchemas as c,
  knowledgeSchemas as k,
  draftDiagnosticSchemas as s,
} from "@boardgame/contracts";
import {
  buildLexicalChunk,
  lexicalQuery,
  draftLexicalSql,
  draftBm25Sql,
  assembleRuleContext,
  RetrievalError,
} from "@boardgame/retrieval";
import { scoreEvidence } from "@boardgame/evaluations";
import { curationHash, curationSourceFingerprint } from "./curation.ts";
function draftId(source: string, name: string) {
  // UUID v5 in a fixed private diagnostic namespace; identifiers are not credentials.
  const digest = createHash("sha1")
    .update(Buffer.from("34927d192d8e4c33b2e2468288db8e72", "hex"))
    .update(source + ":" + name)
    .digest();
  digest[6] = (digest[6] & 15) | 80;
  digest[8] = (digest[8] & 63) | 128;
  const h = digest.subarray(0, 16).toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
export function prepareDraftKnowledge(bundleRaw: unknown, sourceRaw: unknown) {
  const bundle = c.bundle.parse(bundleRaw),
    source = c.source.parse(sourceRaw);
  if (Buffer.byteLength(JSON.stringify(bundle)) > 900000)
    throw new RetrievalError(413, "DRAFT_BUNDLE_TOO_LARGE");
  if (curationSourceFingerprint(source) !== bundle.sourceFingerprint)
    throw new RetrievalError(422, "CURATION_SOURCE_MISMATCH");
  const id = (name: string) => draftId(bundle.sourceFingerprint, name),
    byOrdinal = new Map(source.blocks.map((b) => [b.ordinal, b]));
  if (byOrdinal.size !== source.blocks.length)
    throw new RetrievalError(422, "CURATION_SOURCE_ORDINAL_DUPLICATE");
  const ruleIds = new Map(
    bundle.rules.map((r) => [r.alias, id("rule:" + r.alias)]),
  );
  const aliases = new Map([...ruleIds].map(([alias, id]) => [id, alias]));
  const manifest = k.manifestSchema.parse({
    schemaVersion: 1,
    ruleset: {
      id: id("ruleset"),
      gameId: id("game"),
      name: "Unapproved draft",
      language: "zh-CN",
      scope: "Private diagnostic only; not published knowledge",
    },
    documents: [
      {
        id: id("document"),
        revisionId: id("revision"),
        revisionNumber: 0,
        title: "Private draft source",
        sourceType: "rulebook",
        sha256: source.documentSha256,
      },
    ],
    rules: bundle.rules.map((r) => ({
      id: ruleIds.get(r.alias),
      revisionId: id("revision"),
      kind: r.kind,
      reviewedText: r.reviewedText,
      sectionPath: r.sectionPath,
      applicability: r.applicability,
      explanation: r.explanation,
      sources: r.sourceOrdinals.map((ordinal) => {
        const block = byOrdinal.get(ordinal);
        if (!block)
          throw new RetrievalError(422, "CURATION_SOURCE_ORDINAL_MISSING");
        return { ...block, id: id("block:" + ordinal) };
      }),
    })),
    relations: bundle.relations.map((r) => ({
      fromRuleId: ruleIds.get(r.from),
      toRuleId: ruleIds.get(r.to),
      kind: r.kind,
    })),
  });
  const chunks = manifest.rules.map((rule) => ({
    id: id("chunk:" + aliases.get(rule.id)),
    rule_unit_id: rule.id,
  }));
  const records = manifest.rules.map((rule, i) => ({
    chunk_id: chunks[i].id,
    rule_id: rule.id,
    lexical_text: buildLexicalChunk(rule).lexicalText,
  }));
  return {
    kind: "unapproved-draft" as const,
    bundle,
    source,
    manifest,
    chunks,
    records,
    aliases,
  };
}
function summarize(
  cases: z.infer<typeof c.labelCase>[],
  results: z.infer<typeof s.caseResult>[],
) {
  const byId = new Map(results.map((r) => [r.caseId, r]));
  const group = (selected: typeof cases) => {
    const scored = selected.filter(
        (c) => c.acceptableEvidenceAliases.length > 0,
      ),
      rows = selected.map((c) => byId.get(c.id)!);
    const avg = (
      field: "searchScore" | "contextScore",
      key: "complete" | "bestSetRecall",
    ) =>
      scored.length
        ? scored.reduce(
            (sum, c) => sum + Number(byId.get(c.id)?.[field]?.[key] ?? 0),
            0,
          ) / scored.length
        : null;
    return {
      total: selected.length,
      scorable: scored.length,
      unscored: selected.length - scored.length,
      failed: rows.filter((r) => r.status === "failed").length,
      searchCompleteRate: avg("searchScore", "complete"),
      contextCompleteRate: avg("contextScore", "complete"),
      gapFreeContextCompleteRate: scored.length
        ? scored.filter((c) => {
            const r = byId.get(c.id)!;
            return (
              r.status === "succeeded" &&
              r.contextScore?.complete &&
              r.gaps.length === 0
            );
          }).length / scored.length
        : null,
      meanSearchRecall: avg("searchScore", "bestSetRecall"),
      meanContextRecall: avg("contextScore", "bestSetRecall"),
      contextGapCases: rows.filter((r) => r.gaps.length > 0).length,
    };
  };
  return {
    ...group(cases),
    byCategory: Object.fromEntries(
      [...new Set(cases.map((c) => c.category))].map((k) => [
        k,
        group(cases.filter((c) => c.category === k)),
      ]),
    ),
    bySeverity: Object.fromEntries(
      ["critical", "normal"].map((k) => [
        k,
        group(cases.filter((c) => c.severity === k)),
      ]),
    ),
  };
}
export async function diagnoseDraft(
  db: DataSource,
  bundleRaw: unknown,
  sourceRaw: unknown,
  rawConfig: unknown = {},
  signal?: AbortSignal,
) {
  const config = s.config.parse(rawConfig),
    prepared = prepareDraftKnowledge(bundleRaw, sourceRaw),
    cases = prepared.bundle.cases.filter((c) => c.split === "development");
  if (!cases.length) throw new RetrievalError(422, "DRAFT_DEVELOPMENT_EMPTY");
  const started = new Date(),
    deadline = Date.now() + 60000;
  return db.transaction("REPEATABLE READ", async (tx) => {
    await tx.query("SET TRANSACTION READ ONLY");
    await tx.query("SET LOCAL statement_timeout='15s'");
    const [{ version }] = await tx.query(
      "SELECT current_setting('server_version') AS version",
    );
    const recordJson = JSON.stringify(prepared.records),
      results: z.infer<typeof s.caseResult>[] = [];
    const aliasFor = (id: string) => {
      const alias = prepared.aliases.get(id);
      if (!alias) throw new RetrievalError(500, "DRAFT_ALIAS_MAPPING_INVALID");
      return alias;
    };
    for (const row of cases) {
      signal?.throwIfAborted();
      if (Date.now() > deadline)
        throw new RetrievalError(408, "DRAFT_DIAGNOSTIC_TIMEOUT");
      const start = performance.now();
      let query = "",
        tokens: string[] = [],
        hits: z.infer<typeof s.caseResult>["hits"] = [],
        contextAliases: string[] = [],
        gaps: z.infer<typeof s.caseResult>["gaps"] = [],
        errorCode: string | null = null;
      try {
        const last = row.messages.at(-1);
        if (config.queryMode === "current_question" && last?.role !== "user")
          throw new RetrievalError(422, "DRAFT_FINAL_USER_REQUIRED");
        query =
          config.queryMode === "annotated_query" ? row.query : last!.content;
        const parsed = lexicalQuery(query);
        query = parsed.query;
        tokens = parsed.tokens;
        const ranked: Array<{
          chunkId: string;
          ruleId: string;
          score: number;
        }> = tokens.length
          ? await tx.query(
              config.ranker === "bm25-v1" ? draftBm25Sql : draftLexicalSql,
              [
                recordJson,
                config.ranker === "bm25-v1" ? parsed.tokens : parsed.expression,
                config.limit,
              ],
            )
          : [];
        hits = ranked.map((r, i) => ({
          alias: aliasFor(r.ruleId),
          score: r.score,
          rank: i + 1,
        }));
        if (ranked.length) {
          const context = assembleRuleContext(
            prepared.manifest,
            prepared.chunks,
            {
              chunkIds: ranked.map((r) => r.chunkId),
              maxRules: config.maxRules,
              maxChars: config.maxChars,
            },
          );
          contextAliases = context.evidence.map((e) => aliasFor(e.ruleId));
          gaps = context.gaps.map((g) => ({
            alias: aliasFor(g.ruleId),
            code: g.code,
          }));
        }
      } catch (error) {
        if (error instanceof RetrievalError) {
          errorCode = error.code;
        } else if (error instanceof Error && error.name === "ZodError") {
          errorCode = "DRAFT_CASE_INVALID";
        } else throw new RetrievalError(503, "DRAFT_DIAGNOSTIC_DATABASE_ERROR");
      }
      results.push(
        s.caseResult.parse({
          caseId: row.id,
          category: row.category,
          severity: row.severity,
          hasHistory: row.messages.length > 1,
          query,
          tokens,
          status: errorCode ? "failed" : "succeeded",
          errorCode,
          hits,
          contextAliases,
          gaps,
          searchScore: scoreEvidence(
            row.acceptableEvidenceAliases,
            errorCode ? [] : hits.map((h) => h.alias),
          ),
          contextScore: scoreEvidence(
            row.acceptableEvidenceAliases,
            errorCode ? [] : contextAliases,
          ),
          durationMs: Math.round(performance.now() - start),
        }),
      );
    }
    return s.report.parse({
      runId: randomUUID(),
      kind: "draft-retrieval-diagnostic",
      publishable: false,
      answerQualityEvaluated: false,
      labelsReviewed: false,
      config,
      bundleHash: curationHash(prepared.bundle),
      sourceFingerprint: prepared.bundle.sourceFingerprint,
      developmentCasesHash: curationHash(cases),
      algorithm: {
        lexicalCore:
          config.ranker === "bm25-v1" ? "bm25-v1" : "lexical-core-v1",
        contextCore: "rule-graph-bfs-v1",
        sqlHash: curationHash(
          config.ranker === "bm25-v1" ? draftBm25Sql : draftLexicalSql,
        ),
        nodeVersion: process.versions.node,
        icuVersion: process.versions.icu,
        postgresVersion: version,
        tieBreak: "deterministic-draft-chunk-uuid",
      },
      summary: summarize(cases, results),
      results,
      createdAt: started.toISOString(),
      finishedAt: new Date().toISOString(),
    });
  });
}
