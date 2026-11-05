import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { testDatabase } from "./helpers/database.js";
import { chatServer, validDraft } from "./helpers/chat.js";
import { embeddingServer } from "./helpers/embedding.js";
import { KnowledgeRepository } from "../packages/db/src/index.ts";
import { KnowledgeIndexService } from "../packages/retrieval/src/index.ts";
import { CompatibleChatProvider } from "../packages/agent/src/index.ts";
import {
  AnswerEvaluationService,
  ANSWER_EVALUATION_QUEUE,
  AnswerService,
  EvaluationService,
  VectorService,
  connectQueue,
  handleAdmin,
  openApiDocument,
} from "../packages/backend/src/index.ts";
import {
  automaticAnswerScore,
  manualReviewPasses,
  summarizeAnswers,
} from "../packages/evaluations/src/index.ts";
import type {
  EvalCase,
  AnswerReview,
} from "../packages/contracts/src/index.ts";
let fixture: Awaited<ReturnType<typeof testDatabase>>,
  queue: Awaited<ReturnType<typeof connectQueue>>,
  chat: Awaited<ReturnType<typeof chatServer>>,
  embedding: Awaited<ReturnType<typeof embeddingServer>>,
  repo: KnowledgeRepository,
  knowledge: KnowledgeIndexService,
  vectors: VectorService,
  answers: AnswerService,
  service: AnswerEvaluationService;
