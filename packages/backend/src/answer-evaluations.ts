import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { DataSource, EntityManager } from "typeorm";
import type { PgBoss, JobWithMetadata } from "pg-boss";
import {
  answerEvaluationSchemas as s,
  answeringSchemas as a,
  knowledgeSchemas as k,
  type EvalCase,
} from "@boardgame/contracts";
import {
  ANSWER_EVALUATOR_VERSION,
  automaticAnswerScore,
  summarizeAnswers,
  type AnswerReviewRow,
} from "@boardgame/evaluations";
import { verifyAnswer } from "@boardgame/agent";
import { KnowledgeIndexService, RetrievalError } from "@boardgame/retrieval";
import { EvaluationService } from "./evaluations.ts";
import type { AnswerService } from "./answers.ts";
export const ANSWER_EVALUATION_QUEUE = "evaluate-answers-v1";
const json = (v: unknown) => JSON.parse(JSON.stringify(v));
const generated = (state: string) =>
  ["awaiting_review", "sealed"].includes(state);
const dbAdapter = (tx: EntityManager) => ({
  executeSql: async (text: string, values?: unknown[]) => ({
    rows: await tx.query(text, values),
  }),
});
const failCode = (error: unknown) =>
  error instanceof RetrievalError
    ? error.code
    : "ANSWER_EVALUATION_INFRASTRUCTURE_ERROR";
