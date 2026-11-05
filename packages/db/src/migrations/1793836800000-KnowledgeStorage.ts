import type { MigrationInterface, QueryRunner } from "typeorm";

export class KnowledgeStorage1793836800000 implements MigrationInterface {
  name = "KnowledgeStorage1793836800000";
  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE games (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
        name text NOT NULL CHECK (length(trim(name)) > 0), created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE rulesets (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), game_id uuid NOT NULL REFERENCES games(id),
        name text NOT NULL, language text NOT NULL, scope text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(game_id,name,language)
      );
      CREATE TABLE source_documents (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), ruleset_id uuid NOT NULL REFERENCES rulesets(id),
        title text NOT NULL, source_type text NOT NULL CHECK (source_type IN ('rulebook','official_faq','editorial')),
        object_key text NOT NULL, sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
        created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(ruleset_id,sha256)
      );
      CREATE TABLE document_revisions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), document_id uuid NOT NULL REFERENCES source_documents(id),
        number integer NOT NULL CHECK (number > 0),
        status text NOT NULL DEFAULT 'uploaded' CHECK (status IN ('uploaded','parsing','awaiting_review','approved')),
        parser_config jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(document_id,number)
      );
      CREATE TABLE source_blocks (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), revision_id uuid NOT NULL REFERENCES document_revisions(id),
        ordinal integer NOT NULL CHECK (ordinal >= 0), kind text NOT NULL CHECK (kind IN ('text','heading','table','figure')),
        raw_text text NOT NULL, pdf_page_index integer NOT NULL CHECK (pdf_page_index >= 0), printed_page_label text,
        bbox jsonb CHECK (bbox IS NULL OR (jsonb_typeof(bbox) = 'array' AND jsonb_array_length(bbox) = 4)),
        UNIQUE(revision_id,ordinal), UNIQUE(id,revision_id)
      );
      CREATE TABLE rule_units (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), revision_id uuid NOT NULL REFERENCES document_revisions(id),
        kind text NOT NULL CHECK (kind IN ('rule','exception','definition','example')),
        reviewed_text text NOT NULL CHECK (length(trim(reviewed_text)) > 0),
        section_path jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(section_path)='array'),
        applicability jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(applicability)='array'), explanation text,
        review_status text NOT NULL DEFAULT 'pending' CHECK (review_status IN ('pending','approved','rejected')),
        UNIQUE(id,revision_id)
      );
      CREATE TABLE rule_sources (
        revision_id uuid NOT NULL REFERENCES document_revisions(id), rule_unit_id uuid NOT NULL, block_id uuid NOT NULL,
        PRIMARY KEY(rule_unit_id,block_id),
        FOREIGN KEY(rule_unit_id,revision_id) REFERENCES rule_units(id,revision_id),
        FOREIGN KEY(block_id,revision_id) REFERENCES source_blocks(id,revision_id)
      );
      CREATE TABLE rule_relations (
        revision_id uuid NOT NULL REFERENCES document_revisions(id), from_rule_id uuid NOT NULL, to_rule_id uuid NOT NULL,
        kind text NOT NULL CHECK (kind IN ('condition','exception','example','supplement')),
        CHECK(from_rule_id <> to_rule_id), PRIMARY KEY(from_rule_id,to_rule_id,kind),
        FOREIGN KEY(from_rule_id,revision_id) REFERENCES rule_units(id,revision_id),
        FOREIGN KEY(to_rule_id,revision_id) REFERENCES rule_units(id,revision_id)
      );
      CREATE INDEX blocks_revision_idx ON source_blocks(revision_id);
      CREATE INDEX units_revision_idx ON rule_units(revision_id);
      CREATE INDEX documents_ruleset_idx ON source_documents(ruleset_id);
      CREATE INDEX rulesets_game_idx ON rulesets(game_id);
      CREATE INDEX sources_block_idx ON rule_sources(block_id);
      CREATE INDEX relations_target_idx ON rule_relations(to_rule_id);

      CREATE FUNCTION guard_revision_content() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE target_id uuid; current_status text;
      BEGIN
        IF TG_OP='UPDATE' AND NEW.revision_id <> OLD.revision_id THEN
          RAISE EXCEPTION 'Content cannot move between revisions' USING ERRCODE='23514';
        END IF;
        IF TG_OP='DELETE' THEN target_id := OLD.revision_id; ELSE target_id := NEW.revision_id; END IF;
        SELECT status INTO current_status FROM document_revisions WHERE id=target_id FOR UPDATE;
        IF current_status='approved' THEN RAISE EXCEPTION 'Approved revision is immutable' USING ERRCODE='23514'; END IF;
        IF TG_OP='DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER source_blocks_guard BEFORE INSERT OR UPDATE OR DELETE ON source_blocks FOR EACH ROW EXECUTE FUNCTION guard_revision_content();
      CREATE TRIGGER rule_units_guard BEFORE INSERT OR UPDATE OR DELETE ON rule_units FOR EACH ROW EXECUTE FUNCTION guard_revision_content();
      CREATE TRIGGER rule_sources_guard BEFORE INSERT OR UPDATE OR DELETE ON rule_sources FOR EACH ROW EXECUTE FUNCTION guard_revision_content();
      CREATE TRIGGER rule_relations_guard BEFORE INSERT OR UPDATE OR DELETE ON rule_relations FOR EACH ROW EXECUTE FUNCTION guard_revision_content();

      CREATE FUNCTION guard_revision_review() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP='INSERT' THEN
          IF NEW.status <> 'uploaded' THEN RAISE EXCEPTION 'Revisions must start uploaded' USING ERRCODE='23514'; END IF;
          RETURN NEW;
        END IF;
        IF OLD.status='approved' THEN RAISE EXCEPTION 'Approved revision is immutable' USING ERRCODE='23514'; END IF;
        IF TG_OP='DELETE' THEN RETURN OLD; END IF;
        IF NEW.document_id <> OLD.document_id OR NEW.number <> OLD.number THEN
          RAISE EXCEPTION 'Revision identity is immutable' USING ERRCODE='23514';
        END IF;
        IF NEW.status='approved' THEN
          IF OLD.status <> 'awaiting_review' THEN RAISE EXCEPTION 'Revision must await review' USING ERRCODE='23514'; END IF;
          IF NOT EXISTS(SELECT 1 FROM rule_units WHERE revision_id=NEW.id) THEN
            RAISE EXCEPTION 'Revision has no rules' USING ERRCODE='23514';
          END IF;
          IF EXISTS(SELECT 1 FROM rule_units u WHERE u.revision_id=NEW.id AND
            (u.review_status <> 'approved' OR NOT EXISTS(SELECT 1 FROM rule_sources s WHERE s.rule_unit_id=u.id))) THEN
            RAISE EXCEPTION 'All rules require approval and sources' USING ERRCODE='23514';
          END IF;
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER revision_review_guard BEFORE INSERT OR UPDATE OR DELETE ON document_revisions FOR EACH ROW EXECUTE FUNCTION guard_revision_review();
      CREATE FUNCTION guard_source_document() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'Source documents are immutable; create a new document' USING ERRCODE='23514';
      END $$;
      CREATE TRIGGER source_document_guard BEFORE UPDATE ON source_documents FOR EACH ROW EXECUTE FUNCTION guard_source_document();
    `);
  }
  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE rule_relations, rule_sources, rule_units, source_blocks, document_revisions, source_documents, rulesets, games;
      DROP FUNCTION guard_revision_content(), guard_revision_review(), guard_source_document();`);
  }
}
