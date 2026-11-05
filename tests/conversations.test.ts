import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { testDatabase } from "./helpers/database.js";
import { chatServer } from "./helpers/chat.js";
import { embeddingServer } from "./helpers/embedding.js";
import {
  publicationCases,
  publicationReply,
  publicationPolicy,
  passingReview,
} from "./helpers/publication.js";
import { KnowledgeRepository } from "../packages/db/src/index.ts";
import { KnowledgeIndexService } from "../packages/retrieval/src/index.ts";
import { CompatibleChatProvider } from "../packages/agent/src/index.ts";
import {
  PublicationService,
  SessionService,
  ConversationService,
  handleConversations,
  AnswerEvaluationService,
  AnswerService,
  EvaluationService,
  VectorService,
  connectQueue,
  handleAdmin,
  openApiDocument,
} from "../packages/backend/src/index.ts";
import {
  answeringSchemas as a,
  type EvalCase,
} from "../packages/contracts/src/index.ts";
let fixture: Awaited<ReturnType<typeof testDatabase>>,
  queue: Awaited<ReturnType<typeof connectQueue>>,
  chat: Awaited<ReturnType<typeof chatServer>>,
  repo: KnowledgeRepository,
  knowledge: KnowledgeIndexService,
  vectors: VectorService,
  answers: AnswerService,
  answerEvals: AnswerEvaluationService,
  retrievalEvals: EvaluationService,
  service: PublicationService;
