import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { testDatabase } from "./helpers/database.js";
import { KnowledgeRepository } from "../packages/db/src/index.ts";
import {
  KnowledgeIndexService,
  draftBm25Sql,
  lexicalQuery,
  buildLexicalChunk,
  lexicalConfiguration,
} from "../packages/retrieval/src/index.ts";
import {
  handleAdmin,
  openApiDocument,
  diagnoseDraft,
  curationSourceFingerprint,
} from "../packages/backend/src/index.ts";
import { curationSchemas as c } from "../packages/contracts/src/index.ts";
let fixture: Awaited<ReturnType<typeof testDatabase>>,
  repo: KnowledgeRepository,
  service: KnowledgeIndexService;
before(async () => {
  fixture = await testDatabase();
  await fixture.db.runMigrations();
  repo = new KnowledgeRepository(fixture.db);
  service = new KnowledgeIndexService(fixture.db);
});
after(async () => {
  if (fixture) await fixture.close();
});
async function seed(
  texts = ["a rare", "a ".repeat(40) + "filler", "a filler"],
) {
  const game = await repo.createGame({
      slug: "bm25-" + randomUUID(),
      name: "Synthetic corpus",
    }),
    rs = await repo.createRuleset({
      gameId: game.id,
      name: "base",
      language: "zh-CN",
      scope: "Synthetic only",
    }),
    doc = await repo.createDocument({
      rulesetId: rs.id,
      title: "Synthetic source",
      sourceType: "rulebook",
      objectKey: "test/" + randomUUID() + ".pdf",
      sha256: "a".repeat(64),
    }),
    rev = await repo.createRevision(doc.id),
    blocks = await repo.saveParsedBlocks(
      rev.id,
      texts.map((rawText, ordinal) => ({
        ordinal,
        kind: "text" as const,
        rawText,
        pdfPageIndex: ordinal,
        printedPageLabel: null,
        bbox: [0, 0, 10, 10] as [number, number, number, number],
      })),
    ),
    rules = [];
  for (let i = 0; i < texts.length; i++)
    rules.push(
      await repo.addRule(
        {
          revisionId: rev.id,
          kind: "rule",
          reviewedText: texts[i],
          sectionPath: [],
          applicability: [],
          explanation: null,
          reviewStatus: "approved",
        },
        [blocks[i].id],
      ),
    );
  await repo.approveRevision(rev.id);
  const release = await service.createRelease(
    rs.id,
    { name: "corpus", revisionIds: [rev.id] },
    randomUUID(),
  );
  return { release, rules };
}
test("BM25 is explicitly versioned, idempotent, and corrects frequent common-word dominance", async () => {
  const { release, rules } = await seed(),
    old = await service.build(release.id, randomUUID());
  const builds = await Promise.all(
      Array.from({ length: 3 }, () =>
        service.build(release.id, randomUUID(), { ranker: "bm25-v1" }),
      ),
    ),
    index = builds[0];
  assert.equal(new Set(builds.map((b) => b.id)).size, 1);
  assert.notEqual(old.id, index.id);
  assert.notEqual(old.configHash, index.configHash);
  assert.equal(old.config.schemaVersion, 1);
  assert.equal(index.config.schemaVersion, 2);
  assert.equal(
    (await service.search(old.id, { query: "rare a" })).hits[0].ruleId,
    rules[1].id,
  );
  const ranked = await service.search(index.id, { query: "rare a" });
  assert.equal(ranked.hits[0].ruleId, rules[0].id);
  // Independent three-document example: lengths 2,41,2; df(a)=3 and df(rare)=1.
  const tf = (n: number, len: number) =>
    (n * 2.2) / (n + 1.2 * (0.25 + (0.75 * len) / 15));
  const expected =
    (Math.log(1 + 2.5 / 1.5) + Math.log(1 + 0.5 / 3.5)) * tf(1, 2);
  assert.ok(Math.abs(ranked.hits[0].score - expected) < 1e-12);
  const [stats] = await fixture.db.query(
    "SELECT document_count,total_tokens FROM bm25_corpora WHERE build_id=$1",
    [index.id],
  );
  assert.equal(stats.document_count, 3);
  assert.equal(Number(stats.total_tokens), 45);
  assert.equal(
    (
      await fixture.db.query(
        "SELECT count(*)::int AS n FROM bm25_documents WHERE build_id=$1",
        [old.id],
      )
    )[0].n,
    0,
  );
  assert.equal(
    (await service.search(old.id, { query: "rare a" })).hits[0].ruleId,
    rules[1].id,
  );
});
test("database derives BM25 statistics when sealing; forged building statistics cannot become ready", async () => {
  const { release } = await seed(),
    config = lexicalConfiguration("bm25-v1"),
    manifest = await service.manifest(release.id);
  const [index] = await fixture.db.query(
    "INSERT INTO index_builds(release_id,config,config_hash) VALUES($1,$2,'') RETURNING id",
    [release.id, JSON.stringify(config)],
  );
  for (const r of manifest.rules) {
    const chunk = buildLexicalChunk(r);
    await fixture.db.query(
      "INSERT INTO retrieval_chunks(build_id,release_id,rule_unit_id,content,lexical_text) VALUES($1,$2,$3,$4,$5)",
      [index.id, release.id, r.id, chunk.content, chunk.lexicalText],
    );
  }
  await fixture.db.query("INSERT INTO bm25_corpora VALUES($1,$2,999,999)", [
    index.id,
    release.id,
  ]);
  await fixture.db.query("INSERT INTO bm25_terms VALUES($1,$2,'rare',999)", [
    index.id,
    release.id,
  ]);
  await fixture.db.query("UPDATE index_builds SET state='ready' WHERE id=$1", [
    index.id,
  ]);
  assert.equal(
    (
      await fixture.db.query(
        "SELECT document_count FROM bm25_corpora WHERE build_id=$1",
        [index.id],
      )
    )[0].document_count,
    3,
  );
  assert.equal(
    (
      await fixture.db.query(
        "SELECT document_frequency FROM bm25_terms WHERE build_id=$1 AND term='rare'",
        [index.id],
      )
    )[0].document_frequency,
    1,
  );
  for (const sql of [
    "UPDATE bm25_corpora SET document_count=999 WHERE build_id=$1",
    "DELETE FROM bm25_terms WHERE build_id=$1",
    "UPDATE bm25_documents SET token_count=1 WHERE build_id=$1",
  ]) {
    await assert.rejects(fixture.db.query(sql, [index.id]), /immutable/);
  }
  await assert.rejects(
    fixture.db.query("INSERT INTO bm25_terms VALUES($1,$2,'forged',1)", [
      index.id,
      release.id,
    ]),
    /immutable/,
  );
  const [audit] = await fixture.db.query(
    "SELECT count(*)::int AS n FROM admin_audit_events WHERE target_id=$1 AND action='index.ready'",
    [index.id],
  );
  assert.equal(audit.n, 0); // DB correctness does not depend on application audit execution.
});
test("statistics and scores cannot be contaminated by another release or index", async () => {
  const a = await seed(),
    ia = await service.build(a.release.id, randomUUID(), { ranker: "bm25-v1" }),
    before = await service.search(ia.id, { query: "rare a" }),
    b = await seed(["rare ".repeat(30), "rare another", "unrelated"]),
    ib = await service.build(b.release.id, randomUUID(), { ranker: "bm25-v1" });
  assert.deepEqual(await service.search(ia.id, { query: "rare a" }), before);
  const [chunk] = await fixture.db.query(
    "SELECT id FROM retrieval_chunks WHERE build_id=$1",
    [ib.id],
  );
  const [pending] = await fixture.db.query(
    "INSERT INTO index_builds(release_id,config,config_hash) VALUES($1,$2,'') RETURNING id",
    [
      a.release.id,
      JSON.stringify({
        ...lexicalConfiguration("bm25-v1"),
        icuVersion: "incompatible",
      }),
    ],
  );
  await assert.rejects(
    fixture.db.query(
      "INSERT INTO bm25_documents VALUES($1,$2,$3,1,'{\"forged\":1}')",
      [chunk.id, pending.id, a.release.id],
    ),
    /outside index/,
  );
  await assert.rejects(
    fixture.db.query("UPDATE index_builds SET state='ready' WHERE id=$1", [
      pending.id,
    ]),
  );
  assert.equal(
    (
      await fixture.db.query(
        "SELECT count(*)::int AS n FROM bm25_corpora WHERE build_id=$1",
        [pending.id],
      )
    )[0].n,
    0,
  );
});
test("draft and persisted BM25 use identical full-corpus statistics and ranking without candidate truncation", async () => {
  const { release } = await seed([
      "拿取同色花砖。",
      "检查花砖例外和特殊标记。",
      "每枚积木三分。",
    ]),
    index = await service.build(release.id, randomUUID(), {
      ranker: "bm25-v1",
    }),
    manifest = await service.manifest(release.id),
    chunks: Array<{ id: string; rule_unit_id: string }> =
      await fixture.db.query(
        "SELECT id,rule_unit_id FROM retrieval_chunks WHERE build_id=$1",
        [index.id],
      );
  const records = manifest.rules.map((r) => ({
    chunk_id: chunks.find((c) => c.rule_unit_id === r.id)!.id,
    rule_id: r.id,
    lexical_text: buildLexicalChunk(r).lexicalText,
  }));
  for (const query of ["花砖标记", "每枚１２３ ABC", "' | ! & :* 花砖"]) {
    const { tokens } = lexicalQuery(query),
      rows = await fixture.db.query(draftBm25Sql, [
        JSON.stringify(records),
        tokens,
        2,
      ]),
      actual = await service.search(index.id, { query, limit: 2 });
    assert.deepEqual(
      rows.map((r: object, i: number) => ({ ...r, rank: i + 1 })),
      actual.hits,
    );
  }
  assert.deepEqual(
    (await service.search(index.id, { query: "' | ! & :*" })).hits,
    [],
  );
  assert.equal(
    (await service.search(index.id, { query: "unmatched" })).hits.length,
    0,
  );
  await assert.rejects(
    service.search(index.id, {
      query: Array.from({ length: 140 }, (_, i) => "t" + i).join(" "),
    }),
    /TOO_MANY_SEARCH_TERMS/,
  );
});
test("administrator API selects BM25 explicitly and existing empty requests keep the legacy profile", async () => {
  const { release } = await seed(),
    token = "bm25-test-" + "x".repeat(32),
    deps = { getDb: async () => fixture.db, adminToken: () => token };
  const call = (data: unknown, auth = true) =>
    handleAdmin(
      new Request(`http://local/api/admin/releases/${release.id}/indexes`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(auth ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(data),
      }),
      deps,
    );
  assert.equal((await call({ ranker: "bm25-v1" }, false)).status, 401);
  assert.equal((await call({ ranker: "unknown" })).status, 400);
  const a = await call({ ranker: "bm25-v1" });
  assert.equal(a.status, 201, await a.clone().text());
  assert.equal(
    ((await a.json()) as { data: { config: { ranker: string } } }).data.config
      .ranker,
    "bm25-v1",
  );
  const b = await call({});
  assert.equal(b.status, 201);
  assert.equal(
    ((await b.json()) as { data: { config: { schemaVersion: number } } }).data
      .config.schemaVersion,
    1,
  );
  assert.ok(openApiDocument().paths["/api/admin/releases/{id}/indexes"]);
});
test("private diagnostic opts in to BM25, never runs holdout and never claims publication or answer quality", async () => {
  const source = c.source.parse({
      documentSha256: "a".repeat(64),
      parserConfig: {},
      pipelineVersion: "structured-import-v1",
      parserVersion: null,
      blocks: [
        {
          ordinal: 0,
          kind: "text",
          rawText: "Synthetic source",
          pdfPageIndex: 0,
          printedPageLabel: null,
          bbox: [0, 0, 10, 10],
        },
      ],
    }),
    bundle = c.bundle.parse({
      schemaVersion: 1,
      name: "Synthetic",
      revision: "1",
      sourceFingerprint: curationSourceFingerprint(source),
      rules: [
        {
          alias: "rare",
          kind: "rule",
          reviewedText: "a rare",
          sourceOrdinals: [0],
        },
        {
          alias: "common",
          kind: "rule",
          reviewedText: "a ".repeat(40) + "filler",
          sourceOrdinals: [0],
        },
      ],
      cases: [
        {
          id: "dev",
          category: "recall",
          severity: "critical",
          split: "development",
          messages: [{ role: "user", content: "rare a" }],
          query: "rare a",
          expectedBehavior: "answer",
          requiredClaims: [],
          forbiddenClaims: [],
          acceptableEvidenceAliases: [["rare"]],
          reviewNote: "Synthetic only",
        },
        {
          id: "holdout",
          category: "recall",
          severity: "normal",
          split: "holdout",
          messages: [{ role: "user", content: "HOLDOUT_PRIVATE" }],
          query: "HOLDOUT_QUERY",
          expectedBehavior: "answer",
          requiredClaims: [],
          forbiddenClaims: [],
          acceptableEvidenceAliases: [["common"]],
          reviewNote: "Synthetic holdout",
        },
      ],
    });
  const legacy = await diagnoseDraft(fixture.db, bundle, source, { limit: 1 }),
    bm25 = await diagnoseDraft(fixture.db, bundle, source, {
      ranker: "bm25-v1",
      limit: 1,
    });
  assert.equal(legacy.summary.searchCompleteRate, 0);
  assert.equal(bm25.summary.searchCompleteRate, 1);
  assert.notEqual(legacy.algorithm.sqlHash, bm25.algorithm.sqlHash);
  assert.equal(bm25.algorithm.lexicalCore, "bm25-v1");
  assert.equal(bm25.publishable, false);
  assert.equal(bm25.answerQualityEvaluated, false);
  assert.equal(bm25.results.length, 1);
  assert.ok(!JSON.stringify(bm25).includes("HOLDOUT_PRIVATE"));
});
test("migration downgrade refuses to strand immutable BM25 indexes", async () => {
  await assert.rejects(
    fixture.db.undoLastMigration(),
    /Cannot remove BM25 storage/,
  );
  const [index] = await fixture.db.query(
    "SELECT id FROM index_builds WHERE config->>'ranker'='bm25-v1' AND state='ready' LIMIT 1",
  );
  assert.ok(index);
  assert.ok(
    (await service.search(index.id, { query: "a rare" })).hits.length > 0,
  );
  assert.equal(
    (
      await fixture.db.query(
        "SELECT count(*)::int AS n FROM migrations WHERE name='Bm25Retrieval1793836813000'",
      )
    )[0].n,
    1,
  );
});
test("BM25 scores the full scoped corpus even when the relevant rule is outside the legacy top fifty", async () => {
  const { release, rules } = await seed([
      ...Array.from({ length: 65 }, () => "a ".repeat(40) + "filler"),
      "a rare",
    ]),
    legacy = await service.build(release.id, randomUUID()),
    bm25 = await service.build(release.id, randomUUID(), { ranker: "bm25-v1" });
  assert.ok(
    !(
      await service.search(legacy.id, { query: "rare a", limit: 50 })
    ).hits.some((h) => h.ruleId === rules[65].id),
  );
  const result = await service.search(bm25.id, { query: "rare a", limit: 1 });
  assert.equal(result.hits[0].ruleId, rules[65].id);
  assert.deepEqual(
    (await service.search(bm25.id, { query: "rare rare a a", limit: 1 })).hits,
    result.hits,
  );
});
