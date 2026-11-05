import type { MigrationInterface, QueryRunner } from "typeorm";
export class PdfIngestion1793836802000 implements MigrationInterface {
  name = "PdfIngestion1793836802000";
  async up(q: QueryRunner) {
    await q.query(`
 CREATE TABLE stored_documents(document_id uuid PRIMARY KEY REFERENCES source_documents(id),byte_size integer NOT NULL CHECK(byte_size>0),created_at timestamptz NOT NULL DEFAULT now());
 CREATE TABLE ingestion_jobs(
   id uuid PRIMARY KEY,revision_id uuid NOT NULL UNIQUE REFERENCES document_revisions(id),
   state text NOT NULL CHECK(state IN ('queued','running','retrying','succeeded','failed')),
   config jsonb NOT NULL,attempt_token uuid,attempts integer NOT NULL DEFAULT 0,error_code text,
   created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
 );
 CREATE TABLE parse_results(
   revision_id uuid PRIMARY KEY REFERENCES document_revisions(id),job_id uuid NOT NULL UNIQUE REFERENCES ingestion_jobs(id),
   object_key text NOT NULL,pipeline_version text NOT NULL,parser_version text NOT NULL,
   warnings jsonb NOT NULL CHECK(jsonb_typeof(warnings)='array'),created_at timestamptz NOT NULL DEFAULT now()
 );
 CREATE TABLE parse_reviews(revision_id uuid PRIMARY KEY REFERENCES parse_results(revision_id),note text NOT NULL CHECK(length(trim(note))>=10),actor text NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
 CREATE FUNCTION guard_parser_review() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN
   IF NEW.status='approved' AND EXISTS(SELECT 1 FROM parse_results p WHERE p.revision_id=NEW.id AND jsonb_array_length(p.warnings)>0 AND NOT EXISTS(SELECT 1 FROM parse_reviews r WHERE r.revision_id=p.revision_id)) THEN
     RAISE EXCEPTION 'Parser findings require review' USING ERRCODE='23514';
   END IF; RETURN NEW;
 END $$;
 CREATE TRIGGER parser_review_guard BEFORE UPDATE ON document_revisions FOR EACH ROW EXECUTE FUNCTION guard_parser_review();
 CREATE TRIGGER parse_results_guard BEFORE UPDATE OR DELETE ON parse_results FOR EACH ROW EXECUTE FUNCTION guard_source_document();
 CREATE TRIGGER parse_reviews_guard BEFORE UPDATE OR DELETE ON parse_reviews FOR EACH ROW EXECUTE FUNCTION guard_source_document();
 `);
  }
  async down(q: QueryRunner) {
    await q.query(
      `DROP TRIGGER parser_review_guard ON document_revisions;DROP FUNCTION guard_parser_review();DROP TABLE parse_reviews,parse_results,ingestion_jobs,stored_documents;`,
    );
  }
}
