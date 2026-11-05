import type { MigrationInterface, QueryRunner } from "typeorm";
export class Bm25Retrieval1793836813000 implements MigrationInterface {
  name = "Bm25Retrieval1793836813000";
  async up(q: QueryRunner) {
    await q.query(`
 CREATE TABLE bm25_documents(
 chunk_id uuid PRIMARY KEY REFERENCES retrieval_chunks(id),build_id uuid NOT NULL,release_id uuid NOT NULL,
 token_count integer NOT NULL CHECK(token_count>0),term_counts jsonb NOT NULL CHECK(jsonb_typeof(term_counts)='object'),
 FOREIGN KEY(build_id,release_id) REFERENCES index_builds(id,release_id));
 CREATE INDEX bm25_documents_scope ON bm25_documents(build_id,release_id);
 CREATE INDEX bm25_documents_terms ON bm25_documents USING gin(term_counts);
 CREATE TABLE bm25_corpora(build_id uuid PRIMARY KEY,release_id uuid NOT NULL,document_count integer NOT NULL CHECK(document_count>0),total_tokens bigint NOT NULL CHECK(total_tokens>0),FOREIGN KEY(build_id,release_id) REFERENCES index_builds(id,release_id));
 CREATE TABLE bm25_terms(build_id uuid NOT NULL,release_id uuid NOT NULL,term text NOT NULL CHECK(length(term)>0),document_frequency integer NOT NULL CHECK(document_frequency>0),PRIMARY KEY(build_id,term),FOREIGN KEY(build_id,release_id) REFERENCES index_builds(id,release_id));
 CREATE FUNCTION guard_bm25_content() RETURNS trigger LANGUAGE plpgsql AS $$
 DECLARE target uuid; r uuid; current_state text;
 BEGIN
 IF TG_OP='UPDATE' AND (NEW.build_id<>OLD.build_id OR NEW.release_id<>OLD.release_id) THEN RAISE EXCEPTION 'BM25 statistics identity is immutable' USING ERRCODE='23514'; END IF;
 IF TG_OP='DELETE' THEN target:=OLD.build_id;r:=OLD.release_id; ELSE target:=NEW.build_id;r:=NEW.release_id; END IF;
 SELECT state INTO current_state FROM index_builds WHERE id=target AND release_id=r FOR UPDATE;
 IF current_state IS DISTINCT FROM 'building' THEN RAISE EXCEPTION 'Ready BM25 statistics are immutable' USING ERRCODE='23514'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 IF TG_TABLE_NAME='bm25_documents' THEN
 IF NOT EXISTS(SELECT 1 FROM retrieval_chunks WHERE id=NEW.chunk_id AND build_id=target AND release_id=r) THEN RAISE EXCEPTION 'BM25 chunk outside index' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
 END $$;
 CREATE TRIGGER bm25_documents_guard BEFORE INSERT OR UPDATE OR DELETE ON bm25_documents FOR EACH ROW EXECUTE FUNCTION guard_bm25_content();
 CREATE TRIGGER bm25_corpora_guard BEFORE INSERT OR UPDATE OR DELETE ON bm25_corpora FOR EACH ROW EXECUTE FUNCTION guard_bm25_content();
 CREATE TRIGGER bm25_terms_guard BEFORE INSERT OR UPDATE OR DELETE ON bm25_terms FOR EACH ROW EXECUTE FUNCTION guard_bm25_content();
 CREATE FUNCTION build_bm25_statistics() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN
 IF OLD.state='building' AND NEW.state='ready' AND NEW.config->>'ranker'='bm25-v1' THEN
  DELETE FROM bm25_documents WHERE build_id=NEW.id;
  DELETE FROM bm25_corpora WHERE build_id=NEW.id;
  DELETE FROM bm25_terms WHERE build_id=NEW.id;
  INSERT INTO bm25_documents(chunk_id,build_id,release_id,token_count,term_counts)
  SELECT c.id,c.build_id,c.release_id,cardinality(string_to_array(c.lexical_text,' ')),
   (SELECT jsonb_object_agg(term,n) FROM(SELECT term,count(*) AS n FROM unnest(string_to_array(c.lexical_text,' ')) AS term GROUP BY term) f)
   FROM retrieval_chunks c WHERE c.build_id=NEW.id AND c.release_id=NEW.release_id;
  INSERT INTO bm25_corpora(build_id,release_id,document_count,total_tokens)
   SELECT NEW.id,NEW.release_id,count(*),sum(token_count) FROM bm25_documents WHERE build_id=NEW.id;
  INSERT INTO bm25_terms(build_id,release_id,term,document_frequency)
   SELECT NEW.id,NEW.release_id,term,count(*) FROM bm25_documents CROSS JOIN LATERAL jsonb_object_keys(term_counts) AS term WHERE build_id=NEW.id GROUP BY term;
 END IF;
 RETURN NEW;
 END $$;
 CREATE TRIGGER bm25_build_statistics BEFORE UPDATE ON index_builds FOR EACH ROW EXECUTE FUNCTION build_bm25_statistics();
 `);
  }
  async down(q: QueryRunner) {
    await q.query(
      `DO $$ BEGIN IF EXISTS(SELECT 1 FROM index_builds WHERE config->>'ranker'='bm25-v1') THEN RAISE EXCEPTION 'Cannot remove BM25 storage while versioned BM25 indexes exist' USING ERRCODE='23514'; END IF; END $$;DROP TRIGGER bm25_build_statistics ON index_builds;DROP FUNCTION build_bm25_statistics();DROP TABLE bm25_documents,bm25_terms,bm25_corpora;DROP FUNCTION guard_bm25_content();`,
    );
  }
}
