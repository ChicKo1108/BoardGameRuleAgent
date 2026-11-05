import type { MigrationInterface, QueryRunner } from "typeorm";
export class PublicConversations1793836810000 implements MigrationInterface {
  name = "PublicConversations1793836810000";
  async up(q: QueryRunner) {
    await q.query(`
 CREATE TABLE public_conversations(id uuid PRIMARY KEY,principal_id uuid NOT NULL REFERENCES public_principals(id),ruleset_id uuid NOT NULL REFERENCES rulesets(id),publication_id uuid NOT NULL REFERENCES knowledge_publications(id),created_at timestamptz NOT NULL DEFAULT now());
 CREATE TABLE public_turns(id uuid PRIMARY KEY,conversation_id uuid NOT NULL REFERENCES public_conversations(id),sequence integer NOT NULL CHECK(sequence>0),question text NOT NULL,input jsonb NOT NULL,execution_key uuid NOT NULL UNIQUE,allowance_id uuid NOT NULL UNIQUE REFERENCES question_allowances(id),state text NOT NULL DEFAULT 'prepared' CHECK(state IN ('prepared','running','completed','failed')),answer jsonb,error_code text,expires_at timestamptz NOT NULL DEFAULT(clock_timestamp()+interval '2 minutes'),created_at timestamptz NOT NULL DEFAULT now(),finished_at timestamptz,UNIQUE(conversation_id,sequence),CHECK((state IN ('completed','failed'))=(finished_at IS NOT NULL)),CHECK((state='completed')=(answer IS NOT NULL)));
 CREATE UNIQUE INDEX public_turns_one_pending ON public_turns(conversation_id) WHERE state IN ('prepared','running');
 CREATE INDEX public_conversations_owner ON public_conversations(principal_id,created_at);
 CREATE FUNCTION guard_public_conversation() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Conversation identity is immutable' USING ERRCODE='23514';END IF;
 IF NOT EXISTS(SELECT 1 FROM publication_heads h JOIN knowledge_publications p ON p.id=h.publication_id WHERE h.ruleset_id=NEW.ruleset_id AND p.id=NEW.publication_id AND p.passed) THEN RAISE EXCEPTION 'Conversation requires an activated publication' USING ERRCODE='23514';END IF;RETURN NEW;
 END $$;
 CREATE TRIGGER public_conversation_guard BEFORE INSERT OR UPDATE OR DELETE ON public_conversations FOR EACH ROW EXECUTE FUNCTION guard_public_conversation();
 CREATE FUNCTION guard_public_turn() RETURNS trigger LANGUAGE plpgsql AS $$
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
 CREATE TRIGGER public_turn_guard BEFORE INSERT OR UPDATE OR DELETE ON public_turns FOR EACH ROW EXECUTE FUNCTION guard_public_turn();
 `);
  }
  async down(q: QueryRunner) {
    await q.query(
      "DROP TABLE public_turns,public_conversations;DROP FUNCTION guard_public_turn(),guard_public_conversation();",
    );
  }
}
