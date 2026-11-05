import {
  knowledgeSchemas as k,
  type KnowledgeManifest,
} from "@boardgame/contracts";
import { RetrievalError } from "./errors.ts";
export const lexicalConfiguration = () =>
  k.lexicalConfigSchema.parse({
    schemaVersion: 1,
    method: "lexical",
    chunker: "complete-rule-v1",
    tokenizer: "intl-zh-word-v1",
    icuVersion: process.versions.icu,
    maxRuleChars: 8000,
  });
/** Both indexing and queries use this exact normalizer/segmenter and record ICU version. */
export function lexicalTokens(text: string): string[] {
  const segmenter = new Intl.Segmenter("zh-CN", { granularity: "word" });
  return Array.from(segmenter.segment(text.normalize("NFKC").toLowerCase()))
    .filter((s) => s.isWordLike)
    .flatMap((s) => s.segment.split(/[^\p{L}\p{N}_]+/u))
    .filter((s) => s.length > 0 && s.length <= 128);
}

export function buildLexicalChunk(rule: {
  sectionPath: string[];
  applicability: string[];
  reviewedText: string;
}) {
  const content = [
    ...rule.sectionPath,
    ...rule.applicability,
    rule.reviewedText,
  ].join("\n");
  if (content.length > lexicalConfiguration().maxRuleChars)
    throw new RetrievalError(422, "RULE_REQUIRES_SEMANTIC_SPLIT");
  const tokens = lexicalTokens(content);
  if (!tokens.length)
    throw new RetrievalError(422, "RULE_HAS_NO_SEARCHABLE_TERMS");
  return { content, lexicalText: tokens.join(" ") };
}
export function lexicalQuery(raw: string) {
  const { query } = k.searchInput.parse({ query: raw });
  const tokens = [...new Set(lexicalTokens(query))];
  if (tokens.length > 128)
    throw new RetrievalError(422, "TOO_MANY_SEARCH_TERMS");
  return { query, tokens, expression: tokens.map((t) => `'${t}'`).join(" | ") };
}
const projection = `c.id AS "chunkId",c.rule_unit_id AS "ruleId",ts_rank_cd(c.search_vector,q.query)::float8 AS score`;
const order = `ORDER BY score DESC,c.id`;
export const persistedLexicalSql = `SELECT ${projection} FROM retrieval_chunks c CROSS JOIN (SELECT to_tsquery('simple'::regconfig,$3) AS query) q WHERE c.build_id=$1 AND c.release_id=$2 AND c.search_vector @@ q.query ${order} LIMIT $4`;
export const draftLexicalSql = `WITH c AS(SELECT x.chunk_id::uuid AS id,x.rule_id::uuid AS rule_unit_id,to_tsvector('simple'::regconfig,x.lexical_text) AS search_vector FROM jsonb_to_recordset($1::jsonb) AS x(chunk_id text,rule_id text,lexical_text text)) SELECT ${projection} FROM c CROSS JOIN (SELECT to_tsquery('simple'::regconfig,$2) AS query) q WHERE c.search_vector @@ q.query ${order} LIMIT $3`;
export function assembleRuleContext(
  manifest: KnowledgeManifest,
  chunks: Array<{ id: string; rule_unit_id: string }>,
  input: { chunkIds: string[]; maxRules?: number; maxChars?: number },
) {
  const valid = k.contextInput.parse(input);
  const byChunk = new Map(chunks.map((c) => [c.id, c.rule_unit_id]));
  const byRule = new Map(chunks.map((c) => [c.rule_unit_id, c.id]));
  const primary = valid.chunkIds.map((id) => byChunk.get(id.toLowerCase()));
  if (primary.some((id) => !id))
    throw new RetrievalError(404, "CHUNK_OUTSIDE_INDEX");
  const primaryIds = primary as string[];
  const primarySet = new Set(primaryIds);
  const rules = new Map(manifest.rules.map((rule) => [rule.id, rule]));
  const documents = new Map(
    manifest.documents.map((doc) => [doc.revisionId, doc]),
  );
  const related = new Map<string, Set<string>>();
  for (const relation of manifest.relations) {
    const a = related.get(relation.fromRuleId) ?? new Set<string>();
    a.add(relation.toRuleId);
    related.set(relation.fromRuleId, a);
    const b = related.get(relation.toRuleId) ?? new Set<string>();
    b.add(relation.fromRuleId);
    related.set(relation.toRuleId, b);
  }
  const pending = [...primaryIds];
  const visited = new Set<string>();
  let chars = 0;
  const evidence = [];
  const gaps: Array<{
    code: "PRIMARY_RULE_OMITTED" | "RELATED_RULE_OMITTED";
    ruleId: string;
  }> = [];
  for (let position = 0; position < pending.length; position++) {
    const id = pending[position];
    if (visited.has(id)) continue;
    visited.add(id);
    const rule = rules.get(id);
    if (!rule) throw new RetrievalError(500, "INVALID_RELEASE_MANIFEST");
    const doc = documents.get(rule.revisionId)!;
    const item = {
      evidenceId: byRule.get(id)!,
      ruleId: id,
      kind: rule.kind,
      role: primarySet.has(id) ? ("primary" as const) : ("related" as const),
      text: rule.reviewedText,
      sectionPath: rule.sectionPath,
      applicability: rule.applicability,
      editorialExplanation: rule.explanation,
      sources: rule.sources.map((source) => ({
        blockId: source.id,
        documentId: doc.id,
        documentTitle: doc.title,
        sourceType: doc.sourceType,
        pdfPageIndex: source.pdfPageIndex,
        printedPageLabel: source.printedPageLabel,
        bbox: source.bbox,
      })),
    };
    const cost = JSON.stringify(item).length;
    if (evidence.length >= valid.maxRules || chars + cost > valid.maxChars) {
      gaps.push({
        code: primarySet.has(id)
          ? "PRIMARY_RULE_OMITTED"
          : "RELATED_RULE_OMITTED",
        ruleId: id,
      });
      continue;
    }
    chars += cost;
    evidence.push(item);
    pending.push(...[...(related.get(id) ?? [])].sort());
  }
  const included = new Set(evidence.map((e) => e.ruleId));

  return {
    evidence,
    relations: manifest.relations.filter(
      (r) => included.has(r.fromRuleId) && included.has(r.toRuleId),
    ),
    gaps,
  };
}
