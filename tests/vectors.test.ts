import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { testDatabase } from "./helpers/database.js";
import { embeddingServer } from "./helpers/embedding.js";
import { KnowledgeRepository } from "../packages/db/src/index.ts";
import {
  KnowledgeIndexService,
  CompatibleEmbeddingProvider,
  EmbeddingError,
  type EmbeddingProvider,
} from "../packages/retrieval/src/index.ts";
import {
  connectQueue,
  VectorService,
  VECTOR_QUEUE,
  handleAdmin,
  fuseRanks,
} from "../packages/backend/src/index.ts";
let fixture: Awaited<ReturnType<typeof testDatabase>>;
let queue: Awaited<ReturnType<typeof connectQueue>>;
let http: Awaited<ReturnType<typeof embeddingServer>>;
let repo: KnowledgeRepository;
let knowledge: KnowledgeIndexService;
let service: VectorService;
before(async () => {
  fixture = await testDatabase();
  await fixture.db.runMigrations();
  queue = await connectQueue((fixture.db.options as { url: string }).url, true);
  http = await embeddingServer();
  repo = new KnowledgeRepository(fixture.db);
  knowledge = new KnowledgeIndexService(fixture.db);
  service = new VectorService(fixture.db, queue, http.provider);
});
after(async () => {
  if (queue) await queue.stop();
  if (http) await http.close();
  if (fixture) await fixture.close();
});
async function seed(count = 3) {
  const game = await repo.createGame({
    slug: `vector-${randomUUID()}`,
    name: "合成向量测试，非规则答案",
  });
  const ruleset = await repo.createRuleset({
    gameId: game.id,
    name: "基础",
    language: "zh-CN",
    scope: "synthetic",
  });
  const hash = createHash("sha256").update(randomUUID()).digest("hex");
  const doc = await repo.createDocument({
    rulesetId: ruleset.id,
    title: "测试",
    sourceType: "rulebook",
    objectKey: `documents/${hash}.pdf`,
    sha256: hash,
  });
  const rev = await repo.createRevision(doc.id);
  const texts = Array.from(
    { length: count },
    (_, i) =>
      ["工厂拿取花砖", "地板花砖扣分", "回合结束检查"][i % 3] + `合成规则${i}`,
  );
  const blocks = await repo.saveParsedBlocks(
    rev.id,
    texts.map((rawText, ordinal) => ({
      rawText,
      ordinal,
      kind: "text" as const,
      pdfPageIndex: ordinal,
      printedPageLabel: null,
      bbox: null,
    })),
  );
  const rules = [];
  for (let i = 0; i < count; i++)
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
  const release = await knowledge.createRelease(
    ruleset.id,
    { name: "test", revisionIds: [rev.id] },
    randomUUID(),
  );
  const build = await knowledge.build(release.id, randomUUID());
  return { release, build, rules };
}
test("real pgvector indexes preserve response ordering and support scoped lexical/vector/RRF searches", async () => {
  const a = await seed();
  const enqueued = await Promise.all(
    Array.from({ length: 3 }, () => service.enqueue(a.build.id, randomUUID())),
  );
  assert.equal(new Set(enqueued.map((x) => x.vectorIndexId)).size, 1);
  const id = enqueued[0].vectorIndexId;
  await assert.rejects(service.search(id, { query: "工厂" }), /NOT_READY/);
  await service.workOnce();
  assert.equal((await service.get(id)).state, "ready");
  assert.equal((await service.get(id)).completedChunks, 3);
  const vector = await service.search(id, {
    query: "跌落的损失",
    mode: "vector",
  });
  assert.equal(vector.hits[0].ruleId, a.rules[1].id);
  assert.equal(vector.hits[0].cosineDistance, 0);
  assert.equal(vector.candidates.lexical.length, 0);
  const before = http.requests.length;
  const lexical = await service.search(id, { query: "工厂", mode: "lexical" });
  assert.equal(http.requests.length, before);
  assert.equal(lexical.hits[0].ruleId, a.rules[0].id);
  const hybrid = await service.search(id, { query: "工厂" });
  assert.equal(hybrid.hits[0].ruleId, a.rules[0].id);
  assert.equal(hybrid.hits[0].score, 2 / 61);
  assert.equal(hybrid.hits[0].lexicalRank, 1);
  assert.equal(hybrid.hits[0].vectorRank, 1);
  assert.equal((await service.run(hybrid.retrievalRunId)).status, "succeeded");
  assert.equal((await service.run(hybrid.retrievalRunId)).usageTokens, 10);
  const b = await seed();
  const other = await service.enqueue(b.build.id, randomUUID());
  await service.workOnce();
  const otherResult = await service.search(other.vectorIndexId, {
    query: "工厂",
  });
  assert.ok(
    otherResult.hits.every((hit) =>
      b.rules.some((rule) => rule.id === hit.ruleId),
    ),
  );
  const context = await knowledge.context(a.build.id, {
    chunkIds: [hybrid.hits[0].chunkId],
  });
  assert.equal(context.releaseId, a.release.id);
  await assert.rejects(
    knowledge.context(a.build.id, { chunkIds: [otherResult.hits[0].chunkId] }),
    /OUTSIDE_INDEX/,
  );
});
test("failed batches remain unsearchable and retry resumes saved checkpoints", async () => {
  await queue.updateQueue(VECTOR_QUEUE, { retryLimit: 0 });
  const a = await seed(17);
  let calls = 0;
  const faulty: EmbeddingProvider = {
    profile: http.provider.profile,
    embed: async (...args) => {
      if (++calls === 2) throw new EmbeddingError("EMBEDDING_UNAVAILABLE");
      return http.provider.embed(...args);
    },
  };
  const worker = new VectorService(fixture.db, queue, faulty);
  const { vectorIndexId: id } = await worker.enqueue(a.build.id, randomUUID());
  await worker.workOnce();
  const failed = await service.get(id);
  assert.equal(failed.state, "failed");
  assert.equal(failed.completedChunks, 8);
  await assert.rejects(service.search(id, { query: "工厂" }), /NOT_READY/);
  const prior = http.requests.length;
  await service.retry(id, randomUUID());
  await service.workOnce();
  assert.equal((await service.get(id)).state, "ready");
  assert.equal(http.requests.length - prior, 2);
  assert.equal((await service.get(id)).completedChunks, 17);
  const [batches] = await fixture.db.query(
    "SELECT count(*)::int AS n,sum(cardinality(chunk_ids))::int AS chunks FROM embedding_batches WHERE vector_index_id=$1",
    [id],
  );
  assert.equal(batches.n, 3);
  assert.equal(batches.chunks, 17);
  await queue.updateQueue(VECTOR_QUEUE, { retryLimit: 2 });
});
test("database rejects incomplete, wrong-dimension, zero and cross-index embeddings and freezes completed artifacts", async () => {
  const a = await seed();
  const { vectorIndexId: id } = await service.enqueue(a.build.id, randomUUID());
  await assert.rejects(
    fixture.db.query("UPDATE vector_indexes SET state='ready' WHERE id=$1", [
      id,
    ]),
    /cover every chunk/,
  );
  await fixture.db.query(
    "UPDATE vector_indexes SET state='running' WHERE id=$1",
    [id],
  );
  const [chunk] = await fixture.db.query(
    "SELECT id FROM retrieval_chunks WHERE build_id=$1 LIMIT 1",
    [a.build.id],
  );
  const insert = (chunkId: string, vector: string) =>
    fixture.db.query(
      "INSERT INTO chunk_embeddings(vector_index_id,index_build_id,release_id,chunk_id,embedding) VALUES($1,$2,$3,$4,$5::vector)",
      [id, a.build.id, a.release.id, chunkId, vector],
    );
  await assert.rejects(insert(chunk.id, "[1,2]"), /dimensions/);
  await assert.rejects(insert(chunk.id, "[0,0,0]"), /norm/);
  const b = await seed();
  const [foreign] = await fixture.db.query(
    "SELECT id FROM retrieval_chunks WHERE build_id=$1 LIMIT 1",
    [b.build.id],
  );
  await assert.rejects(insert(foreign.id, "[1,0,0]"), /foreign key/);
  await service.workOnce();
  assert.equal((await service.get(id)).state, "ready");
  await assert.rejects(
    fixture.db.query("UPDATE vector_indexes SET profile='{}' WHERE id=$1", [
      id,
    ]),
    /immutable/,
  );
  await assert.rejects(
    fixture.db.query("DELETE FROM chunk_embeddings WHERE vector_index_id=$1", [
      id,
    ]),
    /immutable/,
  );
});
test("profile changes cannot silently query an old vector space and failed calls are recorded", async () => {
  const a = await seed();
  const { vectorIndexId: id } = await service.enqueue(a.build.id, randomUUID());
  await service.workOnce();
  const different = new VectorService(fixture.db, queue, {
    profile: { ...http.provider.profile, revision: "different" },
    embed: http.provider.embed.bind(http.provider),
  });
  await assert.rejects(
    different.search(id, { query: "工厂" }),
    /PROFILE_MISMATCH/,
  );
  const [run] = await fixture.db.query(
    "SELECT status,error_code FROM retrieval_runs WHERE vector_index_id=$1 ORDER BY created_at DESC LIMIT 1",
    [id],
  );
  assert.equal(run.status, "failed");
  assert.equal(run.error_code, "EMBEDDING_PROFILE_MISMATCH");
  const newer = await different.enqueue(a.build.id, randomUUID());
  assert.notEqual(newer.vectorIndexId, id);
  await different.workOnce();
  assert.equal((await different.get(newer.vectorIndexId)).state, "ready");
});
test("late worker cannot publish over a newer attempt", async () => {
  const a = await seed();
  const { vectorIndexId: id } = await service.enqueue(a.build.id, randomUUID());
  const [job] = await queue.fetch<{ vectorIndexId: string }>(VECTOR_QUEUE, {
    includeMetadata: true,
    batchSize: 1,
  });
  assert.equal(job.id, id);
  let entered!: () => void;
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const begun = new Promise<void>((r) => {
    entered = r;
  });
  const slow = new VectorService(fixture.db, queue, {
    profile: http.provider.profile,
    embed: async (...args) => {
      entered();
      await gate;
      return http.provider.embed(...args);
    },
  });
  const stale = assert.rejects(slow.process(job), /STALE_VECTOR_ATTEMPT/);
  await begun;
  await service.process(job);
  release();
  await stale;
  await queue.complete(VECTOR_QUEUE, job);
  assert.equal((await service.get(id)).completedChunks, 3);
  assert.equal((await service.get(id)).state, "ready");
});
test("provider rejects bad output and enforces model-specific input and timeout limits", async () => {
  const duplicate = await embeddingServer((body) => ({
    model: body.model,
    data: body.input.map(() => ({ index: 0, embedding: [1, 0, 0] })),
  }));
  try {
    await assert.rejects(
      duplicate.provider.embed(["a", "b"], "document"),
      /INVALID_EMBEDDING_RESPONSE/,
    );
  } finally {
    await duplicate.close();
  }
  const zero = await embeddingServer((body) => ({
    model: body.model,
    data: [{ index: 0, embedding: [0, 0, 0] }],
  }));
  try {
    await assert.rejects(
      zero.provider.embed(["x"], "document"),
      /ZERO_EMBEDDING_VECTOR/,
    );
  } finally {
    await zero.close();
  }
  const delayed = await embeddingServer(async (body) => {
    await new Promise((r) => setTimeout(r, 100));
    return { model: body.model, data: [{ index: 0, embedding: [1, 0, 0] }] };
  });
  try {
    await assert.rejects(
      new CompatibleEmbeddingProvider({
        ...delayed.config,
        timeoutMs: 20,
      }).embed(["x"], "query"),
      /TIMEOUT/,
    );
  } finally {
    await delayed.close();
  }
  const limited = new CompatibleEmbeddingProvider({
    ...http.config,
    maxInputChars: 2000,
  });
  const count = http.requests.length;
  await assert.rejects(
    limited.embed(["字".repeat(2001)], "document"),
    /INPUT_LIMIT/,
  );
  assert.equal(http.requests.length, count);
});
test("vector routes require admin auth and expose reproducible retrieval runs", async () => {
  const a = await seed();
  const token = "vector-admin-" + "x".repeat(32);
  const deps = {
    getDb: async () => fixture.db,
    getVectors: async () => service,
    adminToken: () => token,
  };
  const call = (path: string, body: unknown, auth = true) =>
    handleAdmin(
      new Request(`http://local/api/admin${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(auth ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
      }),
      deps,
    );
  assert.equal(
    (await call(`/index-builds/${a.build.id}/vectors`, {}, false)).status,
    401,
  );
  const added = await call(`/index-builds/${a.build.id}/vectors`, {});
  assert.equal(added.status, 202, await added.clone().text());
  const id = JSON.parse(await added.text()).data.vectorIndexId;
  await service.workOnce();
  const response = await call(`/vector-indexes/${id}/search`, {
    query: "工厂",
  });
  assert.equal(response.status, 200, await response.clone().text());
  const data = JSON.parse(await response.text()).data;
  assert.ok(data.retrievalRunId);
  assert.equal(data.indexBuildId, a.build.id);
  const read = await handleAdmin(
    new Request(
      `http://local/api/admin/retrieval-runs/${data.retrievalRunId}`,
      { headers: { authorization: `Bearer ${token}` } },
    ),
    deps,
  );
  assert.equal(read.status, 200);
});

test("expired queue records can be recreated without losing batch checkpoints", async () => {
  const a = await seed();
  const { vectorIndexId: id } = await service.enqueue(a.build.id, randomUUID());
  await queue.deleteJob(VECTOR_QUEUE, id);
  assert.equal((await service.get(id)).state, "failed");
  await service.retry(id, randomUUID());
  await service.workOnce();
  assert.equal((await service.get(id)).state, "ready");
});
