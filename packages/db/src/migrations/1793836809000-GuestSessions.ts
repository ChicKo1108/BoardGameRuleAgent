import type { MigrationInterface, QueryRunner } from "typeorm";
export class GuestSessions1793836809000 implements MigrationInterface {
  name = "GuestSessions1793836809000";
  async up(q: QueryRunner) {
    await q.query(`
 CREATE TABLE public_principals(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),kind text NOT NULL DEFAULT 'guest' CHECK(kind='guest'),created_at timestamptz NOT NULL DEFAULT now());
 CREATE TABLE browser_sessions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),principal_id uuid NOT NULL REFERENCES public_principals(id),token_hash text NOT NULL UNIQUE CHECK(token_hash ~ '^[a-f0-9]{64}$'),expires_at timestamptz NOT NULL,revoked_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),CHECK(expires_at>created_at));
 CREATE INDEX browser_sessions_expiry ON browser_sessions(expires_at);
 CREATE TABLE session_mint_windows(window_start timestamptz PRIMARY KEY,minted integer NOT NULL CHECK(minted>=0));
 CREATE TABLE question_allowances(id uuid PRIMARY KEY,principal_id uuid NOT NULL REFERENCES public_principals(id),request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),quota_day date NOT NULL DEFAULT (timezone('Asia/Shanghai',clock_timestamp())::date),state text NOT NULL DEFAULT 'reserved' CHECK(state IN ('reserved','dispatched','settled','released')),expires_at timestamptz NOT NULL DEFAULT (clock_timestamp()+interval '2 minutes'),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
 CREATE INDEX question_allowances_day ON question_allowances(quota_day,principal_id,state);
 CREATE FUNCTION guard_browser_session() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Sessions must be revoked before retention cleanup' USING ERRCODE='23514';END IF;
 IF ROW(NEW.id,NEW.principal_id,NEW.token_hash,NEW.expires_at,NEW.created_at) IS DISTINCT FROM ROW(OLD.id,OLD.principal_id,OLD.token_hash,OLD.expires_at,OLD.created_at) OR OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL THEN RAISE EXCEPTION 'Session identity is immutable; revocation is terminal' USING ERRCODE='23514';END IF;RETURN NEW;
 END $$;
 CREATE TRIGGER browser_session_guard BEFORE UPDATE OR DELETE ON browser_sessions FOR EACH ROW EXECUTE FUNCTION guard_browser_session();
 CREATE FUNCTION guard_question_allowance() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Allowances cannot be deleted' USING ERRCODE='23514';END IF;
 IF TG_OP='INSERT' THEN
 IF NEW.state<>'reserved' OR NEW.quota_day<>timezone('Asia/Shanghai',clock_timestamp())::date THEN RAISE EXCEPTION 'Allowance must begin reserved for the current quota day' USING ERRCODE='23514';END IF;
 ELSE
 IF ROW(NEW.id,NEW.principal_id,NEW.request_hash,NEW.quota_day,NEW.expires_at,NEW.created_at) IS DISTINCT FROM ROW(OLD.id,OLD.principal_id,OLD.request_hash,OLD.quota_day,OLD.expires_at,OLD.created_at) OR NOT ((OLD.state='reserved' AND NEW.state IN ('released','dispatched')) OR (OLD.state='dispatched' AND NEW.state='settled')) THEN RAISE EXCEPTION 'Allowance identity is immutable or transition invalid' USING ERRCODE='23514';END IF;
 IF NEW.state='dispatched' AND (OLD.expires_at<=clock_timestamp() OR OLD.quota_day<>timezone('Asia/Shanghai',clock_timestamp())::date) THEN RAISE EXCEPTION 'Expired allowance cannot dispatch' USING ERRCODE='23514';END IF;
 END IF;RETURN NEW;
 END $$;
 CREATE TRIGGER question_allowance_guard BEFORE INSERT OR UPDATE OR DELETE ON question_allowances FOR EACH ROW EXECUTE FUNCTION guard_question_allowance();
 `);
  }
  async down(q: QueryRunner) {
    await q.query(
      "DROP TABLE question_allowances,session_mint_windows,browser_sessions,public_principals;DROP FUNCTION guard_browser_session(),guard_question_allowance();",
    );
  }
}
