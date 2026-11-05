import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { testDatabase } from "./helpers/database.js";
import { syntheticPdf } from "./helpers/pdf.js";
import {
  KnowledgeRepository,
  SourceBlockEntity,
} from "../packages/db/src/index.ts";
import {
  connectQueue,
  IngestionService,
  LocalBlobStore,
  PythonPdfParser,
  ParseError,
  parserConfigSchema,
  PARSE_QUEUE,
  sha256,
  handleAdmin,
  type PdfParser,
} from "../packages/backend/src/index.ts";
let fixture: Awaited<ReturnType<typeof testDatabase>>;
let queue: Awaited<ReturnType<typeof connectQueue>>;
let root: string;
let store: LocalBlobStore;
let parser: PythonPdfParser;
let service: IngestionService;
let repo: KnowledgeRepository;
before(async () => {
  fixture = await testDatabase();
  await fixture.db.runMigrations();
  queue = await connectQueue((fixture.db.options as { url: string }).url, true);
  root = await mkdtemp(join(tmpdir(), "boardgame-ingestion-test-"));
  store = new LocalBlobStore(root);
  parser = new PythonPdfParser(
    process.env.PARSER_PYTHON ?? "python3",
    resolve("services/document-parser/parse.py"),
  );
  service = new IngestionService(fixture.db, queue, store, parser);
  repo = new KnowledgeRepository(fixture.db);
});
after(async () => {
  if (queue) await queue.stop();
  if (fixture) await fixture.close();
  if (root) await rm(root, { recursive: true, force: true });
});
async function input(
  bytes = syntheticPdf(),
  config: Record<string, unknown> = {},
) {
  const game = await repo.createGame({
    slug: `parse-${randomUUID()}`,
    name: "合成解析测试",
  });
  const ruleset = await repo.createRuleset({
    gameId: game.id,
    name: "测试",
    language: "en",
    scope: "synthetic",
  });
  const hash = sha256(bytes);
  const doc = await repo.createDocument({
    rulesetId: ruleset.id,
    title: "合成 PDF",
    sourceType: "rulebook",
    objectKey: `documents/${hash}.pdf`,
    sha256: hash,
  });
  const rev = await repo.createRevision(doc.id, config);
  return { doc, rev, bytes };
}
test("PDF storage rejects traversal and mismatched hashes, uploads are idempotent", async () => {
  const a = await input();
  await assert.rejects(
    service.upload(a.doc.id, syntheticPdf("Other text"), randomUUID()),
    /HASH_MISMATCH/,
  );
  await assert.rejects(store.put("../escape", a.bytes), /INVALID_STORAGE_KEY/);
  await Promise.all([
    service.upload(a.doc.id, a.bytes, randomUUID()),
    service.upload(a.doc.id, a.bytes, randomUUID()),
  ]);
  assert.deepEqual(await service.download(a.doc.id), a.bytes);
  assert.equal(
    (
      await fixture.db.query(
        "SELECT count(*)::int AS n FROM admin_audit_events WHERE action='document.upload' AND target_id=$1",
        [a.doc.id],
      )
    )[0].n,
    1,
  );
});
test("concurrent parse requests enqueue exactly one durable job and publish provenance atomically", async () => {
  const a = await input();
  await service.upload(a.doc.id, a.bytes, randomUUID());
  const enqueued = await Promise.all(
    Array.from({ length: 4 }, () => service.enqueue(a.rev.id, randomUUID())),
  );
  assert.equal(new Set(enqueued.map((j) => j.jobId)).size, 1);
  const jobId = enqueued[0].jobId;
  assert.equal((await service.job(jobId)).state, "queued");
  assert.equal(await service.workOnce(), 1);
  assert.equal((await service.job(jobId)).state, "succeeded");
  const result = await service.result(a.rev.id);
  assert.match(result.blocks[0].rawText, /Synthetic rule/);
  assert.equal(result.blocks[0].pdfPageIndex, 0);
  assert.equal(result.blocks[0].bbox?.length, 4);
  const stored = await fixture.db
    .getRepository(SourceBlockEntity)
    .findBy({ revisionId: a.rev.id });
  const rule = await repo.addRule(
    {
      revisionId: a.rev.id,
      kind: "rule",
      reviewedText: "Synthetic rule",
      sectionPath: [],
      applicability: [],
      explanation: null,
      reviewStatus: "approved",
    },
    [stored[0].id],
  );
  assert.ok(rule.id);
  await assert.rejects(
    repo.approveRevision(a.rev.id),
    /findings require review/,
  );
  await service.acknowledge(
    a.rev.id,
    "Checked the source and reading order manually.",
    randomUUID(),
  );
  await repo.approveRevision(a.rev.id);
  assert.equal((await service.enqueue(a.rev.id, randomUUID())).jobId, jobId);
  assert.equal(await service.workOnce(), 0);
});
test("failed queue transaction leaves no orphan domain job", async () => {
  const a = await input();
  await service.upload(a.doc.id, a.bytes, randomUUID());
  await queue.deleteQueue(PARSE_QUEUE);
  try {
    await assert.rejects(service.enqueue(a.rev.id, randomUUID()));
    assert.equal(
      (
        await fixture.db.query(
          "SELECT count(*)::int AS n FROM ingestion_jobs WHERE revision_id=$1",
          [a.rev.id],
        )
      )[0].n,
      0,
    );
  } finally {
    await queue.createQueue(PARSE_QUEUE, {
      retryLimit: 2,
      retryDelay: 1,
      retryBackoff: true,
      expireInSeconds: 180,
    });
  }
});
test("transient parser errors retry without duplicating source blocks", async () => {
  let attempts = 0;
  const flaky: PdfParser = {
    parse: async (bytes, config, signal) => {
      if (++attempts === 1) throw new ParseError("PARSE_TIMEOUT", true);
      return parser.parse(bytes, config, signal);
    },
  };
  const runner = new IngestionService(fixture.db, queue, store, flaky);
  const a = await input();
  await runner.upload(a.doc.id, a.bytes, randomUUID());
  const { jobId } = await runner.enqueue(a.rev.id, randomUUID());
  await runner.workOnce();
  assert.equal((await runner.job(jobId)).state, "retrying");
  for (
    let i = 0;
    i < 40 && (await runner.job(jobId)).state !== "succeeded";
    i++
  ) {
    await new Promise((r) => setTimeout(r, 250));
    await runner.workOnce();
  }
  assert.equal((await runner.job(jobId)).state, "succeeded");
  assert.equal((await runner.job(jobId)).attempts, 2);
  assert.equal(
    await fixture.db
      .getRepository(SourceBlockEntity)
      .countBy({ revisionId: a.rev.id }),
    1,
  );
});
test("terminal failure is observable and can be explicitly retried", async () => {
  await queue.updateQueue(PARSE_QUEUE, { retryLimit: 0 });
  const a = await input();
  await service.upload(a.doc.id, a.bytes, randomUUID());
  const { jobId } = await service.enqueue(a.rev.id, randomUUID());
  const failing = new IngestionService(fixture.db, queue, store, {
    parse: async () => {
      throw new ParseError("INVALID_PDF");
    },
  });
  await failing.workOnce();
  assert.equal((await failing.job(jobId)).state, "failed");
  await service.retry(jobId, randomUUID());
  await service.workOnce();
  assert.equal((await service.job(jobId)).state, "succeeded");
  await queue.updateQueue(PARSE_QUEUE, { retryLimit: 2 });
});
test("old attempt cannot overwrite a newer successful attempt", async () => {
  const a = await input();
  await service.upload(a.doc.id, a.bytes, randomUUID());
  await service.enqueue(a.rev.id, randomUUID());
  const [job] = await queue.fetch<{ revisionId: string }>(PARSE_QUEUE, {
    includeMetadata: true,
    batchSize: 1,
  });
  let release!: () => void;
  let entered!: () => void;
  const enteredPromise = new Promise<void>((r) => {
    entered = r;
  });
  const hold = new Promise<void>((r) => {
    release = r;
  });
  const slow = new IngestionService(fixture.db, queue, store, {
    parse: async (bytes, config, signal) => {
      entered();
      await hold;
      return parser.parse(bytes, config, signal);
    },
  });
  const stale = assert.rejects(slow.process(job), /STALE_ATTEMPT/);
  await enteredPromise;
  await service.process(job);
  release();
  await stale;
  await queue.complete(PARSE_QUEUE, job);
  assert.equal((await service.job(job.id)).state, "succeeded");
  assert.equal(
    await fixture.db
      .getRepository(SourceBlockEntity)
      .countBy({ revisionId: a.rev.id }),
    1,
  );
});
test("parser rejects malformed PDFs, bounds subprocess time and validates region configurations", async () => {
  await assert.rejects(
    parser.parse(Buffer.from("%PDF-invalid"), parserConfigSchema.parse({})),
    /INVALID_PDF/,
  );
  const script = join(root, "slow.py");
  await writeFile(script, "import time; time.sleep(10)");
  await assert.rejects(
    new PythonPdfParser(
      process.env.PARSER_PYTHON ?? "python3",
      script,
      40,
    ).parse(syntheticPdf(), parserConfigSchema.parse({})),
    /PARSE_TIMEOUT/,
  );
  assert.throws(
    () =>
      parserConfigSchema.parse({
        pageRegions: [
          {
            pageIndex: 0,
            regions: [
              [0, 0, 1, 1],
              [0, 0, 0.5, 1],
            ],
          },
        ],
      }),
    /overlap/,
  );
});
test("file endpoints remain authenticated and do not accept JSON as a PDF", async () => {
  const a = await input();
  const token = "only-for-tests-" + "x".repeat(32);
  const deps = {
    getDb: async () => fixture.db,
    adminToken: () => token,
    getIngestion: async () => service,
  };
  const url = `http://localhost/api/admin/documents/${a.doc.id}/file`;
  assert.equal(
    (
      await handleAdmin(
        new Request(url, { method: "PUT", body: new Uint8Array(a.bytes) }),
        deps,
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await handleAdmin(
        new Request(url, {
          method: "PUT",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: "{}",
        }),
        deps,
      )
    ).status,
    415,
  );
  assert.equal(
    (
      await handleAdmin(
        new Request(url, {
          method: "PUT",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/pdf",
          },
          body: new Uint8Array(a.bytes),
        }),
        deps,
      )
    ).status,
    200,
  );
  const res = await handleAdmin(
    new Request(url, { headers: { authorization: `Bearer ${token}` } }),
    deps,
  );
  assert.equal(
    res.headers.get("content-disposition"),
    "attachment; filename=rules.pdf",
  );
  assert.equal(sha256(new Uint8Array(await res.arrayBuffer())), a.doc.sha256);
});
