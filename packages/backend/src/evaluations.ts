import { randomUUID } from "node:crypto";
import type { DataSource, EntityManager } from "typeorm";
import type { PgBoss, JobWithMetadata } from "pg-boss";
import {
  evaluationSchemas as e,
  type EvalCase,
  type EvalConfig,
  type CaseResult,
} from "@boardgame/contracts";
import {
  scoreEvidence,
  summarize,
  SCORER_VERSION,
} from "@boardgame/evaluations";
import {
  KnowledgeIndexService,
  RetrievalError,
  EmbeddingError,
} from "@boardgame/retrieval";
import type { VectorService } from "./vectors.ts";
const RETRIEVER_VERSION = "lexical-vector-rrf-v1";
const CONTEXT_VERSION = "rule-graph-bfs-v1";
export const EVALUATION_QUEUE = "evaluate-retrieval-v1";
const json = (v: unknown) => JSON.parse(JSON.stringify(v));
const adapter = (tx: EntityManager) => ({
  executeSql: async (text: string, values?: unknown[]) => ({
    rows: await tx.query(text, values),
  }),
});
const terminal = (state: string) =>
  ["completed", "completed_with_errors"].includes(state);
const code = (error: unknown) =>
  error instanceof RetrievalError || error instanceof EmbeddingError
    ? error.code
    : "EVALUATION_INFRASTRUCTURE_ERROR";
