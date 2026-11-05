import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { testDatabase } from "./helpers/database.js";
import { chatServer, validDraft } from "./helpers/chat.js";
import { embeddingServer } from "./helpers/embedding.js";
import { KnowledgeRepository } from "../packages/db/src/index.ts";
import { KnowledgeIndexService } from "../packages/retrieval/src/index.ts";
import {
  AnswerService,
  VectorService,
  connectQueue,
  handleAdmin,
  openApiDocument,
} from "../packages/backend/src/index.ts";
let fixture: Awaited<ReturnType<typeof testDatabase>>,
  queue: Awaited<ReturnType<typeof connectQueue>>,
  chat: Awaited<ReturnType<typeof chatServer>>,
  embedding: Awaited<ReturnType<typeof embeddingServer>>,
  repo: KnowledgeRepository,
  knowledge: KnowledgeIndexService,
  vectors: VectorService,
  service: AnswerService;
before(async () => {
  fixture = await testDatabase();
  await fixture.db.runMigrations();
  queue = await connectQueue((fixture.db.options as { url: string }).url, true);
  chat = await chatServer();
  embedding = await embeddingServer();
  repo = new KnowledgeRepository(fixture.db);
  knowledge = new KnowledgeIndexService(fixture.db);
  vectors = new VectorService(fixture.db, queue, embedding.provider);
  service = new AnswerService(fixture.db, vectors, chat.provider);
});
after(async () => {
  if (queue) await queue.stop();
  if (chat) await chat.close();
  if (embedding) await embedding.close();
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

function request(indexBuildId: string) {
  return {
    idempotencyKey: randomUUID(),
    question: "工厂花砖怎么拿？",
    history: [],
    retrieval: { indexBuildId, mode: "lexical" },
  };
}
test("answer service pins evidence, persists canonical citations and audit events, and makes duplicate requests cost-idempotent", async () => {
  const a = await seed(),
    input = request(a.build.id),
    before = chat.requests.length;
  const runs = await Promise.all([
    service.preview(input, randomUUID()),
    service.preview(input, randomUUID()),
  ]);
  assert.ok(
    runs.some((r) => r.state === "completed"),
    JSON.stringify(runs),
  );
  assert.equal(chat.requests.length - before, 1);
  const run = await service.get(input.idempotencyKey);
  assert.equal(run.state, "completed");
  assert.equal(run.releaseId, a.release.id);
  assert.equal(run.answer!.citations[0].ruleId, a.rules[0].id);
  const events = await service.events(run.id, { limit: 100, offset: 0 });
  assert.ok(events.items.some((e: any) => e.kind === "retrieval"));
  assert.ok(events.items.some((e: any) => e.kind === "answer_validation"));
  assert.deepEqual(
    events.items.map((e: any) => e.sequence),
    Array.from({ length: events.total }, (_, i) => i + 1),
  );
  await service.preview(input, randomUUID());
  assert.equal(chat.requests.length - before, 1);
  await assert.rejects(
    service.preview({ ...input, question: "其他问题" }, randomUUID()),
    /IDEMPOTENCY_CONFLICT/,
  );
  await assert.rejects(
    fixture.db.query("UPDATE answer_runs SET answer='{}' WHERE id=$1", [
      run.id,
    ]),
    /immutable/,
  );
  await assert.rejects(
    fixture.db.query("DELETE FROM answer_events WHERE run_id=$1", [run.id]),
    /immutable/,
  );
});
test("hybrid preview uses one immutable tuple and rejects a foreign vector index", async () => {
  const a = await seed(),
    b = await seed();
  const av = await vectors.enqueue(a.build.id, randomUUID()),
    bv = await vectors.enqueue(b.build.id, randomUUID());
  await vectors.workOnce();
  await vectors.workOnce();
  const input = {
    ...request(a.build.id),
    retrieval: {
      indexBuildId: a.build.id,
      vectorIndexId: av.vectorIndexId,
      mode: "hybrid",
    },
  };
  const run = await service.preview(input, randomUUID());
  assert.equal(run.state, "completed", JSON.stringify(run));
  assert.ok(run.config.embeddingProfileHash);
  assert.equal(run.answer!.citations[0].ruleId, a.rules[0].id);
  await assert.rejects(
    service.preview(
      {
        ...input,
        idempotencyKey: randomUUID(),
        retrieval: { ...input.retrieval, vectorIndexId: bv.vectorIndexId },
      },
      randomUUID(),
    ),
    /VECTOR_MISMATCH/,
  );
  const events = await service.events(run.id, { limit: 100, offset: 0 });
  const retrieval = events.items.find((e: any) => e.kind === "retrieval")!;
  assert.ok((retrieval.data as any).result.retrievalRunId);
});
test("unconfigured models fail closed; disconnected requests persist a terminal failure instead of retrying silently", async () => {
  const a = await seed(),
    input = request(a.build.id);
  await assert.rejects(
    new AnswerService(fixture.db, vectors).preview(input, randomUUID()),
    /CHAT_NOT_CONFIGURED/,
  );
  assert.equal(
    (
      await fixture.db.query(
        "SELECT count(*)::int AS n FROM answer_runs WHERE id=$1",
        [input.idempotencyKey],
      )
    )[0].n,
    0,
  );
  const controller = new AbortController();
  controller.abort();
  const run = await service.preview(input, randomUUID(), controller.signal);
  assert.equal(run.state, "failed");
  assert.equal(run.reasonCode, "ANSWER_ABORTED");
  assert.equal(run.answer, null);
  const before = chat.requests.length;
  await service.preview(input, randomUUID());
  assert.equal(chat.requests.length, before);
});
test("abandoned running requests expire and cannot receive late events or a replacement result", async () => {
  const a = await seed(),
    original = await service.preview(request(a.build.id), randomUUID());
  const id = randomUUID();
  await fixture.db.query(
    "INSERT INTO answer_runs(id,request_id,release_id,index_build_id,input,config,expires_at) VALUES($1,$2,$3,$4,$5,$6,now()+interval '20 milliseconds')",
    [
      id,
      randomUUID(),
      a.release.id,
      a.build.id,
      JSON.stringify({ ...original.input, idempotencyKey: id }),
      JSON.stringify(original.config),
    ],
  );
  await new Promise((r) => setTimeout(r, 30));
  const expired = await service.get(id);
  assert.equal(expired.state, "failed");
  assert.equal(expired.reasonCode, "ANSWER_RUN_EXPIRED");
  await assert.rejects(
    fixture.db.query(
      "INSERT INTO answer_events(run_id,sequence,kind,data) VALUES($1,1,'late','{}')",
      [id],
    ),
    /no longer active/,
  );
  await assert.rejects(
    fixture.db.query(
      "UPDATE answer_runs SET state='completed',answer=$2 WHERE id=$1",
      [id, JSON.stringify(original.answer)],
    ),
    /immutable/,
  );
});
test("admin answering API requires auth, rejects client budgets and exposes typed results in OpenAPI", async () => {
  const a = await seed(),
    input = request(a.build.id),
    token = "answer-test-" + "x".repeat(32);
  const deps = {
    getDb: async () => fixture.db,
    getAnswers: async () => service,
    adminToken: () => token,
  };
  const call = (path: string, body?: unknown, auth = true) =>
    handleAdmin(
      new Request(`http://local/api/admin${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          "content-type": "application/json",
          ...(auth ? { authorization: `Bearer ${token}` } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      deps,
    );
  assert.equal((await call("/answer-runs", input, false)).status, 401);
  assert.equal(
    (await call("/answer-runs", { ...input, budgets: { maxModelCalls: 999 } }))
      .status,
    400,
  );
  const response = await call("/answer-runs", input);
  assert.equal(response.status, 200, await response.clone().text());
  const run = JSON.parse(await response.text()).data;
  assert.equal(run.state, "completed");
  assert.equal(
    (await call(`/answer-runs/${run.id}/events?limit=1`)).status,
    200,
  );
  assert.equal((await call(`/answer-runs/${randomUUID()}`)).status, 404);
  assert.ok(openApiDocument().paths["/api/admin/answer-runs"]);
});
