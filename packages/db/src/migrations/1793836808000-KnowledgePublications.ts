import type { MigrationInterface, QueryRunner } from "typeorm";
export class KnowledgePublications1793836808000 implements MigrationInterface {
  name = "KnowledgePublications1793836808000";
  async up(q: QueryRunner) {
    await q.query(`
 CREATE TABLE publication_policies(
 id uuid PRIMARY KEY,ruleset_id uuid NOT NULL REFERENCES rulesets(id),dataset_id uuid NOT NULL REFERENCES eval_datasets(id),
 baseline_publication_id uuid,regression_publication_id uuid,baseline_revision integer NOT NULL CHECK(baseline_revision>=0),config jsonb NOT NULL,note text NOT NULL,
 policy_hash text NOT NULL DEFAULT '',created_at timestamptz NOT NULL DEFAULT now());
 CREATE TABLE knowledge_publications(
 id uuid PRIMARY KEY,ruleset_id uuid NOT NULL REFERENCES rulesets(id),release_id uuid NOT NULL REFERENCES knowledge_releases(id),
 policy_id uuid NOT NULL REFERENCES publication_policies(id),answer_evaluation_id uuid NOT NULL REFERENCES answer_evaluations(id),retrieval_run_id uuid NOT NULL REFERENCES eval_runs(id),
 manifest jsonb NOT NULL,manifest_hash text NOT NULL DEFAULT '',gate jsonb NOT NULL,passed boolean NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
 ALTER TABLE publication_policies ADD FOREIGN KEY(baseline_publication_id) REFERENCES knowledge_publications(id);
 ALTER TABLE publication_policies ADD FOREIGN KEY(regression_publication_id) REFERENCES knowledge_publications(id);
 CREATE TABLE publication_events(
 id uuid PRIMARY KEY,ruleset_id uuid NOT NULL REFERENCES rulesets(id),revision integer NOT NULL CHECK(revision>0),
 action text NOT NULL CHECK(action IN ('publish','rollback','deactivate')),publication_id uuid REFERENCES knowledge_publications(id),previous_publication_id uuid REFERENCES knowledge_publications(id),
 note text NOT NULL CHECK(length(trim(note))>0),created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(ruleset_id,revision),
 CHECK((action='deactivate')=(publication_id IS NULL)));
 CREATE TABLE publication_heads(
 ruleset_id uuid PRIMARY KEY REFERENCES rulesets(id),revision integer NOT NULL CHECK(revision>0),publication_id uuid REFERENCES knowledge_publications(id),event_id uuid NOT NULL UNIQUE REFERENCES publication_events(id));
 CREATE FUNCTION guard_publication_policy() RETURNS trigger LANGUAGE plpgsql AS $$
 DECLARE h publication_heads%ROWTYPE;
 BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Publication policies are immutable' USING ERRCODE='23514';END IF;
 PERFORM 1 FROM rulesets WHERE id=NEW.ruleset_id FOR UPDATE;
 SELECT * INTO h FROM publication_heads WHERE ruleset_id=NEW.ruleset_id;
 IF coalesce(h.revision,0)<>NEW.baseline_revision OR h.publication_id IS DISTINCT FROM NEW.baseline_publication_id THEN RAISE EXCEPTION 'Publication baseline changed' USING ERRCODE='23514';END IF;
 IF NOT EXISTS(SELECT 1 FROM eval_datasets d JOIN knowledge_releases r ON r.id=d.release_id WHERE d.id=NEW.dataset_id AND r.ruleset_id=NEW.ruleset_id) THEN RAISE EXCEPTION 'Policy dataset belongs to another ruleset' USING ERRCODE='23514';END IF;
 IF NEW.regression_publication_id IS DISTINCT FROM (SELECT publication_id FROM publication_events WHERE ruleset_id=NEW.ruleset_id AND publication_id IS NOT NULL ORDER BY revision DESC LIMIT 1) THEN RAISE EXCEPTION 'Policy must retain the latest active regression baseline' USING ERRCODE='23514';END IF;
 NEW.policy_hash:=encode(sha256(convert_to(jsonb_build_object('datasetId',NEW.dataset_id,'rulesetId',NEW.ruleset_id,'baselinePublicationId',NEW.baseline_publication_id,'regressionPublicationId',NEW.regression_publication_id,'baselineRevision',NEW.baseline_revision,'config',NEW.config,'note',NEW.note)::text,'UTF8')),'hex');RETURN NEW;
 END $$;
 CREATE TRIGGER publication_policy_guard BEFORE INSERT OR UPDATE OR DELETE ON publication_policies FOR EACH ROW EXECUTE FUNCTION guard_publication_policy();
 CREATE FUNCTION guard_knowledge_publication() RETURNS trigger LANGUAGE plpgsql AS $$
 DECLARE p publication_policies%ROWTYPE;a answer_evaluations%ROWTYPE;r eval_runs%ROWTYPE;
 BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Publication assessments are immutable' USING ERRCODE='23514';END IF;
 SELECT * INTO p FROM publication_policies WHERE id=NEW.policy_id;
 SELECT * INTO a FROM answer_evaluations WHERE id=NEW.answer_evaluation_id;
 SELECT * INTO r FROM eval_runs WHERE id=NEW.retrieval_run_id;
 IF p.id IS NULL OR a.id IS NULL OR r.id IS NULL OR p.ruleset_id<>NEW.ruleset_id OR a.dataset_id<>p.dataset_id OR r.dataset_id<>p.dataset_id OR a.release_id<>NEW.release_id OR r.release_id<>NEW.release_id OR a.state<>'sealed' OR r.state NOT IN ('completed','completed_with_errors') OR a.config->>'split'<>'holdout' OR r.config->>'split'<>'holdout' THEN RAISE EXCEPTION 'Publication requires same-scope sealed holdout evaluations' USING ERRCODE='23514';END IF;
 IF p.created_at>a.created_at OR p.created_at>r.created_at THEN RAISE EXCEPTION 'Policy must predate evaluations' USING ERRCODE='23514';END IF;
 IF NEW.manifest->>'answerReportHash' IS DISTINCT FROM a.report_hash OR NEW.manifest->'answerSummary' IS DISTINCT FROM a.report->'summary' OR NEW.manifest->'retrievalReport' IS DISTINCT FROM r.report OR NEW.manifest->'answerConfig' IS DISTINCT FROM a.identity->'answerConfig' OR NEW.manifest->'retrieval' IS DISTINCT FROM a.config->'retrieval' OR NEW.manifest->'policy'->>'policyHash' IS DISTINCT FROM p.policy_hash OR NEW.passed IS DISTINCT FROM ((NEW.gate->>'passed')::boolean) OR NEW.passed IS DISTINCT FROM (jsonb_array_length(NEW.gate->'failures')=0) THEN RAISE EXCEPTION 'Publication must retain exact evaluation reports and gate' USING ERRCODE='23514';END IF;
 IF NEW.passed AND (coalesce(a.identity->'answerConfig'->>'buildRevision','') !~ '^[0-9a-fA-F]{40}$' OR a.report->'summary'->>'runtimeFailures'<>'0' OR jsonb_array_length(a.report->'summary'->'criticalFailures')<>0 OR (a.report->'summary'->>'citationIntegrityRate')::numeric IS DISTINCT FROM 1 OR (a.report->'summary'->>'correctRate')::numeric<(p.config->>'minCorrectRate')::numeric OR r.state<>'completed') THEN RAISE EXCEPTION 'Failed quality checks cannot pass publication' USING ERRCODE='23514';END IF;
 NEW.manifest_hash:=encode(sha256(convert_to(jsonb_build_object('manifest',NEW.manifest,'gate',NEW.gate)::text,'UTF8')),'hex');RETURN NEW;
 END $$;
 CREATE TRIGGER knowledge_publication_guard BEFORE INSERT OR UPDATE OR DELETE ON knowledge_publications FOR EACH ROW EXECUTE FUNCTION guard_knowledge_publication();
 CREATE FUNCTION guard_publication_event() RETURNS trigger LANGUAGE plpgsql AS $$
 DECLARE h publication_heads%ROWTYPE;p knowledge_publications%ROWTYPE;policy publication_policies%ROWTYPE;
 BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Publication events are immutable' USING ERRCODE='23514';END IF;
 PERFORM 1 FROM rulesets WHERE id=NEW.ruleset_id FOR UPDATE;
 SELECT * INTO h FROM publication_heads WHERE ruleset_id=NEW.ruleset_id;
 IF NEW.revision<>coalesce(h.revision,0)+1 OR NEW.previous_publication_id IS DISTINCT FROM h.publication_id THEN RAISE EXCEPTION 'Publication revision conflict' USING ERRCODE='23514';END IF;
 IF NEW.action='deactivate' THEN
 IF h.publication_id IS NULL THEN RAISE EXCEPTION 'No active publication to deactivate' USING ERRCODE='23514';END IF;
 ELSE
 SELECT * INTO p FROM knowledge_publications WHERE id=NEW.publication_id;
 IF p.id IS NULL OR NOT p.passed OR p.ruleset_id<>NEW.ruleset_id OR NEW.publication_id IS NOT DISTINCT FROM h.publication_id THEN RAISE EXCEPTION 'Transition requires a different passed publication in this ruleset' USING ERRCODE='23514';END IF;
 IF NEW.action='publish' THEN
 SELECT * INTO policy FROM publication_policies WHERE id=p.policy_id;
 IF policy.baseline_revision<>coalesce(h.revision,0) OR policy.baseline_publication_id IS DISTINCT FROM h.publication_id THEN RAISE EXCEPTION 'Publication baseline changed' USING ERRCODE='23514';END IF;
 ELSE
 IF NOT EXISTS(SELECT 1 FROM publication_events WHERE ruleset_id=NEW.ruleset_id AND publication_id=p.id AND action IN ('publish','rollback')) THEN RAISE EXCEPTION 'Rollback requires a previously activated publication' USING ERRCODE='23514';END IF;
 END IF;END IF;RETURN NEW;
 END $$;
 CREATE TRIGGER publication_event_guard BEFORE INSERT OR UPDATE OR DELETE ON publication_events FOR EACH ROW EXECUTE FUNCTION guard_publication_event();
 CREATE FUNCTION guard_publication_head() RETURNS trigger LANGUAGE plpgsql AS $$
 DECLARE e publication_events%ROWTYPE;
 BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Publication heads cannot be deleted' USING ERRCODE='23514';END IF;
 IF TG_OP='UPDATE' AND (NEW.ruleset_id<>OLD.ruleset_id OR NEW.revision<>OLD.revision+1) THEN RAISE EXCEPTION 'Publication head must advance one audited revision' USING ERRCODE='23514';END IF;
 IF TG_OP='INSERT' AND NEW.revision<>1 THEN RAISE EXCEPTION 'Publication head starts at revision one' USING ERRCODE='23514';END IF;
 SELECT * INTO e FROM publication_events WHERE id=NEW.event_id;
 IF e.id IS NULL OR e.ruleset_id<>NEW.ruleset_id OR e.revision<>NEW.revision OR e.publication_id IS DISTINCT FROM NEW.publication_id OR (TG_OP='UPDATE' AND e.previous_publication_id IS DISTINCT FROM OLD.publication_id) THEN RAISE EXCEPTION 'Publication head requires its exact audit event' USING ERRCODE='23514';END IF;RETURN NEW;
 END $$;
 CREATE TRIGGER publication_head_guard BEFORE INSERT OR UPDATE OR DELETE ON publication_heads FOR EACH ROW EXECUTE FUNCTION guard_publication_head();
 CREATE FUNCTION advance_publication_head() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN
 IF EXISTS(SELECT 1 FROM publication_heads WHERE ruleset_id=NEW.ruleset_id) THEN
 UPDATE publication_heads SET revision=NEW.revision,publication_id=NEW.publication_id,event_id=NEW.id WHERE ruleset_id=NEW.ruleset_id;
 ELSE INSERT INTO publication_heads(ruleset_id,revision,publication_id,event_id) VALUES(NEW.ruleset_id,NEW.revision,NEW.publication_id,NEW.id);END IF;RETURN NEW;
 END $$;
 CREATE TRIGGER publication_head_advance AFTER INSERT ON publication_events FOR EACH ROW EXECUTE FUNCTION advance_publication_head();
 CREATE INDEX publications_scope_created ON knowledge_publications(ruleset_id,created_at);
 CREATE INDEX publication_policies_scope_created ON publication_policies(ruleset_id,created_at);
 `);
  }
  async down(q: QueryRunner) {
    await q.query(
      `DROP TABLE publication_heads,publication_events;ALTER TABLE publication_policies DROP CONSTRAINT publication_policies_baseline_publication_id_fkey, DROP CONSTRAINT publication_policies_regression_publication_id_fkey;DROP TABLE knowledge_publications,publication_policies;DROP FUNCTION guard_publication_policy(),guard_knowledge_publication(),guard_publication_event(),guard_publication_head(),advance_publication_head();`,
    );
  }
}
