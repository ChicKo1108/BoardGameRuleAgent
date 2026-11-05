import type { MigrationInterface, QueryRunner } from "typeorm";
export class KnowledgeCuration1793836812000 implements MigrationInterface {
  name = "KnowledgeCuration1793836812000";
  async up(q: QueryRunner) {
    await q.query(`
 CREATE TABLE curation_imports(id uuid PRIMARY KEY,revision_id uuid NOT NULL UNIQUE REFERENCES document_revisions(id),source_fingerprint text NOT NULL,bundle_hash text NOT NULL,bundle jsonb NOT NULL,rule_map jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
 CREATE TABLE curation_dataset_reviews(import_id uuid NOT NULL REFERENCES curation_imports(id),dataset_id uuid NOT NULL REFERENCES eval_datasets(id),note text NOT NULL CHECK(length(trim(note))>=10),request_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(import_id,dataset_id));
 CREATE FUNCTION guard_curation_record() RETURNS trigger LANGUAGE plpgsql AS $$
 DECLARE pair record;
 BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Curation provenance and reviews are immutable' USING ERRCODE='23514';END IF;
 IF TG_TABLE_NAME='curation_imports' THEN
 IF NOT EXISTS(SELECT 1 FROM document_revisions WHERE id=NEW.revision_id AND status='awaiting_review') OR (SELECT count(*) FROM jsonb_each_text(NEW.rule_map))<>jsonb_array_length(NEW.bundle->'rules') THEN RAISE EXCEPTION 'Curation mapping must cover the draft rules' USING ERRCODE='23514';END IF;
 FOR pair IN SELECT * FROM jsonb_each_text(NEW.rule_map) LOOP
 IF NOT EXISTS(SELECT 1 FROM rule_units WHERE id=pair.value::uuid AND revision_id=NEW.revision_id AND review_status='pending') OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.bundle->'rules') r WHERE r->>'alias'=pair.key) THEN RAISE EXCEPTION 'Curation rules must remain pending in the same revision' USING ERRCODE='23514';END IF;
 END LOOP;
 ELSE
 IF NOT EXISTS(SELECT 1 FROM curation_imports c JOIN eval_datasets d ON d.id=NEW.dataset_id JOIN release_revisions r ON r.release_id=d.release_id AND r.revision_id=c.revision_id WHERE c.id=NEW.import_id) THEN RAISE EXCEPTION 'Reviewed annotations must bind the imported knowledge snapshot' USING ERRCODE='23514';END IF;
 END IF;RETURN NEW;
 END $$;
 CREATE TRIGGER curation_import_guard BEFORE INSERT OR UPDATE OR DELETE ON curation_imports FOR EACH ROW EXECUTE FUNCTION guard_curation_record();
 CREATE TRIGGER curation_dataset_review_guard BEFORE INSERT OR UPDATE OR DELETE ON curation_dataset_reviews FOR EACH ROW EXECUTE FUNCTION guard_curation_record();
 `);
  }
  async down(q: QueryRunner) {
    await q.query(
      "DROP TABLE curation_dataset_reviews,curation_imports;DROP FUNCTION guard_curation_record();",
    );
  }
}
