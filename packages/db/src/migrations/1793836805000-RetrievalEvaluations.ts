import type { MigrationInterface, QueryRunner } from "typeorm";
export class RetrievalEvaluations1793836805000 implements MigrationInterface {
  name = "RetrievalEvaluations1793836805000";
  async up(q: QueryRunner) {
    await q.query(`
 CREATE TABLE eval_datasets(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), release_id uuid NOT NULL REFERENCES knowledge_releases(id),
 manifest jsonb NOT NULL, manifest_hash text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,release_id));
 CREATE UNIQUE INDEX eval_dataset_revision ON eval_datasets(release_id,(manifest->>'name'),(manifest->>'revision'));
 CREATE FUNCTION guard_eval_dataset() RETURNS trigger LANGUAGE plpgsql AS $$
 DECLARE c jsonb; evidence jsonb; rule_id text;
 BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Evaluation datasets are immutable' USING ERRCODE='23514'; END IF;
 IF NOT EXISTS(SELECT 1 FROM knowledge_releases WHERE id=NEW.release_id AND state='sealed') OR
 jsonb_typeof(NEW.manifest->'cases') IS DISTINCT FROM 'array' OR
 coalesce(jsonb_array_length(NEW.manifest->'cases'),0) NOT BETWEEN 1 AND 100 THEN
 RAISE EXCEPTION 'Dataset requires a sealed release and cases' USING ERRCODE='23514'; END IF;
 IF (SELECT count(DISTINCT item->>'id') FROM jsonb_array_elements(NEW.manifest->'cases') item)<>jsonb_array_length(NEW.manifest->'cases') THEN RAISE EXCEPTION 'Duplicate or missing case IDs' USING ERRCODE='23514'; END IF;
 FOR c IN SELECT value FROM jsonb_array_elements(NEW.manifest->'cases') LOOP
 IF (c->>'split') IS NULL OR (c->>'split') NOT IN ('development','holdout') OR jsonb_typeof(c->'acceptableEvidenceSets') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Invalid evaluation case' USING ERRCODE='23514'; END IF;
 FOR evidence IN SELECT value FROM jsonb_array_elements(c->'acceptableEvidenceSets') LOOP
 IF jsonb_typeof(evidence)<>'array' OR jsonb_array_length(evidence)=0 THEN RAISE EXCEPTION 'Empty evidence alternative' USING ERRCODE='23514'; END IF;
 FOR rule_id IN SELECT jsonb_array_elements_text(evidence) LOOP
 IF NOT EXISTS(SELECT 1 FROM release_members WHERE release_id=NEW.release_id AND rule_unit_id=rule_id::uuid) THEN RAISE EXCEPTION 'Evidence outside dataset release' USING ERRCODE='23514'; END IF;
 END LOOP; END LOOP; END LOOP;
 NEW.manifest_hash:=encode(sha256(convert_to(NEW.manifest::text,'UTF8')),'hex'); RETURN NEW;
 END $$;
 CREATE TRIGGER eval_dataset_guard BEFORE INSERT OR UPDATE OR DELETE ON eval_datasets FOR EACH ROW EXECUTE FUNCTION guard_eval_dataset();
 CREATE TABLE eval_runs(
 id uuid PRIMARY KEY, dataset_id uuid NOT NULL, release_id uuid NOT NULL, index_build_id uuid NOT NULL, vector_index_id uuid,
 config jsonb NOT NULL, identity jsonb NOT NULL, state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','running','retrying','failed','completed','completed_with_errors')),
 attempts integer NOT NULL DEFAULT 0, attempt_token uuid, error_code text, report jsonb,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(dataset_id,release_id) REFERENCES eval_datasets(id,release_id),
 FOREIGN KEY(index_build_id,release_id) REFERENCES index_builds(id,release_id),
 FOREIGN KEY(vector_index_id,index_build_id,release_id) REFERENCES vector_indexes(id,index_build_id,release_id));
 CREATE TABLE eval_results(
 run_id uuid NOT NULL REFERENCES eval_runs(id),case_id text NOT NULL,result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(run_id,case_id));
 CREATE FUNCTION guard_eval_run() RETURNS trigger LANGUAGE plpgsql AS $$
 DECLARE expected integer; actual integer; errors integer;
 BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Evaluation runs cannot be deleted' USING ERRCODE='23514'; END IF;
 IF TG_OP='INSERT' THEN
 IF NEW.state<>'queued' OR NOT EXISTS(SELECT 1 FROM index_builds WHERE id=NEW.index_build_id AND state='ready') OR
 (NEW.vector_index_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM vector_indexes WHERE id=NEW.vector_index_id AND state='ready')) THEN RAISE EXCEPTION 'Evaluation requires ready indexes and starts queued' USING ERRCODE='23514'; END IF;
 IF (NEW.config->>'indexBuildId')::uuid IS DISTINCT FROM NEW.index_build_id OR (NEW.config->>'vectorIndexId')::uuid IS DISTINCT FROM NEW.vector_index_id OR
 (NEW.config->>'split') IS NULL OR (NEW.config->>'split') NOT IN ('development','holdout') OR
 (NEW.config->>'mode') IS NULL OR (NEW.config->>'mode') NOT IN ('lexical','vector','hybrid') OR
 ((NEW.config->>'mode'='lexical') IS DISTINCT FROM (NEW.vector_index_id IS NULL)) THEN RAISE EXCEPTION 'Invalid evaluation configuration' USING ERRCODE='23514'; END IF;
 ELSE
 IF OLD.state IN ('completed','completed_with_errors') THEN RAISE EXCEPTION 'Completed evaluation is immutable' USING ERRCODE='23514'; END IF;
 IF ROW(NEW.id,NEW.dataset_id,NEW.release_id,NEW.index_build_id,NEW.vector_index_id,NEW.config,NEW.identity,NEW.created_at) IS DISTINCT FROM ROW(OLD.id,OLD.dataset_id,OLD.release_id,OLD.index_build_id,OLD.vector_index_id,OLD.config,OLD.identity,OLD.created_at) THEN RAISE EXCEPTION 'Evaluation identity is immutable' USING ERRCODE='23514'; END IF;
 END IF;
 SELECT count(*) INTO expected FROM eval_datasets d, jsonb_array_elements(d.manifest->'cases') c WHERE d.id=NEW.dataset_id AND c->>'split'=NEW.config->>'split';
 IF expected=0 THEN RAISE EXCEPTION 'Evaluation split is empty' USING ERRCODE='23514'; END IF;
 IF NEW.state IN ('completed','completed_with_errors') THEN
 SELECT count(*),count(*) FILTER(WHERE result->>'status'='failed') INTO actual,errors FROM eval_results WHERE run_id=NEW.id;
 IF actual<>expected OR NEW.report IS NULL OR (NEW.state='completed') IS DISTINCT FROM (errors=0) THEN RAISE EXCEPTION 'Evaluation must retain every selected result and error' USING ERRCODE='23514'; END IF;
 END IF; RETURN NEW;
 END $$;
 CREATE TRIGGER eval_run_guard BEFORE INSERT OR UPDATE OR DELETE ON eval_runs FOR EACH ROW EXECUTE FUNCTION guard_eval_run();
 CREATE FUNCTION guard_eval_result() RETURNS trigger LANGUAGE plpgsql AS $$
 DECLARE r eval_runs%ROWTYPE;
 BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Evaluation results are immutable' USING ERRCODE='23514'; END IF;
 SELECT * INTO r FROM eval_runs WHERE id=NEW.run_id FOR UPDATE;
 IF r.state IS DISTINCT FROM 'running' OR (NEW.result->>'caseId') IS DISTINCT FROM NEW.case_id OR (NEW.result->>'status') IS NULL OR (NEW.result->>'status') NOT IN ('succeeded','failed') OR NOT EXISTS(SELECT 1 FROM eval_datasets d,jsonb_array_elements(d.manifest->'cases') c WHERE d.id=r.dataset_id AND c->>'id'=NEW.case_id AND c->>'split'=r.config->>'split') THEN RAISE EXCEPTION 'Result must belong to a running evaluation and selected split' USING ERRCODE='23514'; END IF;
 RETURN NEW;
 END $$;
 CREATE TRIGGER eval_result_guard BEFORE INSERT OR UPDATE OR DELETE ON eval_results FOR EACH ROW EXECUTE FUNCTION guard_eval_result();
 CREATE INDEX eval_runs_dataset_created ON eval_runs(dataset_id,created_at);
 `);
  }
  async down(q: QueryRunner) {
    await q.query(
      `DROP TABLE eval_results,eval_runs,eval_datasets;DROP FUNCTION guard_eval_result(),guard_eval_run(),guard_eval_dataset();`,
    );
  }
}
