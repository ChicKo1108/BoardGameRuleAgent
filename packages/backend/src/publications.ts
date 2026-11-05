import { isDeepStrictEqual } from "node:util";
import type { DataSource, EntityManager } from "typeorm";
import {
  publicationSchemas as s,
  answerEvaluationSchemas as ae,
  evaluationSchemas as e,
} from "@boardgame/contracts";
import { publicationGate } from "@boardgame/evaluations";
import { KnowledgeIndexService, RetrievalError } from "@boardgame/retrieval";
import type { AnswerService } from "./answers.ts";
const json = (value: unknown) => JSON.parse(JSON.stringify(value));
const fail = (code: string, status = 409) => new RetrievalError(status, code);
export class PublicationService {
  constructor(
    private readonly db: DataSource,
    private readonly answers: AnswerService | (() => Promise<AnswerService>),
  ) {}
  private async scope(
    id: string,
    tx: EntityManager = this.db.manager,
    lock = false,
  ) {
    if (
      !(
        await tx.query(
          `SELECT id FROM rulesets WHERE id=$1${lock ? " FOR UPDATE" : ""}`,
          [id],
        )
      ).length
    )
      throw fail("RULESET_NOT_FOUND", 404);
  }
  async head(rulesetId: string, tx: EntityManager = this.db.manager) {
    rulesetId = rulesetId.toLowerCase();
    await this.scope(rulesetId, tx);
    const [row] = await tx.query(
      `SELECT ruleset_id AS "rulesetId",revision,publication_id AS "publicationId",event_id AS "eventId" FROM publication_heads WHERE ruleset_id=$1`,
      [rulesetId],
    );
    return s.headResult.parse(
      row ?? { rulesetId, revision: 0, publicationId: null, eventId: null },
    );
  }
  async policy(id: string, tx: EntityManager = this.db.manager) {
    const [row] = await tx.query(
      `SELECT id,ruleset_id AS "rulesetId",dataset_id AS "datasetId",baseline_publication_id AS "baselinePublicationId",regression_publication_id AS "regressionPublicationId",baseline_revision AS "baselineRevision",config,note,policy_hash AS "policyHash",created_at AS "createdAt" FROM publication_policies WHERE id=$1`,
      [id],
    );
    if (!row) throw fail("PUBLICATION_POLICY_NOT_FOUND", 404);
    return s.policyResult.parse(json(row));
  }
  async get(id: string, tx: EntityManager = this.db.manager) {
    const [row] = await tx.query(
      `SELECT id,ruleset_id AS "rulesetId",release_id AS "releaseId",policy_id AS "policyId",answer_evaluation_id AS "answerEvaluationId",retrieval_run_id AS "retrievalRunId",manifest,manifest_hash AS "manifestHash",gate,passed,created_at AS "createdAt" FROM knowledge_publications WHERE id=$1`,
      [id],
    );
    if (!row) throw fail("PUBLICATION_NOT_FOUND", 404);
    return s.publicationResult.parse(json(row));
  }
  private async dataset(id: string, tx: EntityManager = this.db.manager) {
    const [row] = await tx.query(
      `SELECT id,release_id AS "releaseId",manifest,manifest_hash AS "manifestHash",created_at AS "createdAt" FROM eval_datasets WHERE id=$1`,
      [id],
    );
    if (!row) throw fail("EVAL_DATASET_NOT_FOUND", 404);
    return e.datasetResult.parse(json(row));
  }
  async createPolicy(rulesetId: string, raw: unknown, requestId: string) {
    rulesetId = rulesetId.toLowerCase();
    const input = s.policyInput.parse(raw);
    return this.db.transaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        input.idempotencyKey,
      ]);
      if (
        (
          await tx.query("SELECT id FROM publication_policies WHERE id=$1", [
            input.idempotencyKey,
          ])
        ).length
      ) {
        const old = await this.policy(input.idempotencyKey, tx);
        if (
          old.rulesetId !== rulesetId ||
          old.datasetId !== input.datasetId ||
          old.baselineRevision !== input.expectedRevision ||
          old.note !== input.note ||
          !isDeepStrictEqual(old.config, input.config)
        )
          throw fail("PUBLICATION_IDEMPOTENCY_CONFLICT");
        return old;
      }
      await this.scope(rulesetId, tx, true);
      const head = await this.head(rulesetId, tx);
      if (head.revision !== input.expectedRevision)
        throw fail("PUBLICATION_REVISION_CONFLICT");
      const dataset = await this.dataset(input.datasetId, tx),
        release = await new KnowledgeIndexService(this.db).release(
          dataset.releaseId,
        );
      if (release.rulesetId !== rulesetId)
        throw fail("PUBLICATION_SCOPE_MISMATCH", 422);
      if (!dataset.manifest.cases.some((c) => c.split === "holdout"))
        throw fail("PUBLICATION_HOLDOUT_EMPTY", 422);
      const [lastActive] = await tx.query(
        "SELECT publication_id FROM publication_events WHERE ruleset_id=$1 AND publication_id IS NOT NULL ORDER BY revision DESC LIMIT 1",
        [rulesetId],
      );
      await tx.query(
        "INSERT INTO publication_policies(id,ruleset_id,dataset_id,baseline_publication_id,baseline_revision,config,note,regression_publication_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
        [
          input.idempotencyKey,
          rulesetId,
          input.datasetId,
          head.publicationId,
          head.revision,
          JSON.stringify(input.config),
          input.note,
          lastActive?.publication_id ?? null,
        ],
      );
      await this.audit(
        tx,
        requestId,
        "publication.policy",
        input.idempotencyKey,
      );
      return this.policy(input.idempotencyKey, tx);
    });
  }
  private audit(
    tx: EntityManager,
    requestId: string,
    action: string,
    targetId: string,
  ) {
    return tx.query(
      "INSERT INTO admin_audit_events(request_id,actor,action,target_id) VALUES($1,'admin',$2,$3)",
      [requestId, action, targetId],
    );
  }
  async assess(raw: unknown, requestId: string) {
    const input = s.assessmentInput.parse(raw);
    return this.db.transaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        input.idempotencyKey,
      ]);
      if (
        (
          await tx.query("SELECT id FROM knowledge_publications WHERE id=$1", [
            input.idempotencyKey,
          ])
        ).length
      ) {
        const old = await this.get(input.idempotencyKey, tx);
        if (
          old.policyId !== input.policyId ||
          old.answerEvaluationId !== input.answerEvaluationId ||
          old.retrievalRunId !== input.retrievalRunId
        )
          throw fail("PUBLICATION_IDEMPOTENCY_CONFLICT");
        return old;
      }
      const policy = await this.policy(input.policyId, tx),
        dataset = await this.dataset(policy.datasetId, tx);
      const [ar] = await tx.query(
        "SELECT * FROM answer_evaluations WHERE id=$1",
        [input.answerEvaluationId],
      );
      const [rr] = await tx.query("SELECT * FROM eval_runs WHERE id=$1", [
        input.retrievalRunId,
      ]);
      if (!ar || !rr) throw fail("PUBLICATION_EVALUATION_NOT_FOUND", 404);
      if (
        ar.dataset_id !== dataset.id ||
        rr.dataset_id !== dataset.id ||
        ar.release_id !== dataset.releaseId ||
        rr.release_id !== dataset.releaseId
      )
        throw fail("PUBLICATION_SCOPE_MISMATCH", 422);
      if (
        ar.state !== "sealed" ||
        !["completed", "completed_with_errors"].includes(rr.state)
      )
        throw fail("PUBLICATION_EVALUATION_INCOMPLETE");
      if (ar.config.split !== "holdout" || rr.config.split !== "holdout")
        throw fail("PUBLICATION_REQUIRES_HOLDOUT", 422);
      const [{ timely }] = await tx.query(
        "SELECT p.created_at<=a.created_at AND p.created_at<=r.created_at AS timely FROM publication_policies p,answer_evaluations a,eval_runs r WHERE p.id=$1 AND a.id=$2 AND r.id=$3",
        [policy.id, ar.id, rr.id],
      );
      if (!timely) throw fail("PUBLICATION_POLICY_TOO_LATE", 422);
      const answer = ae.sealedReport.parse(ar.report),
        retrievalConfig = e.runConfig.parse(rr.config),
        retrievalReport = e.reportSchema.parse(rr.report),
        retrievalIdentity = e.identitySchema.parse(rr.identity);
      const desired = answer.config.retrieval;
      const { maxRules, maxChars, ...searchConfig } = desired;
      if (
        !isDeepStrictEqual(
          {
            ...searchConfig,
            split: "holdout",
            context: { maxRules, maxChars },
          },
          retrievalConfig,
        )
      )
        throw fail("PUBLICATION_RETRIEVAL_CONFIG_MISMATCH", 422);
      const release = await new KnowledgeIndexService(this.db).release(
        dataset.releaseId,
      );
      if (
        answer.identity.datasetHash !== dataset.manifestHash ||
        retrievalIdentity.datasetHash !== dataset.manifestHash ||
        answer.identity.releaseHash !== release.manifestHash ||
        retrievalIdentity.releaseHash !== release.manifestHash ||
        retrievalIdentity.indexConfigHash !==
          answer.identity.answerConfig.indexConfigHash ||
        retrievalIdentity.embeddingProfileHash !==
          answer.identity.answerConfig.embeddingProfileHash ||
        retrievalIdentity.nodeVersion !==
          answer.identity.answerConfig.nodeVersion
      )
        throw fail("PUBLICATION_EVALUATION_IDENTITY_MISMATCH", 422);
      let baseline;
      if (policy.regressionPublicationId) {
        const old = await this.get(policy.regressionPublicationId, tx),
          oldDataset = await this.dataset(old.manifest.policy.datasetId, tx);
        baseline = {
          cases: oldDataset.manifest.cases.filter((c) => c.split === "holdout"),
          summary: old.manifest.answerSummary,
        };
      }
      const gate = publicationGate(
        policy.config,
        dataset.manifest.cases.filter((c) => c.split === "holdout"),
        answer.summary,
        retrievalReport,
        baseline,
      );
      if (
        !/^[0-9a-f]{40}$/i.test(
          answer.identity.answerConfig.buildRevision ?? "",
        )
      ) {
        gate.failures.push("BUILD_REVISION_REQUIRED");
        gate.passed = false;
      }
      const manifest = s.manifest.parse({
        schemaVersion: 1,
        policy,
        releaseId: release.id,
        releaseHash: release.manifestHash,
        datasetHash: dataset.manifestHash,
        retrieval: desired,
        answerConfig: answer.identity.answerConfig,
        answerEvaluationId: ar.id,
        answerReportHash: ar.report_hash,
        answerSummary: answer.summary,
        retrievalRunId: rr.id,
        retrievalIdentity,
        retrievalReport,
      });
      await tx.query(
        "INSERT INTO knowledge_publications(id,ruleset_id,release_id,policy_id,answer_evaluation_id,retrieval_run_id,manifest,gate,passed) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
        [
          input.idempotencyKey,
          policy.rulesetId,
          release.id,
          policy.id,
          ar.id,
          rr.id,
          JSON.stringify(manifest),
          JSON.stringify(gate),
          gate.passed,
        ],
      );
      await this.audit(
        tx,
        requestId,
        "publication.assess",
        input.idempotencyKey,
      );
      return this.get(input.idempotencyKey, tx);
    });
  }
  private async runtime(
    publication: Awaited<ReturnType<PublicationService["get"]>>,
  ) {
    const answers =
      typeof this.answers === "function" ? await this.answers() : this.answers;
    const runtime = await answers.configuration(publication.manifest.retrieval);
    if (!isDeepStrictEqual(runtime.config, publication.manifest.answerConfig))
      throw fail("PUBLICATION_RUNTIME_MISMATCH");
  }
  async transition(rulesetId: string, raw: unknown, requestId: string) {
    rulesetId = rulesetId.toLowerCase();
    const input = s.transitionInput.parse(raw);
    return this.db.transaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        input.idempotencyKey,
      ]);
      const [existing] = await tx.query(
        "SELECT * FROM publication_events WHERE id=$1",
        [input.idempotencyKey],
      );
      if (existing) {
        if (
          existing.ruleset_id !== rulesetId ||
          existing.revision !== input.expectedRevision + 1 ||
          existing.action !== input.action ||
          existing.publication_id !== input.publicationId ||
          existing.note !== input.note
        )
          throw fail("PUBLICATION_IDEMPOTENCY_CONFLICT");
        return this.event(input.idempotencyKey, tx);
      }
      await this.scope(rulesetId, tx, true);
      const head = await this.head(rulesetId, tx);
      if (head.revision !== input.expectedRevision)
        throw fail("PUBLICATION_REVISION_CONFLICT");
      if (input.publicationId) {
        const publication = await this.get(input.publicationId, tx);
        if (publication.rulesetId !== rulesetId)
          throw fail("PUBLICATION_SCOPE_MISMATCH", 422);
        if (!publication.passed) throw fail("PUBLICATION_GATE_FAILED");
        if (publication.id === head.publicationId)
          throw fail("PUBLICATION_ALREADY_ACTIVE");
        if (
          input.action === "publish" &&
          (publication.manifest.policy.baselineRevision !== head.revision ||
            publication.manifest.policy.baselinePublicationId !==
              head.publicationId)
        )
          throw fail("PUBLICATION_BASELINE_CHANGED");
        if (
          input.action === "rollback" &&
          !(
            await tx.query(
              "SELECT id FROM publication_events WHERE ruleset_id=$1 AND publication_id=$2 AND action IN ('publish','rollback') LIMIT 1",
              [rulesetId, publication.id],
            )
          ).length
        )
          throw fail("PUBLICATION_NOT_PREVIOUSLY_ACTIVE");
        await this.runtime(publication);
      } else if (!head.publicationId) throw fail("PUBLICATION_NOT_ACTIVE");
      await tx.query(
        "INSERT INTO publication_events(id,ruleset_id,revision,action,publication_id,previous_publication_id,note) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [
          input.idempotencyKey,
          rulesetId,
          head.revision + 1,
          input.action,
          input.publicationId,
          head.publicationId,
          input.note,
        ],
      );
      await this.audit(
        tx,
        requestId,
        `publication.${input.action}`,
        input.idempotencyKey,
      );
      return this.event(input.idempotencyKey, tx);
    });
  }
  private async event(id: string, tx: EntityManager = this.db.manager) {
    const [row] = await tx.query(
      `SELECT id,ruleset_id AS "rulesetId",revision,action,publication_id AS "publicationId",previous_publication_id AS "previousPublicationId",note,created_at AS "createdAt" FROM publication_events WHERE id=$1`,
      [id],
    );
    return s.eventResult.parse(json(row));
  }
  async history(rulesetId: string, page = { limit: 25, offset: 0 }) {
    await this.scope(rulesetId);
    const [{ total }] = await this.db.query(
      "SELECT count(*)::int AS total FROM publication_events WHERE ruleset_id=$1",
      [rulesetId],
    );
    const rows: Array<{ id: string }> = await this.db.query(
      "SELECT id FROM publication_events WHERE ruleset_id=$1 ORDER BY revision DESC LIMIT $2 OFFSET $3",
      [rulesetId, page.limit, page.offset],
    );
    return {
      items: await Promise.all(rows.map((r) => this.event(r.id))),
      total,
      ...page,
    };
  }
  // Internal boundary for future public sessions: callers pin this entire snapshot once per answer.
  async resolve(rulesetId: string) {
    const head = await this.head(rulesetId);
    if (!head.publicationId) throw fail("KNOWLEDGE_NOT_PUBLISHED", 503);
    const publication = await this.get(head.publicationId);
    await this.runtime(publication);
    return { head, publication };
  }
}
