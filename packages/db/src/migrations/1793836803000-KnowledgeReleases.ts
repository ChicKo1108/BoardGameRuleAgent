import type { MigrationInterface, QueryRunner } from "typeorm";
export class KnowledgeReleases1793836803000 implements MigrationInterface {
  name = "KnowledgeReleases1793836803000";
  async up(q: QueryRunner) {
    await q.query(`
 CREATE TABLE knowledge_releases(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),ruleset_id uuid NOT NULL REFERENCES rulesets(id),name text NOT NULL CHECK(length(trim(name))>0),
 state text NOT NULL DEFAULT 'assembling' CHECK(state IN ('assembling','sealed')),manifest jsonb NOT NULL DEFAULT '{}',manifest_hash text,
 created_at timestamptz NOT NULL DEFAULT now(),CHECK(manifest_hash IS NULL OR manifest_hash ~ '^[a-f0-9]{64}$'));
 CREATE INDEX releases_ruleset_idx ON knowledge_releases(ruleset_id,created_at);
 CREATE FUNCTION guard_versioned_ruleset() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN
 IF EXISTS(SELECT 1 FROM knowledge_releases WHERE ruleset_id=OLD.id) THEN RAISE EXCEPTION 'Versioned ruleset identity is immutable; create a new ruleset' USING ERRCODE='23514'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
 END $$;
 CREATE TRIGGER versioned_ruleset_guard BEFORE UPDATE OR DELETE ON rulesets FOR EACH ROW EXECUTE FUNCTION guard_versioned_ruleset();
 CREATE TABLE release_revisions(release_id uuid NOT NULL REFERENCES knowledge_releases(id),revision_id uuid NOT NULL REFERENCES document_revisions(id),document_id uuid NOT NULL REFERENCES source_documents(id),PRIMARY KEY(release_id,revision_id),UNIQUE(release_id,document_id));
 CREATE TABLE release_members(release_id uuid NOT NULL,revision_id uuid NOT NULL,rule_unit_id uuid NOT NULL,PRIMARY KEY(release_id,rule_unit_id),FOREIGN KEY(release_id,revision_id) REFERENCES release_revisions(release_id,revision_id),FOREIGN KEY(rule_unit_id,revision_id) REFERENCES rule_units(id,revision_id));

 CREATE FUNCTION build_knowledge_manifest(target uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT jsonb_build_object('schemaVersion',1,
 'ruleset',jsonb_build_object('id',rs.id,'gameId',rs.game_id,'name',rs.name,'language',rs.language,'scope',rs.scope),
 'documents',(SELECT jsonb_agg(jsonb_build_object('id',d.id,'revisionId',v.id,'revisionNumber',v.number,'title',d.title,'sourceType',d.source_type,'sha256',d.sha256) ORDER BY v.id) FROM release_revisions rr JOIN document_revisions v ON v.id=rr.revision_id JOIN source_documents d ON d.id=v.document_id WHERE rr.release_id=target),
 'rules',(SELECT jsonb_agg(jsonb_build_object('id',u.id,'revisionId',u.revision_id,'kind',u.kind,'reviewedText',u.reviewed_text,'sectionPath',u.section_path,'applicability',u.applicability,'explanation',u.explanation,
 'sources',(SELECT jsonb_agg(jsonb_build_object('id',b.id,'ordinal',b.ordinal,'kind',b.kind,'rawText',b.raw_text,'pdfPageIndex',b.pdf_page_index,'printedPageLabel',b.printed_page_label,'bbox',b.bbox) ORDER BY b.ordinal,b.id) FROM rule_sources s JOIN source_blocks b ON b.id=s.block_id WHERE s.rule_unit_id=u.id)) ORDER BY u.id) FROM release_members m JOIN rule_units u ON u.id=m.rule_unit_id WHERE m.release_id=target),
 'relations',COALESCE((SELECT jsonb_agg(jsonb_build_object('fromRuleId',l.from_rule_id,'toRuleId',l.to_rule_id,'kind',l.kind) ORDER BY l.from_rule_id,l.to_rule_id,l.kind) FROM rule_relations l JOIN release_members m ON m.rule_unit_id=l.from_rule_id AND m.release_id=target JOIN release_members n ON n.rule_unit_id=l.to_rule_id AND n.release_id=target),'[]'::jsonb))
 FROM knowledge_releases kr JOIN rulesets rs ON rs.id=kr.ruleset_id WHERE kr.id=target
 $$;

 CREATE FUNCTION guard_release_content() RETURNS trigger LANGUAGE plpgsql AS $$
 DECLARE target uuid; current_state text; scope_id uuid;
 BEGIN
 IF TG_OP='UPDATE' AND NEW.release_id<>OLD.release_id THEN RAISE EXCEPTION 'Release identity is immutable' USING ERRCODE='23514'; END IF;
 IF TG_OP='DELETE' THEN target:=OLD.release_id; ELSE target:=NEW.release_id; END IF;
 SELECT state,ruleset_id INTO current_state,scope_id FROM knowledge_releases WHERE id=target FOR UPDATE;
 IF current_state<>'assembling' THEN RAISE EXCEPTION 'Sealed release is immutable' USING ERRCODE='23514'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 IF TG_TABLE_NAME='release_revisions' THEN
   IF NOT EXISTS(SELECT 1 FROM document_revisions v JOIN source_documents d ON d.id=v.document_id WHERE v.id=NEW.revision_id AND v.status='approved' AND d.ruleset_id=scope_id AND d.id=NEW.document_id) THEN
    RAISE EXCEPTION 'Release requires approved revisions in its ruleset' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
 END $$;
 CREATE TRIGGER release_revisions_guard BEFORE INSERT OR UPDATE OR DELETE ON release_revisions FOR EACH ROW EXECUTE FUNCTION guard_release_content();
 CREATE TRIGGER release_members_guard BEFORE INSERT OR UPDATE OR DELETE ON release_members FOR EACH ROW EXECUTE FUNCTION guard_release_content();
 CREATE FUNCTION guard_release() RETURNS trigger LANGUAGE plpgsql AS $$
 DECLARE members integer; expected integer; bytes bigint;
 BEGIN
 IF TG_OP='INSERT' THEN
   IF NEW.state<>'assembling' OR NEW.manifest<>'{}'::jsonb OR NEW.manifest_hash IS NOT NULL THEN RAISE EXCEPTION 'Release must start assembling' USING ERRCODE='23514'; END IF;
   RETURN NEW;
 END IF;
 IF OLD.state='sealed' THEN RAISE EXCEPTION 'Sealed release is immutable' USING ERRCODE='23514'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 IF NEW.id<>OLD.id OR NEW.ruleset_id<>OLD.ruleset_id THEN RAISE EXCEPTION 'Release identity is immutable' USING ERRCODE='23514'; END IF;
 IF NEW.state='sealed' THEN
   SELECT count(*) INTO members FROM release_members WHERE release_id=NEW.id;
   SELECT count(*) INTO expected FROM release_revisions r JOIN rule_units u ON u.revision_id=r.revision_id WHERE r.release_id=NEW.id;
   IF members=0 OR members<>expected OR members>2000 THEN RAISE EXCEPTION 'Release must include every approved rule (maximum 2000)' USING ERRCODE='23514'; END IF;
   SELECT sum(octet_length(u.reviewed_text)+octet_length(b.raw_text)) INTO bytes FROM release_members m JOIN rule_units u ON u.id=m.rule_unit_id JOIN rule_sources s ON s.rule_unit_id=u.id JOIN source_blocks b ON b.id=s.block_id WHERE m.release_id=NEW.id;
   IF bytes>8388608 THEN RAISE EXCEPTION 'Release content exceeds limit' USING ERRCODE='23514'; END IF;
   NEW.manifest:=build_knowledge_manifest(NEW.id);
   IF octet_length(NEW.manifest::text)>8388608 THEN RAISE EXCEPTION 'Release manifest exceeds limit' USING ERRCODE='23514'; END IF;
   NEW.manifest_hash:=encode(sha256(convert_to(NEW.manifest::text,'UTF8')),'hex');
 ELSE
   IF NEW.manifest<>'{}'::jsonb OR NEW.manifest_hash IS NOT NULL THEN RAISE EXCEPTION 'Manifest is built only when sealing' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
 END $$;
 CREATE TRIGGER knowledge_releases_guard BEFORE INSERT OR UPDATE OR DELETE ON knowledge_releases FOR EACH ROW EXECUTE FUNCTION guard_release();

 CREATE TABLE index_builds(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),release_id uuid NOT NULL REFERENCES knowledge_releases(id),state text NOT NULL DEFAULT 'building' CHECK(state IN ('building','ready')),config jsonb NOT NULL,config_hash text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(release_id,config_hash),UNIQUE(id,release_id));
 CREATE TABLE retrieval_chunks(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),build_id uuid NOT NULL,release_id uuid NOT NULL,rule_unit_id uuid NOT NULL,content text NOT NULL,lexical_text text NOT NULL,
 search_vector tsvector GENERATED ALWAYS AS (to_tsvector('simple'::regconfig,lexical_text)) STORED,
 UNIQUE(build_id,rule_unit_id),FOREIGN KEY(build_id,release_id) REFERENCES index_builds(id,release_id),FOREIGN KEY(release_id,rule_unit_id) REFERENCES release_members(release_id,rule_unit_id));
 CREATE INDEX chunks_search_idx ON retrieval_chunks USING gin(search_vector);
 CREATE FUNCTION guard_index_build() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN
 IF TG_OP='INSERT' THEN
   IF NEW.state<>'building' OR NOT EXISTS(SELECT 1 FROM knowledge_releases WHERE id=NEW.release_id AND state='sealed') THEN RAISE EXCEPTION 'Index requires a sealed release and starts building' USING ERRCODE='23514'; END IF;
   NEW.config_hash:=encode(sha256(convert_to(NEW.config::text,'UTF8')),'hex'); RETURN NEW;
 END IF;
 IF OLD.state='ready' THEN RAISE EXCEPTION 'Ready index is immutable' USING ERRCODE='23514'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 IF NEW.id<>OLD.id OR NEW.release_id<>OLD.release_id OR NEW.config<>OLD.config OR NEW.config_hash<>OLD.config_hash THEN RAISE EXCEPTION 'Index identity is immutable' USING ERRCODE='23514'; END IF;
 IF NEW.state='ready' THEN
   IF (SELECT count(*) FROM retrieval_chunks WHERE build_id=NEW.id)<>(SELECT count(*) FROM release_members WHERE release_id=NEW.release_id) THEN RAISE EXCEPTION 'Index must cover every rule' USING ERRCODE='23514'; END IF;
 END IF; RETURN NEW;
 END $$;
 CREATE TRIGGER index_builds_guard BEFORE INSERT OR UPDATE OR DELETE ON index_builds FOR EACH ROW EXECUTE FUNCTION guard_index_build();
 CREATE FUNCTION guard_chunk() RETURNS trigger LANGUAGE plpgsql AS $$
 DECLARE target uuid; current_state text;
 BEGIN
 IF TG_OP='UPDATE' AND (NEW.build_id<>OLD.build_id OR NEW.release_id<>OLD.release_id) THEN RAISE EXCEPTION 'Chunk identity is immutable' USING ERRCODE='23514'; END IF;
 IF TG_OP='DELETE' THEN target:=OLD.build_id; ELSE target:=NEW.build_id; END IF;
 SELECT state INTO current_state FROM index_builds WHERE id=target FOR UPDATE;
 IF current_state<>'building' THEN RAISE EXCEPTION 'Ready index is immutable' USING ERRCODE='23514'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
 END $$;
 CREATE TRIGGER retrieval_chunks_guard BEFORE INSERT OR UPDATE OR DELETE ON retrieval_chunks FOR EACH ROW EXECUTE FUNCTION guard_chunk();
 `);
  }
  async down(q: QueryRunner) {
    await q.query(
      `DROP TRIGGER versioned_ruleset_guard ON rulesets;DROP FUNCTION guard_versioned_ruleset();DROP TABLE retrieval_chunks,index_builds,release_members,release_revisions,knowledge_releases;DROP FUNCTION guard_chunk(),guard_index_build(),guard_release(),guard_release_content(),build_knowledge_manifest(uuid);`,
    );
  }
}
