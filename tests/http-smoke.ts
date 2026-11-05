import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { once } from "node:events";
import { resolve, join } from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { syntheticPdf } from "./helpers/pdf.js";
import {
  connectQueue,
  IngestionService,
  LocalBlobStore,
  PythonPdfParser,
  sha256,
  VectorService,
  EvaluationService,
  AnswerEvaluationService,
  AnswerService,
} from "../packages/backend/src/index.ts";
import { testDatabase } from "./helpers/database.js";

import { embeddingServer } from "./helpers/embedding.js";
import { chatServer } from "./helpers/chat.js";
import {
  publicationCases,
  publicationReply,
  publicationPolicy,
  passingReview,
} from "./helpers/publication.js";
// Synthetic deployment identity; shared by the isolated HTTP server and workers.
process.env.APP_REVISION = "0".repeat(40);
const chatHttp = await chatServer(publicationReply);
const wechatCalls: URL[] = [];
const wechatHttp = createHttpServer((req, res) => {
  const url = new URL(req.url!, "http://127.0.0.1");
  wechatCalls.push(url);
  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      openid: "http-synthetic-member",
      access_token: "http-synthetic-access-token",
      expires_in: 7200,
      scope: "snsapi_login",
    }),
  );
});
await new Promise<void>((r) => wechatHttp.listen(0, "127.0.0.1", r));
const wechatEndpoint = `http://127.0.0.1:${(wechatHttp.address() as { port: number }).port}/`;

