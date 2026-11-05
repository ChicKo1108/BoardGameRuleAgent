import { createHash, randomUUID } from "node:crypto";
import type { DataSource, EntityManager } from "typeorm";
import {
  curationSchemas as s,
  evaluationSchemas as e,
} from "@boardgame/contracts";
import { RetrievalError } from "@boardgame/retrieval";
import { KnowledgeRepository } from "@boardgame/db";
import type { EvaluationService } from "./evaluations.ts";
import type { z } from "zod";
const json = (v: unknown) => JSON.parse(JSON.stringify(v));
const stable = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(stable)
    : v && typeof v === "object"
      ? Object.fromEntries(
          Object.entries(v)
            .sort(([a], [b]) => a.localeCompare(b, "en"))
            .map(([k, v]) => [k, stable(v)]),
        )
      : v;
export const curationHash = (v: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(stable(v)))
    .digest("hex");
export function curationSourceFingerprint(raw: unknown) {
  return curationHash({
    fingerprintVersion: "curation-source-v1",
    source: s.source.parse(raw),
  });
}
export class CurationService {
  constructor(private readonly db: DataSource) {}
  async template(id: string, tx: EntityManager = this.db.manager) {
    const [revision] = await tx.query(
      "SELECT r.id,r.parser_config,d.sha256,p.pipeline_version,p.parser_version FROM document_revisions r JOIN source_documents d ON d.id=r.document_id LEFT JOIN parse_results p ON p.revision_id=r.id WHERE r.id=$1",
      [id],
    );
    if (!revision) throw new RetrievalError(404, "REVISION_NOT_FOUND");
    const blocks = await tx.query(
      `SELECT ordinal,kind,raw_text AS "rawText",pdf_page_index AS "pdfPageIndex",printed_page_label AS "printedPageLabel",bbox FROM source_blocks WHERE revision_id=$1 ORDER BY ordinal`,
      [id],
    );
    if (!blocks.length)
      throw new RetrievalError(409, "CURATION_SOURCE_NOT_PARSED");
    const source = s.source.parse({
      documentSha256: revision.sha256,
      parserConfig: revision.parser_config,
      pipelineVersion: revision.pipeline_version ?? "structured-import-v1",
      parserVersion: revision.parser_version ?? null,
      blocks,
    });
    return s.template.parse({
      revisionId: id,
      sourceFingerprint: curationSourceFingerprint(source),
      source,
    });
  }
  async get(id: string, tx: EntityManager = this.db.manager) {
    const [row] = await tx.query(
      `SELECT id,revision_id AS "revisionId",source_fingerprint AS "sourceFingerprint",bundle_hash AS "bundleHash",bundle,rule_map AS "ruleMap",created_at AS "createdAt" FROM curation_imports WHERE id=$1`,
      [id],
    );
    if (!row) throw new RetrievalError(404, "CURATION_IMPORT_NOT_FOUND");
    return s.importResult.parse(json(row));
  }
  async import(revisionId: string, raw: unknown, requestId: string) {
    revisionId = revisionId.toLowerCase();
    const input = s.importInput.parse(raw);
    if (Buffer.byteLength(JSON.stringify(input.bundle)) > 900000)
      throw new RetrievalError(413, "CURATION_BUNDLE_TOO_LARGE");
    const hash = curationHash(input.bundle);
    return this.db.transaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,13))", [
        input.idempotencyKey,
      ]);
      const [old] = await tx.query(
        "SELECT id,revision_id,bundle_hash FROM curation_imports WHERE id=$1",
        [input.idempotencyKey],
      );
      if (old) {
        if (old.revision_id !== revisionId || old.bundle_hash !== hash)
          throw new RetrievalError(409, "CURATION_IDEMPOTENCY_CONFLICT");
        return this.get(old.id, tx);
      }
      const [revision] = await tx.query(
        "SELECT status FROM document_revisions WHERE id=$1 FOR UPDATE",
        [revisionId],
      );
      if (!revision) throw new RetrievalError(404, "REVISION_NOT_FOUND");
      if (revision.status !== "awaiting_review")
        throw new RetrievalError(409, "CURATION_REVISION_NOT_EDITABLE");
      if (
        (
          await tx.query(
            "SELECT id FROM rule_units WHERE revision_id=$1 LIMIT 1",
            [revisionId],
          )
        ).length
      )
        throw new RetrievalError(409, "CURATION_REQUIRES_EMPTY_REVISION");
      const template = await this.template(revisionId, tx);
      if (template.sourceFingerprint !== input.bundle.sourceFingerprint)
        throw new RetrievalError(422, "CURATION_SOURCE_MISMATCH");
      const blocks: Array<{ id: string; ordinal: number }> = await tx.query(
          "SELECT id,ordinal FROM source_blocks WHERE revision_id=$1",
          [revisionId],
        ),
        byOrdinal = new Map(blocks.map((b) => [b.ordinal, b.id]));
      for (const rule of input.bundle.rules)
        if (rule.sourceOrdinals.some((o) => !byOrdinal.has(o)))
          throw new RetrievalError(422, "CURATION_SOURCE_ORDINAL_MISSING");
      const repo = new KnowledgeRepository(tx),
        ruleMap: Record<string, string> = Object.create(null);
      for (const rule of input.bundle.rules) {
        const created = await repo.addRule(
          {
            revisionId,
            kind: rule.kind,
            reviewedText: rule.reviewedText,
            sectionPath: rule.sectionPath,
            applicability: rule.applicability,
            explanation: rule.explanation,
            reviewStatus: "pending",
          },
          rule.sourceOrdinals.map((o) => byOrdinal.get(o)!),
        );
        ruleMap[rule.alias] = created.id;
      }
      for (const relation of input.bundle.relations)
        await tx.query(
          "INSERT INTO rule_relations(revision_id,from_rule_id,to_rule_id,kind) VALUES($1,$2,$3,$4)",
          [
            revisionId,
            ruleMap[relation.from],
            ruleMap[relation.to],
            relation.kind,
          ],
        );
      await tx.query(
        "INSERT INTO curation_imports(id,revision_id,source_fingerprint,bundle_hash,bundle,rule_map) VALUES($1,$2,$3,$4,$5,$6)",
        [
          input.idempotencyKey,
          revisionId,
          template.sourceFingerprint,
          hash,
          JSON.stringify(input.bundle),
          JSON.stringify(ruleMap),
        ],
      );
      await tx.query(
        "INSERT INTO admin_audit_events(request_id,actor,action,target_id) VALUES($1,'admin','curation.import',$2)",
        [requestId, input.idempotencyKey],
      );
      return this.get(input.idempotencyKey, tx);
    });
  }
  async annotationReviews(id: string, page = { limit: 25, offset: 0 }) {
    await this.get(id);
    const [{ total }] = await this.db.query(
      "SELECT count(*)::int AS total FROM curation_dataset_reviews WHERE import_id=$1",
      [id],
    );
    const rows = await this.db.query(
      `SELECT dataset_id AS "datasetId",note,request_id AS "requestId",created_at AS "createdAt" FROM curation_dataset_reviews WHERE import_id=$1 ORDER BY created_at,dataset_id LIMIT $2 OFFSET $3`,
      [id, page.limit, page.offset],
    );
    return {
      items: rows.map((r: unknown) => s.annotationReviewResult.parse(json(r))),
      total,
      ...page,
    };
  }
  async materialize(
    id: string,
    raw: unknown,
    requestId: string,
    evaluations: EvaluationService,
  ) {
    const input = s.materializeInput.parse(raw);
    return this.db.transaction(async (tx) => {
      const imported = await this.get(id, tx),
        [release] = await tx.query(
          "SELECT id FROM knowledge_releases WHERE id=$1 AND state='sealed' FOR UPDATE",
          [input.releaseId],
        );
      if (!release) throw new RetrievalError(404, "RELEASE_NOT_FOUND");
      if (
        !(
          await tx.query(
            "SELECT 1 FROM release_revisions WHERE release_id=$1 AND revision_id=$2",
            [input.releaseId, imported.revisionId],
          )
        ).length
      )
        throw new RetrievalError(422, "CURATION_RELEASE_MISMATCH");
      if (!imported.bundle.cases.length)
        throw new RetrievalError(422, "CURATION_CASES_EMPTY");
      const cases = imported.bundle.cases.map((c) => {
        const { acceptableEvidenceAliases, ...rest } = c;
        return e.evalCase.parse({
          ...rest,
          acceptableEvidenceSets: acceptableEvidenceAliases.map((set) =>
            set.map((alias) => imported.ruleMap[alias]),
          ),
        });
      });
      const dataset = await evaluations.createDataset(
        input.releaseId,
        { name: input.name, revision: input.revision, cases },
        requestId,
        tx,
      );
      const [review] = await tx.query(
        "SELECT note FROM curation_dataset_reviews WHERE import_id=$1 AND dataset_id=$2",
        [id, dataset.id],
      );
      if (review && review.note !== input.annotationReviewNote)
        throw new RetrievalError(409, "CURATION_ANNOTATION_REVIEW_CONFLICT");
      await tx.query(
        "INSERT INTO curation_dataset_reviews(import_id,dataset_id,note,request_id) VALUES($1,$2,$3,$4) ON CONFLICT(import_id,dataset_id) DO NOTHING",
        [id, dataset.id, input.annotationReviewNote, requestId],
      );
      return dataset;
    });
  }
}
