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
  chat = await chatServer(publicationReply);
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

test("publishing pins complete configuration; rollback and deactivation preserve an append-only history", async () => {
  const s = await setup();
  await assert.rejects(
    service.resolve(s.release.rulesetId),
    /KNOWLEDGE_NOT_PUBLISHED/,
  );
  const first = await assess(s);
  assert.equal(first.passed, true, JSON.stringify(first.gate));
  assert.match(first.manifestHash, /^[0-9a-f]{64}$/);
  await move(s.release.rulesetId, first.id);
  const pinned = await service.resolve(s.release.rulesetId);
  assert.equal(
    pinned.publication.manifest.answerReportHash,
    first.manifest.answerReportHash,
  );
  const next = await setup(await nextSnapshot(s)),
    second = await assess(next);
  assert.notEqual(second.releaseId, first.releaseId);
  assert.notEqual(
    second.manifest.retrieval.indexBuildId,
    first.manifest.retrieval.indexBuildId,
  );
  assert.equal(second.passed, true, JSON.stringify(second.gate));
  await move(s.release.rulesetId, second.id);
  assert.equal(pinned.publication.id, first.id);
  assert.equal(
    (await service.resolve(s.release.rulesetId)).publication.id,
    second.id,
  );
  await move(s.release.rulesetId, first.id, "rollback");
  assert.equal(
    (await service.resolve(s.release.rulesetId)).publication.id,
    first.id,
  );
  await move(s.release.rulesetId, null, "deactivate");
  await assert.rejects(
    service.resolve(s.release.rulesetId),
    /KNOWLEDGE_NOT_PUBLISHED/,
  );
  const afterStop = await setup(s);
  assert.equal(afterStop.policy.baselinePublicationId, null);
  assert.equal(afterStop.policy.regressionPublicationId, first.id);
  await move(s.release.rulesetId, second.id, "rollback");
  assert.equal((await service.head(s.release.rulesetId)).revision, 5);
  assert.equal(
    (await service.history(s.release.rulesetId, { limit: 2, offset: 1 })).items
      .length,
    2,
  );
  await assert.rejects(
    fixture.db.query(
      "UPDATE knowledge_publications SET gate='{}' WHERE id=$1",
      [first.id],
    ),
    /immutable/,
  );
  await assert.rejects(
    fixture.db.query("DELETE FROM publication_events WHERE ruleset_id=$1", [
      s.release.rulesetId,
    ]),
    /immutable/,
  );
  await assert.rejects(
    fixture.db.query(
      "UPDATE publication_heads SET publication_id=$2 WHERE ruleset_id=$1",
      [s.release.rulesetId, first.id],
    ),
    /audited revision/,
  );
});
test("coverage and critical semantic failures block publication even when a report is sealed", async () => {
  const short = await setup(undefined, (cs) => [cs[0]]);
  const denied = await assess(short);
  assert.equal(denied.passed, false);
  assert.ok(denied.gate.failures.includes("MINIMUM_CASES"));
  await assert.rejects(move(short.release.rulesetId, denied.id), /GATE_FAILED/);
  const wrong = await setup(undefined, undefined, 0.5),
    bad = await assess(wrong, "recall");
  assert.equal(bad.passed, false);
  assert.ok(bad.gate.failures.includes("CRITICAL_ANSWER_FAILURES"));
  assert.equal(bad.manifest.answerSummary.correctRate, 5 / 6);
  await assert.rejects(
    fixture.db.query(
      "INSERT INTO publication_events(id,ruleset_id,revision,action,publication_id,note) VALUES($1,$2,1,'publish',$3,'bypass')",
      [randomUUID(), wrong.release.rulesetId, bad.id],
    ),
    /passed publication/,
  );
});
test("a previously passing case cannot regress or disappear, including after deactivation", async () => {
  const s = await setup(),
    first = await assess(s);
  await move(s.release.rulesetId, first.id);
  const next = await setup(s, undefined, 0.5),
    regressed = await assess(next, "inference");
  assert.equal(regressed.passed, false);
  assert.deepEqual(regressed.gate.regressedCases, ["inference"]);
  await move(s.release.rulesetId, null, "deactivate");
  const changed = await setup(s, (cs) =>
    cs.map((c) =>
      c.id === "recall"
        ? {
            ...c,
            messages: [
              { role: "user", content: "工厂花砖 changed test contract" },
            ],
          }
        : c,
    ),
  );
  const result = await assess(changed);
  assert.equal(result.passed, false);
  assert.ok(result.gate.incomparableCases.includes("recall"));
  assert.equal(result.manifest.policy.regressionPublicationId, first.id);
});
test("policies predate evaluation and reject development, foreign datasets and mismatched retrieval", async () => {
  const s = await setup(),
    ids = await evaluate(s);
  const late = await service.createPolicy(
    s.release.rulesetId,
    {
      idempotencyKey: randomUUID(),
      datasetId: s.dataset.id,
      expectedRevision: 0,
      config: publicationPolicy,
      note: "late policy",
    },
    randomUUID(),
  );
  await assert.rejects(
    service.assess(
      { idempotencyKey: randomUUID(), policyId: late.id, ...ids },
      randomUUID(),
    ),
    /POLICY_TOO_LATE/,
  );
  const other = await setup();
  await assert.rejects(
    service.assess(
      { idempotencyKey: randomUUID(), policyId: other.policy.id, ...ids },
      randomUUID(),
    ),
    /SCOPE_MISMATCH/,
  );
  const different = await evaluate(s, undefined, "holdout", 5);
  await assert.rejects(
    service.assess(
      {
        idempotencyKey: randomUUID(),
        policyId: s.policy.id,
        answerEvaluationId: ids.answerEvaluationId,
        retrievalRunId: different.retrievalRunId,
      },
      randomUUID(),
    ),
    /RETRIEVAL_CONFIG_MISMATCH/,
  );
  const dev = await setup(undefined, (cs) => [
    ...cs,
    ...cs.map((c) => ({
      ...c,
      id: `dev_${c.id}`,
      split: "development" as const,
    })),
  ]);
  const devIds = await evaluate(dev, undefined, "development");
  await assert.rejects(
    service.assess(
      { idempotencyKey: randomUUID(), policyId: dev.policy.id, ...devIds },
      randomUUID(),
    ),
    /REQUIRES_HOLDOUT/,
  );
});
test("concurrent activation is compare-and-swap; retries return the original event without switching again", async () => {
  const s = await setup(),
    ids = await evaluate(s),
    first = await service.assess(
      { idempotencyKey: randomUUID(), policyId: s.policy.id, ...ids },
      randomUUID(),
    ),
    second = await service.assess(
      { idempotencyKey: randomUUID(), policyId: s.policy.id, ...ids },
      randomUUID(),
    );
  const requests = [first, second].map((p) => ({
    idempotencyKey: randomUUID(),
    expectedRevision: 0,
    action: "publish",
    publicationId: p.id,
    note: "race",
  }));
  const result = await Promise.allSettled(
    requests.map((r) =>
      service.transition(s.release.rulesetId, r, randomUUID()),
    ),
  );
  assert.equal(result.filter((r) => r.status === "fulfilled").length, 1);
  const winner = result.findIndex((r) => r.status === "fulfilled"),
    loser = 1 - winner;
  assert.match(
    String((result[loser] as PromiseRejectedResult).reason),
    /REVISION_CONFLICT/,
  );
  const original = await service.transition(
    s.release.rulesetId,
    requests[winner],
    randomUUID(),
  );
  assert.equal(original.revision, 1);
  assert.equal((await service.history(s.release.rulesetId)).total, 1);
  await assert.rejects(
    move(s.release.rulesetId, requests[loser].publicationId, "publish"),
    /BASELINE_CHANGED/,
  );
  await assert.rejects(
    move(s.release.rulesetId, requests[loser].publicationId, "rollback"),
    /NOT_PREVIOUSLY_ACTIVE/,
  );
  await move(s.release.rulesetId, null, "deactivate");
  assert.equal(
    (
      await service.transition(
        s.release.rulesetId,
        requests[winner],
        randomUUID(),
      )
    ).revision,
    1,
  );
  assert.equal((await service.head(s.release.rulesetId)).publicationId, null);
  await assert.rejects(
    service.transition(
      s.release.rulesetId,
      { ...requests[winner], note: "changed" },
      randomUUID(),
    ),
    /IDEMPOTENCY_CONFLICT/,
  );
});
test("model changes fail closed at activation and resolution but still allow emergency deactivation", async () => {
  const s = await setup(),
    publication = await assess(s);
  const changed = new PublicationService(
    fixture.db,
    new AnswerService(
      fixture.db,
      vectors,
      new CompatibleChatProvider({ ...chat.config, revision: "new" }),
    ),
  );
  const raw = {
    idempotencyKey: randomUUID(),
    expectedRevision: 0,
    action: "publish",
    publicationId: publication.id,
    note: "runtime check",
  };
  await assert.rejects(
    changed.transition(s.release.rulesetId, raw, randomUUID()),
    /RUNTIME_MISMATCH/,
  );
  assert.equal((await service.head(s.release.rulesetId)).revision, 0);
  await service.transition(s.release.rulesetId, raw, randomUUID());
  await assert.rejects(
    changed.resolve(s.release.rulesetId),
    /RUNTIME_MISMATCH/,
  );
  const unavailable = new PublicationService(fixture.db, async () => {
    throw new Error("synthetic invalid provider configuration");
  });
  await unavailable.transition(
    s.release.rulesetId,
    {
      idempotencyKey: randomUUID(),
      expectedRevision: 1,
      action: "deactivate",
      publicationId: null,
      note: "Emergency stop",
    },
    randomUUID(),
  );
  assert.equal((await service.head(s.release.rulesetId)).publicationId, null);
});
test("publication event and pointer roll back if administrator audit persistence fails", async () => {
  const s = await setup(),
    publication = await assess(s);
  await fixture.db.query(
    "CREATE FUNCTION fail_publication_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='publication.publish' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER synthetic_audit_failure BEFORE INSERT ON admin_audit_events FOR EACH ROW EXECUTE FUNCTION fail_publication_audit()",
  );
  try {
    await assert.rejects(
      move(s.release.rulesetId, publication.id),
      /synthetic audit failure/,
    );
    assert.equal((await service.head(s.release.rulesetId)).revision, 0);
    assert.equal((await service.history(s.release.rulesetId)).total, 0);
  } finally {
    await fixture.db.query(
      "DROP TRIGGER synthetic_audit_failure ON admin_audit_events; DROP FUNCTION fail_publication_audit()",
    );
  }
  await move(s.release.rulesetId, publication.id);
  assert.equal((await service.head(s.release.rulesetId)).revision, 1);
});
test("administrator routes require auth and expose strict publication contracts", async () => {
  const s = await setup(),
    publication = await assess(s),
    token = "publication-test-" + "x".repeat(32),
    deps = {
      getDb: async () => fixture.db,
      getPublications: async () => service,
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
  assert.equal(
    (await call(`/publications/${publication.id}`, undefined, false)).status,
    401,
  );
  const raw = {
    idempotencyKey: randomUUID(),
    expectedRevision: 0,
    action: "publish",
    publicationId: publication.id,
    note: "Synthetic API publish",
  };
  assert.equal(
    (
      await call(`/rulesets/${s.release.rulesetId}/publication-transitions`, {
        ...raw,
        force: true,
      })
    ).status,
    400,
  );
  const published = await call(
    `/rulesets/${s.release.rulesetId}/publication-transitions`,
    raw,
  );
  assert.equal(published.status, 201, await published.clone().text());
  const head = await call(`/rulesets/${s.release.rulesetId}/publication`);
  assert.equal(head.status, 200);
  assert.equal(
    JSON.parse(await head.text()).data.publicationId,
    publication.id,
  );
  assert.ok(
    openApiDocument().paths["/api/admin/rulesets/{id}/publication-transitions"],
  );
});

test("answer configuration rejects missing or mismatched embedding service before a publication can activate", async () => {
  const s = await seed(),
    http = await embeddingServer();
  try {
    const configured = new VectorService(fixture.db, queue, http.provider),
      queued = await configured.enqueue(s.build.id, randomUUID());
    await configured.workOnce();
    const retrieval = {
      indexBuildId: s.build.id,
      vectorIndexId: queued.vectorIndexId,
      mode: "hybrid",
    };
    await assert.rejects(
      answers.configuration(retrieval),
      /EMBEDDING_NOT_CONFIGURED/,
    );
    const changed = new VectorService(fixture.db, queue, {
      profile: { ...http.provider.profile, revision: "changed" },
      embed: http.provider.embed.bind(http.provider),
    });
    await assert.rejects(
      new AnswerService(fixture.db, changed, chat.provider).configuration(
        retrieval,
      ),
      /EMBEDDING_PROFILE_MISMATCH/,
    );
    assert.ok(
      (
        await new AnswerService(
          fixture.db,
          configured,
          chat.provider,
        ).configuration(retrieval)
      ).config.embeddingProfileHash,
    );
  } finally {
    await http.close();
  }
});

test("unidentified application builds cannot pass the public release gate", async () => {
  const s = await setup();
  const previous = process.env.APP_REVISION;
  delete process.env.APP_REVISION;
  let ids: Awaited<ReturnType<typeof evaluate>>;
  try {
    ids = await evaluate(s);
  } finally {
    process.env.APP_REVISION = previous;
  }
  const denied = await service.assess(
    { idempotencyKey: randomUUID(), policyId: s.policy.id, ...ids },
    randomUUID(),
  );
  assert.equal(denied.passed, false);
  assert.ok(denied.gate.failures.includes("BUILD_REVISION_REQUIRED"));
  await assert.rejects(move(s.release.rulesetId, denied.id), /GATE_FAILED/);
});
