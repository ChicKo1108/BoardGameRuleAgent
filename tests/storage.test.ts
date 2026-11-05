import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { testDatabase } from "./helpers/database.js";
import { KnowledgeRepository, SourceBlockEntity, RuleUnitEntity } from "../packages/db/src/index.js";
let fixture: Awaited<ReturnType<typeof testDatabase>>;
let repo: KnowledgeRepository;
before(async () => { fixture = await testDatabase(); await fixture.db.runMigrations(); repo = new KnowledgeRepository(fixture.db); });
after(async () => { if (fixture) await fixture.close(); });
async function document() {
  const game = await repo.createGame({ slug: `test-${randomUUID()}`, name: "合成测试游戏（非真实规则）" });
  const ruleset = await repo.createRuleset({ gameId: game.id, name: "基础", language: "zh-CN", scope: "测试" });
  return repo.createDocument({ rulesetId: ruleset.id, title: "测试资料", sourceType: "rulebook", objectKey: `test/${game.id}.pdf`, sha256: "a".repeat(64) });
}
async function reviewed() {
  const doc = await document(); const revision = await repo.createRevision(doc.id);
  const [block] = await repo.saveParsedBlocks(revision.id, [{ ordinal: 0, kind: "text", rawText: "测试规则：每次取一个。", pdfPageIndex: 0, printedPageLabel: "1", bbox: [0, 0, 100, 50] }]);
  const rule = await repo.addRule({ revisionId: revision.id, kind: "rule", reviewedText: block.rawText, sectionPath: ["取物"], applicability: [], explanation: null, reviewStatus: "approved" }, [block.id]);
  return { doc, revision, block, rule };
}
test("migrations are idempotent; concurrent revision creation assigns unique numbers", async () => {
  assert.equal((await fixture.db.runMigrations()).length, 0);
  const doc = await document();
  const revisions = await Promise.all(Array.from({ length: 5 }, () => repo.createRevision(doc.id)));
  assert.deepEqual(revisions.map(r => r.number).sort(), [1,2,3,4,5]);
});
test("approval freezes rules, raw sources, provenance links and document identity", async () => {
  const { doc, revision, block, rule } = await reviewed();
  await repo.approveRevision(revision.id);
  await assert.rejects(fixture.db.getRepository(RuleUnitEntity).update(rule.id, { reviewedText: "篡改" }), /immutable/);
  await assert.rejects(fixture.db.getRepository(SourceBlockEntity).update(block.id, { rawText: "篡改" }), /immutable/);
  await assert.rejects(fixture.db.query("DELETE FROM rule_sources WHERE rule_unit_id=$1", [rule.id]), /immutable/);
  await assert.rejects(fixture.db.query("UPDATE document_revisions SET status='awaiting_review' WHERE id=$1", [revision.id]), /immutable/);
  await assert.rejects(fixture.db.query("UPDATE source_documents SET object_key='other' WHERE id=$1", [doc.id]), /immutable/);
});
test("cross-revision provenance is rejected and failed rule insertion rolls back", async () => {
  const a = await reviewed(); const b = await reviewed();
  const count = await fixture.db.getRepository(RuleUnitEntity).count();
  await assert.rejects(repo.addRule({ ...a.rule, revisionId: a.revision.id }, [b.block.id]), /foreign key/);
  assert.equal(await fixture.db.getRepository(RuleUnitEntity).count(), count);
  await assert.rejects(fixture.db.query("UPDATE source_blocks SET revision_id=$1 WHERE id=$2", [b.revision.id, a.block.id]), /cannot move/);
});
test("a revision cannot be created already approved", async () => {
  const doc = await document();
  await assert.rejects(fixture.db.query("INSERT INTO document_revisions(document_id,number,status) VALUES ($1,1,'approved')", [doc.id]), /must start uploaded/);
});
test("approval requires reviewed rules with evidence, not merely parsed text", async () => {
  const a = await reviewed();
  await fixture.db.getRepository(RuleUnitEntity).update(a.rule.id, { reviewStatus: "pending" });
  await assert.rejects(repo.approveRevision(a.revision.id), /approval and sources/);
  await fixture.db.getRepository(RuleUnitEntity).update(a.rule.id, { reviewStatus: "approved" });
  await fixture.db.query("DELETE FROM rule_sources WHERE rule_unit_id=$1", [a.rule.id]);
  await assert.rejects(repo.approveRevision(a.revision.id), /approval and sources/);
});
test("revision approval serializes concurrent content edits", async () => {
  const a = await reviewed();
  const tx = fixture.db.createQueryRunner(); await tx.connect(); await tx.startTransaction();
  try {
    await tx.query("SELECT id FROM document_revisions WHERE id=$1 FOR UPDATE", [a.revision.id]);
    await tx.query("UPDATE document_revisions SET status='approved' WHERE id=$1", [a.revision.id]);
    const edit = assert.rejects(fixture.db.query("UPDATE rule_units SET reviewed_text='racing edit' WHERE id=$1", [a.rule.id]), /immutable/);
    await tx.commitTransaction(); await edit;
  } finally { if (tx.isTransactionActive) await tx.rollbackTransaction(); await tx.release(); }
});
test("migration rollback and reapply work on an empty isolated database", async () => {
  const other = await testDatabase();
  try {
    await other.db.runMigrations(); for (let i = 0; i < other.db.migrations.length; i++) await other.db.undoLastMigration();
    assert.equal((await other.db.query("SELECT to_regclass('public.games') AS name"))[0].name, null);
    assert.equal((await other.db.runMigrations()).length, other.db.migrations.length);
  } finally { await other.close(); }
});