type EvalJob = { evaluationId: string };
type Review = z.infer<typeof s.reviewResult>;
type CaseRow = {
  id: string;
  evaluation_id: string;
  case_id: string;
  execution_key: string;
  request: z.infer<typeof a.previewInput>;
  answer_run_id: string | null;
  outcome: z.infer<typeof s.outcome> | null;
};
export class AnswerEvaluationService {
  constructor(
    private readonly db: DataSource,
    private readonly queue: PgBoss,
    private readonly answers: AnswerService,
  ) {}
  private dataset(id: string, tx: EntityManager = this.db.manager) {
    return new EvaluationService(this.db, this.queue).dataset(id, tx);
  }
  private async load(id: string, tx: EntityManager = this.db.manager) {
    const [row] = await tx.query(
      `SELECT id,dataset_id AS "datasetId",release_id AS "releaseId",config,identity,identity_hash AS "identityHash",state,attempts,error_code AS "errorCode",report,report_hash AS "reportHash",created_at AS "createdAt",updated_at AS "updatedAt" FROM answer_evaluations WHERE id=$1`,
      [id],
    );
    if (!row) throw new RetrievalError(404, "ANSWER_EVALUATION_NOT_FOUND");
    return row;
  }
  private async latest(
    caseRowId: string,
    tx: EntityManager = this.db.manager,
  ): Promise<Review | null> {
    const [row] = await tx.query(
      `SELECT id,case_row_id AS "caseRowId",revision,actor,review,created_at AS "createdAt" FROM answer_case_reviews WHERE case_row_id=$1 ORDER BY revision DESC LIMIT 1`,
      [caseRowId],
    );
    return row ? s.reviewResult.parse(json(row)) : null;
  }
  private async summary(
    row: Awaited<ReturnType<AnswerEvaluationService["load"]>>,
    tx: EntityManager = this.db.manager,
  ) {
    const dataset = await this.dataset(row.datasetId, tx);
    const rows: Array<{ case_id: string; outcome: unknown; review: unknown }> =
      await tx.query(
        "SELECT c.case_id,c.outcome,v.review FROM answer_evaluation_cases c LEFT JOIN LATERAL (SELECT review FROM answer_case_reviews WHERE case_row_id=c.id ORDER BY revision DESC LIMIT 1) v ON true WHERE c.evaluation_id=$1 ORDER BY c.case_id",
        [row.id],
      );
    const scores: AnswerReviewRow[] = rows.map((r) => ({
      caseId: r.case_id,
      outcome: r.outcome ? s.outcome.parse(r.outcome) : null,
      review: r.review ? s.reviewFields.parse(r.review) : null,
    }));
    return s.summary.parse(
      summarizeAnswers(
        dataset.manifest.cases.filter((c) => c.split === row.config.split),
        scores,
      ),
    );
  }
  async enqueue(datasetId: string, input: unknown, requestId: string) {
    datasetId = datasetId.toLowerCase();
    const { idempotencyKey: id, config } = s.enqueueInput.parse(input);
    return this.db.transaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        id,
      ]);
      const [existing] = await tx.query(
        "SELECT dataset_id,config=$2::jsonb AS same FROM answer_evaluations WHERE id=$1",
        [id, JSON.stringify(config)],
      );
      if (existing) {
        if (existing.dataset_id !== datasetId || !existing.same)
          throw new RetrievalError(
            409,
            "ANSWER_EVALUATION_IDEMPOTENCY_CONFLICT",
          );
        return { evaluationId: id };
      }
      const dataset = await this.dataset(datasetId, tx),
        cases = dataset.manifest.cases.filter((c) => c.split === config.split);
      if (!cases.length)
        throw new RetrievalError(422, "ANSWER_EVALUATION_SPLIT_EMPTY");
      const execution = cases.map((c) => {
        const last = c.messages.at(-1);
        if (last?.role !== "user")
          throw new RetrievalError(422, "ANSWER_EVALUATION_CASE_INPUT_INVALID");
        const request = a.previewInput.safeParse({
          idempotencyKey: randomUUID(),
          question: last.content,
          history: c.messages.slice(0, -1),
          retrieval: config.retrieval,
        });
        if (!request.success)
          throw new RetrievalError(422, "ANSWER_EVALUATION_CASE_INPUT_INVALID");
        return { caseId: c.id, request: request.data };
      });
      const answer = await this.answers.configuration(config.retrieval);
      if (answer.base.releaseId !== dataset.releaseId)
        throw new RetrievalError(422, "ANSWER_EVALUATION_RELEASE_MISMATCH");
      const release = await new KnowledgeIndexService(this.db).release(
        dataset.releaseId,
      );
      const identity = s.identity.parse({
        evaluatorVersion: ANSWER_EVALUATOR_VERSION,
        datasetHash: dataset.manifestHash,
        releaseHash: release.manifestHash,
        answerConfig: answer.config,
      });
      await tx.query(
        "INSERT INTO answer_evaluations(id,dataset_id,release_id,index_build_id,vector_index_id,config,identity) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [
          id,
          datasetId,
          dataset.releaseId,
          answer.base.id,
          config.retrieval.vectorIndexId,
          JSON.stringify(config),
          JSON.stringify(identity),
        ],
      );
      for (const item of execution)
        await tx.query(
          "INSERT INTO answer_evaluation_cases(evaluation_id,case_id,execution_key,request) VALUES($1,$2,$3,$4)",
          [
            id,
            item.caseId,
            item.request.idempotencyKey,
            JSON.stringify(item.request),
          ],
        );
      await tx.query(
        "UPDATE answer_evaluations SET state='queued' WHERE id=$1",
        [id],
      );
      if (
        !(await this.queue.send(
          ANSWER_EVALUATION_QUEUE,
          { evaluationId: id },
          { id, db: dbAdapter(tx) },
        ))
      )
        throw new Error("ANSWER_EVALUATION_QUEUE_FAILED");
      await tx.query(
        "INSERT INTO admin_audit_events(request_id,actor,action,target_id) VALUES($1,'admin','answer_evaluation.enqueue',$2)",
        [requestId, id],
      );
      return { evaluationId: id };
    });
  }
  async get(id: string) {
    const row = await this.load(id),
      job = await this.queue.getJobById(ANSWER_EVALUATION_QUEUE, id);
    if (!generated(row.state)) {
      if (!job) {
        row.state = "failed";
        row.errorCode = "ANSWER_EVALUATION_QUEUE_RECORD_MISSING";
      } else if (job.state === "failed") row.state = "failed";
      else if (job.state === "retry") row.state = "retrying";
    }
    return s.runResult.parse(
      json({
        ...row,
        queueState: job?.state ?? null,
        summary: row.report?.summary ?? (await this.summary(row)),
      }),
    );
  }
  async cases(id: string, page = { limit: 25, offset: 0 }) {
    const row = await this.load(id),
      dataset = await this.dataset(row.datasetId),
      byId = new Map(dataset.manifest.cases.map((c) => [c.id, c]));
    const rows: CaseRow[] = await this.db.query(
      "SELECT * FROM answer_evaluation_cases WHERE evaluation_id=$1 ORDER BY case_id LIMIT $2 OFFSET $3",
      [id, page.limit, page.offset],
    );
    const items = [];
    for (const r of rows) {
      const [present] = await this.db.query(
        "SELECT id FROM answer_runs WHERE id=$1",
        [r.execution_key],
      );
      items.push(
        s.caseResult.parse({
          id: r.id,
          evaluationId: id,
          caseId: r.case_id,
          executionKey: r.execution_key,
          answerRunId: r.answer_run_id,
          testCase: byId.get(r.case_id),
          outcome: r.outcome,
          answerRun: present ? await this.answers.get(present.id) : null,
          latestReview: await this.latest(r.id),
        }),
      );
    }
    return {
      items,
      total: dataset.manifest.cases.filter((c) => c.split === row.config.split)
        .length,
      ...page,
    };
  }
  async reviews(caseRowId: string, page = { limit: 25, offset: 0 }) {
    const [c] = await this.db.query(
      "SELECT id FROM answer_evaluation_cases WHERE id=$1",
      [caseRowId],
    );
    if (!c) throw new RetrievalError(404, "ANSWER_EVALUATION_CASE_NOT_FOUND");
    const [{ total }] = await this.db.query(
      "SELECT count(*)::int AS total FROM answer_case_reviews WHERE case_row_id=$1",
      [caseRowId],
    );
    const rows = await this.db.query(
      `SELECT id,case_row_id AS "caseRowId",revision,actor,review,created_at AS "createdAt" FROM answer_case_reviews WHERE case_row_id=$1 ORDER BY revision LIMIT $2 OFFSET $3`,
      [caseRowId, page.limit, page.offset],
    );
    const items: Review[] = rows.map((r: unknown) =>
      s.reviewResult.parse(json(r)),
    );
    return { items, total, ...page };
  }
  async review(caseRowId: string, input: unknown, requestId: string) {
    const valid = s.reviewInput.parse(input);
    return this.db.transaction(async (tx) => {
      const [c]: CaseRow[] = await tx.query(
        "SELECT * FROM answer_evaluation_cases WHERE id=$1",
        [caseRowId],
      );
      if (!c) throw new RetrievalError(404, "ANSWER_EVALUATION_CASE_NOT_FOUND");
      const [parent] = await tx.query(
        "SELECT state FROM answer_evaluations WHERE id=$1 FOR UPDATE",
        [c.evaluation_id],
      );
      const previous = await this.latest(caseRowId, tx);
      if (
        previous?.revision === valid.expectedRevision + 1 &&
        isDeepStrictEqual(previous.review, valid.review)
      )
        return previous;
      if (parent.state !== "awaiting_review")
        throw new RetrievalError(409, "ANSWER_EVALUATION_NOT_REVIEWABLE");
      if ((previous?.revision ?? 0) !== valid.expectedRevision)
        throw new RetrievalError(409, "ANSWER_REVIEW_REVISION_CONFLICT");
      const run = await this.load(c.evaluation_id, tx),
        dataset = await this.dataset(run.datasetId, tx),
        testCase = dataset.manifest.cases.find((x) => x.id === c.case_id)!;
      if (
        valid.review.requiredClaimsSatisfied.length !==
          testCase.requiredClaims.length ||
        valid.review.forbiddenClaimsAbsent.length !==
          testCase.forbiddenClaims.length
      )
        throw new RetrievalError(422, "ANSWER_REVIEW_CLAIM_COUNT_MISMATCH");
      const [created] = await tx.query(
        "INSERT INTO answer_case_reviews(case_row_id,revision,actor,review) VALUES($1,$2,'admin',$3) RETURNING id",
        [caseRowId, valid.expectedRevision + 1, JSON.stringify(valid.review)],
      );
      await tx.query(
        "INSERT INTO admin_audit_events(request_id,actor,action,target_id,details) VALUES($1,'admin','answer_evaluation.review',$2,$3)",
        [
          requestId,
          caseRowId,
          JSON.stringify({
            reviewId: created.id,
            revision: valid.expectedRevision + 1,
          }),
        ],
      );
      return (await this.latest(caseRowId, tx))!;
    });
  }
  async seal(id: string, input: unknown, requestId: string) {
    const { note } = s.sealInput.parse(input);
    await this.db.transaction(async (tx) => {
      const [locked] = await tx.query(
        "SELECT state FROM answer_evaluations WHERE id=$1 FOR UPDATE",
        [id],
      );
      if (!locked) throw new RetrievalError(404, "ANSWER_EVALUATION_NOT_FOUND");
      const row = await this.load(id, tx);
      if (row.state === "sealed") {
        if (row.report.note !== note)
          throw new RetrievalError(409, "ANSWER_EVALUATION_ALREADY_SEALED");
        return;
      }
      if (row.state !== "awaiting_review")
        throw new RetrievalError(409, "ANSWER_EVALUATION_NOT_REVIEWABLE");
      const summary = await this.summary(row, tx);
      if (summary.missingReviews.length)
        throw new RetrievalError(409, "ANSWER_EVALUATION_REVIEWS_INCOMPLETE");
      const cases = await tx.query(
        `SELECT c.id AS "caseRowId",c.case_id AS "caseId",c.answer_run_id AS "answerRunId",v.id AS "reviewId",v.revision AS "reviewRevision" FROM answer_evaluation_cases c JOIN LATERAL (SELECT id,revision FROM answer_case_reviews WHERE case_row_id=c.id ORDER BY revision DESC LIMIT 1) v ON true WHERE c.evaluation_id=$1 ORDER BY c.case_id`,
        [id],
      );
      const report = s.sealedReport.parse({
        evaluationId: id,
        datasetId: row.datasetId,
        releaseId: row.releaseId,
        config: row.config,
        identity: row.identity,
        identityHash: row.identityHash,
        summary,
        note,
        sealedAt: new Date().toISOString(),
        cases,
      });
      await tx.query(
        "UPDATE answer_evaluations SET state='sealed',report=$2,updated_at=now() WHERE id=$1",
        [id, JSON.stringify(report)],
      );
      await tx.query(
        "INSERT INTO admin_audit_events(request_id,actor,action,target_id) VALUES($1,'admin','answer_evaluation.seal',$2)",
        [requestId, id],
      );
    });
    return this.get(id);
  }
  async retry(id: string, requestId: string) {
    if ((await this.get(id)).state !== "failed")
      throw new RetrievalError(409, "ANSWER_EVALUATION_NOT_FAILED");
    return this.db.transaction(async (tx) => {
      const [row] = await tx.query(
        "SELECT state FROM answer_evaluations WHERE id=$1 FOR UPDATE",
        [id],
      );
      const job = await this.queue.getJobById(ANSWER_EVALUATION_QUEUE, id);
      if (!row || generated(row.state) || (job && job.state !== "failed"))
        throw new RetrievalError(409, "ANSWER_EVALUATION_NOT_FAILED");
      if (job)
        await this.queue.retry(ANSWER_EVALUATION_QUEUE, id, {
          db: dbAdapter(tx),
        });
      else if (
        !(await this.queue.send(
          ANSWER_EVALUATION_QUEUE,
          { evaluationId: id },
          { id, db: dbAdapter(tx) },
        ))
      )
        throw new Error("ANSWER_EVALUATION_QUEUE_RESTORE_FAILED");
      await tx.query(
        "UPDATE answer_evaluations SET state='queued',attempt_token=NULL,error_code=NULL,updated_at=now() WHERE id=$1",
        [id],
      );
      await tx.query(
        "INSERT INTO admin_audit_events(request_id,actor,action,target_id) VALUES($1,'admin','answer_evaluation.retry',$2)",
        [requestId, id],
      );
      return { evaluationId: id };
    });
  }
  private async citationIntegrity(
    answer: Awaited<ReturnType<AnswerService["get"]>>,
  ) {
    if (answer.state !== "completed" || !answer.answer) return false;
    try {
      const rows: Array<{ data: unknown }> = await this.db.query(
        "SELECT data FROM answer_events WHERE run_id=$1 AND kind='context' ORDER BY sequence",
        [answer.id],
      );
      const evidence = new Map<
          string,
          z.infer<typeof k.contextResult>["evidence"][number]
        >(),
        gaps = new Set<string>();
      for (const row of rows) {
        const context = k.contextResult.parse(row.data);
        if (
          context.releaseId !== answer.releaseId ||
          context.indexBuildId !== answer.indexBuildId
        )
          return false;
        for (const e of context.evidence) evidence.set(e.evidenceId, e);
        for (const gap of context.gaps) gaps.add(gap.ruleId);
        for (const e of evidence.values()) gaps.delete(e.ruleId);
      }
      const draft = {
        ...answer.answer,
        citations: answer.answer.citations.map(
          ({ evidenceId, quote, supports }) => ({
            evidenceId,
            quote,
            supports,
          }),
        ),
      };
      return isDeepStrictEqual(
        verifyAnswer(draft, evidence, gaps),
        answer.answer,
      );
    } catch {
      return false;
    }
  }
  private async claim(
    tx: EntityManager,
    id: string,
    token: string,
    signal: AbortSignal,
  ) {
    const [r] = await tx.query(
      "SELECT state,attempt_token FROM answer_evaluations WHERE id=$1 FOR UPDATE",
      [id],
    );
    if (
      signal.aborted ||
      !r ||
      r.state !== "running" ||
      r.attempt_token !== token
    )
      throw new RetrievalError(409, "STALE_ANSWER_EVALUATION_ATTEMPT");
  }
  async process(job: JobWithMetadata<EvalJob>) {
    const token = randomUUID();
    const row = await this.db.transaction(async (tx) => {
      const [r] = await tx.query(
        "SELECT * FROM answer_evaluations WHERE id=$1 FOR UPDATE",
        [job.data.evaluationId],
      );
      if (!r || r.id !== job.id)
        throw new Error("ANSWER_EVALUATION_JOB_NOT_FOUND");
      if (generated(r.state)) return null;
      await tx.query(
        "UPDATE answer_evaluations SET state='running',attempt_token=$2,attempts=attempts+1,error_code=NULL,updated_at=now() WHERE id=$1",
        [r.id, token],
      );
      return r;
    });
    if (!row) return;
    const signal = AbortSignal.any([
      AbortSignal.timeout(17000000),
      ...(job.signal ? [job.signal] : []),
    ]);
    try {
      const config = s.config.parse(row.config),
        identity = s.identity.parse(row.identity);
      const current = await this.answers.configuration(config.retrieval);
      if (
        identity.evaluatorVersion !== ANSWER_EVALUATOR_VERSION ||
        !isDeepStrictEqual(current.config, identity.answerConfig)
      )
        throw new RetrievalError(409, "ANSWER_EVALUATION_RUNTIME_MISMATCH");
      const dataset = await this.dataset(row.dataset_id),
        byId = new Map(dataset.manifest.cases.map((c) => [c.id, c]));
      const cases: CaseRow[] = await this.db.query(
        "SELECT * FROM answer_evaluation_cases WHERE evaluation_id=$1 AND outcome IS NULL ORDER BY case_id",
        [row.id],
      );
      for (const c of cases) {
        await this.db.transaction((tx) =>
          this.claim(tx, row.id, token, signal),
        );
        let answer = await this.answers.preview(
          c.request,
          randomUUID(),
          signal,
        );
        while (answer.state === "running") {
          await delay(1000, undefined, { signal });
          await this.db.transaction((tx) =>
            this.claim(tx, row.id, token, signal),
          );
          answer = await this.answers.get(c.execution_key);
        }
        if (!isDeepStrictEqual(answer.config, identity.answerConfig))
          throw new RetrievalError(409, "ANSWER_EVALUATION_RUNTIME_MISMATCH");
        const testCase = byId.get(c.case_id)!;
        const outcome = s.outcome.parse({
          automatic: automaticAnswerScore(
            testCase,
            answer.answer,
            answer.state === "completed" && answer.reasonCode === null,
            await this.citationIntegrity(answer),
          ),
          durationMs: Math.max(
            0,
            Date.parse(answer.finishedAt!) - Date.parse(answer.createdAt),
          ),
          usage: answer.usage,
          reasonCode: answer.reasonCode,
        });
        await this.db.transaction(async (tx) => {
          await this.claim(tx, row.id, token, signal);
          await tx.query(
            "UPDATE answer_evaluation_cases SET answer_run_id=$2,outcome=$3 WHERE id=$1",
            [c.id, answer.id, JSON.stringify(outcome)],
          );
        });
      }
      await this.db.transaction(async (tx) => {
        await this.claim(tx, row.id, token, signal);
        await tx.query(
          "UPDATE answer_evaluations SET state='awaiting_review',error_code=NULL,updated_at=now() WHERE id=$1",
          [row.id],
        );
      });
    } catch (error) {
      const code = failCode(error);
      await this.db.query(
        "UPDATE answer_evaluations SET state=$3,error_code=$4,updated_at=now() WHERE id=$1 AND attempt_token=$2 AND state='running'",
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
  async workOnce() {
    const jobs = await this.queue.fetch<EvalJob>(ANSWER_EVALUATION_QUEUE, {
      includeMetadata: true,
      batchSize: 1,
    });
    for (const job of jobs) {
      try {
        await this.process(job);
        await this.queue.complete(ANSWER_EVALUATION_QUEUE, job);
      } catch {
        await this.queue.fail(ANSWER_EVALUATION_QUEUE, job, {
          code: "ANSWER_EVALUATION_FAILED",
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
      ANSWER_EVALUATION_QUEUE,
      options,
      async (jobs) => {
        for (const job of jobs) await this.process(job);
      },
    );
  }
}
