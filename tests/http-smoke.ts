import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:net";
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
} from "../packages/backend/src/index.ts";
import { testDatabase } from "./helpers/database.js";

import { embeddingServer } from "./helpers/embedding.js";
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
  await fixture.close();
  await rm(storage, { recursive: true, force: true });
}