const embeddingHttp = await embeddingServer();
const fixture = await testDatabase();
await fixture.db.runMigrations();
const queue = await connectQueue(
  (fixture.db.options as { url: string }).url,
  true,
);
const storage = await mkdtemp(join(tmpdir(), "boardgame-http-store-"));
const script = resolve("services/document-parser/parse.py");
const runner = new IngestionService(
  fixture.db,
  queue,
  new LocalBlobStore(storage),
  new PythonPdfParser(process.env.PARSER_PYTHON ?? "python3", script),
);
const socket = createServer();
await new Promise<void>((r) => socket.listen(0, "127.0.0.1", r));
const port = (socket.address() as { port: number }).port;
await new Promise<void>((r) => socket.close(() => r()));
const token = randomBytes(32).toString("hex");
const child = spawn(
  process.execPath,
  [
    "--import",
    resolve("tests/helpers/wechat-fetch.mjs"),
    resolve("node_modules/next/dist/bin/next"),
    "start",
    "--hostname",
    "127.0.0.1",
    "--port",
    String(port),
  ],
  {
    cwd: resolve("apps/web"),
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      ADMIN_API_TOKEN: token,
      PUBLIC_APP_ORIGIN: `http://127.0.0.1:${port}`,
      PUBLIC_GUEST_DAILY_QUESTIONS: "2",
      PUBLIC_MEMBER_DAILY_QUESTIONS: "5",
      WECHAT_APP_ID: "wx_http_synthetic",
      WECHAT_APP_SECRET: "http-synthetic-app-secret",
      TEST_WECHAT_LOOPBACK: wechatEndpoint,
      PUBLIC_GLOBAL_DAILY_QUESTIONS: "10",
      CHAT_BASE_URL: chatHttp.config.baseUrl,
      CHAT_API_KEY: chatHttp.config.apiKey,
      CHAT_PROVIDER_ID: chatHttp.config.providerId,
      CHAT_MODEL: chatHttp.config.model,
      CHAT_MODEL_REVISION: chatHttp.config.revision,
      CHAT_CONTEXT_WINDOW: String(chatHttp.config.contextWindow),
      CHAT_INPUT_USD_PER_MILLION: String(chatHttp.config.inputUsdPerMillion),
      CHAT_OUTPUT_USD_PER_MILLION: String(chatHttp.config.outputUsdPerMillion),
      DATABASE_URL: (fixture.db.options as { url: string }).url,
      NEXT_TELEMETRY_DISABLED: "1",
      STORAGE_ROOT: storage,
      PARSER_SCRIPT: script,
      EMBEDDING_ENDPOINT: embeddingHttp.endpoint,
      EMBEDDING_API_KEY: embeddingHttp.config.apiKey,
      EMBEDDING_PROVIDER_ID: embeddingHttp.config.providerId,
      EMBEDDING_MODEL: embeddingHttp.config.model,
      EMBEDDING_REVISION: embeddingHttp.config.revision,
      EMBEDDING_DIMENSIONS: "3",
      EMBEDDING_MAX_INPUT_CHARS: "8000",
      EMBEDDING_SEND_DIMENSIONS: "false",
      EMBEDDING_DOCUMENT_PREFIX: "",
      EMBEDDING_QUERY_PREFIX: "",
    },
  },
);
let log = "";
child.stdout.on("data", (v) => {
  log += v;
});
child.stderr.on("data", (v) => {
  log += v;
});
const base = `http://127.0.0.1:${port}`;
try {
  let ready = false;
  for (let i = 0; i < 80; i++) {
    if (child.exitCode !== null) throw new Error(`Web process failed: ${log}`);
    try {
      if ((await fetch(`${base}/api/health`)).ok) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  assert.ok(ready, "Web process did not start");
  assert.equal((await fetch(`${base}/api/session`)).status, 401);
  assert.equal(
    (await fetch(`${base}/api/session`, { method: "POST" })).status,
    403,
  );
  const sessionHeaders = { origin: base, "x-boardgame-request": "1" };
  const minted = await fetch(`${base}/api/session`, {
    method: "POST",
    headers: sessionHeaders,
  });
  assert.equal(minted.status, 200, await minted.clone().text());
  const browserCookie = minted.headers.get("set-cookie")!.split(";")[0];
  assert.match(browserCookie, /boardgame_local_session=/);
  const current = await fetch(`${base}/api/session`, {
    headers: { cookie: browserCookie },
  });
  assert.equal(current.status, 200);
  assert.equal(JSON.parse(await current.text()).data.quota.remaining, 2);
  const logout = await fetch(`${base}/api/session`, {
    method: "DELETE",
    headers: { ...sessionHeaders, cookie: browserCookie },
  });
  assert.equal(logout.status, 200);
  assert.equal(
    (await fetch(`${base}/api/session`, { headers: { cookie: browserCookie } }))
      .status,
    401,
  );
  const publicSpec = await fetch(`${base}/api/openapi`);
  assert.equal(publicSpec.status, 200);
  assert.ok(JSON.parse(await publicSpec.text()).paths["/api/session"]);
  console.info(
    "PASS production HTTP: opaque guest cookie, origin protection, quota view, revocation and public OpenAPI",
  );

  assert.equal((await fetch(`${base}/api/admin/games`)).status, 401);
  const headers = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
  const created = await fetch(`${base}/api/admin/games`, {
    method: "POST",
    headers,
    body: JSON.stringify({ slug: "http-smoke", name: "合成 HTTP 验证" }),
  });
  assert.equal(created.status, 201, await created.clone().text());
  const result = JSON.parse(await created.text());
  assert.ok(result.data.id);
  const listed = await fetch(`${base}/api/admin/games`, { headers });
  assert.equal(listed.status, 200);
  assert.equal(JSON.parse(await listed.text()).data.total, 1);
  const spec = await fetch(`${base}/api/admin/openapi`, { headers });
  assert.equal(spec.status, 200);
  assert.equal(JSON.parse(await spec.text()).openapi, "3.1.0");
  async function post(path: string, body: unknown, status = 201) {
    const response = await fetch(`${base}/api/admin${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    assert.equal(response.status, status, await response.clone().text());
    return JSON.parse(await response.text()).data;
  }
  const ruleset = await post("/rulesets", {
    gameId: result.data.id,
    name: "Parser smoke",
    language: "zh-CN",
    scope: "local validation only",
  });
  const bytes = process.env.INGESTION_TEST_PDF
    ? await readFile(process.env.INGESTION_TEST_PDF)
    : syntheticPdf();
  const doc = await post("/documents", {
    rulesetId: ruleset.id,
    title: "Private parser smoke",
    sourceType: "rulebook",
    sha256: sha256(bytes),
  });
  const uploaded = await fetch(`${base}/api/admin/documents/${doc.id}/file`, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/pdf",
    },
    body: new Uint8Array(bytes),
  });
  assert.equal(uploaded.status, 200, await uploaded.clone().text());
  const downloaded = await fetch(`${base}/api/admin/documents/${doc.id}/file`, {
    headers,
  });
  assert.equal(downloaded.status, 200);
  assert.equal(
    sha256(new Uint8Array(await downloaded.arrayBuffer())),
    sha256(bytes),
  );
  const parserConfig = process.env.INGESTION_TEST_CONFIG
    ? JSON.parse(await readFile(process.env.INGESTION_TEST_CONFIG, "utf8"))
    : {};
  const revision = await post(`/documents/${doc.id}/revisions`, {
    parserConfig,
  });
  const job = await post(`/revisions/${revision.id}/parse`, {}, 202);
  assert.equal(
    (await post(`/revisions/${revision.id}/parse`, {}, 202)).jobId,
    job.jobId,
  );
  await runner.start();
  let finished = false;
  for (let i = 0; i < 120; i++) {
    const response = await fetch(`${base}/api/admin/jobs/${job.jobId}`, {
      headers,
    });
    assert.equal(response.status, 200);
    const state = JSON.parse(await response.text()).data;
    if (state.state === "failed")
      throw new Error(`Parse job failed: ${state.error_code}`);
    if (state.state === "succeeded") {
      finished = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  assert.ok(finished, "Parse job did not finish");
  const parsedResponse = await fetch(
    `${base}/api/admin/revisions/${revision.id}/parse-result`,
    { headers },
  );
  assert.equal(parsedResponse.status, 200);
  const parsed = JSON.parse(await parsedResponse.text()).data;
  assert.ok(
    parsed.blocks.some((b: { rawText: string }) => b.rawText.length > 20),
  );
  const status = (
    await fixture.db.query(
      "SELECT status FROM document_revisions WHERE id=$1",
      [revision.id],
    )
  )[0].status;
  assert.equal(status, "awaiting_review");
  // Only generated fixtures are automatically approved; private rulebooks stay awaiting_review.
  if (!process.env.INGESTION_TEST_PDF) {
    const response = await fetch(
      `${base}/api/admin/revisions/${revision.id}/blocks`,
      { headers },
    );
    assert.equal(response.status, 200);
    const block = JSON.parse(await response.text()).data.items[0];
    const rule = await post(`/revisions/${revision.id}/rules`, {
      kind: "rule",
      reviewedText: block.rawText,
      reviewStatus: "approved",
      sourceBlockIds: [block.id],
    });
    await post(
      `/revisions/${revision.id}/parser-review`,
      {
        note: "Generated fixture manually specified by the test; verified source text and order.",
      },
      200,
    );
    await post(`/revisions/${revision.id}/approve`, {}, 200);
    const release = await post(`/rulesets/${ruleset.id}/releases`, {
      name: "HTTP synthetic baseline",
      revisionIds: [revision.id],
    });
    const index = await post(`/releases/${release.id}/indexes`, {});
    const search = await post(
      `/index-builds/${index.id}/search`,
      { query: "Synthetic tile" },
      200,
    );
    assert.ok(
      search.hits.some((hit: { ruleId: string }) => hit.ruleId === rule.id),
    );
    const context = await post(
      `/index-builds/${index.id}/context`,
      { chunkIds: [search.hits[0].chunkId] },
      200,
    );
    assert.equal(context.releaseId, release.id);
    assert.equal(context.evidence[0].sources[0].blockId, block.id);
    assert.equal(context.evidence[0].sources[0].pdfPageIndex, 0);
    const vectorIndex = await post(
      `/index-builds/${index.id}/vectors`,
      {},
      202,
    );
    await new VectorService(fixture.db, queue, embeddingHttp.provider).start();
    let ready = false;
    for (let attempt = 0; attempt < 80; attempt++) {
      const response = await fetch(
        `${base}/api/admin/vector-indexes/${vectorIndex.vectorIndexId}`,
        { headers },
      );
      assert.equal(response.status, 200);
      const state = JSON.parse(await response.text()).data;
      if (state.state === "ready") {
        ready = true;
        break;
      }
      if (state.state === "failed") throw new Error(state.errorCode);
      await new Promise((r) => setTimeout(r, 250));
    }
    assert.ok(ready, "Vector worker did not finish");
    const hybrid = await post(
      `/vector-indexes/${vectorIndex.vectorIndexId}/search`,
      { query: "Synthetic tile" },
      200,
    );
    assert.equal(hybrid.indexBuildId, index.id);
    assert.equal(hybrid.hits[0].ruleId, rule.id);
    assert.ok(hybrid.candidates.vector.length);
    assert.ok(hybrid.candidates.lexical.length);
    const traced = await fetch(
      `${base}/api/admin/retrieval-runs/${hybrid.retrievalRunId}`,
      { headers },
    );
    assert.equal(traced.status, 200);
    const trace = JSON.parse(await traced.text()).data;
    assert.ok(trace.requestId);
    assert.equal(trace.status, "succeeded");
    const answerInput = {
      idempotencyKey: randomUUID(),
      question: "Synthetic tile",
      history: [],
      retrieval: {
        indexBuildId: index.id,
        vectorIndexId: vectorIndex.vectorIndexId,
        mode: "hybrid",
      },
    };
    const answerRun = await post("/answer-runs", answerInput, 200);
    assert.equal(answerRun.state, "completed", JSON.stringify(answerRun));
    assert.equal(answerRun.answer.status, "answered");
    assert.equal(answerRun.answer.citations[0].sources[0].blockId, block.id);
    assert.equal(answerRun.releaseId, release.id);
    const beforeChat = chatHttp.requests.length;
    const duplicateAnswer = await post("/answer-runs", answerInput, 200);
    assert.equal(duplicateAnswer.id, answerRun.id);
    assert.equal(chatHttp.requests.length, beforeChat);
    const answerAudit = await fetch(
      `${base}/api/admin/answer-runs/${answerRun.id}/events`,
      { headers },
    );
    assert.equal(answerAudit.status, 200);
    const answerEvents = JSON.parse(await answerAudit.text()).data;
    assert.ok(
      answerEvents.items.some(
        (event: { kind: string }) => event.kind === "answer_validation",
      ),
    );
    console.info(
      "PASS production HTTP: real Pi agent, mandatory hybrid retrieval, SSE model, validated source citations, durable idempotent answer",
    );
    const dataset = await post(`/releases/${release.id}/evaluation-datasets`, {
      name: "HTTP synthetic retrieval evaluation",
      revision: "1",
      cases: [
        {
          id: "synthetic",
          category: "recall",
          split: "development",
          severity: "critical",
          messages: [{ role: "user", content: "Synthetic tile" }],
          query: "Synthetic tile",
          expectedBehavior: "answer",
          requiredClaims: [],
          forbiddenClaims: [],
          acceptableEvidenceSets: [[rule.id]],
          reviewNote: "Synthetic fixture; not a real game answer",
        },
      ],
    });
    const evaluation = await post(
      `/evaluation-datasets/${dataset.id}/runs`,
      {
        idempotencyKey: randomUUID(),
        config: {
          indexBuildId: index.id,
          vectorIndexId: vectorIndex.vectorIndexId,
          mode: "hybrid",
          split: "development",
          context: { maxRules: 20, maxChars: 32000 },
        },
      },
      202,
    );
    await new EvaluationService(
      fixture.db,
      queue,
      new VectorService(fixture.db, queue, embeddingHttp.provider),
    ).start();
    let evaluationReady = false;
    for (let attempt = 0; attempt < 80; attempt++) {
      const response = await fetch(
        `${base}/api/admin/evaluation-runs/${evaluation.runId}`,
        { headers },
      );
      assert.equal(response.status, 200);
      const run = JSON.parse(await response.text()).data;
      if (run.state === "completed") {
        assert.equal(run.report.context.completeRate, 1);
        assert.equal(run.report.answerQualityEvaluated, false);
        evaluationReady = true;
        break;
      }
      if (["failed", "completed_with_errors"].includes(run.state))
        throw new Error(JSON.stringify(run));
      await new Promise((r) => setTimeout(r, 250));
    }
    assert.ok(evaluationReady, "Evaluation worker did not finish");
    const evaluated = await fetch(
      `${base}/api/admin/evaluation-runs/${evaluation.runId}/results?limit=1`,
      { headers },
    );
    assert.equal(evaluated.status, 200);
    const outcome = JSON.parse(await evaluated.text()).data;
    assert.equal(outcome.items[0].context.evidence[0].ruleId, rule.id);
    const answerEvaluation = await post(
      `/evaluation-datasets/${dataset.id}/answer-evaluations`,
      {
        idempotencyKey: randomUUID(),
        config: { split: "development", retrieval: answerInput.retrieval },
      },
      202,
    );
    await new AnswerEvaluationService(
      fixture.db,
      queue,
      new AnswerService(
        fixture.db,
        new VectorService(fixture.db, queue, embeddingHttp.provider),
        chatHttp.provider,
      ),
    ).start();
    let answersReady = false;
    for (let attempt = 0; attempt < 80; attempt++) {
      const response = await fetch(
        `${base}/api/admin/answer-evaluations/${answerEvaluation.evaluationId}`,
        { headers },
      );
      assert.equal(response.status, 200);
      const run = JSON.parse(await response.text()).data;
      if (run.state === "awaiting_review") {
        assert.equal(run.summary.automaticPasses, 1);
        assert.equal(run.summary.passed, 0);
        assert.equal(run.summary.semanticQualityReviewed, false);
        answersReady = true;
        break;
      }
      if (run.state === "failed") throw new Error(JSON.stringify(run));
      await new Promise((r) => setTimeout(r, 250));
    }
    assert.ok(answersReady, "Answer evaluation worker did not finish");
    const casesResponse = await fetch(
      `${base}/api/admin/answer-evaluations/${answerEvaluation.evaluationId}/cases`,
      { headers },
    );
    assert.equal(casesResponse.status, 200);
    const answerCase = JSON.parse(await casesResponse.text()).data.items[0];
    assert.equal(
      answerCase.answerRun.answer.citations[0].sources[0].blockId,
      block.id,
    );
    const reviewed = await post(
      `/answer-evaluation-cases/${answerCase.id}/reviews`,
      {
        expectedRevision: 0,
        review: {
          conclusionCorrect: true,
          conditionsAndExceptionsCorrect: true,
          ambiguityHandled: true,
          refusalAppropriate: true,
          citationsSupportClaims: true,
          requiredClaimsSatisfied: [],
          forbiddenClaimsAbsent: [],
          note: "Generated fixture only: testing review persistence, not validating Azul rules.",
        },
      },
    );
    const sealed = await post(
      `/answer-evaluations/${answerEvaluation.evaluationId}/seal`,
      { note: "Synthetic HTTP evaluation report" },
      200,
    );
    assert.equal(sealed.state, "sealed");
    assert.equal(sealed.report.summary.correctRate, 1);
    assert.match(sealed.reportHash, /^[0-9a-f]{64}$/);
    assert.equal(sealed.report.cases[0].reviewId, reviewed.id);
    console.info(
      "PASS production HTTP: queued Pi answer evaluation, manual review boundary, immutable report and provenance",
    );

    const acceptanceDataset = await post(
      `/releases/${release.id}/evaluation-datasets`,
      {
        name: "Synthetic publication holdout",
        revision: "1",
        cases: publicationCases(rule.id, "Synthetic tile"),
      },
    );
    const policy = await post(`/rulesets/${ruleset.id}/publication-policies`, {
      idempotencyKey: randomUUID(),
      datasetId: acceptanceDataset.id,
      expectedRevision: 0,
      config: publicationPolicy,
      note: "Synthetic HTTP acceptance policy",
    });
    const acceptanceRetrieval = await post(
      `/evaluation-datasets/${acceptanceDataset.id}/runs`,
      {
        idempotencyKey: randomUUID(),
        config: {
          ...answerInput.retrieval,
          split: "holdout",
          limit: 6,
          context: { maxRules: 20, maxChars: 24000 },
        },
      },
      202,
    );
    const acceptanceAnswers = await post(
      `/evaluation-datasets/${acceptanceDataset.id}/answer-evaluations`,
      {
        idempotencyKey: randomUUID(),
        config: { split: "holdout", retrieval: answerInput.retrieval },
      },
      202,
    );
    let acceptanceReady = false;
    for (let attempt = 0; attempt < 120; attempt++) {
      const responses = await Promise.all([
        fetch(
          `${base}/api/admin/evaluation-runs/${acceptanceRetrieval.runId}`,
          { headers },
        ),
        fetch(
          `${base}/api/admin/answer-evaluations/${acceptanceAnswers.evaluationId}`,
          { headers },
        ),
      ]);
      const states = [];
      for (const response of responses) {
        assert.equal(response.status, 200);
        states.push(JSON.parse(await response.text()).data);
      }
      if (
        states.some(
          (r) => r.state === "failed" || r.state === "completed_with_errors",
        )
      )
        throw new Error(JSON.stringify(states));
      if (
        states[0].state === "completed" &&
        states[1].state === "awaiting_review"
      ) {
        acceptanceReady = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    assert.ok(acceptanceReady, "Publication evaluations did not finish");
    const acceptanceCasesResponse = await fetch(
      `${base}/api/admin/answer-evaluations/${acceptanceAnswers.evaluationId}/cases`,
      { headers },
    );
    assert.equal(acceptanceCasesResponse.status, 200);
    const acceptanceCases = JSON.parse(
      await acceptanceCasesResponse.text(),
    ).data;
    for (const c of acceptanceCases.items)
      await post(`/answer-evaluation-cases/${c.id}/reviews`, {
        expectedRevision: 0,
        review: passingReview,
      });
    await post(
      `/answer-evaluations/${acceptanceAnswers.evaluationId}/seal`,
      { note: "Synthetic holdout sealed" },
      200,
    );
    const publication = await post("/publications", {
      idempotencyKey: randomUUID(),
      policyId: policy.id,
      answerEvaluationId: acceptanceAnswers.evaluationId,
      retrievalRunId: acceptanceRetrieval.runId,
    });
    assert.equal(publication.passed, true, JSON.stringify(publication.gate));
    const activated = await post(
      `/rulesets/${ruleset.id}/publication-transitions`,
      {
        idempotencyKey: randomUUID(),
        expectedRevision: 0,
        action: "publish",
        publicationId: publication.id,
        note: "Synthetic activation",
      },
    );
    assert.equal(activated.revision, 1);
    await post(`/rulesets/${ruleset.id}/publication-transitions`, {
      idempotencyKey: randomUUID(),
      expectedRevision: 1,
      action: "deactivate",
      publicationId: null,
      note: "Synthetic emergency stop",
    });
    const restored = await post(
      `/rulesets/${ruleset.id}/publication-transitions`,
      {
        idempotencyKey: randomUUID(),
        expectedRevision: 2,
        action: "rollback",
        publicationId: publication.id,
        note: "Synthetic rollback",
      },
    );
    assert.equal(restored.revision, 3);
    const guest = await fetch(`${base}/api/session`, {
      method: "POST",
      headers: sessionHeaders,
    });
    assert.equal(guest.status, 200);
    const guestCookie = guest.headers.get("set-cookie")!.split(";")[0];
    const guestHeaders = {
      ...sessionHeaders,
      cookie: guestCookie,
      "content-type": "application/json",
    };
    const createdConversation = await fetch(`${base}/api/conversations`, {
      method: "POST",
      headers: guestHeaders,
      body: JSON.stringify({
        idempotencyKey: randomUUID(),
        rulesetId: ruleset.id,
      }),
    });
    assert.equal(
      createdConversation.status,
      200,
      await createdConversation.clone().text(),
    );
    const conversation = JSON.parse(await createdConversation.text()).data;
    const messageInput = {
      idempotencyKey: randomUUID(),
      expectedRevision: 0,
      question: "Synthetic tile",
    };
    const publicAnswerResponse = await fetch(
      `${base}/api/conversations/${conversation.id}/messages`,
      {
        method: "POST",
        headers: guestHeaders,
        body: JSON.stringify(messageInput),
      },
    );
    assert.equal(
      publicAnswerResponse.status,
      200,
      await publicAnswerResponse.clone().text(),
    );
    const publicAnswer = JSON.parse(await publicAnswerResponse.text()).data;
    assert.equal(publicAnswer.state, "completed", JSON.stringify(publicAnswer));
    assert.equal(publicAnswer.publicationId, publication.id);
    assert.equal(publicAnswer.answer.citations[0].sources[0].blockId, block.id);
    const callsBeforeRetry = chatHttp.requests.length;
    const retriedPublic = await fetch(
      `${base}/api/conversations/${conversation.id}/messages`,
      {
        method: "POST",
        headers: guestHeaders,
        body: JSON.stringify(messageInput),
      },
    );
    assert.equal(retriedPublic.status, 200);
    assert.equal(chatHttp.requests.length, callsBeforeRetry);
    const history = await fetch(
      `${base}/api/conversations/${conversation.id}/messages`,
      { headers: { cookie: guestCookie } },
    );
    assert.equal(history.status, 200);
    assert.equal(JSON.parse(await history.text()).data.total, 1);
    const allowanceView = await fetch(`${base}/api/session`, {
      headers: { cookie: guestCookie },
    });
    assert.equal(JSON.parse(await allowanceView.text()).data.quota.used, 1);
    console.info(
      "PASS production HTTP: scoped public conversation, published hybrid answer, real history, quota and idempotent retry",
    );
    const loginStart = await fetch(`${base}/api/auth/wechat/start`, {
      method: "POST",
      headers: { ...sessionHeaders, cookie: guestCookie },
    });
    assert.equal(loginStart.status, 200, await loginStart.clone().text());
    const loginState = new URL(
      JSON.parse(await loginStart.text()).data.authorizationUrl,
    ).searchParams.get("state")!;
    const bindingCookie = loginStart.headers
      .getSetCookie()
      .find((c) => c.startsWith("boardgame_local_oauth="))!
      .split(";")[0];
    assert.match(loginStart.headers.get("set-cookie")!, /SameSite=Lax/);
    const callbackResponse = await fetch(
      `${base}/api/auth/wechat/callback?` +
        new URLSearchParams({ state: loginState, code: randomUUID() }),
      {
        redirect: "manual",
        headers: { cookie: bindingCookie, "sec-fetch-site": "cross-site" },
      },
    );
    assert.equal(
      callbackResponse.status,
      303,
      await callbackResponse.clone().text(),
    );
    assert.equal(callbackResponse.headers.get("location"), base + "/");
    const memberCookie = callbackResponse.headers
      .getSetCookie()
      .find((c) => c.startsWith("boardgame_local_session="))!
      .split(";")[0];
    assert.equal(
      (await fetch(`${base}/api/session`, { headers: { cookie: guestCookie } }))
        .status,
      401,
    );
    const memberView = await fetch(`${base}/api/session`, {
      headers: { cookie: memberCookie },
    });
    assert.equal(memberView.status, 200);
    const account = JSON.parse(await memberView.text()).data;
    assert.equal(account.kind, "member");
    assert.equal(account.quota.used, 1);
    assert.equal(account.quota.limit, 5);
    const memberHistory = await fetch(
      `${base}/api/conversations/${conversation.id}/messages`,
      { headers: { cookie: memberCookie } },
    );
    assert.equal(memberHistory.status, 200);
    assert.equal(JSON.parse(await memberHistory.text()).data.total, 1);
    const memberAnswer = await fetch(
      `${base}/api/conversations/${conversation.id}/messages`,
      {
        method: "POST",
        headers: {
          ...sessionHeaders,
          cookie: memberCookie,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          idempotencyKey: randomUUID(),
          expectedRevision: 1,
          question: "Synthetic tile",
        }),
      },
    );
    assert.equal(memberAnswer.status, 200, await memberAnswer.clone().text());
    assert.equal(JSON.parse(await memberAnswer.text()).data.state, "completed");
    assert.equal(wechatCalls.length, 1);
    console.info(
      "PASS production HTTP: fixed WeChat adapter over test transport, one-time binding, session rotation, account quota and real guest history claim",
    );

    const headResponse = await fetch(
      `${base}/api/admin/rulesets/${ruleset.id}/publication`,
      { headers },
    );
    assert.equal(headResponse.status, 200);
    assert.equal(
      JSON.parse(await headResponse.text()).data.publicationId,
      publication.id,
    );
    console.info(
      "PASS production HTTP: frozen holdout policy, publication gate, atomic activate/deactivate/rollback and audit",
    );
    console.info(
      "PASS production HTTP: immutable evaluation dataset, async hybrid evaluation, complete evidence metrics, paginated results",
    );
    console.info(
      "PASS production HTTP: vector worker, embedding HTTP adapter, pgvector cosine search, RRF, persisted retrieval trace",
    );

    console.info(
      "PASS production HTTP: reviewed snapshot, versioned index, lexical search, exact evidence source",
    );
  }

  console.info(
    "PASS production HTTP: auth, PostgreSQL, OpenAPI, PDF upload/download, durable job, live worker, provenance, initial awaiting-review state",
  );
  console.info(
    JSON.stringify({
      privateSource: Boolean(process.env.INGESTION_TEST_PDF),
      sha256: sha256(bytes),
      pages: parsed.pages.length,
      blocks: parsed.blocks.length,
      textBlocks: parsed.blocks.filter(
        (b: { kind: string }) => b.kind === "text",
      ).length,
      figureBlocks: parsed.blocks.filter(
        (b: { kind: string }) => b.kind === "figure",
      ).length,
      warnings: parsed.warnings,
      statusAfterParse: status,
    }),
  );
} finally {
  if (child.exitCode === null) {
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    await exited;
  }
  await queue.stop();
  await embeddingHttp.close();
  await chatHttp.close();
  wechatHttp.closeAllConnections();
  await new Promise<void>((r, reject) =>
    wechatHttp.close((error) => (error ? reject(error) : r())),
  );
  await fixture.close();
  await rm(storage, { recursive: true, force: true });
}