before(async () => {
  fixture = await testDatabase();
  await fixture.db.runMigrations();
  queue = await connectQueue((fixture.db.options as { url: string }).url, true);
  chat = await chatServer();
  embedding = await embeddingServer();
  repo = new KnowledgeRepository(fixture.db);
  knowledge = new KnowledgeIndexService(fixture.db);
  vectors = new VectorService(fixture.db, queue, embedding.provider);
  answers = new AnswerService(fixture.db, vectors, chat.provider);
  service = new AnswerEvaluationService(fixture.db, queue, answers);
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

function makeCase(
  id: string,
  ruleId: string,
  extra: Partial<EvalCase> = {},
): EvalCase {
  return {
    id,
    category: "recall",
    split: "development",
    severity: "normal",
    messages: [{ role: "user", content: "工厂花砖怎么拿？" }],
    query: "PRIVILEGED_MANUAL_QUERY",
    expectedBehavior: "answer",
    requiredClaims: ["REQUIRED_LABEL_NOT_MODEL_INPUT"],
    forbiddenClaims: ["FORBIDDEN_LABEL_NOT_MODEL_INPUT"],
    acceptableEvidenceSets: [[ruleId]],
    reviewNote: "仅为合成测试标注，不是真实规则答案",
    ...extra,
  };
}
async function setup(
  cases?: (a: Awaited<ReturnType<typeof seed>>) => EvalCase[],
) {
  const a = await seed();
  const dataset = await new EvaluationService(fixture.db, queue).createDataset(
    a.release.id,
    {
      name: "synthetic-answer-eval",
      revision: "1",
      cases: cases ? cases(a) : [makeCase("factory", a.rules[0].id)],
    },
    randomUUID(),
  );
  return { ...a, dataset };
}
function input(a: Awaited<ReturnType<typeof setup>>, split = "development") {
  return {
    idempotencyKey: randomUUID(),
    config: { split, retrieval: { indexBuildId: a.build.id, mode: "lexical" } },
  };
}
function review(c: EvalCase, extra: Partial<AnswerReview> = {}): AnswerReview {
  return {
    conclusionCorrect: true,
    conditionsAndExceptionsCorrect: true,
    ambiguityHandled: true,
    refusalAppropriate: true,
    citationsSupportClaims: true,
    requiredClaimsSatisfied: c.requiredClaims.map(() => true),
    forbiddenClaimsAbsent: c.forbiddenClaims.map(() => true),
    note: "合成结果人工审核接口测试；不是实际游戏验收",
    ...extra,
  };
}
test("automatic evidence checks never substitute for semantic review or remove failed cases from denominators", () => {
  const c = makeCase("c", randomUUID()),
    draft = {
      status: "answered" as const,
      ambiguity: null,
      assumedMeaning: null,
      answer: "结论",
      basis: "explicit" as const,
      citations: [
        {
          evidenceId: c.acceptableEvidenceSets[0][0],
          ruleId: c.acceptableEvidenceSets[0][0],
          quote: "原句",
          supports: "结论",
          sectionPath: [],
          sources: [],
        },
      ],
      followUp: null,
    };
  const automatic = automaticAnswerScore(c, draft, true, true);
  assert.equal(automatic.pass, true);
  const outcome = { automatic, durationMs: 10, usage: null, reasonCode: null };
  const pending = summarizeAnswers(
    [c],
    [{ caseId: c.id, outcome, review: null }],
  );
  assert.equal(pending.automaticPasses, 1);
  assert.equal(pending.passed, 0);
  assert.equal(pending.correctRate, 0);
  assert.equal(pending.semanticQualityReviewed, false);
  const bad = review(c, { conclusionCorrect: false });
  assert.equal(manualReviewPasses(bad), false);
  assert.equal(
    summarizeAnswers([c], [{ caseId: c.id, outcome, review: bad }]).correctRate,
    0,
  );
  const rejected = automaticAnswerScore(
    { ...c, expectedBehavior: "abstain" },
    { ...draft, status: "insufficient_evidence", basis: null, citations: [] },
    false,
    true,
  );
  assert.equal(rejected.behaviorMatch, true);
  assert.equal(rejected.pass, false);
  assert.equal(summarizeAnswers([], []).correctRate, null);
});
test("generation uses original conversation, excludes labels, isolates split and is enqueue-idempotent", async () => {
  const a = await setup((a) => [
    makeCase("factory", a.rules[0].id, {
      messages: [
        { role: "user", content: "之前我们在讨论工厂。" },
        { role: "assistant", content: "请说出你的问题。" },
        { role: "user", content: "工厂花砖怎么拿？" },
      ],
    }),
    makeCase("hidden", a.rules[0].id, { split: "holdout" }),
  ]);
  const req = input(a),
    before = chat.requests.length;
  const ids = await Promise.all(
    Array.from({ length: 3 }, () =>
      service.enqueue(a.dataset.id, req, randomUUID()),
    ),
  );
  assert.equal(new Set(ids.map((r) => r.evaluationId)).size, 1);
  await service.workOnce();
  const run = await service.get(req.idempotencyKey);
  assert.equal(run.state, "awaiting_review", JSON.stringify(run));
  assert.equal(run.summary.total, 1);
  assert.equal(run.summary.automaticPasses, 1);
  assert.equal(run.summary.passed, 0);
  assert.equal(chat.requests.length - before, 1);
  const sent = JSON.stringify(chat.requests.at(-1));
  assert.ok(!sent.includes("REQUIRED_LABEL_NOT_MODEL_INPUT"));
  assert.ok(!sent.includes("FORBIDDEN_LABEL_NOT_MODEL_INPUT"));
  assert.ok(!sent.includes("PRIVILEGED_MANUAL_QUERY"));
  assert.ok(sent.includes("之前我们在讨论工厂"));
  const cases = await service.cases(run.id);
  assert.equal(cases.items[0].answerRun!.input.question, "工厂花砖怎么拿？");
  assert.equal(cases.items[0].answerRun!.input.history.length, 2);
  assert.match(run.identityHash, /^[0-9a-f]{64}$/);
  await assert.rejects(
    service.enqueue(
      a.dataset.id,
      { ...req, config: { ...req.config, split: "holdout" } },
      randomUUID(),
    ),
    /IDEMPOTENCY_CONFLICT/,
  );
});
test("incompatible conversations and cross-release indexes are rejected without truncating or leaking test inputs", async () => {
  const invalid = await setup((a) => [
    makeCase("bad", a.rules[0].id, {
      messages: [{ role: "assistant", content: "不能作为最后提问" }],
    }),
  ]);
  await assert.rejects(
    service.enqueue(invalid.dataset.id, input(invalid), randomUUID()),
    /CASE_INPUT_INVALID/,
  );
  const long = await setup((a) => [
    makeCase("too-long", a.rules[0].id, {
      messages: Array.from({ length: 12 }, () => ({
        role: "user" as const,
        content: "长历史",
      })),
    }),
  ]);
  await assert.rejects(
    service.enqueue(long.dataset.id, input(long), randomUUID()),
    /CASE_INPUT_INVALID/,
  );
  const a = await setup(),
    b = await setup();
  await assert.rejects(
    service.enqueue(a.dataset.id, input(b), randomUUID()),
    /RELEASE_MISMATCH/,
  );
  await assert.rejects(
    service.enqueue(a.dataset.id, input(a, "holdout"), randomUUID()),
    /SPLIT_EMPTY/,
  );
});
test("manual review covers every claim, preserves corrections and cannot override automatic failures", async () => {
  const a = await setup((a) => [
    makeCase("assumption", a.rules[0].id, {
      expectedBehavior: "answer_with_assumption",
      severity: "critical",
    }),
    makeCase("factory", a.rules[0].id),
  ]);
  const req = input(a);
  await service.enqueue(a.dataset.id, req, randomUUID());
  const pending = (await service.cases(req.idempotencyKey)).items[0];
  await assert.rejects(
    service.review(
      pending.id,
      { expectedRevision: 0, review: review(pending.testCase) },
      randomUUID(),
    ),
    /NOT_REVIEWABLE/,
  );
  await service.workOnce();
  const rows = (await service.cases(req.idempotencyKey)).items;
  await assert.rejects(
    service.seal(req.idempotencyKey, { note: "premature" }, randomUUID()),
    /REVIEWS_INCOMPLETE/,
  );
  const regular = rows.find((r) => r.caseId === "factory")!,
    assumed = rows.find((r) => r.caseId === "assumption")!;
  await assert.rejects(
    service.review(
      regular.id,
      {
        expectedRevision: 0,
        review: review(regular.testCase, { requiredClaimsSatisfied: [] }),
      },
      randomUUID(),
    ),
    /CLAIM_COUNT_MISMATCH/,
  );
  const fail = review(regular.testCase, {
    conditionsAndExceptionsCorrect: false,
  });
  const first = await service.review(
    regular.id,
    { expectedRevision: 0, review: fail },
    randomUUID(),
  );
  assert.equal(first.revision, 1);
  assert.equal(
    (
      await service.review(
        regular.id,
        { expectedRevision: 0, review: fail },
        randomUUID(),
      )
    ).id,
    first.id,
  );
  await assert.rejects(
    service.review(
      regular.id,
      { expectedRevision: 0, review: review(regular.testCase) },
      randomUUID(),
    ),
    /REVISION_CONFLICT/,
  );
  await service.review(
    regular.id,
    { expectedRevision: 1, review: review(regular.testCase) },
    randomUUID(),
  );
  await service.review(
    assumed.id,
    { expectedRevision: 0, review: review(assumed.testCase) },
    randomUUID(),
  );
  const run = await service.get(req.idempotencyKey);
  assert.equal(run.summary.correctRate, 0.5);
  assert.deepEqual(run.summary.criticalFailures, ["assumption"]);
  assert.equal((await service.reviews(regular.id)).total, 2);
  const sealed = await service.seal(
    run.id,
    { note: "封存含失败结果的合成实验，不表示质量达标" },
    randomUUID(),
  );
  assert.equal(sealed.state, "sealed");
  assert.equal(sealed.report!.summary.correctRate, 0.5);
  assert.match(sealed.reportHash!, /^[0-9a-f]{64}$/);
  assert.equal(
    sealed.report!.cases.find((c) => c.caseId === "factory")!.reviewRevision,
    2,
  );
  await assert.rejects(
    service.review(
      regular.id,
      { expectedRevision: 2, review: fail },
      randomUUID(),
    ),
    /NOT_REVIEWABLE/,
  );
  await assert.rejects(
    fixture.db.query("UPDATE answer_case_reviews SET review='{}' WHERE id=$1", [
      first.id,
    ]),
    /immutable/,
  );
  await assert.rejects(
    fixture.db.query(
      "UPDATE answer_evaluation_cases SET outcome='{}' WHERE id=$1",
      [regular.id],
    ),
    /immutable/,
  );
  await assert.rejects(
    fixture.db.query("UPDATE answer_evaluations SET report='{}' WHERE id=$1", [
      run.id,
    ]),
    /immutable/,
  );
});
test("a semantically wrong but well-cited answer stays failed after human review", async () => {
  const http = await chatServer((body) => {
    const draft = validDraft(body);
    draft.answer = "只拿一块就行。";
    draft.citations[0].supports = draft.answer;
    return { text: JSON.stringify(draft) };
  });
  try {
    const local = new AnswerEvaluationService(
      fixture.db,
      queue,
      new AnswerService(fixture.db, vectors, http.provider),
    );
    const a = await setup();
    const req = input(a);
    await local.enqueue(a.dataset.id, req, randomUUID());
    await local.workOnce();
    const c = (await local.cases(req.idempotencyKey)).items[0];
    assert.equal(c.outcome!.automatic.pass, true);
    await local.review(
      c.id,
      {
        expectedRevision: 0,
        review: review(c.testCase, {
          conclusionCorrect: false,
          requiredClaimsSatisfied: [false],
          note: "合成用例：引用存在但结论不满足标注，判错",
        }),
      },
      randomUUID(),
    );
    const result = await local.seal(
      req.idempotencyKey,
      { note: "保留语义失败案例" },
      randomUUID(),
    );
    assert.equal(result.summary.correctRate, 0);
    assert.deepEqual(result.summary.failures, ["factory"]);
  } finally {
    await http.close();
  }
});
test("a crash after paid generation reuses the committed answer instead of calling the model again", async () => {
  const a = await setup((a) => [
      makeCase("a", a.rules[0].id),
      makeCase("b", a.rules[0].id),
    ]),
    controller = new AbortController();
  let calls = 0;
  class InterruptedAnswers extends AnswerService {
    override async preview(...args: Parameters<AnswerService["preview"]>) {
      const answer = await super.preview(...args);
      if (++calls === 1) controller.abort();
      return answer;
    }
  }
  const interrupted = new AnswerEvaluationService(
    fixture.db,
    queue,
    new InterruptedAnswers(fixture.db, vectors, chat.provider),
  );
  const req = input(a);
  await interrupted.enqueue(a.dataset.id, req, randomUUID());
  const [job] = await queue.fetch<{ evaluationId: string }>(
    ANSWER_EVALUATION_QUEUE,
    { includeMetadata: true, batchSize: 1 },
  );
  assert.equal(job.id, req.idempotencyKey);
  const before = chat.requests.length;
  await assert.rejects(
    interrupted.process({ ...job, signal: controller.signal }),
    /STALE_ANSWER_EVALUATION_ATTEMPT/,
  );
  let cases = await interrupted.cases(job.id);
  assert.equal(cases.items[0].outcome, null);
  assert.equal(cases.items[0].answerRun!.state, "completed");
  assert.equal(chat.requests.length - before, 1);
  await queue.deleteJob(ANSWER_EVALUATION_QUEUE, job.id);
  assert.equal(
    (await service.get(job.id)).errorCode,
    "ANSWER_EVALUATION_QUEUE_RECORD_MISSING",
  );
  await service.retry(job.id, randomUUID());
  await service.workOnce();
  cases = await service.cases(job.id);
  assert.ok(cases.items.every((c) => c.outcome));
  assert.equal(chat.requests.length - before, 2);
  assert.equal((await service.get(job.id)).state, "awaiting_review");
});
test("runtime changes cannot mix answer configurations inside one experiment", async () => {
  const a = await setup(),
    req = input(a);
  await service.enqueue(a.dataset.id, req, randomUUID());
  const changed = new AnswerEvaluationService(
    fixture.db,
    queue,
    new AnswerService(
      fixture.db,
      vectors,
      new CompatibleChatProvider({ ...chat.config, revision: "different" }),
    ),
  );
  const [job] = await queue.fetch<{ evaluationId: string }>(
    ANSWER_EVALUATION_QUEUE,
    { includeMetadata: true, batchSize: 1 },
  );
  const before = chat.requests.length;
  await assert.rejects(changed.process(job), /RUNTIME_MISMATCH/);
  assert.equal(chat.requests.length, before);
  await queue.deleteJob(ANSWER_EVALUATION_QUEUE, job.id);
  await service.retry(job.id, randomUUID());
  await service.workOnce();
  assert.equal((await service.get(job.id)).state, "awaiting_review");
});
test("an older worker cannot replace results produced by a newer attempt", async () => {
  const a = await setup(),
    req = input(a);
  let unblock!: () => void, ready!: () => void;
  const waiting = new Promise<void>((r) => {
      unblock = r;
    }),
    entered = new Promise<void>((r) => {
      ready = r;
    });
  class SlowAnswers extends AnswerService {
    override async preview(...args: Parameters<AnswerService["preview"]>) {
      const result = await super.preview(...args);
      ready();
      await waiting;
      return result;
    }
  }
  const slow = new AnswerEvaluationService(
    fixture.db,
    queue,
    new SlowAnswers(fixture.db, vectors, chat.provider),
  );
  await slow.enqueue(a.dataset.id, req, randomUUID());
  const [job] = await queue.fetch<{ evaluationId: string }>(
    ANSWER_EVALUATION_QUEUE,
    { includeMetadata: true, batchSize: 1 },
  );
  const old = slow.process(job),
    rejected = assert.rejects(old, /STALE_ANSWER_EVALUATION_ATTEMPT/);
  await entered;
  try {
    await service.process(job);
  } finally {
    unblock();
  }
  await rejected;
  await queue.complete(ANSWER_EVALUATION_QUEUE, job);
  const run = await service.get(job.id);
  assert.equal(run.state, "awaiting_review");
  assert.equal(run.summary.generated, 1);
  assert.equal(run.attempts, 2);
});
test("administrator APIs enforce authentication, strict review fields, pagination and OpenAPI", async () => {
  const a = await setup(),
    token = "answer-eval-" + "x".repeat(32),
    deps = {
      getDb: async () => fixture.db,
      getAnswerEvaluations: async () => service,
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
  const req = input(a);
  assert.equal(
    (
      await call(
        `/evaluation-datasets/${a.dataset.id}/answer-evaluations`,
        req,
        false,
      )
    ).status,
    401,
  );
  const queued = await call(
    `/evaluation-datasets/${a.dataset.id}/answer-evaluations`,
    req,
  );
  assert.equal(queued.status, 202, await queued.clone().text());
  await service.workOnce();
  const response = await call(
    `/answer-evaluations/${req.idempotencyKey}/cases?limit=1`,
  );
  assert.equal(response.status, 200, await response.clone().text());
  const c = JSON.parse(await response.text()).data.items[0];
  assert.equal(
    (
      await call(`/answer-evaluation-cases/${c.id}/reviews`, {
        expectedRevision: 0,
        review: { ...review(c.testCase), passed: true },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await call(`/answer-evaluation-cases/${c.id}/reviews`, {
        expectedRevision: 0,
        review: review(c.testCase),
      })
    ).status,
    201,
  );
  const sealed = await call(`/answer-evaluations/${req.idempotencyKey}/seal`, {
    note: "HTTP 合成报告",
  });
  assert.equal(sealed.status, 200, await sealed.clone().text());
  assert.equal(JSON.parse(await sealed.text()).data.summary.correctRate, 1);
  assert.ok(openApiDocument().paths["/api/admin/answer-evaluations/{id}/seal"]);
});

test("provider failures stay in the experiment denominator and cannot be rerolled by retry", async () => {
  const http = await chatServer(() => ({ status: 503 }));
  try {
    const local = new AnswerEvaluationService(
      fixture.db,
      queue,
      new AnswerService(fixture.db, vectors, http.provider),
    );
    const a = await setup(),
      req = input(a);
    await local.enqueue(a.dataset.id, req, randomUUID());
    await assert.rejects(
      fixture.db.query(
        "UPDATE answer_evaluations SET report='{}' WHERE id=$1",
        [req.idempotencyKey],
      ),
      /check constraint/,
    );
    await assert.rejects(
      fixture.db.query(
        "UPDATE answer_evaluations SET state='sealed',report='{}' WHERE id=$1",
        [req.idempotencyKey],
      ),
      /finish before review/,
    );
    await local.workOnce();
    const run = await local.get(req.idempotencyKey);
    assert.equal(run.state, "awaiting_review");
    assert.equal(run.summary.total, 1);
    assert.equal(run.summary.runtimeFailures, 1);
    assert.equal(run.summary.correctRate, 0);
    const c = (await local.cases(run.id)).items[0];
    assert.equal(c.answerRun!.state, "failed");
    assert.equal(c.answerRun!.answer, null);
    assert.ok(c.outcome!.reasonCode);
    await local.review(
      c.id,
      { expectedRevision: 0, review: review(c.testCase) },
      randomUUID(),
    );
    const sealed = await local.seal(
      run.id,
      { note: "Provider failure retained, not removed from scoring" },
      randomUUID(),
    );
    assert.equal(sealed.summary.correctRate, 0);
    const calls = http.requests.length;
    await assert.rejects(local.retry(run.id, randomUUID()), /NOT_FAILED/);
    assert.equal(http.requests.length, calls);
  } finally {
    await http.close();
  }
});
