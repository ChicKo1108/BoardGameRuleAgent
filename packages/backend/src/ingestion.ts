import { randomUUID } from "node:crypto";
import { PgBoss, type JobWithMetadata } from "pg-boss";
import type { DataSource } from "typeorm";
import {
  DocumentRevisionEntity,
  SourceDocumentEntity,
  KnowledgeRepository,
} from "@boardgame/db";
import { sha256, type BlobStore } from "./storage.ts";
import {
  parserConfigSchema,
  parserResultSchema,
  ParseError,
  type PdfParser,
} from "./parser.ts";
export const PARSE_QUEUE = "parse-document-v1";
export const RETRIES = 2;
export async function connectQueue(url: string, setup = false) {
  const queue = new PgBoss({
    connectionString: url,
    schema: "boardgame_queue",
    migrate: setup,
    supervise: true,
    schedule: false,
  });
  queue.on("error", () =>
    console.error(JSON.stringify({ event: "queue_error" })),
  );
  try {
    await queue.start();
    if (setup)
      await queue.createQueue(PARSE_QUEUE, {
        retryLimit: RETRIES,
        retryDelay: 2,
        retryBackoff: true,
        expireInSeconds: 180,
        retentionSeconds: 86400,
        deleteAfterSeconds: 604800,
      });
    return queue;
  } catch (error) {
    await queue.stop();
    throw error;
  }
}
export class IngestionError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}
interface JobData {
  revisionId: string;
}
export class IngestionService {
  constructor(
    readonly db: DataSource,
    readonly queue: PgBoss,
    readonly store: BlobStore,
    readonly parser: PdfParser,
  ) {}
  async upload(documentId: string, bytes: Buffer, requestId: string) {
    const doc = await this.db
      .getRepository(SourceDocumentEntity)
      .findOneBy({ id: documentId });
    if (!doc) throw new IngestionError(404, "NOT_FOUND");
    if (!bytes.subarray(0, 5).equals(Buffer.from("%PDF-")))
      throw new IngestionError(422, "INVALID_PDF_HEADER");
    if (bytes.length > 20 * 1024 * 1024)
      throw new IngestionError(413, "BODY_TOO_LARGE");
    if (sha256(bytes) !== doc.sha256)
      throw new IngestionError(422, "HASH_MISMATCH");
    await this.store.put(doc.objectKey, bytes);
    await this.db.transaction(async (tx) => {
      const inserted = await tx.query(
        "INSERT INTO stored_documents(document_id,byte_size) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING document_id",
        [documentId, bytes.length],
      );
      if (inserted.length)
        await tx.query(
          "INSERT INTO admin_audit_events(request_id,actor,action,target_id) VALUES ($1,'admin','document.upload',$2)",
          [requestId, documentId],
        );
    });
    return { documentId, byteSize: bytes.length, sha256: doc.sha256 };
  }
  async download(documentId: string) {
    const doc = await this.db
      .getRepository(SourceDocumentEntity)
      .findOneBy({ id: documentId });
    if (
      !doc ||
      !(
        await this.db.query(
          "SELECT 1 FROM stored_documents WHERE document_id=$1",
          [documentId],
        )
      ).length
    )
      throw new IngestionError(404, "FILE_NOT_FOUND");
    const bytes = await this.store.get(doc.objectKey);
    if (sha256(bytes) !== doc.sha256)
      throw new IngestionError(500, "STORED_OBJECT_CORRUPTED");
    return bytes;
  }
  async enqueue(revisionId: string, requestId: string) {
    return this.db.transaction(async (tx) => {
      const revision = await tx.getRepository(DocumentRevisionEntity).findOne({
        where: { id: revisionId },
        lock: { mode: "pessimistic_write" },
      });
      if (!revision) throw new IngestionError(404, "NOT_FOUND");
      const existing = await tx.query(
        "SELECT id FROM ingestion_jobs WHERE revision_id=$1",
        [revisionId],
      );
      if (existing.length) return { jobId: existing[0].id };
      if (revision.status !== "uploaded")
        throw new IngestionError(409, "REVISION_NOT_PARSEABLE");
      if (
        !(
          await tx.query(
            "SELECT 1 FROM stored_documents WHERE document_id=$1",
            [revision.documentId],
          )
        ).length
      )
        throw new IngestionError(409, "FILE_NOT_UPLOADED");
      const config = parserConfigSchema.parse(revision.parserConfig);
      const id = randomUUID();
      await tx.query(
        "INSERT INTO ingestion_jobs(id,revision_id,state,config) VALUES ($1,$2,'queued',$3)",
        [id, revisionId, JSON.stringify(config)],
      );
      const sent = await this.queue.send(
        PARSE_QUEUE,
        { revisionId },
        {
          id,
          db: {
            executeSql: async (text, values) => ({
              rows: await tx.query(text, values),
            }),
          },
        },
      );
      if (!sent) throw new Error("QUEUE_ENQUEUE_FAILED");
      await tx.query(
        "INSERT INTO admin_audit_events(request_id,actor,action,target_id) VALUES ($1,'admin','parse.enqueue',$2)",
        [requestId, revisionId],
      );
      return { jobId: id };
    });
  }
  async job(id: string) {
    const rows = await this.db.query(
      "SELECT id,revision_id,state,attempts,error_code,created_at,updated_at FROM ingestion_jobs WHERE id=$1",
      [id],
    );
    if (!rows.length) throw new IngestionError(404, "NOT_FOUND");
    const queued = await this.queue.getJobById(PARSE_QUEUE, id);
    const job = rows[0];
    // Reconcile worker crashes/timeouts without falsely advertising an abandoned attempt as running.
    if (queued && job.state !== "succeeded" && job.state !== "failed")
      job.state =
        queued.state === "failed"
          ? "failed"
          : queued.state === "retry"
            ? "retrying"
            : job.state;
    return { ...job, queueState: queued?.state ?? null };
  }
  async retry(id: string, requestId: string) {
    const observed = await this.job(id);
    if (observed.state !== "failed")
      throw new IngestionError(409, "JOB_NOT_FAILED");
    return this.db.transaction(async (tx) => {
      const rev = await tx.getRepository(DocumentRevisionEntity).findOne({
        where: { id: observed.revision_id },
        lock: { mode: "pessimistic_write" },
      });
      if (!rev || !["uploaded", "parsing"].includes(rev.status))
        throw new IngestionError(409, "REVISION_NOT_PARSEABLE");
      const rows = await tx.query(
        "SELECT * FROM ingestion_jobs WHERE id=$1 FOR UPDATE",
        [id],
      );
      if (!["failed", "running", "retrying"].includes(rows[0].state))
        throw new IngestionError(409, "JOB_NOT_FAILED");
      // pg-boss fences completions by retryCount; the domain task additionally fences writes by attempt_token.
      const queueJob = await this.queue.getJobById(PARSE_QUEUE, id, {
        db: {
          executeSql: async (text, values) => ({
            rows: await tx.query(text, values),
          }),
        },
      });
      if (!queueJob || queueJob.state !== "failed")
        throw new IngestionError(409, "JOB_NOT_FAILED");
      await this.queue.retry(PARSE_QUEUE, id, {
        db: {
          executeSql: async (text, values) => ({
            rows: await tx.query(text, values),
          }),
        },
      });

      await tx.query(
        "UPDATE ingestion_jobs SET state='queued',attempt_token=NULL,error_code=NULL,updated_at=now() WHERE id=$1",
        [id],
      );
      await tx.query(
        "INSERT INTO admin_audit_events(request_id,actor,action,target_id) VALUES ($1,'admin','parse.retry',$2)",
        [requestId, id],
      );
      return { jobId: id };
    });
  }
  async result(revisionId: string) {
    const rows = await this.db.query(
      "SELECT * FROM parse_results WHERE revision_id=$1",
      [revisionId],
    );
    if (!rows.length) throw new IngestionError(404, "PARSE_RESULT_NOT_FOUND");
    const data = await this.store.get(rows[0].object_key);
    if (sha256(data) !== rows[0].object_key.split("/")[1].split(".")[0])
      throw new Error("STORED_OBJECT_CORRUPTED");
    return parserResultSchema.parse(JSON.parse(data.toString("utf8")));
  }
  async acknowledge(revisionId: string, note: string, requestId: string) {
    return this.db.transaction(async (tx) => {
      const rev = await tx.getRepository(DocumentRevisionEntity).findOne({
        where: { id: revisionId },
        lock: { mode: "pessimistic_write" },
      });
      if (!rev || rev.status !== "awaiting_review")
        throw new IngestionError(409, "REVISION_NOT_REVIEWABLE");
      const rows = await tx.query(
        "INSERT INTO parse_reviews(revision_id,note,actor) VALUES ($1,$2,'admin') ON CONFLICT DO NOTHING RETURNING revision_id",
        [revisionId, note],
      );
      if (rows.length)
        await tx.query(
          "INSERT INTO admin_audit_events(request_id,actor,action,target_id,details) VALUES ($1,'admin','parse.review',$2,$3)",
          [requestId, revisionId, JSON.stringify({ note })],
        );
      return { revisionId, acknowledged: true };
    });
  }
  async process(job: JobWithMetadata<JobData>) {
    const token = randomUUID();
    const start = await this.db.transaction(async (tx) => {
      const revision = await tx.getRepository(DocumentRevisionEntity).findOne({
        where: { id: job.data.revisionId },
        lock: { mode: "pessimistic_write" },
      });
      const rows = await tx.query(
        "SELECT * FROM ingestion_jobs WHERE id=$1 FOR UPDATE",
        [job.id],
      );
      if (!revision || !rows.length) throw new Error("JOB_NOT_FOUND");
      const record = rows[0];
      if (record.state === "succeeded") return null;
      if (!["uploaded", "parsing"].includes(revision.status))
        throw new Error("REVISION_NOT_PARSEABLE");
      await tx
        .getRepository(DocumentRevisionEntity)
        .update(revision.id, { status: "parsing" });
      await tx.query(
        "UPDATE ingestion_jobs SET state='running',attempt_token=$2,attempts=attempts+1,error_code=NULL,updated_at=now() WHERE id=$1",
        [job.id, token],
      );
      const doc = await tx
        .getRepository(SourceDocumentEntity)
        .findOneByOrFail({ id: revision.documentId });
      return { doc, config: parserConfigSchema.parse(record.config) };
    });
    if (!start) return;
    try {
      const bytes = await this.download(start.doc.id);
      const parsed = await this.parser.parse(bytes, start.config, job.signal);
      if (job.signal?.aborted) throw new ParseError("PARSE_ABORTED", true);
      const result = parserResultSchema.parse(parsed);
      const output = Buffer.from(JSON.stringify(result));
      const key = `parses/${sha256(output)}.json`;
      await this.store.put(key, output);
      await this.db.transaction(async (tx) => {
        await tx.query(
          "SELECT id FROM document_revisions WHERE id=$1 FOR UPDATE",
          [job.data.revisionId],
        );
        const row = (
          await tx.query(
            "SELECT * FROM ingestion_jobs WHERE id=$1 FOR UPDATE",
            [job.id],
          )
        )[0];
        if (row.attempt_token !== token || job.signal?.aborted)
          throw new ParseError("STALE_ATTEMPT", true);
        await new KnowledgeRepository(tx).saveParsedBlocks(
          job.data.revisionId,
          result.blocks,
        );
        await tx.query(
          "INSERT INTO parse_results(revision_id,job_id,object_key,pipeline_version,parser_version,warnings) VALUES ($1,$2,$3,$4,$5,$6)",
          [
            job.data.revisionId,
            job.id,
            key,
            result.pipelineVersion,
            result.parserVersion,
            JSON.stringify(result.warnings),
          ],
        );
        await tx.query(
          "UPDATE ingestion_jobs SET state='succeeded',error_code=NULL,updated_at=now() WHERE id=$1",
          [job.id],
        );
      });
    } catch (error) {
      const code =
        error instanceof ParseError ? error.code : "PARSE_INFRASTRUCTURE_ERROR";
      const state = job.retryCount < job.retryLimit ? "retrying" : "failed";
      await this.db.query(
        "UPDATE ingestion_jobs SET state=$3,error_code=$4,updated_at=now() WHERE id=$1 AND attempt_token=$2 AND state<>'succeeded'",
        [job.id, token, state, code],
      );
      throw new Error(code);
    }
  }
  async workOnce() {
    const jobs = await this.queue.fetch<JobData>(PARSE_QUEUE, {
      includeMetadata: true,
      batchSize: 1,
    });
    for (const job of jobs) {
      try {
        await this.process(job);
        await this.queue.complete(PARSE_QUEUE, job);
      } catch (error) {
        await this.queue.fail(PARSE_QUEUE, job, {
          code: error instanceof Error ? error.message : "PARSE_FAILED",
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
    await this.queue.work<JobData, void, typeof options>(
      PARSE_QUEUE,
      options,
      async (jobs) => {
        for (const job of jobs) await this.process(job);
      },
    );
  }
}
