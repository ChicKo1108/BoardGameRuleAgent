import type { DataSource, EntityManager } from "typeorm";
import {
  knowledgeSchemas as k,
  type KnowledgeManifest,
} from "@boardgame/contracts";
export class RetrievalError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}
const releaseColumns = `id,ruleset_id AS "rulesetId",name,state,manifest_hash AS "manifestHash",created_at AS "createdAt"`;
const indexColumns = `id,release_id AS "releaseId",state,config_hash AS "configHash",config,created_at AS "createdAt"`;
const serializable = (value: unknown) => JSON.parse(JSON.stringify(value));
const config = () =>
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
function assertRuntime(buildConfig: unknown) {
  const recorded = k.lexicalConfigSchema.safeParse(buildConfig);
  if (
    !recorded.success ||
    JSON.stringify(recorded.data) !== JSON.stringify(config())
  )
    throw new RetrievalError(409, "TOKENIZER_VERSION_MISMATCH");
}
async function audit(
  tx: EntityManager,
  requestId: string,
  action: string,
  id: string,
) {
  await tx.query(
    "INSERT INTO admin_audit_events(request_id,actor,action,target_id) VALUES($1,'admin',$2,$3)",
    [requestId, action, id],
  );
}
export class KnowledgeIndexService {
  constructor(private readonly db: DataSource) {}
  async createRelease(
    rulesetId: string,
    input: { name: string; revisionIds: string[] },
    requestId: string,
  ) {
    const valid = k.createRelease.parse(input);
    const ids = valid.revisionIds.map((id) => id.toLowerCase()).sort();
    if (new Set(ids).size !== ids.length)
      throw new RetrievalError(422, "DUPLICATE_REVISIONS");
    return this.db.transaction(async (tx) => {
      if (
        !(
          await tx.query("SELECT id FROM rulesets WHERE id=$1 FOR UPDATE", [
            rulesetId,
          ])
        ).length
      )
        throw new RetrievalError(404, "RULESET_NOT_FOUND");
      const revisions = await tx.query(
        "SELECT v.id,v.status,v.document_id,d.ruleset_id FROM document_revisions v JOIN source_documents d ON d.id=v.document_id WHERE v.id=ANY($1::uuid[]) ORDER BY v.id FOR SHARE OF v",
        [ids],
      );
      if (revisions.length !== ids.length)
        throw new RetrievalError(404, "REVISION_NOT_FOUND");
      if (
        revisions.some(
          (v: { status: string; ruleset_id: string }) =>
            v.status !== "approved" || v.ruleset_id !== rulesetId.toLowerCase(),
        )
      )
        throw new RetrievalError(
          409,
          "RELEASE_REQUIRES_APPROVED_SCOPED_REVISIONS",
        );
      if (
        new Set(revisions.map((v: { document_id: string }) => v.document_id))
          .size !== ids.length
      )
        throw new RetrievalError(409, "MULTIPLE_DOCUMENT_REVISIONS");
      const existing = await tx.query(
        `SELECT ${releaseColumns} FROM knowledge_releases r WHERE r.ruleset_id=$1 AND state='sealed' AND ARRAY(SELECT revision_id FROM release_revisions WHERE release_id=r.id ORDER BY revision_id)=$2::uuid[] ORDER BY created_at,id LIMIT 1`,
        [rulesetId, ids],
      );
      if (existing.length)
        return k.releaseResult.parse(serializable(existing[0]));
      const [{ id }] = await tx.query(
        "INSERT INTO knowledge_releases(ruleset_id,name) VALUES($1,$2) RETURNING id",
        [rulesetId, valid.name],
      );
      await tx.query(
        "INSERT INTO release_revisions(release_id,revision_id,document_id) SELECT $1,id,document_id FROM document_revisions WHERE id=ANY($2::uuid[])",
        [id, ids],
      );
      await tx.query(
        "INSERT INTO release_members(release_id,revision_id,rule_unit_id) SELECT $1,revision_id,id FROM rule_units WHERE revision_id=ANY($2::uuid[])",
        [id, ids],
      );
      const [release] = await tx.query(
        `WITH updated AS (UPDATE knowledge_releases SET state='sealed' WHERE id=$1 RETURNING ${releaseColumns}) SELECT * FROM updated`,
        [id],
      );
      await audit(tx, requestId, "release.seal", id);
      return k.releaseResult.parse(serializable(release));
    });
  }
  async release(id: string) {
    const [row] = await this.db.query(
      `SELECT ${releaseColumns} FROM knowledge_releases WHERE id=$1 AND state='sealed'`,
      [id],
    );
    if (!row) throw new RetrievalError(404, "RELEASE_NOT_FOUND");
    return k.releaseResult.parse(serializable(row));
  }
  async manifest(id: string): Promise<KnowledgeManifest> {
    const [row] = await this.db.query(
      "SELECT manifest FROM knowledge_releases WHERE id=$1 AND state='sealed'",
      [id],
    );
    if (!row) throw new RetrievalError(404, "RELEASE_NOT_FOUND");
    return k.manifestSchema.parse(row.manifest);
  }
  async build(releaseId: string, requestId: string) {
    return this.db.transaction(async (tx) => {
      const [release] = await tx.query(
        "SELECT manifest FROM knowledge_releases WHERE id=$1 AND state='sealed' FOR UPDATE",
        [releaseId],
      );
      if (!release) throw new RetrievalError(404, "RELEASE_NOT_FOUND");
      const buildConfig = config();
      const existing = await tx.query(
        `SELECT ${indexColumns} FROM index_builds WHERE release_id=$1 AND config=$2::jsonb AND state='ready'`,
        [releaseId, JSON.stringify(buildConfig)],
      );
      if (existing.length)
        return k.indexBuildResult.parse(serializable(existing[0]));
      const manifest = k.manifestSchema.parse(release.manifest);
      const chunks = manifest.rules.map((rule) => {
        const content = [
          ...rule.sectionPath,
          ...rule.applicability,
          rule.reviewedText,
        ].join("\n");
        if (content.length > buildConfig.maxRuleChars)
          throw new RetrievalError(422, "RULE_REQUIRES_SEMANTIC_SPLIT");
        const tokens = lexicalTokens(content);
        if (!tokens.length)
          throw new RetrievalError(422, "RULE_HAS_NO_SEARCHABLE_TERMS");
        return {
          rule_unit_id: rule.id,
          content,
          lexical_text: tokens.join(" "),
        };
      });
      const [{ id }] = await tx.query(
        "INSERT INTO index_builds(release_id,config,config_hash) VALUES($1,$2,'') RETURNING id",
        [releaseId, JSON.stringify(buildConfig)],
      );
      await tx.query(
        "INSERT INTO retrieval_chunks(build_id,release_id,rule_unit_id,content,lexical_text) SELECT $1,$2,x.rule_unit_id::uuid,x.content,x.lexical_text FROM jsonb_to_recordset($3::jsonb) AS x(rule_unit_id text,content text,lexical_text text)",
        [id, releaseId, JSON.stringify(chunks)],
      );
      const [build] = await tx.query(
        `WITH updated AS (UPDATE index_builds SET state='ready' WHERE id=$1 RETURNING ${indexColumns}) SELECT * FROM updated`,
        [id],
      );
      await audit(tx, requestId, "index.ready", id);
      return k.indexBuildResult.parse(serializable(build));
    });
  }
  async index(id: string) {
    const [row] = await this.db.query(
      `SELECT ${indexColumns} FROM index_builds WHERE id=$1 AND state='ready'`,
      [id],
    );
    if (!row) throw new RetrievalError(404, "INDEX_NOT_FOUND");
    return k.indexBuildResult.parse(serializable(row));
  }
  async search(buildId: string, input: { query: string; limit?: number }) {
    const valid = k.searchInput.parse(input);
    const build = await this.index(buildId);
    assertRuntime(build.config);
    const tokens = [...new Set(lexicalTokens(valid.query))];
    if (tokens.length > 128)
      throw new RetrievalError(422, "TOO_MANY_SEARCH_TERMS");
    // Tokens contain only Unicode letters/numbers/underscore. SQL text and tsquery operators cannot enter.
    const expression = tokens.map((t) => `'${t}'`).join(" | ");
    const rows = tokens.length
      ? await this.db.query(
          `SELECT c.id AS "chunkId",c.rule_unit_id AS "ruleId",ts_rank_cd(c.search_vector,q.query)::float8 AS score FROM retrieval_chunks c CROSS JOIN (SELECT to_tsquery('simple'::regconfig,$3) AS query) q WHERE c.build_id=$1 AND c.release_id=$2 AND c.search_vector @@ q.query ORDER BY score DESC,c.id LIMIT $4`,
          [buildId, build.releaseId, expression, valid.limit],
        )
      : [];
    return k.searchResult.parse({
      releaseId: build.releaseId,
      indexBuildId: buildId,
      query: valid.query,
      tokens,
      hits: rows.map((row: object, index: number) => ({
        ...row,
        rank: index + 1,
      })),
    });
  }
  async context(
    buildId: string,
    input: { chunkIds: string[]; maxRules?: number; maxChars?: number },
  ) {
    const valid = k.contextInput.parse(input);
    const build = await this.index(buildId);
    const manifest = await this.manifest(build.releaseId);
    const chunks: Array<{ id: string; rule_unit_id: string }> =
      await this.db.query(
        "SELECT id,rule_unit_id FROM retrieval_chunks WHERE build_id=$1 AND release_id=$2",
        [buildId, build.releaseId],
      );
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
    return k.contextResult.parse({
      releaseId: build.releaseId,
      indexBuildId: buildId,
      rulesetId: manifest.ruleset.id,
      evidence,
      relations: manifest.relations.filter(
        (r) => included.has(r.fromRuleId) && included.has(r.toRuleId),
      ),
      gaps,
    });
  }
}

export * from "./embedding.ts";
