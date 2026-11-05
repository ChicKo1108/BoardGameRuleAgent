import type { MigrationInterface, QueryRunner } from "typeorm";
export class WechatAccounts1793836811000 implements MigrationInterface {
  name = "WechatAccounts1793836811000";
  async up(q: QueryRunner) {
    await q.query(`
 ALTER TABLE public_principals DROP CONSTRAINT public_principals_kind_check;
 ALTER TABLE public_principals ADD CHECK(kind IN ('guest','member'));
 CREATE TABLE wechat_identities(app_id text NOT NULL,subject_hash text NOT NULL CHECK(subject_hash ~ '^[a-f0-9]{64}$'),principal_id uuid NOT NULL UNIQUE REFERENCES public_principals(id),created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(app_id,subject_hash));
 CREATE TABLE guest_account_claims(guest_principal_id uuid PRIMARY KEY REFERENCES public_principals(id),account_principal_id uuid NOT NULL REFERENCES public_principals(id),created_at timestamptz NOT NULL DEFAULT now(),CHECK(guest_principal_id<>account_principal_id));
 CREATE INDEX guest_claims_account ON guest_account_claims(account_principal_id);
 CREATE FUNCTION principal_scope(owner_id uuid) RETURNS SETOF uuid LANGUAGE sql STABLE AS $$ SELECT owner_id UNION SELECT guest_principal_id FROM guest_account_claims WHERE account_principal_id=owner_id $$;
 CREATE OR REPLACE FUNCTION guard_public_turn() RETURNS trigger LANGUAGE plpgsql AS $$
 DECLARE c public_conversations%ROWTYPE;p knowledge_publications%ROWTYPE;expected integer;
 BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Public turns cannot be deleted' USING ERRCODE='23514';END IF;
 SELECT * INTO c FROM public_conversations WHERE id=NEW.conversation_id FOR UPDATE;
 SELECT * INTO p FROM knowledge_publications WHERE id=c.publication_id;
 IF TG_OP='INSERT' THEN
 SELECT coalesce(max(sequence),0)+1 INTO expected FROM public_turns WHERE conversation_id=c.id;
 IF NEW.state<>'prepared' OR NEW.sequence<>expected OR NOT EXISTS(SELECT 1 FROM publication_heads WHERE ruleset_id=c.ruleset_id AND publication_id=p.id) OR (NEW.input->>'idempotencyKey')::uuid IS DISTINCT FROM NEW.execution_key OR NEW.input->>'question' IS DISTINCT FROM NEW.question OR NEW.input->'retrieval' IS DISTINCT FROM p.manifest->'retrieval' OR NOT EXISTS(SELECT 1 FROM question_allowances WHERE id=NEW.allowance_id AND c.principal_id IN (SELECT principal_scope(question_allowances.principal_id)) AND state='reserved') THEN RAISE EXCEPTION 'Public turn must match conversation, input and reserved allowance' USING ERRCODE='23514';END IF;
 ELSE
 IF OLD.state IN ('completed','failed') OR ROW(NEW.id,NEW.conversation_id,NEW.sequence,NEW.question,NEW.input,NEW.execution_key,NEW.allowance_id,NEW.created_at) IS DISTINCT FROM ROW(OLD.id,OLD.conversation_id,OLD.sequence,OLD.question,OLD.input,OLD.execution_key,OLD.allowance_id,OLD.created_at) OR NOT ((OLD.state='prepared' AND NEW.state IN ('running','failed')) OR (OLD.state='running' AND NEW.state IN ('completed','failed'))) THEN RAISE EXCEPTION 'Turn identity/terminal result is immutable or transition invalid' USING ERRCODE='23514';END IF;
 IF NEW.state='running' AND NOT EXISTS(SELECT 1 FROM question_allowances WHERE id=NEW.allowance_id AND state='dispatched') THEN RAISE EXCEPTION 'Public execution requires dispatched allowance' USING ERRCODE='23514';END IF;
 IF NEW.state='completed' AND NOT EXISTS(SELECT 1 FROM answer_runs a WHERE a.id=NEW.execution_key AND a.state='completed' AND a.input=NEW.input AND a.config=p.manifest->'answerConfig' AND a.answer=NEW.answer AND a.release_id=p.release_id) THEN RAISE EXCEPTION 'Public result must match the pinned completed answer' USING ERRCODE='23514';END IF;
 END IF;RETURN NEW;
 END $$;

 CREATE TABLE wechat_login_attempts(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),session_id uuid NOT NULL REFERENCES browser_sessions(id),app_id text NOT NULL,redirect_uri text NOT NULL,state_hash text NOT NULL UNIQUE,binding_hash text NOT NULL UNIQUE,code_hash text UNIQUE,state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','exchanging','succeeded','failed')),error_code text,expires_at timestamptz NOT NULL DEFAULT(clock_timestamp()+interval '10 minutes'),created_at timestamptz NOT NULL DEFAULT now(),finished_at timestamptz);
 CREATE INDEX wechat_attempts_session_created ON wechat_login_attempts(session_id,created_at);
 CREATE INDEX wechat_attempts_created ON wechat_login_attempts(created_at);
 CREATE FUNCTION guard_account_record() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Account ownership records are immutable' USING ERRCODE='23514';END IF;
 IF TG_TABLE_NAME='guest_account_claims' THEN
 IF NOT EXISTS(SELECT 1 FROM public_principals WHERE id=NEW.guest_principal_id AND kind='guest') OR NOT EXISTS(SELECT 1 FROM public_principals WHERE id=NEW.account_principal_id AND kind='member') THEN RAISE EXCEPTION 'Claim must bind guest to member' USING ERRCODE='23514';END IF;
 ELSE
 IF NOT EXISTS(SELECT 1 FROM public_principals WHERE id=NEW.principal_id AND kind='member') THEN RAISE EXCEPTION 'WeChat identity requires member principal' USING ERRCODE='23514';END IF;
 END IF;RETURN NEW;
 END $$;
 CREATE TRIGGER wechat_identity_guard BEFORE INSERT OR UPDATE OR DELETE ON wechat_identities FOR EACH ROW EXECUTE FUNCTION guard_account_record();
 CREATE TRIGGER guest_account_claim_guard BEFORE INSERT OR UPDATE OR DELETE ON guest_account_claims FOR EACH ROW EXECUTE FUNCTION guard_account_record();
 CREATE FUNCTION guard_principal_identity() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Principal identity cannot change' USING ERRCODE='23514';END $$;
 CREATE TRIGGER principal_identity_guard BEFORE UPDATE OR DELETE ON public_principals FOR EACH ROW EXECUTE FUNCTION guard_principal_identity();
 CREATE FUNCTION guard_wechat_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Login attempts cannot be deleted before retention cleanup' USING ERRCODE='23514';END IF;
 IF ROW(NEW.id,NEW.session_id,NEW.app_id,NEW.redirect_uri,NEW.state_hash,NEW.binding_hash,NEW.expires_at,NEW.created_at) IS DISTINCT FROM ROW(OLD.id,OLD.session_id,OLD.app_id,OLD.redirect_uri,OLD.state_hash,OLD.binding_hash,OLD.expires_at,OLD.created_at) OR NOT ((OLD.state='pending' AND NEW.state IN ('exchanging','failed')) OR (OLD.state='exchanging' AND NEW.state IN ('succeeded','failed'))) OR (OLD.code_hash IS NOT NULL AND NEW.code_hash IS DISTINCT FROM OLD.code_hash) THEN RAISE EXCEPTION 'Login state is immutable or consumed' USING ERRCODE='23514';END IF;RETURN NEW;
 END $$;
 CREATE TRIGGER wechat_attempt_guard BEFORE UPDATE OR DELETE ON wechat_login_attempts FOR EACH ROW EXECUTE FUNCTION guard_wechat_attempt();
 `);
  }
  async down(q: QueryRunner) {
    await q.query(`
 DO $$ BEGIN IF EXISTS(SELECT 1 FROM public_principals WHERE kind='member') THEN RAISE EXCEPTION 'Cannot revert accounts while members exist; export or restore a backup first';END IF;END $$;
 CREATE OR REPLACE FUNCTION guard_public_turn() RETURNS trigger LANGUAGE plpgsql AS $$
 DECLARE c public_conversations%ROWTYPE;p knowledge_publications%ROWTYPE;expected integer;
 BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Public turns cannot be deleted' USING ERRCODE='23514';END IF;
 SELECT * INTO c FROM public_conversations WHERE id=NEW.conversation_id FOR UPDATE;
 SELECT * INTO p FROM knowledge_publications WHERE id=c.publication_id;
 IF TG_OP='INSERT' THEN
 SELECT coalesce(max(sequence),0)+1 INTO expected FROM public_turns WHERE conversation_id=c.id;
 IF NEW.state<>'prepared' OR NEW.sequence<>expected OR NOT EXISTS(SELECT 1 FROM publication_heads WHERE ruleset_id=c.ruleset_id AND publication_id=p.id) OR (NEW.input->>'idempotencyKey')::uuid IS DISTINCT FROM NEW.execution_key OR NEW.input->>'question' IS DISTINCT FROM NEW.question OR NEW.input->'retrieval' IS DISTINCT FROM p.manifest->'retrieval' OR NOT EXISTS(SELECT 1 FROM question_allowances WHERE id=NEW.allowance_id AND principal_id=c.principal_id AND state='reserved') THEN RAISE EXCEPTION 'Public turn must match conversation, input and reserved allowance' USING ERRCODE='23514';END IF;
 ELSE
 IF OLD.state IN ('completed','failed') OR ROW(NEW.id,NEW.conversation_id,NEW.sequence,NEW.question,NEW.input,NEW.execution_key,NEW.allowance_id,NEW.created_at) IS DISTINCT FROM ROW(OLD.id,OLD.conversation_id,OLD.sequence,OLD.question,OLD.input,OLD.execution_key,OLD.allowance_id,OLD.created_at) OR NOT ((OLD.state='prepared' AND NEW.state IN ('running','failed')) OR (OLD.state='running' AND NEW.state IN ('completed','failed'))) THEN RAISE EXCEPTION 'Turn identity/terminal result is immutable or transition invalid' USING ERRCODE='23514';END IF;
 IF NEW.state='running' AND NOT EXISTS(SELECT 1 FROM question_allowances WHERE id=NEW.allowance_id AND state='dispatched') THEN RAISE EXCEPTION 'Public execution requires dispatched allowance' USING ERRCODE='23514';END IF;
 IF NEW.state='completed' AND NOT EXISTS(SELECT 1 FROM answer_runs a WHERE a.id=NEW.execution_key AND a.state='completed' AND a.input=NEW.input AND a.config=p.manifest->'answerConfig' AND a.answer=NEW.answer AND a.release_id=p.release_id) THEN RAISE EXCEPTION 'Public result must match the pinned completed answer' USING ERRCODE='23514';END IF;
 END IF;RETURN NEW;
 END $$;

 DROP TABLE wechat_login_attempts,guest_account_claims,wechat_identities;DROP FUNCTION guard_account_record(),guard_wechat_attempt(),principal_scope(uuid);DROP TRIGGER principal_identity_guard ON public_principals;DROP FUNCTION guard_principal_identity();ALTER TABLE public_principals DROP CONSTRAINT public_principals_kind_check;ALTER TABLE public_principals ADD CHECK(kind='guest');
 `);
  }
}
