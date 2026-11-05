import type { DataSource, EntityManager } from "typeorm";
import {
  knowledgeSchemas as k,
  type KnowledgeManifest,
} from "@boardgame/contracts";
import { RetrievalError } from "./errors.ts";
import {
  lexicalConfiguration as config,
  buildLexicalChunk,
  lexicalQuery,
  persistedLexicalSql,
  assembleRuleContext,
} from "./core.ts";
export { RetrievalError } from "./errors.ts";
export * from "./core.ts";
const releaseColumns = `id,ruleset_id AS "rulesetId",name,state,manifest_hash AS "manifestHash",created_at AS "createdAt"`;
const indexColumns = `id,release_id AS "releaseId",state,config_hash AS "configHash",config,created_at AS "createdAt"`;
const serializable = (value: unknown) => JSON.parse(JSON.stringify(value));
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
        const chunk = buildLexicalChunk(rule);
        return {
          rule_unit_id: rule.id,
          content: chunk.content,
          lexical_text: chunk.lexicalText,
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
    const { tokens, expression } = lexicalQuery(valid.query);
    const rows = tokens.length
      ? await this.db.query(persistedLexicalSql, [
          buildId,
          build.releaseId,
          expression,
          valid.limit,
        ])
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
    return k.contextResult.parse({
      releaseId: build.releaseId,
      indexBuildId: buildId,
      rulesetId: manifest.ruleset.id,
      ...assembleRuleContext(manifest, chunks, valid),
    });
  }
}
export * from "./embedding.ts";
