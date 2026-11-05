import { randomUUID } from "node:crypto";
import type { DataSource, EntityManager } from "typeorm";
import type { PgBoss, JobWithMetadata } from "pg-boss";
import {
  vectorSchemas as v,
  type EmbeddingProfile,
} from "@boardgame/contracts";
import {
  KnowledgeIndexService,
  RetrievalError,
  EmbeddingError,
  validateVectors,
  type EmbeddingProvider,
} from "@boardgame/retrieval";
export const VECTOR_QUEUE = "embed-index-v1";
const json = (value: unknown) => JSON.parse(JSON.stringify(value));
const sqlAdapter = (tx: EntityManager) => ({
  executeSql: async (text: string, values?: unknown[]) => ({
    rows: await tx.query(text, values),
  }),
});
const sameProfile = (a: unknown, b: unknown) =>
  JSON.stringify(v.embeddingProfile.parse(a)) ===
  JSON.stringify(v.embeddingProfile.parse(b));
const errorCode = (error: unknown) =>
  error instanceof EmbeddingError || error instanceof RetrievalError
    ? error.code
    : "VECTOR_INFRASTRUCTURE_ERROR";
type VectorJob = { vectorIndexId: string };
type LexicalHit = {
  chunkId: string;
  ruleId: string;
  rank: number;
  score: number;
};
type VectorHit = {
  chunkId: string;
  ruleId: string;
  rank: number;
  distance: number;
};
export function fuseRanks(
  lexical: LexicalHit[],
  vectors: VectorHit[],
  mode: "lexical" | "vector" | "hybrid",
  k: number,
  limit: number,
) {
  const byId = new Map<
    string,
    {
      chunkId: string;
      ruleId: string;
      score: number;
      lexicalRank: number | null;
      vectorRank: number | null;
      lexicalScore: number | null;
      cosineDistance: number | null;
    }
  >();
  for (const hit of lexical)
    byId.set(hit.chunkId, {
      chunkId: hit.chunkId,
      ruleId: hit.ruleId,
      score: mode === "hybrid" ? 1 / (k + hit.rank) : hit.score,
      lexicalRank: hit.rank,
      vectorRank: null,
      lexicalScore: hit.score,
      cosineDistance: null,
    });
  for (const hit of vectors) {
    const row = byId.get(hit.chunkId) ?? {
      chunkId: hit.chunkId,
      ruleId: hit.ruleId,
      score: 0,
      lexicalRank: null,
      vectorRank: null,
      lexicalScore: null,
      cosineDistance: null,
    };
    row.score += mode === "hybrid" ? 1 / (k + hit.rank) : 1 - hit.distance;
    row.vectorRank = hit.rank;
    row.cosineDistance = hit.distance;
    byId.set(hit.chunkId, row);
  }
  return [...byId.values()]
    .sort((a, b) => b.score - a.score || a.chunkId.localeCompare(b.chunkId))
    .slice(0, limit)
    .map((hit, index) => ({ ...hit, rank: index + 1 }));
}
export class VectorService {
  constructor(
    private readonly db: DataSource,
    private readonly queue: PgBoss,
    private readonly provider?: EmbeddingProvider,
  ) {}
  private requireProvider(profile?: unknown) {
    if (!this.provider)
      throw new RetrievalError(503, "EMBEDDING_NOT_CONFIGURED");
    if (profile && !sameProfile(profile, this.provider.profile))
      throw new RetrievalError(409, "EMBEDDING_PROFILE_MISMATCH");
    return this.provider;
  }
  async enqueue(indexBuildId: string, requestId: string) {
    const profile = this.requireProvider().profile;
    return this.db.transaction(async (tx) => {
      const [base] = await tx.query(
        "SELECT id,release_id FROM index_builds WHERE id=$1 AND state='ready' FOR UPDATE",
        [indexBuildId],
      );
      if (!base) throw new RetrievalError(404, "INDEX_NOT_FOUND");
      const [existing] = await tx.query(
        "SELECT id FROM vector_indexes WHERE index_build_id=$1 AND profile=$2::jsonb",
        [indexBuildId, JSON.stringify(profile)],
      );
      if (existing) return { vectorIndexId: existing.id };
      const [{ id }] = await tx.query(
        "INSERT INTO vector_indexes(index_build_id,release_id,profile,profile_hash) VALUES($1,$2,$3,'') RETURNING id",
        [indexBuildId, base.release_id, JSON.stringify(profile)],
      );
      const sent = await this.queue.send(
        VECTOR_QUEUE,
        { vectorIndexId: id },
        { id, db: sqlAdapter(tx) },
      );
      if (!sent) throw new Error("VECTOR_QUEUE_FAILED");
      await tx.query(
        "INSERT INTO admin_audit_events(request_id,actor,action,target_id) VALUES($1,'admin','vectors.enqueue',$2)",
        [requestId, id],
      );
      return { vectorIndexId: id };
    });
  }
  async configuredIndex(id: string) {
    const index = await this.get(id);
    if (index.state !== "ready")
      throw new RetrievalError(409, "VECTOR_INDEX_NOT_READY");
    this.requireProvider(index.profile);
    return index;
  }
  async get(id: string) {
    const [row] = await this.db.query(
      `SELECT v.id,v.index_build_id AS "indexBuildId",v.release_id AS "releaseId",v.state,v.profile,v.profile_hash AS "profileHash",v.attempts,v.error_code AS "errorCode",v.created_at AS "createdAt",v.updated_at AS "updatedAt",(SELECT count(*)::int FROM chunk_embeddings WHERE vector_index_id=v.id) AS "completedChunks",(SELECT count(*)::int FROM retrieval_chunks WHERE build_id=v.index_build_id) AS "totalChunks" FROM vector_indexes v WHERE v.id=$1`,
      [id],
    );
    if (!row) throw new RetrievalError(404, "VECTOR_INDEX_NOT_FOUND");
    const job = await this.queue.getJobById(VECTOR_QUEUE, id);
    if (row.state !== "ready" && row.state !== "failed" && job) {
      if (job.state === "failed") row.state = "failed";
      else if (job.state === "retry") row.state = "retrying";
    }
    if (!job && row.state !== "ready") {
      row.state = "failed";
      row.errorCode = "VECTOR_QUEUE_RECORD_MISSING";
    }
    return v.vectorIndexResult.parse(
      json({ ...row, queueState: job?.state ?? null }),
    );
  }
  async retry(id: string, requestId: string) {
    const observed = await this.get(id);
    this.requireProvider(observed.profile);
    if (observed.state !== "failed")
      throw new RetrievalError(409, "VECTOR_JOB_NOT_FAILED");
    return this.db.transaction(async (tx) => {
      const [row] = await tx.query(
        "SELECT state FROM vector_indexes WHERE id=$1 FOR UPDATE",
        [id],
      );
      const job = await this.queue.getJobById(VECTOR_QUEUE, id);
      if (!row || row.state === "ready" || (job && job.state !== "failed"))
        throw new RetrievalError(409, "VECTOR_JOB_NOT_FAILED");
      if (job) await this.queue.retry(VECTOR_QUEUE, id, { db: sqlAdapter(tx) });
      else if (
        !(await this.queue.send(
          VECTOR_QUEUE,
          { vectorIndexId: id },
          { id, db: sqlAdapter(tx) },
        ))
      )
        throw new Error("VECTOR_QUEUE_RESTORE_FAILED");
      await tx.query(
        "UPDATE vector_indexes SET state='queued',attempt_token=NULL,error_code=NULL,updated_at=now() WHERE id=$1",
        [id],
      );
      await tx.query(
        "INSERT INTO admin_audit_events(request_id,actor,action,target_id) VALUES($1,'admin','vectors.retry',$2)",
        [requestId, id],
      );
      return { vectorIndexId: id };
    });
  }
  async process(job: JobWithMetadata<VectorJob>) {
    const token = randomUUID();
    const row = await this.db.transaction(async (tx) => {
      const [record] = await tx.query(
        "SELECT * FROM vector_indexes WHERE id=$1 FOR UPDATE",
        [job.data.vectorIndexId],
      );
      if (!record || record.id !== job.id)
        throw new Error("VECTOR_JOB_NOT_FOUND");
      if (record.state === "ready") return null;
      await tx.query(
        "UPDATE vector_indexes SET state='running',attempt_token=$2,attempts=attempts+1,error_code=NULL,updated_at=now() WHERE id=$1",
        [record.id, token],
      );
      return record;
    });
    if (!row) return;
    const deadline = AbortSignal.timeout(150000);
    const signal = job.signal
      ? AbortSignal.any([job.signal, deadline])
      : deadline;
    try {
      const provider = this.requireProvider(row.profile);
      while (true) {
        if (signal.aborted) throw new EmbeddingError("EMBEDDING_ABORTED");
        const batch: Array<{ id: string; content: string }> =
          await this.db.query(
            "SELECT c.id,c.content FROM retrieval_chunks c WHERE c.build_id=$1 AND NOT EXISTS(SELECT 1 FROM chunk_embeddings e WHERE e.vector_index_id=$2 AND e.chunk_id=c.id) ORDER BY c.id LIMIT 8",
            [row.index_build_id, row.id],
          );
        if (!batch.length) break;
        const output = await provider.embed(
          batch.map((c) => c.content),
          "document",
          signal,
        );
        const vectors = validateVectors(
          output.vectors,
          batch.length,
          provider.profile.dimensions,
        );
        await this.db.transaction(async (tx) => {
          await this.claim(tx, row.id, token, signal);
          for (let i = 0; i < batch.length; i++)
            await tx.query(
              "INSERT INTO chunk_embeddings(vector_index_id,index_build_id,release_id,chunk_id,embedding) VALUES($1,$2,$3,$4,$5::vector)",
              [
                row.id,
                row.index_build_id,
                row.release_id,
                batch[i].id,
                JSON.stringify(vectors[i]),
              ],
            );
          await tx.query(
            "INSERT INTO embedding_batches(vector_index_id,chunk_ids,usage_tokens) VALUES($1,$2,$3)",
            [row.id, batch.map((c) => c.id), output.usageTokens],
          );
        });
      }
      await this.db.transaction(async (tx) => {
        await this.claim(tx, row.id, token, signal);
        await tx.query(
          "UPDATE vector_indexes SET state='ready',error_code=NULL,updated_at=now() WHERE id=$1",
          [row.id],
        );
      });
    } catch (error) {
      const code = errorCode(error);
      await this.db.query(
        "UPDATE vector_indexes SET state=$3,error_code=$4,updated_at=now() WHERE id=$1 AND attempt_token=$2 AND state<>'ready'",
        [
          row.id,
          token,
          job.retryCount < job.retryLimit ? "retrying" : "failed",
          code,
        ],
      );
      throw new Error(code);
    }
  }
  private async claim(
    tx: EntityManager,
    id: string,
    token: string,
    signal: AbortSignal,
  ) {
    const [row] = await tx.query(
      "SELECT state,attempt_token FROM vector_indexes WHERE id=$1 FOR UPDATE",
      [id],
    );
    if (
      signal.aborted ||
      !row ||
      row.state !== "running" ||
      row.attempt_token !== token
    )
      throw new EmbeddingError("STALE_VECTOR_ATTEMPT");
  }
  async workOnce() {
    const jobs = await this.queue.fetch<VectorJob>(VECTOR_QUEUE, {
      includeMetadata: true,
      batchSize: 1,
    });
    for (const job of jobs) {
      try {
        await this.process(job);
        await this.queue.complete(VECTOR_QUEUE, job);
      } catch (error) {
        await this.queue.fail(VECTOR_QUEUE, job, {
          code: error instanceof Error ? error.message : "VECTOR_FAILED",
        });
      }
    }
    return jobs.length;
  }
  async start() {
    const options = {
      includeMetadata: true,
      batchSize: 1,
      pollingIntervalSeconds: 1,
    } as const;
    await this.queue.work<VectorJob, void, typeof options>(
      VECTOR_QUEUE,
      options,
      async (jobs) => {
        for (const job of jobs) await this.process(job);
      },
    );
  }
  async search(
    id: string,
    input: {
      query: string;
      mode?: "lexical" | "vector" | "hybrid";
      candidateLimit?: number;
      limit?: number;
      rrfK?: number;
    },
    signal?: AbortSignal,
    requestId?: string,
  ) {
    const valid = v.vectorSearchInput.parse(input);
    const index = await this.get(id);
    if (index.state !== "ready")
      throw new RetrievalError(409, "VECTORS_NOT_READY");
    const runId = randomUUID();
    const started = performance.now();
    let usageTokens: number | null = valid.mode === "lexical" ? 0 : null;
    let result: Record<string, unknown> = {};
    let status = "succeeded";
    let failure: unknown;
    try {
      const lexical: LexicalHit[] =
        valid.mode === "vector"
          ? []
          : (
              await new KnowledgeIndexService(this.db).search(
                index.indexBuildId,
                { query: valid.query, limit: valid.candidateLimit },
              )
            ).hits;
      let vectors: VectorHit[] = [];
      if (valid.mode !== "lexical") {
        const provider = this.requireProvider(index.profile);
        const output = await provider.embed([valid.query], "query", signal);
        usageTokens = output.usageTokens;
        const [embedding] = validateVectors(
          output.vectors,
          1,
          index.profile.dimensions,
        );
        const rows = await this.db.query(
          `SELECT c.id AS "chunkId",c.rule_unit_id AS "ruleId",(e.embedding <=> $4::vector)::float8 AS distance FROM chunk_embeddings e JOIN retrieval_chunks c ON c.id=e.chunk_id AND c.build_id=e.index_build_id AND c.release_id=e.release_id WHERE e.vector_index_id=$1 AND e.index_build_id=$2 AND e.release_id=$3 ORDER BY e.embedding <=> $4::vector,c.id LIMIT $5`,
          [
            id,
            index.indexBuildId,
            index.releaseId,
            JSON.stringify(embedding),
            valid.candidateLimit,
          ],
        );
        vectors = rows.map((row: Omit<VectorHit, "rank">, rank: number) => ({
          ...row,
          rank: rank + 1,
        }));
      }
      result = v.vectorSearchResult.parse({
        retrievalRunId: runId,
        releaseId: index.releaseId,
        indexBuildId: index.indexBuildId,
        vectorIndexId: id,
        mode: valid.mode,
        query: valid.query,
        hits: fuseRanks(lexical, vectors, valid.mode, valid.rrfK, valid.limit),
        candidates: { lexical, vector: vectors },
        durationMs: Math.round(performance.now() - started),
        usageTokens,
      });
    } catch (error) {
      status = "failed";
      failure = error;
    }
    await this.db.query(
      "INSERT INTO retrieval_runs(id,vector_index_id,index_build_id,release_id,query,mode,config,status,result,error_code,duration_ms,usage_tokens,request_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)",
      [
        runId,
        id,
        index.indexBuildId,
        index.releaseId,
        valid.query,
        valid.mode,
        JSON.stringify({
          candidateLimit: valid.candidateLimit,
          limit: valid.limit,
          rrfK: valid.rrfK,
          profileHash: index.profileHash,
        }),
        status,
        JSON.stringify(result),
        failure ? errorCode(failure) : null,
        Math.round(performance.now() - started),
        usageTokens,
        requestId ?? null,
      ],
    );
    if (failure) throw failure;
    return v.vectorSearchResult.parse(result);
  }
  async run(id: string) {
    const [row] = await this.db.query(
      `SELECT id,request_id AS "requestId",vector_index_id AS "vectorIndexId",index_build_id AS "indexBuildId",release_id AS "releaseId",query,mode,config,status,result,error_code AS "errorCode",duration_ms AS "durationMs",usage_tokens AS "usageTokens",created_at AS "createdAt" FROM retrieval_runs WHERE id=$1`,
      [id],
    );
    if (!row) throw new RetrievalError(404, "RETRIEVAL_RUN_NOT_FOUND");
    return v.retrievalRunResult.parse(json(row));
  }
}