const previousRevision = process.env.APP_REVISION;
before(async () => {
  process.env.APP_REVISION = "0".repeat(40);
  fixture = await testDatabase();
  await fixture.db.runMigrations();
  queue = await connectQueue((fixture.db.options as { url: string }).url, true);
  chat = await chatServer((body) =>
    JSON.stringify(body).includes("force-failure")
      ? { status: 503 }
      : publicationReply(body),
  );
  repo = new KnowledgeRepository(fixture.db);
  knowledge = new KnowledgeIndexService(fixture.db);
  vectors = new VectorService(fixture.db, queue);
  answers = new AnswerService(fixture.db, vectors, chat.provider);
  answerEvals = new AnswerEvaluationService(fixture.db, queue, answers);
  retrievalEvals = new EvaluationService(fixture.db, queue, vectors);
  service = new PublicationService(fixture.db, answers);
});
after(async () => {
  if (previousRevision === undefined) delete process.env.APP_REVISION;
  else process.env.APP_REVISION = previousRevision;
  if (queue) await queue.stop();
  if (chat) await chat.close();
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

async function nextSnapshot(source: Awaited<ReturnType<typeof seed>>) {
  const hash = createHash("sha256").update(randomUUID()).digest("hex");
  const doc = await repo.createDocument({
    rulesetId: source.release.rulesetId,
    title: "Synthetic revised source",
    sourceType: "rulebook",
    objectKey: `documents/${hash}.pdf`,
    sha256: hash,
  });
  const revision = await repo.createRevision(doc.id);
  const [block] = await repo.saveParsedBlocks(revision.id, [
    {
      ordinal: 0,
      kind: "text",
      rawText: "工厂拿取花砖合成新修订",
      pdfPageIndex: 0,
      printedPageLabel: null,
      bbox: null,
    },
  ]);
  const rule = await repo.addRule(
    {
      revisionId: revision.id,
      kind: "rule",
      reviewedText: block.rawText,
      sectionPath: [],
      applicability: [],
      explanation: null,
      reviewStatus: "approved",
    },
    [block.id],
  );
  await repo.approveRevision(revision.id);
  const release = await knowledge.createRelease(
    source.release.rulesetId,
    { name: "Synthetic next snapshot", revisionIds: [revision.id] },
    randomUUID(),
  );
  return {
    release,
    build: await knowledge.build(release.id, randomUUID()),
    rules: [rule],
  };
}
async function setup(
  existing?: Awaited<ReturnType<typeof seed>>,
  transform?: (cases: EvalCase[]) => EvalCase[],
  threshold = 1,
) {
  const source = existing ?? (await seed());
  let cases = publicationCases(source.rules[0].id);
  if (transform) cases = transform(cases);
  const dataset = await retrievalEvals.createDataset(
    source.release.id,
    { name: "synthetic-publication", revision: randomUUID(), cases },
    randomUUID(),
  );
  const head = await service.head(source.release.rulesetId),
    policy = await service.createPolicy(
      source.release.rulesetId,
      {
        idempotencyKey: randomUUID(),
        datasetId: dataset.id,
        expectedRevision: head.revision,
        config: { ...publicationPolicy, minCorrectRate: threshold },
        note: "Synthetic test policy",
      },
      randomUUID(),
    );
  return { ...source, dataset, policy };
}
async function evaluate(
  s: Awaited<ReturnType<typeof setup>>,
  badCase?: string,
  split = "holdout",
  limit = 6,
) {
  const retrieval = a.retrievalConfig.parse({
    indexBuildId: s.build.id,
    mode: "lexical",
    limit,
  });
  const { maxRules, maxChars, ...search } = retrieval;
  const er = await retrievalEvals.enqueue(
    s.dataset.id,
    {
      idempotencyKey: randomUUID(),
      config: { ...search, split, context: { maxRules, maxChars } },
    },
    randomUUID(),
  );
  await retrievalEvals.workOnce();
  const ar = await answerEvals.enqueue(
    s.dataset.id,
    { idempotencyKey: randomUUID(), config: { split, retrieval } },
    randomUUID(),
  );
  await answerEvals.workOnce();
  const cases = await answerEvals.cases(ar.evaluationId);
  for (const c of cases.items)
    await answerEvals.review(
      c.id,
      {
        expectedRevision: 0,
        review: { ...passingReview, conclusionCorrect: c.caseId !== badCase },
      },
      randomUUID(),
    );
  const sealed = await answerEvals.seal(
    ar.evaluationId,
    { note: "Synthetic report" },
    randomUUID(),
  );
  assert.equal(sealed.summary.runtimeFailures, 0);
  return { answerEvaluationId: ar.evaluationId, retrievalRunId: er.runId };
}
async function assess(s: Awaited<ReturnType<typeof setup>>, badCase?: string) {
  const ids = await evaluate(s, badCase);
  return service.assess(
    { idempotencyKey: randomUUID(), policyId: s.policy.id, ...ids },
    randomUUID(),
  );
}
async function move(
  scope: string,
  id: string | null,
  action: "publish" | "rollback" | "deactivate" = "publish",
  revision?: number,
) {
  return service.transition(
    scope,
    {
      idempotencyKey: randomUUID(),
      expectedRevision: revision ?? (await service.head(scope)).revision,
      action,
      publicationId: id,
      note: "Synthetic transition",
    },
    randomUUID(),
  );
}

async function start() {
  const s = await setup(),
    published = await assess(s);
  assert.equal(published.passed, true);
  await move(s.release.rulesetId, published.id);
  const sessions = new SessionService(fixture.db, {
    origin: "https://public.example",
    guestDailyQuestions: 5,
    globalDailyQuestions: 1000,
    mintsPerMinute: 1000,
  });
  const minted = await sessions.initialize(null),
    token = minted.cookie!.split(";")[0].split("=")[1];
  const conversations = new ConversationService(
    fixture.db,
    sessions,
    service,
    async () => answers,
  );
  return { s, published, sessions, token, conversations };
}
const newConversation = (state: Awaited<ReturnType<typeof start>>) =>
  state.conversations.create(state.token, {
    idempotencyKey: randomUUID(),
    rulesetId: state.s.release.rulesetId,
  });
const ask = (revision = 0, question = "工厂花砖怎么拿？") => ({
  idempotencyKey: randomUUID(),
  expectedRevision: revision,
  question,
});
test("public answers bind published knowledge, actual history, quota and immutable result", async () => {
  const x = await start(),
    c = await newConversation(x),
    input = ask();
  const before = chat.requests.length;
  const answer = await x.conversations.send(x.token, c.id, input, randomUUID());
  assert.equal(answer.state, "completed", JSON.stringify(answer));
  assert.equal(answer.publicationId, x.published.id);
  assert.ok(answer.answer!.citations.length);
  assert.equal(chat.requests.length - before, 1);
  const retry = await x.conversations.send(x.token, c.id, input, randomUUID());
  assert.deepEqual(retry, answer);
  assert.equal(chat.requests.length - before, 1);
  assert.equal((await x.sessions.current(x.token)).quota.used, 1);
  const second = await x.conversations.send(
    x.token,
    c.id,
    ask(1, "那么地板上的呢？"),
    randomUUID(),
  );
  assert.equal(second.sequence, 2);
  assert.equal(second.state, "completed");
  const [{ input: stored }] = await fixture.db.query(
    "SELECT input FROM public_turns WHERE id=$1",
    [second.id],
  );
  assert.equal(stored.history.length, 2);
  assert.equal(stored.history[0].content, input.question);
  assert.ok(stored.history[1].content.includes(answer.answer!.answer));
  assert.ok(!stored.history[1].content.includes("sources"));
  assert.equal((await x.conversations.list(x.token)).total, 1);
  assert.equal(
    (await x.conversations.messages(x.token, c.id, { limit: 1, offset: 1 }))
      .items[0].id,
    second.id,
  );
  await assert.rejects(
    fixture.db.query("UPDATE public_turns SET answer='{}' WHERE id=$1", [
      answer.id,
    ]),
    /immutable/,
  );
  const [audit] = await fixture.db.query(
    "SELECT actor FROM admin_audit_events WHERE target_id=(SELECT execution_key FROM public_turns WHERE id=$1)",
    [answer.id],
  );
  assert.equal(audit.actor, "public");
});
test("foreign credentials, guessed identifiers and forged history/retrieval cannot cross scope", async () => {
  const x = await start(),
    c = await newConversation(x),
    other = (await x.sessions.initialize(null))
      .cookie!.split(";")[0]
      .split("=")[1];
  await assert.rejects(x.conversations.get(other, c.id), /NOT_FOUND/);
  await assert.rejects(x.conversations.messages(other, c.id), /NOT_FOUND/);
  await assert.rejects(
    x.conversations.send(other, c.id, ask(), randomUUID()),
    /NOT_FOUND/,
  );
  assert.equal((await x.sessions.current(other)).quota.used, 0);
  await assert.rejects(
    x.conversations.send(
      x.token,
      c.id,
      { ...ask(), history: [], retrieval: { indexBuildId: randomUUID() } },
      randomUUID(),
    ),
  );
  await x.sessions.revoke(x.token);
  await assert.rejects(x.conversations.get(x.token, c.id), /SESSION_INVALID/);
});
test("concurrent retry starts one execution and blocks parallel follow-up until it finishes", async () => {
  const x = await start(),
    c = await newConversation(x),
    input = ask();
  let entered!: () => void, unblock!: () => void;
  const ready = new Promise<void>((r) => (entered = r)),
    waiting = new Promise<void>((r) => (unblock = r));
  class Slow extends AnswerService {
    override async preview(...args: Parameters<AnswerService["preview"]>) {
      entered();
      await waiting;
      return super.preview(...args);
    }
  }
  const local = new ConversationService(
    fixture.db,
    x.sessions,
    service,
    async () => new Slow(fixture.db, vectors, chat.provider),
  );
  const before = chat.requests.length;
  const first = local.send(x.token, c.id, input, randomUUID());
  await ready;
  try {
    assert.equal(
      (await local.send(x.token, c.id, input, randomUUID())).state,
      "running",
    );
    await assert.rejects(
      local.send(x.token, c.id, ask(1), randomUUID()),
      /CONVERSATION_BUSY/,
    );
    await assert.rejects(
      local.send(
        x.token,
        c.id,
        { ...input, question: "different" },
        randomUUID(),
      ),
      /IDEMPOTENCY_CONFLICT/,
    );
  } finally {
    unblock();
  }
  assert.equal((await first).state, "completed");
  assert.equal(chat.requests.length - before, 1);
  assert.equal((await x.sessions.current(x.token)).quota.used, 1);
});
test("new messages reject deactivated or changed publication while old results remain readable", async () => {
  const x = await start(),
    c = await newConversation(x),
    input = ask();
  await x.conversations.send(x.token, c.id, input, randomUUID());
  await move(x.s.release.rulesetId, null, "deactivate");
  await assert.rejects(
    x.conversations.send(x.token, c.id, ask(1), randomUUID()),
    /NOT_PUBLISHED/,
  );
  assert.equal(
    (await x.conversations.messages(x.token, c.id)).items[0].state,
    "completed",
  );
  assert.equal((await x.sessions.current(x.token)).quota.used, 1);
});
test("provider failure consumes one allowance and retries cannot reroll an answer", async () => {
  const x = await start(),
    c = await newConversation(x),
    input = ask(0, "force-failure 工厂花砖");
  const before = chat.requests.length;
  const result = await x.conversations.send(x.token, c.id, input, randomUUID());
  assert.equal(result.state, "failed");
  assert.equal(result.answer, null);
  assert.equal(result.errorCode, "ANSWER_UNAVAILABLE");
  assert.equal((await x.sessions.current(x.token)).quota.used, 1);
  const calls = chat.requests.length;
  assert.ok(calls > before);
  await x.conversations.send(x.token, c.id, input, randomUUID());
  assert.equal(chat.requests.length, calls);
  for (let i = 1; i < 5; i++)
    await x.conversations.send(x.token, c.id, ask(i), randomUUID());
  await assert.rejects(
    x.conversations.send(x.token, c.id, ask(5), randomUUID()),
    /QUOTA_EXHAUSTED/,
  );
  assert.equal((await x.conversations.get(x.token, c.id)).revision, 5);
});
test("expired prepared or interrupted dispatched turns recover without issuing an external call", async () => {
  const x = await start(),
    before = chat.requests.length;
  for (const dispatched of [false, true]) {
    const c = await newConversation(x),
      input = ask(),
      key = randomUUID();
    const request = {
      idempotencyKey: key,
      question: input.question,
      history: [],
      retrieval: x.published.manifest.retrieval,
    };
    await x.sessions.reserve(x.token, {
      id: input.idempotencyKey,
      requestHash: "a".repeat(64),
    });
    await fixture.db.query(
      "INSERT INTO public_turns(id,conversation_id,sequence,question,input,execution_key,allowance_id,expires_at) VALUES($1,$2,1,$3,$4,$5,$1,clock_timestamp()-interval '1 second')",
      [
        input.idempotencyKey,
        c.id,
        input.question,
        JSON.stringify(request),
        key,
      ],
    );
    if (dispatched) {
      await x.sessions.transition(input.idempotencyKey, "dispatched");
      await fixture.db.query(
        "UPDATE public_turns SET state='running' WHERE id=$1",
        [input.idempotencyKey],
      );
    }
    const result = (await x.conversations.messages(x.token, c.id)).items[0];
    assert.equal(result.state, "failed");
    assert.equal(result.errorCode, "ANSWER_INTERRUPTED");
    assert.equal(
      (await x.conversations.send(x.token, c.id, input, randomUUID())).id,
      result.id,
    );
    const [allowance] = await fixture.db.query(
      "SELECT state FROM question_allowances WHERE id=$1",
      [input.idempotencyKey],
    );
    assert.equal(allowance.state, dispatched ? "settled" : "released");
  }
  assert.equal(chat.requests.length, before);
});
test("public HTTP contracts reject absent auth, cross origin, oversized bodies and unsafe fields", async () => {
  const x = await start(),
    cookie = x.sessions.cookieName + "=" + x.token;
  const call = (
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    handleConversations(
      new Request("https://public.example/api/conversations" + path, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          cookie,
          origin: "https://public.example",
          "x-boardgame-request": "1",
          "content-type": "application/json",
          ...headers,
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      }),
      async () => x.conversations,
    );
  assert.equal((await call("", undefined, { cookie: "" })).status, 401);
  assert.equal(
    (
      await call(
        "",
        { idempotencyKey: randomUUID(), rulesetId: x.s.release.rulesetId },
        { origin: "https://evil.example" },
      )
    ).status,
    403,
  );
  const created = await call("", {
    idempotencyKey: randomUUID(),
    rulesetId: x.s.release.rulesetId,
  });
  assert.equal(created.status, 200);
  const c = JSON.parse(await created.text()).data;
  assert.equal(
    (await call(`/${c.id}/messages`, { ...ask(), history: [] })).status,
    400,
  );
  assert.equal(
    (await call(`/${c.id}/messages`, { ...ask(), question: "a".repeat(9000) }))
      .status,
    413,
  );
  const answer = await call(`/${c.id}/messages`, ask());
  assert.equal(answer.status, 200, await answer.clone().text());
  const body = JSON.parse(await answer.text()).data;
  assert.equal(body.state, "completed");
  assert.ok(!JSON.stringify(body).includes("modelProfile"));
  assert.equal(answer.headers.get("cache-control"), "no-store");
});

test("parallel conversation creation does not exhaust a ten-connection database pool", async () => {
  const x = await start();
  const conversations = await Promise.all(
    Array.from({ length: 15 }, () => newConversation(x)),
  );
  assert.equal(new Set(conversations.map((c) => c.id)).size, 15);
});
test("a committed answer survives interruption before public delivery without re-generation", async () => {
  const x = await start(),
    c = await newConversation(x),
    input = ask();
  let release!: () => void, entered!: () => void;
  const waiting = new Promise<void>((r) => (release = r)),
    ready = new Promise<void>((r) => (entered = r));
  class DeliveredLater extends AnswerService {
    override async preview(...args: Parameters<AnswerService["preview"]>) {
      const result = await super.preview(...args);
      entered();
      await waiting;
      return result;
    }
  }
  const local = new ConversationService(
    fixture.db,
    x.sessions,
    service,
    async () => new DeliveredLater(fixture.db, vectors, chat.provider),
  );
  const before = chat.requests.length,
    request = local.send(x.token, c.id, input, randomUUID());
  await ready;
  try {
    const recovered = (await local.messages(x.token, c.id)).items[0];
    assert.equal(recovered.state, "completed");
    assert.equal(
      (await local.send(x.token, c.id, input, randomUUID())).id,
      recovered.id,
    );
    assert.equal(chat.requests.length - before, 1);
  } finally {
    release();
  }
  await request;
});
