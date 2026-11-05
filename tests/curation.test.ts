import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { resolve } from "node:path";
import { testDatabase } from "./helpers/database.js";
import { syntheticPdf } from "./helpers/pdf.js";
import { KnowledgeRepository } from "../packages/db/src/index.ts";
import {
  CurationService,
  EvaluationService,
  connectQueue,
  curationSourceFingerprint,
  curationHash,
  handleAdmin,
  openApiDocument,
  PythonPdfParser,
  parserConfigSchema,
} from "../packages/backend/src/index.ts";
import { KnowledgeIndexService } from "../packages/retrieval/src/index.ts";
import { curationSchemas as s } from "../packages/contracts/src/index.ts";
let fixture: Awaited<ReturnType<typeof testDatabase>>,
  repo: KnowledgeRepository,
  service: CurationService,
  queue: Awaited<ReturnType<typeof connectQueue>>,
  evaluations: EvaluationService;
before(async () => {
  fixture = await testDatabase();
  await fixture.db.runMigrations();
  repo = new KnowledgeRepository(fixture.db);
  service = new CurationService(fixture.db);
  queue = await connectQueue((fixture.db.options as { url: string }).url, true);
  evaluations = new EvaluationService(fixture.db, queue);
});
after(async () => {
  if (queue) await queue.stop();
  if (fixture) await fixture.close();
});
async function setup() {
  const game = await repo.createGame({
      slug: "curation-" + randomUUID(),
      name: "Synthetic curation",
    }),
    rs = await repo.createRuleset({
      gameId: game.id,
      name: "base",
      language: "zh-CN",
      scope: "synthetic",
    }),
    hash = createHash("sha256").update(randomUUID()).digest("hex"),
    doc = await repo.createDocument({
      rulesetId: rs.id,
      title: "Synthetic source",
      sourceType: "rulebook",
      objectKey: `documents/${hash}.pdf`,
      sha256: hash,
    }),
    revision = await repo.createRevision(doc.id);
  await repo.saveParsedBlocks(revision.id, [
    {
      ordinal: 0,
      kind: "text",
      rawText: "合成：拿取同色花砖。",
      pdfPageIndex: 0,
      printedPageLabel: "i",
      bbox: [1, 2, 10, 20],
    },
    {
      ordinal: 1,
      kind: "figure",
      rawText: "",
      pdfPageIndex: 1,
      printedPageLabel: "1",
      bbox: [2, 3, 20, 30],
    },
  ]);
  const template = await service.template(revision.id),
    bundle = s.bundle.parse({
      schemaVersion: 1,
      name: "Synthetic draft",
      revision: "1",
      sourceFingerprint: template.sourceFingerprint,
      rules: [
        {
          alias: "take",
          kind: "rule",
          reviewedText: "合成规则：拿取同色花砖。",
          sourceOrdinals: [0],
        },
        {
          alias: "exception",
          kind: "exception",
          reviewedText: "合成例外：需检查图例条件。",
          sourceOrdinals: [0, 1],
        },
      ],
      relations: [{ from: "take", to: "exception", kind: "exception" }],
      cases: [
        {
          id: "all",
          category: "recall",
          split: "development",
          severity: "critical",
          messages: [{ role: "user", content: "合成规则是什么？" }],
          query: "同色花砖",
          expectedBehavior: "answer",
          requiredClaims: ["检查条件"],
          forbiddenClaims: ["忽略例外"],
          acceptableEvidenceAliases: [["take", "exception"]],
          reviewNote: "Synthetic label only",
        },
      ],
    });
  return { revision, rs, template, bundle };
}
async function approve(a: Awaited<ReturnType<typeof setup>>) {
  await fixture.db.query(
    "UPDATE rule_units SET review_status='approved' WHERE revision_id=$1",
    [a.revision.id],
  );
  await repo.approveRevision(a.revision.id);
  return new KnowledgeIndexService(fixture.db).createRelease(
    a.rs.id,
    { name: "synthetic", revisionIds: [a.revision.id] },
    randomUUID(),
  );
}
test("source fingerprints pin bytes, parser configuration, raw text and exact page coordinates", async () => {
  const a = await setup();
  assert.equal(
    curationSourceFingerprint(JSON.parse(JSON.stringify(a.template.source))),
    a.template.sourceFingerprint,
  );
  assert.notEqual(
    curationSourceFingerprint({
      ...a.template.source,
      parserVersion: "changed",
    }),
    a.template.sourceFingerprint,
  );
  assert.notEqual(
    curationSourceFingerprint({
      ...a.template.source,
      blocks: a.template.source.blocks.map((b, i) =>
        i ? b : { ...b, bbox: [1, 2, 11, 20] },
      ),
    }),
    a.template.sourceFingerprint,
  );
  assert.equal(curationHash({ b: 1, a: 2 }), curationHash({ a: 2, b: 1 }));
});
test("import is atomic/idempotent and never approves rules, parser warnings or releases", async () => {
  const a = await setup(),
    input = { idempotencyKey: randomUUID(), bundle: a.bundle };
  const results = await Promise.all([
    service.import(a.revision.id, input, randomUUID()),
    service.import(a.revision.id, input, randomUUID()),
  ]);
  assert.equal(results[0].id, results[1].id);
  assert.equal(Object.keys(results[0].ruleMap).length, 2);
  const rows = await fixture.db.query(
    "SELECT review_status FROM rule_units WHERE revision_id=$1",
    [a.revision.id],
  );
  assert.ok(rows.every((r: any) => r.review_status === "pending"));
  await assert.rejects(repo.approveRevision(a.revision.id));
  assert.equal(
    (
      await fixture.db.query(
        "SELECT count(*)::int AS count FROM knowledge_releases",
      )
    )[0].count,
    0,
  );
  await assert.rejects(
    service.import(
      a.revision.id,
      { ...input, bundle: { ...a.bundle, name: "changed" } },
      randomUUID(),
    ),
    /IDEMPOTENCY_CONFLICT/,
  );
  await assert.rejects(
    service.import(
      a.revision.id,
      { ...input, idempotencyKey: randomUUID() },
      randomUUID(),
    ),
    /EMPTY_REVISION/,
  );
});
test("changed source, unknown evidence aliases and ordinals fail without partial writes", async () => {
  const a = await setup();
  await assert.rejects(
    service.import(
      a.revision.id,
      {
        idempotencyKey: randomUUID(),
        bundle: { ...a.bundle, sourceFingerprint: "0".repeat(64) },
      },
      randomUUID(),
    ),
    /SOURCE_MISMATCH/,
  );
  await assert.rejects(
    service.import(
      a.revision.id,
      {
        idempotencyKey: randomUUID(),
        bundle: {
          ...a.bundle,
          rules: [
            ...a.bundle.rules,
            { ...a.bundle.rules[0], alias: "missing", sourceOrdinals: [999] },
          ],
        },
      },
      randomUUID(),
    ),
    /ORDINAL_MISSING/,
  );
  assert.throws(() =>
    s.bundle.parse({
      ...a.bundle,
      cases: [
        { ...a.bundle.cases[0], acceptableEvidenceAliases: [["foreign"]] },
      ],
    }),
  );
  assert.throws(() =>
    s.bundle.parse({
      ...a.bundle,
      rules: [{ ...a.bundle.rules[0], reviewStatus: "approved" }],
    }),
  );
  assert.throws(() =>
    s.bundle.parse({
      ...a.bundle,
      rules: [{ ...a.bundle.rules[0], alias: "__proto__" }],
    }),
  );
  assert.equal(
    (
      await fixture.db.query(
        "SELECT count(*)::int AS count FROM rule_units WHERE revision_id=$1",
        [a.revision.id],
      )
    )[0].count,
    0,
  );
});
test("reviewed annotations map aliases to exact approved release members and preserve attestation", async () => {
  const a = await setup(),
    imported = await service.import(
      a.revision.id,
      { idempotencyKey: randomUUID(), bundle: a.bundle },
      randomUUID(),
    );
  const foreign = await setup();
  await service.import(
    foreign.revision.id,
    { idempotencyKey: randomUUID(), bundle: foreign.bundle },
    randomUUID(),
  );
  const wrong = await approve(foreign);
  const input = {
    releaseId: wrong.id,
    name: "Synthetic eval",
    revision: "1",
    annotationReviewNote: "Reviewed synthetic annotations only",
  };
  await assert.rejects(
    service.materialize(imported.id, input, randomUUID(), evaluations),
    /RELEASE_MISMATCH/,
  );
  const release = await approve(a),
    valid = { ...input, releaseId: release.id };
  const dataset = await service.materialize(
    imported.id,
    valid,
    randomUUID(),
    evaluations,
  );
  assert.deepEqual(dataset.manifest.cases[0].acceptableEvidenceSets, [
    [imported.ruleMap.take, imported.ruleMap.exception],
  ]);
  assert.equal(
    (await service.annotationReviews(imported.id)).items[0].note,
    valid.annotationReviewNote,
  );
  assert.equal(
    (await service.materialize(imported.id, valid, randomUUID(), evaluations))
      .id,
    dataset.id,
  );
  await assert.rejects(
    service.materialize(
      imported.id,
      {
        ...valid,
        annotationReviewNote:
          "Different attestation should not overwrite original",
      },
      randomUUID(),
      evaluations,
    ),
    /REVIEW_CONFLICT/,
  );
  await assert.rejects(
    fixture.db.query("UPDATE curation_imports SET rule_map='{}' WHERE id=$1", [
      imported.id,
    ]),
    /immutable/,
  );
  await assert.rejects(
    fixture.db.query(
      "DELETE FROM curation_dataset_reviews WHERE import_id=$1",
      [imported.id],
    ),
    /immutable/,
  );
});
test("audit failure rolls back the full rule/source/relation import", async () => {
  const a = await setup();
  await fixture.db.query(
    "CREATE FUNCTION fail_curation_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='curation.import' THEN RAISE EXCEPTION 'synthetic audit failure';END IF;RETURN NEW;END $$;CREATE TRIGGER fail_curation_audit BEFORE INSERT ON admin_audit_events FOR EACH ROW EXECUTE FUNCTION fail_curation_audit()",
  );
  try {
    await assert.rejects(
      service.import(
        a.revision.id,
        { idempotencyKey: randomUUID(), bundle: a.bundle },
        randomUUID(),
      ),
      /synthetic audit failure/,
    );
    assert.equal(
      (
        await fixture.db.query(
          "SELECT count(*)::int AS count FROM rule_units WHERE revision_id=$1",
          [a.revision.id],
        )
      )[0].count,
      0,
    );
  } finally {
    await fixture.db.query(
      "DROP TRIGGER fail_curation_audit ON admin_audit_events;DROP FUNCTION fail_curation_audit()",
    );
  }
});
test("ordered parser regions and printed page labels are explicit, validated provenance", async () => {
  const parser = new PythonPdfParser(
    process.env.PARSER_PYTHON ?? "python3",
    resolve("services/document-parser/parse.py"),
  );
  const output = await parser.parse(
    syntheticPdf(),
    parserConfigSchema.parse({ pageLabels: [{ pageIndex: 0, label: "iv" }] }),
  );
  assert.equal(output.pipelineVersion, "pdfplumber-regions-v2");
  assert.ok(output.blocks.every((b) => b.printedPageLabel === "iv"));
  assert.throws(() =>
    parserConfigSchema.parse({
      pageLabels: [
        { pageIndex: 0, label: "1" },
        { pageIndex: 0, label: "2" },
      ],
    }),
  );
  await assert.rejects(
    parser.parse(
      syntheticPdf(),
      parserConfigSchema.parse({
        pageLabels: [{ pageIndex: 99, label: "wrong" }],
      }),
    ),
    /INVALID_PAGE_CONFIG/,
  );
});
test("administrator routes authenticate curation operations and expose strict OpenAPI", async () => {
  const a = await setup(),
    token = "curation-test-" + "x".repeat(32),
    deps = { getDb: async () => fixture.db, adminToken: () => token };
  const request = (path: string, body?: unknown, auth = true) =>
    handleAdmin(
      new Request("http://local/api/admin" + path, {
        method: body ? "POST" : "GET",
        headers: {
          ...(auth ? { authorization: `Bearer ${token}` } : {}),
          "content-type": "application/json",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
      deps,
    );
  assert.equal(
    (
      await request(
        `/revisions/${a.revision.id}/curation-template`,
        undefined,
        false,
      )
    ).status,
    401,
  );
  assert.equal(
    (await request(`/revisions/${a.revision.id}/curation-template`)).status,
    200,
  );
  const imported = await request(
    `/revisions/${a.revision.id}/curation-imports`,
    { idempotencyKey: randomUUID(), bundle: a.bundle },
  );
  assert.equal(imported.status, 201, await imported.clone().text());
  assert.ok(
    openApiDocument().paths[
      "/api/admin/curation-imports/{id}/evaluation-datasets"
    ],
  );
});
