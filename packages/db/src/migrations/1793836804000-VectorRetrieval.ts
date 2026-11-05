import type { MigrationInterface, QueryRunner } from "typeorm";
export class VectorRetrieval1793836804000 implements MigrationInterface {
  name = "VectorRetrieval1793836804000";
  async up(q: QueryRunner) {
    await q.query(`
 CREATE EXTENSION IF NOT EXISTS vector;
 ALTER TABLE retrieval_chunks ADD CONSTRAINT chunks_identity UNIQUE(id,build_id,release_id);
 CREATE TABLE vector_indexes(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),index_build_id uuid NOT NULL,release_id uuid NOT NULL,
 state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','running','retrying','failed','ready')),
 profile jsonb NOT NULL CHECK(jsonb_typeof(profile)='object'),profile_hash text NOT NULL,
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),attempt_token uuid,error_code text,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(index_build_id,release_id) REFERENCES index_builds(id,release_id),UNIQUE(index_build_id,profile_hash),UNIQUE(id,index_build_id,release_id));
 CREATE TABLE chunk_embeddings(
 vector_index_id uuid NOT NULL,index_build_id uuid NOT NULL,release_id uuid NOT NULL,chunk_id uuid NOT NULL,embedding vector NOT NULL,
 PRIMARY KEY(vector_index_id,chunk_id),FOREIGN KEY(vector_index_id,index_build_id,release_id) REFERENCES vector_indexes(id,index_build_id,release_id),FOREIGN KEY(chunk_id,index_build_id,release_id) REFERENCES retrieval_chunks(id,build_id,release_id));
 CREATE TABLE embedding_batches(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),vector_index_id uuid NOT NULL REFERENCES vector_indexes(id),chunk_ids uuid[] NOT NULL CHECK(cardinality(chunk_ids)>0),usage_tokens integer CHECK(usage_tokens>=0),created_at timestamptz NOT NULL DEFAULT now());
 CREATE FUNCTION guard_vector_index() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.state<>'queued' OR NOT EXISTS(SELECT 1 FROM index_builds WHERE id=NEW.index_build_id AND state='ready') THEN RAISE EXCEPTION 'Vectors require a ready index and start queued' USING ERRCODE='23514'; END IF;
  IF NOT (NEW.profile ? 'dimensions') OR coalesce((NEW.profile->>'dimensions')::integer,0) NOT BETWEEN 1 AND 4096 OR (NEW.profile->>'distance') IS DISTINCT FROM 'cosine' THEN RAISE EXCEPTION 'Invalid embedding profile' USING ERRCODE='23514'; END IF;
  NEW.profile_hash:=encode(sha256(convert_to(NEW.profile::text,'UTF8')),'hex'); RETURN NEW;
 END IF;
 IF OLD.state='ready' THEN RAISE EXCEPTION 'Ready vectors are immutable' USING ERRCODE='23514'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 IF NEW.id<>OLD.id OR NEW.index_build_id<>OLD.index_build_id OR NEW.release_id<>OLD.release_id OR NEW.profile<>OLD.profile OR NEW.profile_hash<>OLD.profile_hash THEN RAISE EXCEPTION 'Vector identity is immutable' USING ERRCODE='23514'; END IF;
 IF NEW.state='ready' AND (SELECT count(*) FROM chunk_embeddings WHERE vector_index_id=NEW.id)<>(SELECT count(*) FROM retrieval_chunks WHERE build_id=NEW.index_build_id) THEN RAISE EXCEPTION 'Vectors must cover every chunk' USING ERRCODE='23514'; END IF;
 RETURN NEW;
 END $$;
 CREATE TRIGGER vector_indexes_guard BEFORE INSERT OR UPDATE OR DELETE ON vector_indexes FOR EACH ROW EXECUTE FUNCTION guard_vector_index();
 CREATE FUNCTION guard_vector_artifact() RETURNS trigger LANGUAGE plpgsql AS $$
 DECLARE current_state text; dimensions integer;
 BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Vector artifacts are immutable' USING ERRCODE='23514'; END IF;
 SELECT state,(profile->>'dimensions')::integer INTO current_state,dimensions FROM vector_indexes WHERE id=NEW.vector_index_id FOR UPDATE;
 IF current_state<>'running' THEN RAISE EXCEPTION 'Vector index must be running' USING ERRCODE='23514'; END IF;
 IF TG_TABLE_NAME='chunk_embeddings' THEN
  IF vector_dims(NEW.embedding)<>dimensions OR vector_norm(NEW.embedding)=0 THEN RAISE EXCEPTION 'Invalid vector dimensions or norm' USING ERRCODE='23514'; END IF;
 END IF;RETURN NEW;
 END $$;
 CREATE TRIGGER chunk_embeddings_guard BEFORE INSERT OR UPDATE OR DELETE ON chunk_embeddings FOR EACH ROW EXECUTE FUNCTION guard_vector_artifact();
 CREATE TRIGGER embedding_batches_guard BEFORE INSERT OR UPDATE OR DELETE ON embedding_batches FOR EACH ROW EXECUTE FUNCTION guard_vector_artifact();
 CREATE TABLE retrieval_runs(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),request_id uuid,vector_index_id uuid NOT NULL,index_build_id uuid NOT NULL,release_id uuid NOT NULL,query text NOT NULL CHECK(length(query)<=2000),mode text NOT NULL CHECK(mode IN ('lexical','vector','hybrid')),config jsonb NOT NULL,status text NOT NULL CHECK(status IN ('succeeded','failed')),result jsonb NOT NULL,error_code text,duration_ms integer NOT NULL CHECK(duration_ms>=0),usage_tokens integer CHECK(usage_tokens>=0),created_at timestamptz NOT NULL DEFAULT now(),FOREIGN KEY(vector_index_id,index_build_id,release_id) REFERENCES vector_indexes(id,index_build_id,release_id));
 CREATE INDEX retrieval_runs_index_idx ON retrieval_runs(vector_index_id,created_at);
 CREATE FUNCTION guard_retrieval_run() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Retrieval runs are immutable' USING ERRCODE='23514'; END $$;
 CREATE TRIGGER retrieval_runs_guard BEFORE UPDATE OR DELETE ON retrieval_runs FOR EACH ROW EXECUTE FUNCTION guard_retrieval_run();
 `);
  }
  async down(q: QueryRunner) {
    await q.query(
      `DROP TABLE retrieval_runs,embedding_batches,chunk_embeddings,vector_indexes;ALTER TABLE retrieval_chunks DROP CONSTRAINT chunks_identity;DROP FUNCTION guard_retrieval_run(),guard_vector_artifact(),guard_vector_index();`,
    );
  }
}