type EvalJob = { runId: string };
export class EvaluationService {
  constructor(
    private readonly db: DataSource,
    private readonly queue: PgBoss,
    private readonly vectors?: VectorService,
  ) {}
  async createDataset(releaseId: string, input: unknown, requestId: string) {
    const manifest = e.datasetInput.parse(input);
    if (Buffer.byteLength(JSON.stringify(manifest)) > 900000)
      throw new RetrievalError(413, "DATASET_TOO_LARGE");
    return this.db.transaction(async (tx) => {
      const [release] = await tx.query(
        "SELECT id FROM knowledge_releases WHERE id=$1 AND state='sealed' FOR UPDATE",
        [releaseId],
      );
      if (!release) throw new RetrievalError(404, "RELEASE_NOT_FOUND");
      const [existing] = await tx.query(
        "SELECT id,manifest=$4::jsonb AS same FROM eval_datasets WHERE release_id=$1 AND manifest->>'name'=$2 AND manifest->>'revision'=$3",
        [releaseId, manifest.name, manifest.revision, JSON.stringify(manifest)],
      );
      if (existing) {
        if (!existing.same)
          throw new RetrievalError(409, "DATASET_REVISION_CONFLICT");
        return this.dataset(existing.id, tx);
      }
      const [row] = await tx.query(
        "INSERT INTO eval_datasets(release_id,manifest) VALUES($1,$2) RETURNING id",
        [releaseId, JSON.stringify(manifest)],
      );
      await tx.query(
        "INSERT INTO admin_audit_events(request_id,actor,action,target_id) VALUES($1,'admin','evaluation.dataset.create',$2)",
        [requestId, row.id],
      );
      return this.dataset(row.id, tx);
    });
  }
  async dataset(id: string, tx: EntityManager = this.db.manager) {
    const [row] = await tx.query(
      `SELECT id,release_id AS "releaseId",manifest,manifest_hash AS "manifestHash",created_at AS "createdAt" FROM eval_datasets WHERE id=$1`,
      [id],
    );
    if (!row) throw new RetrievalError(404, "DATASET_NOT_FOUND");
    return e.datasetResult.parse(json(row));
  }
  async enqueue(datasetId: string, input: unknown, requestId: string) {
    datasetId = datasetId.toLowerCase();
    const { idempotencyKey: id, config } = e.runInput.parse(input);
    return this.db.transaction(async (tx) => {
      // Lock the key as well as dataset: concurrent uses across datasets must conflict.
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        id,
      ]);
      const [existing] = await tx.query(
        "SELECT dataset_id,config=$2::jsonb AS same FROM eval_runs WHERE id=$1",
        [id, JSON.stringify(config)],
      );
      if (existing) {
        if (existing.dataset_id !== datasetId || !existing.same)
          throw new RetrievalError(409, "EVALUATION_IDEMPOTENCY_CONFLICT");
        return { runId: id };
      }
      const dataset = await this.dataset(datasetId, tx);
      if (!dataset.manifest.cases.some((c) => c.split === config.split))
        throw new RetrievalError(422, "EVALUATION_SPLIT_EMPTY");
      const knowledge = new KnowledgeIndexService(this.db);
      const base = await knowledge.index(config.indexBuildId);
      if (base.releaseId !== dataset.releaseId)
        throw new RetrievalError(422, "EVALUATION_RELEASE_MISMATCH");
      let vector = null;
      if (config.vectorIndexId) {
        if (!this.vectors)
          throw new RetrievalError(503, "VECTORS_NOT_CONFIGURED");
        vector = await this.vectors.get(config.vectorIndexId);
        if (vector.indexBuildId !== base.id || vector.state !== "ready")
          throw new RetrievalError(422, "EVALUATION_VECTOR_MISMATCH");
      }
      const release = await knowledge.release(dataset.releaseId);
      const identity = {
        scorerVersion: SCORER_VERSION,
        datasetHash: dataset.manifestHash,
        releaseHash: release.manifestHash,
        indexConfigHash: base.configHash,
        embeddingProfileHash: vector?.profileHash ?? null,
        embeddingProfile: vector?.profile ?? null,
        nodeVersion: process.versions.node,
        retrieverVersion: RETRIEVER_VERSION,
        contextVersion: CONTEXT_VERSION,
      };
      await tx.query(
        "INSERT INTO eval_runs(id,dataset_id,release_id,index_build_id,vector_index_id,config,identity) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [
          id,
          datasetId,
          dataset.releaseId,
          base.id,
          config.vectorIndexId,
          JSON.stringify(config),
          JSON.stringify(identity),
        ],
      );
      if (
        !(await this.queue.send(
          EVALUATION_QUEUE,
          { runId: id },
          { id, db: adapter(tx) },
        ))
      )
        throw new Error("EVALUATION_QUEUE_FAILED");
      await tx.query(
        "INSERT INTO admin_audit_events(request_id,actor,action,target_id) VALUES($1,'admin','evaluation.enqueue',$2)",
        [requestId, id],
      );
      return { runId: id };
    });
  }
  async get(id: string) {
    const [row] = await this.db.query(
      `SELECT r.id,r.dataset_id AS "datasetId",r.release_id AS "releaseId",r.config,r.identity,r.state,r.attempts,r.error_code AS "errorCode",r.report,r.created_at AS "createdAt",r.updated_at AS "updatedAt",(SELECT count(*)::int FROM eval_results WHERE run_id=r.id) AS "completedCases",(SELECT count(*)::int FROM jsonb_array_elements(d.manifest->'cases') c WHERE c->>'split'=r.config->>'split') AS "totalCases" FROM eval_runs r JOIN eval_datasets d ON d.id=r.dataset_id WHERE r.id=$1`,
      [id],
    );
    if (!row) throw new RetrievalError(404, "EVALUATION_NOT_FOUND");
    const job = await this.queue.getJobById(EVALUATION_QUEUE, id);
    if (!terminal(row.state)) {
      if (!job) {
        row.state = "failed";
        row.errorCode = "EVALUATION_QUEUE_RECORD_MISSING";
      } else if (job.state === "failed") row.state = "failed";
      else if (job.state === "retry") row.state = "retrying";
    }
    return e.runResult.parse(json({ ...row, queueState: job?.state ?? null }));
  }
  async results(id: string, page = { limit: 25, offset: 0 }) {
    const run = await this.get(id);
    const rows = await this.db.query(
      "SELECT result FROM eval_results WHERE run_id=$1 ORDER BY case_id LIMIT $2 OFFSET $3",
      [id, page.limit, page.offset],
    );
    const items: CaseResult[] = rows.map((r: { result: unknown }) =>
      e.caseResult.parse(r.result),
    );
    return { items, total: run.completedCases, ...page };
  }
  async retry(id: string, requestId: string) {
    if ((await this.get(id)).state !== "failed")
      throw new RetrievalError(409, "EVALUATION_NOT_FAILED");
    return this.db.transaction(async (tx) => {
      const [row] = await tx.query(
        "SELECT state FROM eval_runs WHERE id=$1 FOR UPDATE",
        [id],
      );
      const job = await this.queue.getJobById(EVALUATION_QUEUE, id);
      if (!row || terminal(row.state) || (job && job.state !== "failed"))
        throw new RetrievalError(409, "EVALUATION_NOT_FAILED");
      if (job)
        await this.queue.retry(EVALUATION_QUEUE, id, { db: adapter(tx) });
      else if (
        !(await this.queue.send(
          EVALUATION_QUEUE,
          { runId: id },
          { id, db: adapter(tx) },
        ))
      )
        throw new Error("EVALUATION_QUEUE_RESTORE_FAILED");
      await tx.query(
        "UPDATE eval_runs SET state='queued',attempt_token=NULL,error_code=NULL,updated_at=now() WHERE id=$1",
        [id],
      );
      await tx.query(
        "INSERT INTO admin_audit_events(request_id,actor,action,target_id) VALUES($1,'admin','evaluation.retry',$2)",
        [requestId, id],
      );
      return { runId: id };
    });
  }
  private async evaluate(
    c: EvalCase,
    config: EvalConfig,
    releaseId: string,
    signal: AbortSignal,
  ): Promise<CaseResult> {
    const started = performance.now();
    let search:
      | Awaited<ReturnType<KnowledgeIndexService["search"]>>
      | Awaited<ReturnType<VectorService["search"]>>
      | null = null;
    let context: Awaited<ReturnType<KnowledgeIndexService["context"]>> | null =
      null;
    let usageTokens: number | null = config.mode === "lexical" ? 0 : null;
    try {
      signal.throwIfAborted();
      const knowledge = new KnowledgeIndexService(this.db);
      if (config.mode === "lexical")
        search = await knowledge.search(config.indexBuildId, {
          query: c.query,
          limit: config.limit,
        });
      else {
        if (!this.vectors || !config.vectorIndexId)
          throw new RetrievalError(503, "VECTORS_NOT_CONFIGURED");
        search = await this.vectors.search(
          config.vectorIndexId,
          {
            query: c.query,
            mode: config.mode,
            limit: config.limit,
            candidateLimit: config.candidateLimit,
            rrfK: config.rrfK,
          },
          signal,
        );
        usageTokens = search.usageTokens;
      }
      if (
        search.releaseId !== releaseId ||
        search.indexBuildId !== config.indexBuildId
      )
        throw new RetrievalError(409, "EVALUATION_SCOPE_VIOLATION");
      if (config.context) {
        context = search.hits.length
          ? await knowledge.context(config.indexBuildId, {
              chunkIds: search.hits.map((h: { chunkId: string }) => h.chunkId),
              ...config.context,
            })
          : {
              releaseId,
              indexBuildId: config.indexBuildId,
              rulesetId: (await knowledge.release(releaseId)).rulesetId,
              evidence: [],
              relations: [],
              gaps: [],
            };
        if (context.releaseId !== releaseId)
          throw new RetrievalError(409, "EVALUATION_SCOPE_VIOLATION");
      }
      signal.throwIfAborted();
      return e.caseResult.parse({
        caseId: c.id,
        category: c.category,
        severity: c.severity,
        status: "succeeded",
        errorCode: null,
        durationMs: Math.round(performance.now() - started),
        usageTokens,
        search,
        context,
        searchScore: scoreEvidence(
          c.acceptableEvidenceSets,
          search.hits.map((h: { ruleId: string }) => h.ruleId),
        ),
        contextScore: config.context
          ? scoreEvidence(
              c.acceptableEvidenceSets,
              context!.evidence.map((h: { ruleId: string }) => h.ruleId),
            )
          : null,
      });
    } catch (error) {
      return e.caseResult.parse({
        caseId: c.id,
        category: c.category,
        severity: c.severity,
        status: "failed",
        errorCode: signal.aborted ? "EVALUATION_CASE_ABORTED" : code(error),
        durationMs: Math.round(performance.now() - started),
        usageTokens,
        search,
        context,
        searchScore: scoreEvidence(c.acceptableEvidenceSets, []),
        contextScore: config.context
          ? scoreEvidence(c.acceptableEvidenceSets, [])
          : null,
      });
    }
  }
  private async claim(
    tx: EntityManager,
    id: string,
    token: string,
    signal: AbortSignal,
  ) {
    const [r] = await tx.query(
      "SELECT state,attempt_token FROM eval_runs WHERE id=$1 FOR UPDATE",
      [id],
    );
    if (
      signal.aborted ||
      !r ||
      r.state !== "running" ||
      r.attempt_token !== token
    )
      throw new RetrievalError(409, "STALE_EVALUATION_ATTEMPT");
  }
  async process(job: JobWithMetadata<EvalJob>) {
    const token = randomUUID();
    const row = await this.db.transaction(async (tx) => {
      const [r] = await tx.query(
        "SELECT * FROM eval_runs WHERE id=$1 FOR UPDATE",
        [job.data.runId],
      );
      if (!r || r.id !== job.id) throw new Error("EVALUATION_JOB_NOT_FOUND");
      if (terminal(r.state)) return null;
      await tx.query(
        "UPDATE eval_runs SET state='running',attempt_token=$2,attempts=attempts+1,error_code=NULL,updated_at=now() WHERE id=$1",
        [r.id, token],
      );
      return r;
    });
    if (!row) return;
    const signal = AbortSignal.any([
      AbortSignal.timeout(3300000),
      ...(job.signal ? [job.signal] : []),
    ]);
    try {
      if (
        row.identity.scorerVersion !== SCORER_VERSION ||
        row.identity.nodeVersion !== process.versions.node ||
        row.identity.retrieverVersion !== RETRIEVER_VERSION ||
        row.identity.contextVersion !== CONTEXT_VERSION
      )
        throw new RetrievalError(409, "EVALUATION_RUNTIME_MISMATCH");
      const dataset = await this.dataset(row.dataset_id);
      const config = e.runConfig.parse(row.config);
      const cases = dataset.manifest.cases.filter(
        (c) => c.split === config.split,
      );
      const saved = await this.db.query(
        "SELECT case_id FROM eval_results WHERE run_id=$1",
        [row.id],
      );
      const done = new Set(saved.map((r: { case_id: string }) => r.case_id));
      for (const c of cases) {
        if (done.has(c.id)) continue;
        await this.db.transaction((tx) =>
          this.claim(tx, row.id, token, signal),
        );
        const result = await this.evaluate(
          c,
          config,
          row.release_id,
          AbortSignal.any([signal, AbortSignal.timeout(35000)]),
        );
        await this.db.transaction(async (tx) => {
          await this.claim(tx, row.id, token, signal);
          await tx.query(
            "INSERT INTO eval_results(run_id,case_id,result) VALUES($1,$2,$3)",
            [row.id, c.id, JSON.stringify(result)],
          );
        });
      }
      await this.db.transaction(async (tx) => {
        await this.claim(tx, row.id, token, signal);
        const saved = await tx.query(
          "SELECT result FROM eval_results WHERE run_id=$1 ORDER BY case_id",
          [row.id],
        );
        const results: CaseResult[] = saved.map((r: { result: unknown }) =>
          e.caseResult.parse(r.result),
        );
        const report = summarize(cases, results, config.context !== null);
        await tx.query(
          "UPDATE eval_runs SET state=$2,report=$3,error_code=NULL,updated_at=now() WHERE id=$1",
          [
            row.id,
            results.some((r) => r.status === "failed")
              ? "completed_with_errors"
              : "completed",
            JSON.stringify(report),
          ],
        );
      });
    } catch (error) {
      await this.db.query(
        "UPDATE eval_runs SET state=$3,error_code=$4,updated_at=now() WHERE id=$1 AND attempt_token=$2 AND state='running'",
        [
          row.id,
          token,
          job.retryCount < job.retryLimit ? "retrying" : "failed",
          code(error),
        ],
      );
      throw new Error(code(error));
    }
  }
  async workOnce() {
    const jobs = await this.queue.fetch<EvalJob>(EVALUATION_QUEUE, {
      includeMetadata: true,
      batchSize: 1,
    });
    for (const job of jobs) {
      try {
        await this.process(job);
        await this.queue.complete(EVALUATION_QUEUE, job);
      } catch {
        await this.queue.fail(EVALUATION_QUEUE, job, {
          code: "EVALUATION_FAILED",
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
    await this.queue.work<EvalJob, void, typeof options>(
      EVALUATION_QUEUE,
      options,
      async (jobs) => {
        for (const job of jobs) await this.process(job);
      },
    );
  }
}
