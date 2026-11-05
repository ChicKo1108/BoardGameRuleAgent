import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { testDatabase } from "./helpers/database.js";
import { KnowledgeRepository } from "../packages/db/src/index.ts";
import {
  KnowledgeIndexService,
  lexicalTokens,
} from "../packages/retrieval/src/index.ts";
import { handleAdmin, openApiDocument } from "../packages/backend/src/index.ts";
let fixture: Awaited<ReturnType<typeof testDatabase>>;
let repo: KnowledgeRepository;
let service: KnowledgeIndexService;
before(async () => {
  fixture = await testDatabase();
  await fixture.db.runMigrations();
  repo = new KnowledgeRepository(fixture.db);
  service = new KnowledgeIndexService(fixture.db);
});
after(async () => {
  if (fixture) await fixture.close();
});
const texts = [
  "合成规则：工厂中有蓝色花砖时，必须拿走所有蓝色花砖。",
  "合成例外：指定测试标记在场时，每回合最多拿两块。",
  "合成计分：每块花砖计三分，最低零分。",
];
async function seed(
  options: { approved?: boolean; documentId?: string; texts?: string[] } = {},
) {
  let doc;
  if (options.documentId) {
    doc = (
      await fixture.db.query(
        'SELECT id,ruleset_id AS "rulesetId" FROM source_documents WHERE id=$1',
        [options.documentId],
      )
    )[0];
  } else {
    const game = await repo.createGame({
      slug: `retrieval-${randomUUID()}`,
      name: "检索合成游戏（不是真实规则）",
    });
    const ruleset = await repo.createRuleset({
      gameId: game.id,
      name: "测试基础",
      language: "zh-CN",
      scope: "合成规则",
    });
    const hash = createHash("sha256").update(randomUUID()).digest("hex");
    doc = await repo.createDocument({
      rulesetId: ruleset.id,
      title: "合成测试来源",
      sourceType: "rulebook",
      objectKey: `documents/${hash}.pdf`,
      sha256: hash,
    });
  }
  const rev = await repo.createRevision(doc.id);
  const values = options.texts ?? texts;
  const blocks = await repo.saveParsedBlocks(
    rev.id,
    values.map((rawText, ordinal) => ({
      ordinal,
      kind: "text" as const,
      rawText,
      pdfPageIndex: ordinal + 2,
      printedPageLabel: String(ordinal + 3),
      bbox: [0, 0, 100, 50] as [number, number, number, number],
    })),
  );
  const rules = [];
  for (let i = 0; i < values.length; i++)
    rules.push(
      await repo.addRule(
        {
          revisionId: rev.id,
          kind: i === 1 ? "exception" : "rule",
          reviewedText: values[i],
          sectionPath: ["合成测试", `章节${i + 1}`],
          applicability: [],
          explanation: i === 0 ? "编辑说明，不作为原文检索内容。" : null,
          reviewStatus: "approved",
        },
        [blocks[i].id],
      ),
    );
  for (let i = 1; i < rules.length; i++)
    await fixture.db.query(
      "INSERT INTO rule_relations(revision_id,from_rule_id,to_rule_id,kind) VALUES($1,$2,$3,$4)",
      [
        rev.id,
        rules[i - 1].id,
        rules[i].id,
        i === 1 ? "exception" : "supplement",
      ],
    );
  if (options.approved !== false) await repo.approveRevision(rev.id);
  return { doc, rev, blocks, rules };
}
async function indexed(a: Awaited<ReturnType<typeof seed>>) {
  const release = await service.createRelease(
    a.doc.rulesetId,
    { name: "基线", revisionIds: [a.rev.id] },
    randomUUID(),
  );
  const build = await service.build(release.id, randomUUID());
  return { release, build };
}
test("release excludes unapproved/wrong-scope revisions and duplicate versions of one document", async () => {
  const a = await seed({ approved: false });
  const b = await seed();
  await assert.rejects(
    service.createRelease(
      a.doc.rulesetId,
      { name: "bad", revisionIds: [a.rev.id] },
      randomUUID(),
    ),
    /APPROVED_SCOPED/,
  );
  await assert.rejects(
    service.createRelease(
      a.doc.rulesetId,
      { name: "bad", revisionIds: [b.rev.id] },
      randomUUID(),
    ),
    /APPROVED_SCOPED/,
  );
  await repo.approveRevision(a.rev.id);
  const newer = await seed({ documentId: a.doc.id });
  await assert.rejects(
    service.createRelease(
      a.doc.rulesetId,
      { name: "bad", revisionIds: [a.rev.id, newer.rev.id] },
      randomUUID(),
    ),
    /MULTIPLE_DOCUMENT_REVISIONS/,
  );
  assert.equal(
    (
      await fixture.db.query(
        "SELECT count(*)::int AS n FROM knowledge_releases",
      )
    )[0].n,
    0,
  );
});
test("concurrent requests seal one complete manifest and build one immutable index", async () => {
  const a = await seed();
  const releases = await Promise.all(
    Array.from({ length: 4 }, () =>
      service.createRelease(
        a.doc.rulesetId,
        { name: "first", revisionIds: [a.rev.id] },
        randomUUID(),
      ),
    ),
  );
  assert.equal(new Set(releases.map((r) => r.id)).size, 1);
  const release = releases[0];
  assert.match(release.manifestHash, /^[a-f0-9]{64}$/);
  await assert.rejects(
    fixture.db.query("UPDATE rulesets SET scope='扩展混入' WHERE id=$1", [
      a.doc.rulesetId,
    ]),
    /identity is immutable/,
  );
  const manifest = await service.manifest(release.id);
  assert.equal(manifest.rules.length, 3);
  assert.equal(manifest.relations.length, 2);
  assert.equal(
    manifest.rules.find((r) => r.id === a.rules[0].id)?.sources[0].rawText,
    texts[0],
  );
  const [hash] = await fixture.db.query(
    "SELECT encode(sha256(convert_to(manifest::text,'UTF8')),'hex') AS hash FROM knowledge_releases WHERE id=$1",
    [release.id],
  );
  assert.equal(hash.hash, release.manifestHash);
  const builds = await Promise.all(
    Array.from({ length: 3 }, () => service.build(release.id, randomUUID())),
  );
  assert.equal(new Set(builds.map((b) => b.id)).size, 1);
  assert.equal(
    (
      await fixture.db.query(
        "SELECT count(*)::int AS n FROM admin_audit_events WHERE action='release.seal' AND target_id=$1",
        [release.id],
      )
    )[0].n,
    1,
  );
  assert.equal(
    (
      await fixture.db.query(
        "SELECT count(*)::int AS n FROM admin_audit_events WHERE action='index.ready' AND target_id=$1",
        [builds[0].id],
      )
    )[0].n,
    1,
  );
  await assert.rejects(
    fixture.db.query(
      "UPDATE knowledge_releases SET manifest='{}' WHERE id=$1",
      [release.id],
    ),
    /immutable/,
  );
  await assert.rejects(
    fixture.db.query("DELETE FROM release_members WHERE release_id=$1", [
      release.id,
    ]),
    /immutable/,
  );
  await assert.rejects(
    fixture.db.query("DELETE FROM release_revisions WHERE release_id=$1", [
      release.id,
    ]),
    /immutable/,
  );
  await assert.rejects(
    fixture.db.query("UPDATE index_builds SET config='{}' WHERE id=$1", [
      builds[0].id,
    ]),
    /immutable/,
  );
  await assert.rejects(
    fixture.db.query(
      "UPDATE retrieval_chunks SET content='篡改' WHERE build_id=$1",
      [builds[0].id],
    ),
    /immutable/,
  );
});
test("database blocks incomplete and forged snapshots/indexes without application checks", async () => {
  const a = await seed();
  await assert.rejects(
    fixture.db.query(
      "INSERT INTO knowledge_releases(ruleset_id,name,state) VALUES($1,'fake','sealed')",
      [a.doc.rulesetId],
    ),
    /must start/,
  );
  await assert.rejects(
    fixture.db.transaction(async (tx) => {
      const [{ id }] = await tx.query(
        "INSERT INTO knowledge_releases(ruleset_id,name) VALUES($1,'incomplete') RETURNING id",
        [a.doc.rulesetId],
      );
      await tx.query(
        "INSERT INTO release_revisions(release_id,revision_id,document_id) VALUES($1,$2,$3)",
        [id, a.rev.id, a.doc.id],
      );
      await tx.query(
        "INSERT INTO release_members(release_id,revision_id,rule_unit_id) VALUES($1,$2,$3)",
        [id, a.rev.id, a.rules[0].id],
      );
      await tx.query(
        "UPDATE knowledge_releases SET state='sealed' WHERE id=$1",
        [id],
      );
    }),
    /every approved rule/,
  );
  const { release } = await indexed(a);
  await assert.rejects(
    fixture.db.transaction(async (tx) => {
      const [{ id }] = await tx.query(
        "INSERT INTO index_builds(release_id,config,config_hash) VALUES($1,'{}','') RETURNING id",
        [release.id],
      );
      await tx.query("UPDATE index_builds SET state='ready' WHERE id=$1", [id]);
    }),
    /cover every rule/,
  );
});
test("Chinese search stays in one index and old revision content remains retrievable", async () => {
  const a = await seed();
  const old = await indexed(a);
  const other = await seed();
  const otherIndex = await indexed(other);
  const newer = await seed({
    documentId: a.doc.id,
    texts: ["新版合成规则：工厂里每次只取一块红色花砖。"],
  });
  const fresh = await indexed(newer);
  const hits = await service.search(old.build.id, { query: "工厂蓝色花砖" });
  assert.ok(hits.hits.some((h) => h.ruleId === a.rules[0].id));
  assert.ok(hits.hits.every((h) => a.rules.some((r) => r.id === h.ruleId)));
  assert.equal(hits.releaseId, old.release.id);
  const changed = await service.search(fresh.build.id, { query: "工厂" });
  assert.equal(changed.hits[0].ruleId, newer.rules[0].id);
  assert.equal(
    (await service.manifest(old.release.id)).rules.find(
      (r) => r.id === a.rules[0].id,
    )?.reviewedText,
    texts[0],
  );
  const foreign = (await service.search(otherIndex.build.id, { query: "工厂" }))
    .hits[0];
  await assert.rejects(
    service.context(old.build.id, { chunkIds: [foreign.chunkId] }),
    /CHUNK_OUTSIDE_INDEX/,
  );
});
test("context expands related exceptions with exact source locations and reports budget gaps", async () => {
  const a = await seed();
  const { release, build } = await indexed(a);
  const hits = await service.search(build.id, { query: "工厂" });
  const primary = hits.hits.find((h) => h.ruleId === a.rules[0].id)!;
  assert.ok(primary);
  const context = await service.context(build.id, {
    chunkIds: [primary.chunkId],
  });
  assert.equal(context.releaseId, release.id);
  assert.equal(context.evidence.length, 3);
  assert.equal(context.gaps.length, 0);
  assert.equal(context.relations.length, 2);
  const first = context.evidence.find((e) => e.ruleId === a.rules[0].id)!;
  assert.equal(first.text, texts[0]);
  assert.equal(first.sources[0].blockId, a.blocks[0].id);
  assert.equal(first.sources[0].pdfPageIndex, 2);
  assert.equal(first.sources[0].printedPageLabel, "3");
  assert.equal(first.editorialExplanation, "编辑说明，不作为原文检索内容。");
  const limited = await service.context(build.id, {
    chunkIds: [primary.chunkId],
    maxRules: 1,
  });
  assert.equal(limited.evidence.length, 1);
  assert.deepEqual(limited.gaps, [
    { code: "RELATED_RULE_OMITTED", ruleId: a.rules[1].id },
  ]);
});
test("oversized complete rules fail atomically instead of losing conditions through truncation", async () => {
  const a = await seed({ texts: ["长规则的条件与例外。".repeat(1000)] });
  const release = await service.createRelease(
    a.doc.rulesetId,
    { name: "too long", revisionIds: [a.rev.id] },
    randomUUID(),
  );
  await assert.rejects(
    service.build(release.id, randomUUID()),
    /REQUIRES_SEMANTIC_SPLIT/,
  );
  assert.equal(
    (
      await fixture.db.query(
        "SELECT count(*)::int AS n FROM index_builds WHERE release_id=$1",
        [release.id],
      )
    )[0].n,
    0,
  );
});
test("normalization handles Chinese and full-width numbers without accepting tsquery operators", async () => {
  assert.ok(lexicalTokens("计分１２３ ABC").includes("123"));
  assert.ok(lexicalTokens("计分１２３ ABC").includes("abc"));
  const a = await seed();
  const { build } = await indexed(a);
  assert.deepEqual(
    (await service.search(build.id, { query: "' | ! & :* ( )" })).hits,
    [],
  );
  await service.search(build.id, { query: "工厂'; DROP TABLE rule_units; --" });
  assert.ok(
    (await fixture.db.query("SELECT count(*)::int AS n FROM rule_units"))[0].n >
      0,
  );
  const original = (
    await fixture.db.query("SELECT config FROM index_builds WHERE id=$1", [
      build.id,
    ])
  )[0].config;
  const [incompatible] = await fixture.db.query(
    "INSERT INTO index_builds(release_id,config,config_hash) SELECT release_id,$2,'' FROM index_builds WHERE id=$1 RETURNING id",
    [build.id, JSON.stringify({ ...original, icuVersion: "unsupported" })],
  );
  await fixture.db.query(
    "INSERT INTO retrieval_chunks(build_id,release_id,rule_unit_id,content,lexical_text) SELECT $1,release_id,rule_unit_id,content,lexical_text FROM retrieval_chunks WHERE build_id=$2",
    [incompatible.id, build.id],
  );
  await fixture.db.query("UPDATE index_builds SET state='ready' WHERE id=$1", [
    incompatible.id,
  ]);
  await assert.rejects(
    service.search(incompatible.id, { query: "工厂" }),
    /TOKENIZER_VERSION_MISMATCH/,
  );
});
test("knowledge routes are authenticated and serialize documented evidence", async () => {
  const a = await seed();
  const token = "retrieval-test-" + "x".repeat(32);
  const deps = { getDb: async () => fixture.db, adminToken: () => token };
  async function call(path: string, body: unknown, authorized = true) {
    return handleAdmin(
      new Request(`http://local/api/admin${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(authorized ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
      }),
      deps,
    );
  }
  assert.equal(
    (
      await call(
        `/rulesets/${a.doc.rulesetId}/releases`,
        { name: "http", revisionIds: [a.rev.id] },
        false,
      )
    ).status,
    401,
  );
  const created = await call(`/rulesets/${a.doc.rulesetId}/releases`, {
    name: "http",
    revisionIds: [a.rev.id],
  });
  assert.equal(created.status, 201, await created.clone().text());
  const release = JSON.parse(await created.text()).data;
  const built = await call(`/releases/${release.id}/indexes`, {});
  assert.equal(built.status, 201, await built.clone().text());
  const build = JSON.parse(await built.text()).data;
  const searched = await call(`/index-builds/${build.id}/search`, {
    query: "工厂",
  });
  assert.equal(searched.status, 200, await searched.clone().text());
  const hit = JSON.parse(await searched.text()).data.hits[0];
  const context = await call(`/index-builds/${build.id}/context`, {
    chunkIds: [hit.chunkId],
  });
  assert.equal(context.status, 200, await context.clone().text());
  assert.equal(JSON.parse(await context.text()).data.evidence.length, 3);
  assert.ok(openApiDocument().paths["/api/admin/index-builds/{id}/context"]);
});

test("character budget reports a missing primary rule rather than truncating its conditions", async () => {
  const a = await seed({ texts: ["合成规则：必须满足全部条件。".repeat(200)] });
  const { build } = await indexed(a);
  const hit = (await service.search(build.id, { query: "条件" })).hits[0];
  const limited = await service.context(build.id, {
    chunkIds: [hit.chunkId],
    maxChars: 1000,
  });
  assert.equal(limited.evidence.length, 0);
  assert.deepEqual(limited.gaps, [
    { code: "PRIMARY_RULE_OMITTED", ruleId: a.rules[0].id },
  ]);
});
