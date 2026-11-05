import type { MigrationInterface, QueryRunner } from "typeorm";
export class AnswerEvaluations1793836807000 implements MigrationInterface {
  name = "AnswerEvaluations1793836807000";
  async up(q: QueryRunner) {
    await q.query(`
 CREATE TABLE answer_evaluations(
 id uuid PRIMARY KEY,dataset_id uuid NOT NULL,release_id uuid NOT NULL,index_build_id uuid NOT NULL,vector_index_id uuid,
 state text NOT NULL DEFAULT 'assembling' CHECK(state IN ('assembling','queued','running','retrying','failed','awaiting_review','sealed')),
 config jsonb NOT NULL,identity jsonb NOT NULL,identity_hash text NOT NULL DEFAULT '',attempts integer NOT NULL DEFAULT 0,attempt_token uuid,error_code text,
 report jsonb,report_hash text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(dataset_id,release_id) REFERENCES eval_datasets(id,release_id),FOREIGN KEY(index_build_id,release_id) REFERENCES index_builds(id,release_id),
 FOREIGN KEY(vector_index_id,index_build_id,release_id) REFERENCES vector_indexes(id,index_build_id,release_id),
 CHECK((state='sealed' AND report IS NOT NULL AND report_hash IS NOT NULL) OR (state<>'sealed' AND report IS NULL AND report_hash IS NULL)));
 CREATE TABLE answer_evaluation_cases(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),evaluation_id uuid NOT NULL REFERENCES answer_evaluations(id),case_id text NOT NULL,
 execution_key uuid NOT NULL UNIQUE,request jsonb NOT NULL,answer_run_id uuid UNIQUE REFERENCES answer_runs(id),outcome jsonb,
 UNIQUE(evaluation_id,case_id),CHECK((outcome IS NULL)=(answer_run_id IS NULL)));
 CREATE TABLE answer_case_reviews(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),case_row_id uuid NOT NULL REFERENCES answer_evaluation_cases(id),revision integer NOT NULL CHECK(revision>0),
 actor text NOT NULL CHECK(actor='admin'),review jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(case_row_id,revision));
 CREATE FUNCTION guard_answer_evaluation() RETURNS trigger LANGUAGE plpgsql AS $$
 DECLARE expected integer;actual integer;completed integer;reviewed integer;
 BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Answer evaluations cannot be deleted' USING ERRCODE='23514';END IF;
 IF TG_OP='INSERT' THEN
 IF NEW.state<>'assembling' OR NOT EXISTS(SELECT 1 FROM index_builds WHERE id=NEW.index_build_id AND state='ready') OR (NEW.vector_index_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM vector_indexes WHERE id=NEW.vector_index_id AND state='ready')) THEN RAISE EXCEPTION 'Answer evaluation requires ready indexes and starts assembling' USING ERRCODE='23514';END IF;
 IF (NEW.config->'retrieval'->>'indexBuildId')::uuid IS DISTINCT FROM NEW.index_build_id OR (NEW.config->'retrieval'->>'vectorIndexId')::uuid IS DISTINCT FROM NEW.vector_index_id OR (NEW.config->>'split') IS NULL OR (NEW.config->>'split') NOT IN ('development','holdout') THEN RAISE EXCEPTION 'Invalid answer evaluation configuration' USING ERRCODE='23514';END IF;
 NEW.identity_hash:=encode(sha256(convert_to(jsonb_build_object('config',NEW.config,'identity',NEW.identity)::text,'UTF8')),'hex');
 ELSE
 IF OLD.state='sealed' THEN RAISE EXCEPTION 'Sealed answer evaluations are immutable' USING ERRCODE='23514';END IF;
 IF OLD.state='awaiting_review' AND NEW.state<>'sealed' THEN RAISE EXCEPTION 'Reviewed generation cannot restart' USING ERRCODE='23514';END IF;
 IF ROW(NEW.id,NEW.dataset_id,NEW.release_id,NEW.index_build_id,NEW.vector_index_id,NEW.config,NEW.identity,NEW.identity_hash,NEW.created_at) IS DISTINCT FROM ROW(OLD.id,OLD.dataset_id,OLD.release_id,OLD.index_build_id,OLD.vector_index_id,OLD.config,OLD.identity,OLD.identity_hash,OLD.created_at) THEN RAISE EXCEPTION 'Answer evaluation identity is immutable' USING ERRCODE='23514';END IF;
 END IF;
 SELECT count(*) INTO expected FROM eval_datasets d,jsonb_array_elements(d.manifest->'cases') c WHERE d.id=NEW.dataset_id AND c->>'split'=NEW.config->>'split';
 IF expected=0 THEN RAISE EXCEPTION 'Answer evaluation split is empty' USING ERRCODE='23514';END IF;
 IF NEW.state<>'assembling' THEN
 SELECT count(*),count(outcome),count(*) FILTER(WHERE EXISTS(SELECT 1 FROM answer_case_reviews v WHERE v.case_row_id=c.id)) INTO actual,completed,reviewed FROM answer_evaluation_cases c WHERE evaluation_id=NEW.id;
 IF actual<>expected THEN RAISE EXCEPTION 'Every selected case needs a fixed execution key' USING ERRCODE='23514';END IF;
 IF NEW.state IN ('awaiting_review','sealed') AND completed<>expected THEN RAISE EXCEPTION 'Every selected answer must finish before review' USING ERRCODE='23514';END IF;
 IF NEW.state='sealed' THEN
 IF OLD.state<>'awaiting_review' OR reviewed<>expected OR NEW.report IS NULL THEN RAISE EXCEPTION 'Sealing requires every manual review' USING ERRCODE='23514';END IF;
 NEW.report_hash:=encode(sha256(convert_to(NEW.report::text,'UTF8')),'hex');
 END IF;END IF;RETURN NEW;
 END $$;
 CREATE TRIGGER answer_evaluation_guard BEFORE INSERT OR UPDATE OR DELETE ON answer_evaluations FOR EACH ROW EXECUTE FUNCTION guard_answer_evaluation();
 CREATE FUNCTION guard_answer_evaluation_case() RETURNS trigger LANGUAGE plpgsql AS $$
 DECLARE r answer_evaluations%ROWTYPE;
 BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Answer evaluation cases cannot be deleted' USING ERRCODE='23514';END IF;
 SELECT * INTO r FROM answer_evaluations WHERE id=NEW.evaluation_id FOR UPDATE;
 IF TG_OP='INSERT' THEN
 IF r.state IS DISTINCT FROM 'assembling' OR NEW.outcome IS NOT NULL OR (NEW.request->>'idempotencyKey')::uuid IS DISTINCT FROM NEW.execution_key OR NEW.request->'retrieval' IS DISTINCT FROM r.config->'retrieval' OR NOT EXISTS(SELECT 1 FROM eval_datasets d,jsonb_array_elements(d.manifest->'cases') c WHERE d.id=r.dataset_id AND c->>'id'=NEW.case_id AND c->>'split'=r.config->>'split') THEN RAISE EXCEPTION 'Case must match the selected dataset and configuration' USING ERRCODE='23514';END IF;
 ELSE
 IF OLD.outcome IS NOT NULL OR r.state<>'running' OR ROW(NEW.id,NEW.evaluation_id,NEW.case_id,NEW.execution_key,NEW.request) IS DISTINCT FROM ROW(OLD.id,OLD.evaluation_id,OLD.case_id,OLD.execution_key,OLD.request) THEN RAISE EXCEPTION 'Case identity and completed outcome are immutable' USING ERRCODE='23514';END IF;
 IF NEW.outcome IS NULL OR NEW.answer_run_id IS DISTINCT FROM NEW.execution_key OR NOT EXISTS(SELECT 1 FROM answer_runs a WHERE a.id=NEW.answer_run_id AND a.state<>'running' AND a.release_id=r.release_id AND a.index_build_id=r.index_build_id AND a.vector_index_id IS NOT DISTINCT FROM r.vector_index_id AND a.config=r.identity->'answerConfig' AND a.input=NEW.request) THEN RAISE EXCEPTION 'Outcome must reference the exact finished answer execution' USING ERRCODE='23514';END IF;
 END IF;RETURN NEW;
 END $$;
 CREATE TRIGGER answer_evaluation_case_guard BEFORE INSERT OR UPDATE OR DELETE ON answer_evaluation_cases FOR EACH ROW EXECUTE FUNCTION guard_answer_evaluation_case();
 CREATE FUNCTION guard_answer_case_review() RETURNS trigger LANGUAGE plpgsql AS $$
 DECLARE parent uuid;current_state text;next_revision integer;c jsonb;
 BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Manual review revisions are immutable' USING ERRCODE='23514';END IF;
 SELECT evaluation_id INTO parent FROM answer_evaluation_cases WHERE id=NEW.case_row_id;
 SELECT state INTO current_state FROM answer_evaluations WHERE id=parent FOR UPDATE;
 IF current_state IS DISTINCT FROM 'awaiting_review' THEN RAISE EXCEPTION 'Manual reviews require completed generation and cannot change after seal' USING ERRCODE='23514';END IF;
 SELECT coalesce(max(revision),0)+1 INTO next_revision FROM answer_case_reviews WHERE case_row_id=NEW.case_row_id;
 IF NEW.revision<>next_revision THEN RAISE EXCEPTION 'Review revision conflict' USING ERRCODE='23514';END IF;
 SELECT item INTO c FROM answer_evaluation_cases ec JOIN answer_evaluations r ON r.id=ec.evaluation_id JOIN eval_datasets d ON d.id=r.dataset_id CROSS JOIN jsonb_array_elements(d.manifest->'cases') item WHERE ec.id=NEW.case_row_id AND item->>'id'=ec.case_id;
 IF jsonb_typeof(NEW.review->'requiredClaimsSatisfied') IS DISTINCT FROM 'array' OR jsonb_typeof(NEW.review->'forbiddenClaimsAbsent') IS DISTINCT FROM 'array' OR jsonb_array_length(NEW.review->'requiredClaimsSatisfied')<>jsonb_array_length(c->'requiredClaims') OR jsonb_array_length(NEW.review->'forbiddenClaimsAbsent')<>jsonb_array_length(c->'forbiddenClaims') THEN RAISE EXCEPTION 'Manual review must address every annotated claim' USING ERRCODE='23514';END IF;
 RETURN NEW;
 END $$;
 CREATE TRIGGER answer_case_review_guard BEFORE INSERT OR UPDATE OR DELETE ON answer_case_reviews FOR EACH ROW EXECUTE FUNCTION guard_answer_case_review();
 CREATE INDEX answer_evaluations_dataset_created ON answer_evaluations(dataset_id,created_at);
 `);
  }
  async down(q: QueryRunner) {
    await q.query(
      "DROP TABLE answer_case_reviews,answer_evaluation_cases,answer_evaluations;DROP FUNCTION guard_answer_case_review(),guard_answer_evaluation_case(),guard_answer_evaluation();",
    );
  }
}
