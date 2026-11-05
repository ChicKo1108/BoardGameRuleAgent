import { isDeepStrictEqual } from "node:util";
import type { DataSource } from "typeorm";
import {
  answeringSchemas as a,
  type AnswerBudgets,
} from "@boardgame/contracts";
import { KnowledgeIndexService, RetrievalError } from "@boardgame/retrieval";
import {
  runRulesAgent,
  PROMPT_HASH,
  PROMPT_VERSION,
  RUNTIME_VERSION,
  type ChatProvider,
  type AgentRecord,
  type RuleBindings,
} from "@boardgame/agent";
import type { VectorService } from "./vectors.ts";
const json = (v: unknown) => JSON.parse(JSON.stringify(v));
export class AnswerService {
  constructor(
    private readonly db: DataSource,
    private readonly vectors: VectorService,
    private readonly provider?: ChatProvider,
    private readonly budget: Partial<AnswerBudgets> = {},
  ) {}
  async configuration(raw: unknown) {
    const retrieval = a.retrievalConfig.parse(raw);
    if (!this.provider) throw new RetrievalError(503, "CHAT_NOT_CONFIGURED");
    const knowledge = new KnowledgeIndexService(this.db),
      base = await knowledge.index(retrieval.indexBuildId);
    let profileHash = null;
    if (retrieval.vectorIndexId) {
      const vector = await this.vectors.configuredIndex(
        retrieval.vectorIndexId,
      );
      if (vector.indexBuildId !== base.id || vector.state !== "ready")
        throw new RetrievalError(422, "ANSWER_VECTOR_MISMATCH");
      profileHash = vector.profileHash;
    }
    const budgets = a.budgets.parse(this.budget);
    const config = {
      model: this.provider.profile,
      budgets,
      promptHash: PROMPT_HASH,
      promptVersion: PROMPT_VERSION,
      piVersion: "1.5.0",
      runtimeVersion: RUNTIME_VERSION,
      nodeVersion: process.versions.node,
      buildRevision: process.env.APP_REVISION ?? null,
      indexConfigHash: base.configHash,
      embeddingProfileHash: profileHash,
    };
    return { base, config: a.runResult.shape.config.parse(config) };
  }
  async preview(
    raw: unknown,
    requestId: string,
    signal?: AbortSignal,
    execution?: { expectedConfig?: unknown; actor?: "public" },
  ) {
    const input = a.previewInput.parse(raw),
      id = input.idempotencyKey;
    const [observed] = await this.db.query(
      "SELECT input=$2::jsonb AS same FROM answer_runs WHERE id=$1",
      [id, JSON.stringify(input)],
    );
    if (observed) {
      if (!observed.same)
        throw new RetrievalError(409, "ANSWER_IDEMPOTENCY_CONFLICT");
      return this.get(id);
    }
    const { base, config } = await this.configuration(input.retrieval);
    if (
      execution?.expectedConfig &&
      !isDeepStrictEqual(config, execution.expectedConfig)
    )
      throw new RetrievalError(409, "ANSWER_CONFIGURATION_CHANGED");
    const created = await this.db.transaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        id,
      ]);
      const [existing] = await tx.query(
        "SELECT input=$2::jsonb AS same FROM answer_runs WHERE id=$1",
        [id, JSON.stringify(input)],
      );
      if (existing) {
        if (!existing.same)
          throw new RetrievalError(409, "ANSWER_IDEMPOTENCY_CONFLICT");
        return false;
      }
      const budgets = config.budgets;
      await tx.query(
        "INSERT INTO answer_runs(id,request_id,release_id,index_build_id,vector_index_id,input,config,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,now()+($8::int * interval '1 millisecond'))",
        [
          id,
          requestId,
          base.releaseId,
          base.id,
          input.retrieval.vectorIndexId,
          JSON.stringify(input),
          JSON.stringify(config),
          budgets.timeoutMs + 30000,
        ],
      );
      await tx.query(
        "INSERT INTO admin_audit_events(request_id,actor,action,target_id) VALUES($1,$3,'answer.preview',$2)",
        [requestId, id, execution?.actor ?? "admin"],
      );
      return true;
    });
    if (!created) return this.get(id);
    try {
      const run = await this.get(id),
        knowledge = new KnowledgeIndexService(this.db),
        release = await knowledge.release(run.releaseId);
      const config = input.retrieval;
      const bindings: RuleBindings = {
        scope: {
          releaseId: run.releaseId,
          indexBuildId: run.indexBuildId,
          rulesetId: release.rulesetId,
        },
        search: async (query, signal) => {
          signal.throwIfAborted();
          const result =
            config.mode === "lexical"
              ? await knowledge.search(run.indexBuildId, {
                  query,
                  limit: config.limit,
                })
              : await this.vectors.search(
                  config.vectorIndexId!,
                  {
                    query,
                    mode: config.mode,
                    limit: config.limit,
                    candidateLimit: config.candidateLimit,
                    rrfK: config.rrfK,
                  },
                  signal,
                  requestId,
                );
          const rows: Array<{ id: string; preview: string }> =
            await this.db.query(
              "SELECT id,left(content,400) AS preview FROM retrieval_chunks WHERE build_id=$1 AND id=ANY($2::uuid[])",
              [run.indexBuildId, result.hits.map((h) => h.chunkId)],
            );
          const previews = new Map(rows.map((r) => [r.id, r.preview]));
          return {
            ...result,
            hits: result.hits.map((h) => ({
              ...h,
              preview: previews.get(h.chunkId) ?? "",
            })),
          };
        },
        context: async (chunkIds, signal) => {
          signal.throwIfAborted();
          return knowledge.context(run.indexBuildId, {
            chunkIds,
            maxRules: config.maxRules,
            maxChars: config.maxChars,
          });
        },
      };
      const output = await runRulesAgent({
        question: input.question,
        history: input.history,
        provider: this.provider!,
        bindings,
        budgets: run.config.budgets,
        signal,
        onRecord: (record) => this.record(id, record),
      });
      await this.db.transaction(async (tx) => {
        const rows = await tx.query(
          "UPDATE answer_runs SET state=$2,answer=$3,reason_code=$4,usage=$5,finished_at=now() WHERE id=$1 AND state='running' AND expires_at>now() RETURNING id",
          [
            id,
            output.state,
            output.answer ? JSON.stringify(output.answer) : null,
            output.reasonCode,
            JSON.stringify(output.usage),
          ],
        );
        if (!rows.length) throw new RetrievalError(409, "ANSWER_RUN_EXPIRED");
      });
    } catch (error) {
      await this.db.query(
        "UPDATE answer_runs SET state='failed',answer=NULL,reason_code=$2,finished_at=now() WHERE id=$1 AND state='running'",
        [
          id,
          error instanceof RetrievalError
            ? error.code
            : "ANSWER_INFRASTRUCTURE_ERROR",
        ],
      );
    }
    return this.get(id);
  }
  private async record(id: string, record: AgentRecord) {
    await this.db.transaction(async (tx) => {
      await tx.query("SELECT id FROM answer_runs WHERE id=$1 FOR UPDATE", [id]);
      await tx.query(
        "INSERT INTO answer_events(run_id,sequence,kind,data) SELECT $1,coalesce(max(sequence),0)+1,$2,$3 FROM answer_events WHERE run_id=$1",
        [id, record.kind, JSON.stringify(record.data)],
      );
    });
  }
  async get(id: string) {
    return AnswerService.read(this.db, id);
  }
  static async read(db: DataSource, id: string) {
    // A crashed synchronous process must not leave a permanently running request.
    await db.query(
      "UPDATE answer_runs SET state='failed',reason_code='ANSWER_RUN_EXPIRED',finished_at=now() WHERE id=$1 AND state='running' AND expires_at<=now()",
      [id],
    );
    const [row] = await db.query(
      `SELECT id,request_id AS "requestId",release_id AS "releaseId",index_build_id AS "indexBuildId",vector_index_id AS "vectorIndexId",state,input,config,answer,reason_code AS "reasonCode",usage,created_at AS "createdAt",finished_at AS "finishedAt",expires_at AS "expiresAt" FROM answer_runs WHERE id=$1`,
      [id],
    );
    if (!row) throw new RetrievalError(404, "ANSWER_RUN_NOT_FOUND");
    return a.runResult.parse(json(row));
  }
  async events(id: string, page = { limit: 25, offset: 0 }) {
    await this.get(id);
    const [{ total }] = await this.db.query(
      "SELECT count(*)::int AS total FROM answer_events WHERE run_id=$1",
      [id],
    );
    const rows = await this.db.query(
      `SELECT sequence,kind,data,created_at AS "createdAt" FROM answer_events WHERE run_id=$1 ORDER BY sequence LIMIT $2 OFFSET $3`,
      [id, page.limit, page.offset],
    );
    return {
      items: rows.map((r: unknown) => a.eventResult.parse(json(r))),
      total,
      ...page,
    };
  }
}
