import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { testDatabase } from "./helpers/database.js";
import { embeddingServer } from "./helpers/embedding.js";
import { KnowledgeRepository } from "../packages/db/src/index.ts";
import { KnowledgeIndexService } from "../packages/retrieval/src/index.ts";
import {
  evaluationSchemas as e,
  type EvalCase,
  type CaseResult,
} from "../packages/contracts/src/index.ts";
import { scoreEvidence, summarize } from "../packages/evaluations/src/index.ts";
import {
  EvaluationService,
  EVALUATION_QUEUE,
  VectorService,
  connectQueue,
  handleAdmin,
  openApiDocument,
} from "../packages/backend/src/index.ts";
let fixture: Awaited<ReturnType<typeof testDatabase>>;
let queue: Awaited<ReturnType<typeof connectQueue>>;
let http: Awaited<ReturnType<typeof embeddingServer>>;
let repo: KnowledgeRepository;
let knowledge: KnowledgeIndexService;
let vectors: VectorService;
let service: EvaluationService;
before(async () => {
  fixture = await testDatabase();
  await fixture.db.runMigrations();
  queue = await connectQueue((fixture.db.options as { url: string }).url, true);
  http = await embeddingServer();
  repo = new KnowledgeRepository(fixture.db);
  knowledge = new KnowledgeIndexService(fixture.db);
  vectors = new VectorService(fixture.db, queue, http.provider);
  service = new EvaluationService(fixture.db, queue, vectors);
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
  if (rules.length > 1)
    await fixture.db.query(
      "INSERT INTO rule_relations(revision_id,from_rule_id,to_rule_id,kind) VALUES($1,$2,$3,'exception')",
      [rev.id, rules[0].id, rules[1].id],
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
  sets: string[][],
  extras: Partial<EvalCase> = {},
): EvalCase {
  return {
    id,
    category: "recall",
    split: "development",
    severity: "normal",
    messages: [{ role: "user", content: "工厂花砖" }],
    query: "工厂",
    expectedBehavior: "answer",
    requiredClaims: [],
    forbiddenClaims: [],
    acceptableEvidenceSets: sets,
    reviewNote: "合成数据，仅验证工程，非花砖物语标准答案",
    ...extras,
  };
}
async function setup(
  cases?: (a: Awaited<ReturnType<typeof seed>>) => EvalCase[],
) {
  const a = await seed();
  const dataset = await service.createDataset(
    a.release.id,
    {
      name: "synthetic",
      revision: "1",
      cases: cases ? cases(a) : [makeCase("factory", [[a.rules[0].id]])],
    },
    randomUUID(),
  );
  return { ...a, dataset };
}
async function execute(
  a: Awaited<ReturnType<typeof setup>>,
  config: Record<string, unknown> = {},
) {
  const { runId } = await service.enqueue(
    a.dataset.id,
    {
      idempotencyKey: randomUUID(),
      config: {
        indexBuildId: a.build.id,
        mode: "lexical",
        split: "development",
        ...config,
      },
    },
    randomUUID(),
  );
  await service.workOnce();
  return await service.get(runId);
}
test("metrics require a complete alternative, deduplicate ranks and retain failed/missing cases in denominator", () => {
  assert.deepEqual(scoreEvidence([["a", "b"], ["c"]], ["a", "a", "x", "b"]), {
    complete: true,
    bestSetRecall: 1,
    reciprocalRank: 1,
    completeReciprocalRank: 1 / 3,
  });
  assert.equal(scoreEvidence([["a", "b"], ["c"]], ["a"])!.complete, false);
  assert.equal(scoreEvidence([["a", "b"], ["c"]], ["a"])!.bestSetRecall, 0.5);
  assert.equal(scoreEvidence([["a", "b"], ["c"]], ["c"])!.complete, true);
  assert.equal(scoreEvidence([], []), null);
  const cases = [
    makeCase("ok", [["a"]]),
    makeCase("failed", [["a"]]),
    makeCase("pending", [["a"]]),
    makeCase("negative", [], { expectedBehavior: "abstain" }),
  ];
  const result: CaseResult = {
    caseId: "ok",
    category: "recall",
    severity: "normal",
    status: "succeeded",
    errorCode: null,
    durationMs: 10,
    usageTokens: 3,
    search: null,
    context: null,
    searchScore: scoreEvidence([["a"]], ["a"]),
    contextScore: null,
  };
  const report = summarize(
    cases,
    [
      result,
      {
        ...result,
        caseId: "failed",
        status: "failed",
        searchScore: scoreEvidence([["a"]], []),
        usageTokens: null,
        durationMs: 90,
      },
    ],
    false,
  );
  assert.equal(report.search.completeRate, 1 / 3);
  assert.equal(report.search.denominator, 3);
  assert.equal(report.unscored, 1);
  assert.equal(report.failed, 1);
  assert.equal(report.pending, 2);
  assert.equal(report.latencyMs.p95, 90);
  assert.equal(report.usage.unknownCases, 1);
  assert.equal(summarize([cases[3]], [], false).search.completeRate, null);
});
test("datasets reject unknown/cross-release evidence, duplicate IDs and changed immutable revisions", async () => {
  const a = await setup();
  const b = await setup();
  await assert.rejects(
    service.createDataset(
      a.release.id,
      {
        name: "foreign",
        revision: "1",
        cases: [makeCase("bad", [[b.rules[0].id]])],
      },
      randomUUID(),
    ),
    /outside dataset release/,
  );
  await assert.rejects(
    service.createDataset(
      a.release.id,
      {
        ...a.dataset.manifest,
        cases: [a.dataset.manifest.cases[0], a.dataset.manifest.cases[0]],
      },
      randomUUID(),
    ),
    /Duplicate cases/,
  );
  await assert.rejects(
    service.createDataset(
      a.release.id,
      {
        ...a.dataset.manifest,
        cases: [makeCase("changed", [[a.rules[1].id]])],
      },
      randomUUID(),
    ),
    /REVISION_CONFLICT/,
  );
  assert.equal(
    (
      await service.createDataset(
        a.release.id,
        a.dataset.manifest,
        randomUUID(),
      )
    ).id,
    a.dataset.id,
  );
  assert.match(a.dataset.manifestHash, /^[0-9a-f]{64}$/);
  await assert.rejects(
    fixture.db.query("UPDATE eval_datasets SET manifest='{}' WHERE id=$1", [
      a.dataset.id,
    ]),
    /immutable/,
  );
  assert.equal(e.evalCase.safeParse(makeCase("bad", [])).success, false);
  assert.equal(
    e.evalCase.safeParse(
      makeCase("negative", [], { expectedBehavior: "abstain" }),
    ).success,
    true,
  );
});
test("lexical evaluations run without a model, isolate holdout and report context completeness separately", async () => {
  const a = await setup((a) => [
    makeCase("factory-and-exception", [[a.rules[0].id, a.rules[1].id]], {
      severity: "critical",
    }),
    makeCase("negative", [], {
      expectedBehavior: "abstain",
      category: "insufficient_evidence",
      query: "zzzznothere",
    }),
    makeCase("holdout", [[a.rules[2].id]], { split: "holdout", query: "回合" }),
  ]);
  const local = new EvaluationService(fixture.db, queue);
  const input = {
    idempotencyKey: randomUUID(),
    config: {
      indexBuildId: a.build.id,
      mode: "lexical",
      split: "development",
      limit: 1,
      context: { maxRules: 1, maxChars: 1000 },
    },
  };
  const ids = await Promise.all(
    Array.from({ length: 3 }, () =>
      local.enqueue(a.dataset.id, input, randomUUID()),
    ),
  );
  assert.equal(new Set(ids.map((x) => x.runId)).size, 1);
  await local.workOnce();
  const run = await local.get(ids[0].runId);
  const report = run.report as any;
  assert.equal(run.state, "completed");
  assert.equal(run.totalCases, 2);
  assert.equal(report.search.completeRate, 0);
  assert.equal(report.context.completeRate, 0);
  assert.equal(report.search.meanBestSetRecall, 0.5);
  assert.equal(report.unscored, 1);
  assert.deepEqual(report.failures, ["factory-and-exception"]);
  assert.equal(report.answerQualityEvaluated, false);
  const rows = await local.results(run.id);
  assert.equal(rows.items.length, 2);
  assert.ok(rows.items.every((r) => r.caseId !== "holdout"));
  assert.equal(rows.items[0].searchScore!.complete, false);
  const expanded = await execute(a, {
    limit: 1,
    context: { maxRules: 20, maxChars: 32000 },
  });
  assert.equal((expanded.report as any).search.completeRate, 0);
  assert.equal((expanded.report as any).context.completeRate, 1);
  const held = await execute(a, { split: "holdout" });
  assert.equal(held.totalCases, 1);
  assert.equal((held.report as any).search.completeRate, 1);
  await assert.rejects(
    local.enqueue(
      a.dataset.id,
      { ...input, config: { ...input.config, limit: 2 } },
      randomUUID(),
    ),
    /IDEMPOTENCY_CONFLICT/,
  );
  await assert.rejects(
    fixture.db.query("UPDATE eval_results SET result='{}' WHERE run_id=$1", [
      run.id,
    ]),
    /immutable/,
  );
  await assert.rejects(
    fixture.db.query("UPDATE eval_runs SET state='queued' WHERE id=$1", [
      run.id,
    ]),
    /immutable/,
  );
});
test("evaluation refuses mismatched release/index, empty split, and premature completion at database boundary", async () => {
  const a = await setup(),
    b = await setup();
  await assert.rejects(
    service.enqueue(
      a.dataset.id,
      {
        idempotencyKey: randomUUID(),
        config: {
          indexBuildId: b.build.id,
          mode: "lexical",
          split: "development",
        },
      },
      randomUUID(),
    ),
    /RELEASE_MISMATCH/,
  );
  await assert.rejects(
    service.enqueue(
      a.dataset.id,
      {
        idempotencyKey: randomUUID(),
        config: { indexBuildId: a.build.id, mode: "lexical", split: "holdout" },
      },
      randomUUID(),
    ),
    /SPLIT_EMPTY/,
  );
  const { runId } = await service.enqueue(
    a.dataset.id,
    {
      idempotencyKey: randomUUID(),
      config: {
        indexBuildId: a.build.id,
        mode: "lexical",
        split: "development",
      },
    },
    randomUUID(),
  );
  await assert.rejects(
    fixture.db.query(
      "UPDATE eval_runs SET state='completed',report='{}' WHERE id=$1",
      [runId],
    ),
    /every selected result/,
  );
  await assert.rejects(
    fixture.db.query("UPDATE eval_runs SET config='{}' WHERE id=$1", [runId]),
    /identity/,
  );
  await assert.rejects(
    fixture.db.query(
      "INSERT INTO eval_results(run_id,case_id,result) VALUES($1,'factory',$2)",
      [runId, JSON.stringify({ caseId: "factory", status: "succeeded" })],
    ),
    /running evaluation/,
  );
  await service.workOnce();
});
test("hybrid reports preserve raw evidence, model identity and usage; provider errors do not vanish", async () => {
  const a = await setup((a) => [
    makeCase("floor", [[a.rules[1].id]], { query: "跌落的损失" }),
  ]);
  const { vectorIndexId } = await vectors.enqueue(a.build.id, randomUUID());
  await vectors.workOnce();
  const run = await execute(a, {
    mode: "hybrid",
    vectorIndexId,
    context: { maxRules: 20, maxChars: 32000 },
  });
  assert.equal(run.state, "completed");
  assert.equal((run.report as any).context.completeRate, 1);
  assert.equal(
    (run.identity as any).embeddingProfile.model,
    http.provider.profile.model,
  );
  const [result] = (await service.results(run.id)).items;
  assert.equal(result.usageTokens, 10);
  assert.ok((result.search as any).retrievalRunId);
  assert.ok((result.context as any).evidence[0].sources[0].blockId);
  const broken = new EvaluationService(
    fixture.db,
    queue,
    new VectorService(fixture.db, queue),
  );
  const { runId } = await broken.enqueue(
    a.dataset.id,
    {
      idempotencyKey: randomUUID(),
      config: {
        indexBuildId: a.build.id,
        vectorIndexId,
        mode: "hybrid",
        split: "development",
      },
    },
    randomUUID(),
  );
  await broken.workOnce();
  const failed = await broken.get(runId);
  assert.equal(failed.state, "completed_with_errors");
  assert.equal((failed.report as any).search.completeRate, 0);
  assert.equal((failed.report as any).failed, 1);
  assert.equal(
    (await broken.results(runId)).items[0].errorCode,
    "EMBEDDING_NOT_CONFIGURED",
  );
  await assert.rejects(broken.retry(runId, randomUUID()), /NOT_FAILED/);
});
test("interrupted jobs keep committed cases, resume missing cases, and recover purged queue records", async () => {
  const a = await setup((a) => [
    makeCase("first", [[a.rules[0].id]]),
    makeCase("second", [[a.rules[1].id]], { query: "地板" }),
  ]);
  const { vectorIndexId } = await vectors.enqueue(a.build.id, randomUUID());
  await vectors.workOnce();
  const controller = new AbortController();
  let calls = 0;
  class InterruptingVectorService extends VectorService {
    override async search(...args: Parameters<VectorService["search"]>) {
      const result = await super.search(...args);
      if (++calls === 2) controller.abort();
      return result;
    }
  }
  const interrupted = new EvaluationService(
    fixture.db,
    queue,
    new InterruptingVectorService(fixture.db, queue, http.provider),
  );
  const { runId } = await interrupted.enqueue(
    a.dataset.id,
    {
      idempotencyKey: randomUUID(),
      config: {
        indexBuildId: a.build.id,
        vectorIndexId,
        mode: "hybrid",
        split: "development",
      },
    },
    randomUUID(),
  );
  const [job] = await queue.fetch<{ runId: string }>(EVALUATION_QUEUE, {
    includeMetadata: true,
    batchSize: 1,
  });
  assert.equal(job.id, runId);
  await assert.rejects(
    interrupted.process({ ...job, signal: controller.signal }),
    /STALE_EVALUATION_ATTEMPT/,
  );
  assert.equal((await interrupted.results(runId)).total, 1);
  await queue.deleteJob(EVALUATION_QUEUE, runId);
  assert.equal(
    (await service.get(runId)).errorCode,
    "EVALUATION_QUEUE_RECORD_MISSING",
  );
  await service.retry(runId, randomUUID());
  const before = http.requests.length;
  await service.workOnce();
  const completed = await service.get(runId);
  assert.equal(completed.state, "completed");
  assert.equal(completed.completedCases, 2);
  assert.equal(http.requests.length - before, 1);
  assert.equal(completed.attempts, 2);
});
test("evaluation API enforces auth, strict input, result pagination and OpenAPI schemas", async () => {
  const a = await setup();
  const token = "test-evals-" + "x".repeat(32);
  const deps = {
    getDb: async () => fixture.db,
    getEvaluations: async () => service,
    adminToken: () => token,
  };
  async function call(path: string, body?: unknown, authorized = true) {
    return handleAdmin(
      new Request(`http://local/api/admin${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          "content-type": "application/json",
          ...(authorized ? { authorization: `Bearer ${token}` } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      deps,
    );
  }
  assert.equal(
    (await call(`/evaluation-datasets/${a.dataset.id}`, undefined, false))
      .status,
    401,
  );
  const response = await call(`/evaluation-datasets/${a.dataset.id}/runs`, {
    idempotencyKey: randomUUID(),
    config: { indexBuildId: a.build.id, mode: "lexical", split: "development" },
  });
  assert.equal(response.status, 202, await response.clone().text());
  const { runId } = JSON.parse(await response.text()).data;
  await service.workOnce();
  const result = await call(
    `/evaluation-runs/${runId}/results?limit=1&offset=0`,
  );
  assert.equal(result.status, 200, await result.clone().text());
  assert.equal(JSON.parse(await result.text()).data.items.length, 1);
  assert.equal(
    (await call(`/evaluation-runs/${runId}/results?limit=0`)).status,
    400,
  );
  assert.ok(
    openApiDocument().paths["/api/admin/evaluation-datasets/{id}/runs"],
  );
});

test("an obsolete worker cannot overwrite results after another attempt finishes", async () => {
  const a = await setup();
  const { vectorIndexId } = await vectors.enqueue(a.build.id, randomUUID());
  await vectors.workOnce();
  let unblock!: () => void, entered!: () => void;
  const waiting = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  class SlowVectors extends VectorService {
    override async search(...args: Parameters<VectorService["search"]>) {
      entered();
      await waiting;
      return super.search(...args);
    }
  }
  const old = new EvaluationService(
    fixture.db,
    queue,
    new SlowVectors(fixture.db, queue, http.provider),
  );
  const { runId } = await old.enqueue(
    a.dataset.id,
    {
      idempotencyKey: randomUUID(),
      config: {
        indexBuildId: a.build.id,
        vectorIndexId,
        mode: "hybrid",
        split: "development",
      },
    },
    randomUUID(),
  );
  const [job] = await queue.fetch<{ runId: string }>(EVALUATION_QUEUE, {
    includeMetadata: true,
    batchSize: 1,
  });
  assert.equal(job.id, runId);
  const obsolete = old.process(job);
  const rejected = assert.rejects(obsolete, /STALE_EVALUATION_ATTEMPT/);
  await started;
  try {
    await service.process(job);
  } finally {
    unblock();
  }
  await rejected;
  await queue.complete(EVALUATION_QUEUE, job);
  const run = await service.get(runId);
  assert.equal(run.state, "completed");
  assert.equal(run.attempts, 2);
  assert.equal(run.completedCases, 1);
  assert.equal((run.report as any).search.completeRate, 1);
});

test("UUID casing is canonicalized before evidence scoring and idempotency comparison", async () => {
  const a = await seed();
  const dataset = await service.createDataset(
    a.release.id.toUpperCase(),
    {
      name: "canonical",
      revision: "1",
      cases: [makeCase("factory", [[a.rules[0].id.toUpperCase()]])],
    },
    randomUUID(),
  );
  assert.equal(
    dataset.manifest.cases[0].acceptableEvidenceSets[0][0],
    a.rules[0].id,
  );
  const key = randomUUID();
  const request = {
    idempotencyKey: key.toUpperCase(),
    config: {
      indexBuildId: a.build.id.toUpperCase(),
      mode: "lexical",
      split: "development",
    },
  };
  const first = await service.enqueue(
    dataset.id.toUpperCase(),
    request,
    randomUUID(),
  );
  assert.equal(first.runId, key);
  assert.equal(
    (await service.enqueue(dataset.id, request, randomUUID())).runId,
    key,
  );
  await service.workOnce();
  assert.equal((await service.get(key)).report!.search.completeRate, 1);
});
