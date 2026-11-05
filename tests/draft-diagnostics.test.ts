import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { DataSource, EntityManager } from "typeorm";
import { testDatabase } from "./helpers/database.js";
import { KnowledgeRepository } from "../packages/db/src/index.ts";
import { curationSchemas as c } from "../packages/contracts/src/index.ts";
import {
  diagnoseDraft,
  prepareDraftKnowledge,
  curationSourceFingerprint,
} from "../packages/backend/src/index.ts";
import {
  KnowledgeIndexService,
  draftLexicalSql,
  lexicalQuery,
  buildLexicalChunk,
  assembleRuleContext,
} from "../packages/retrieval/src/index.ts";
let fixture: Awaited<ReturnType<typeof testDatabase>>;
before(async () => {
  fixture = await testDatabase();
  await fixture.db.runMigrations();
});
after(async () => {
  if (fixture) await fixture.close();
});
function draft() {
  const source = c.source.parse({
    documentSha256: "a".repeat(64),
    parserConfig: { engine: "synthetic" },
    pipelineVersion: "structured-import-v1",
    parserVersion: null,
    blocks: [
      {
        ordinal: 0,
        kind: "text",
        rawText: "合成来源。",
        pdfPageIndex: 2,
        printedPageLabel: "3",
        bbox: [1, 2, 30, 40],
      },
    ],
  });
  const bundle = c.bundle.parse({
    schemaVersion: 1,
    name: "Synthetic draft only",
    revision: "1",
    sourceFingerprint: curationSourceFingerprint(source),
    rules: [
      {
        alias: "take",
        kind: "rule",
        reviewedText: "合成拿取蓝色花砖。",
        sourceOrdinals: [0],
      },
      {
        alias: "exception",
        kind: "exception",
        reviewedText: "合成限制：先检查特殊标记。",
        sourceOrdinals: [0],
      },
      {
        alias: "score",
        kind: "rule",
        reviewedText: "合成计分：每枚积木三分。",
        sourceOrdinals: [0],
      },
    ],
    relations: [
      { from: "take", to: "exception", kind: "exception" },
      { from: "exception", to: "score", kind: "supplement" },
      { from: "score", to: "take", kind: "condition" },
    ],
    cases: [
      {
        id: "dev",
        category: "multi_turn",
        severity: "critical",
        split: "development",
        messages: [
          { role: "user", content: "拿取蓝色花砖" },
          { role: "assistant", content: "合成回答" },
          { role: "user", content: "还需要这样吗" },
        ],
        query: "拿取蓝色花砖",
        expectedBehavior: "answer",
        requiredClaims: ["DO_NOT_USE_CLAIM"],
        forbiddenClaims: ["DO_NOT_USE_FORBIDDEN"],
        acceptableEvidenceAliases: [["take", "exception"]],
        reviewNote: "Synthetic labels; not real rules",
      },
      {
        id: "holdout",
        category: "recall",
        severity: "normal",
        split: "holdout",
        messages: [{ role: "user", content: "HOLDOUT_SECRET_QUESTION" }],
        query: "HOLDOUT_SECRET_QUERY",
        expectedBehavior: "answer",
        requiredClaims: ["HOLDOUT_CLAIM"],
        forbiddenClaims: [],
        acceptableEvidenceAliases: [["score"]],
        reviewNote: "Holdout synthetic only",
      },
    ],
  });
  return { source, bundle };
}
test("draft ranking equals the production PostgreSQL index on identical content and identifiers", async () => {
  const { source, bundle } = draft(),
    repo = new KnowledgeRepository(fixture.db),
    service = new KnowledgeIndexService(fixture.db);
  const game = await repo.createGame({
      slug: "differential-" + randomUUID(),
      name: "Synthetic",
    }),
    rs = await repo.createRuleset({
      gameId: game.id,
      name: "base",
      language: "zh-CN",
      scope: "Synthetic only",
    }),
    doc = await repo.createDocument({
      rulesetId: rs.id,
      title: "Synthetic source",
      sourceType: "rulebook",
      objectKey: "documents/" + source.documentSha256 + ".pdf",
      sha256: source.documentSha256,
    }),
    rev = await repo.createRevision(doc.id),
    blocks = await repo.saveParsedBlocks(rev.id, source.blocks),
    rules: Array<Awaited<ReturnType<KnowledgeRepository["addRule"]>>> = [];
  for (const r of bundle.rules)
    rules.push(
      await repo.addRule(
        {
          revisionId: rev.id,
          kind: r.kind,
          reviewedText: r.reviewedText,
          sectionPath: r.sectionPath,
          applicability: r.applicability,
          explanation: r.explanation,
          reviewStatus: "approved",
        },
        [blocks[0].id],
      ),
    );
  for (const r of bundle.relations)
    await fixture.db.query(
      "INSERT INTO rule_relations(revision_id,from_rule_id,to_rule_id,kind) VALUES($1,$2,$3,$4)",
      [
        rev.id,
        rules[bundle.rules.findIndex((x) => x.alias === r.from)].id,
        rules[bundle.rules.findIndex((x) => x.alias === r.to)].id,
        r.kind,
      ],
    );
  await repo.approveRevision(rev.id);
  const release = await service.createRelease(
      rs.id,
      { name: "differential", revisionIds: [rev.id] },
      randomUUID(),
    ),
    index = await service.build(release.id, randomUUID()),
    manifest = await service.manifest(release.id);
  const chunks: Array<{ id: string; rule_unit_id: string }> =
    await fixture.db.query(
      "SELECT id,rule_unit_id FROM retrieval_chunks WHERE build_id=$1",
      [index.id],
    );
  const records = manifest.rules.map((r) => ({
    chunk_id: chunks.find((c) => c.rule_unit_id === r.id)!.id,
    rule_id: r.id,
    lexical_text: buildLexicalChunk(r).lexicalText,
  }));
  for (const query of [
    "蓝色花砖",
    "合成",
    "计分１２３ ABC",
    "特殊标记 '| ! & :*",
  ]) {
    const parsed = lexicalQuery(query),
      production = await service.search(index.id, { query, limit: 3 }),
      raw = await fixture.db.query(draftLexicalSql, [
        JSON.stringify(records),
        parsed.expression,
        3,
      ]);
    assert.deepEqual(
      raw.map((r: object, i: number) => ({ ...r, rank: i + 1 })),
      production.hits,
    );
  }
  const primary = chunks.find((x) => x.rule_unit_id === rules[0].id)!;
  for (const budget of [{}, { maxRules: 1 }, { maxChars: 1000 }]) {
    const input = { chunkIds: [primary.id], ...budget },
      formal = await service.context(index.id, input),
      core = assembleRuleContext(manifest, chunks, input);
    assert.deepEqual(core, {
      evidence: formal.evidence,
      relations: formal.relations,
      gaps: formal.gaps,
    });
  }
});
test("development diagnostics use a read-only transaction and cannot create approved or published knowledge", async () => {
  const { bundle, source } = draft(),
    queries: string[] = [],
    readonly: string[] = [];
  const readCounts = async () =>
    fixture.db.query(
      "SELECT (SELECT count(*) FROM rule_units) AS rules,(SELECT count(*) FROM knowledge_releases) AS releases,(SELECT count(*) FROM index_builds) AS indexes,(SELECT count(*) FROM admin_audit_events) AS audits",
    );
  const before = await readCounts();
  const db = {
    transaction: async (
      level: string,
      run: (tx: EntityManager) => Promise<unknown>,
    ) =>
      fixture.db.transaction(level as "REPEATABLE READ", async (tx) =>
        run(
          new Proxy(tx, {
            get(target, key) {
              if (key !== "query") return Reflect.get(target, key);
              return async (sql: string, args?: unknown[]) => {
                queries.push(sql);
                if (sql === draftLexicalSql)
                  readonly.push(
                    (await tx.query("SHOW transaction_read_only"))[0]
                      .transaction_read_only,
                  );
                return tx.query(sql, args);
              };
            },
          }),
        ),
      ),
  } as DataSource;
  const report = await diagnoseDraft(db, bundle, source, {
    queryMode: "annotated_query",
    limit: 1,
  });
  assert.deepEqual(await readCounts(), before);
  assert.deepEqual(readonly, ["on"]);
  assert.equal(report.publishable, false);
  assert.equal(report.labelsReviewed, false);
  assert.equal(report.answerQualityEvaluated, false);
  assert.deepEqual(
    report.results[0].hits.map((h) => h.alias),
    ["take"],
  );
  assert.equal(report.results[0].searchScore?.complete, false);
  assert.equal(report.results[0].contextScore?.complete, true);
  assert.ok(queries.every((q) => /^(SET|SELECT|WITH)/.test(q)));
  assert.ok(!JSON.stringify(report).includes("HOLDOUT_SECRET"));
});
test("current question and annotated benchmark remain separate; labels and holdout cannot alter retrieval", async () => {
  const { source, bundle } = draft(),
    actual = await diagnoseDraft(fixture.db, bundle, source),
    annotated = await diagnoseDraft(fixture.db, bundle, source, {
      queryMode: "annotated_query",
    });
  assert.equal(actual.results[0].query, "还需要这样吗");
  assert.equal(actual.results[0].hasHistory, true);
  assert.equal(actual.results[0].hits.length, 0);
  assert.equal(annotated.summary.contextCompleteRate, 1);
  const changed = structuredClone(bundle);
  changed.cases[1].query = "CHANGED_HOLDOUT_QUERY";
  changed.cases[1].messages[0].content = "CHANGED_HOLDOUT_QUESTION";
  changed.cases[1].acceptableEvidenceAliases = [["take"]];
  changed.cases[0].requiredClaims = ["计分三分"];
  changed.cases[0].forbiddenClaims = ["蓝色"];
  const again = await diagnoseDraft(fixture.db, changed, source, {
    queryMode: "annotated_query",
  });
  const stable = (r: typeof annotated) =>
    r.results.map(({ durationMs, ...rest }) => rest);
  assert.deepEqual(stable(again), stable(annotated));
  assert.deepEqual(again.summary, annotated.summary);
  assert.notEqual(again.bundleHash, annotated.bundleHash);
  assert.deepEqual(
    prepareDraftKnowledge(bundle, source).chunks,
    prepareDraftKnowledge(changed, source).chunks,
  );
  await assert.rejects(
    diagnoseDraft(fixture.db, bundle, source, { split: "holdout" }),
  );
});
test("failed queries remain in coverage denominator and unscored abstentions have no artificial pass rate", async () => {
  const { bundle, source } = draft();
  bundle.cases[0].messages = [
    {
      role: "user",
      content: Array.from({ length: 140 }, (_, i) => "term" + i).join(" "),
    },
  ];
  const report = await diagnoseDraft(fixture.db, bundle, source);
  assert.equal(report.summary.failed, 1);
  assert.equal(report.summary.scorable, 1);
  assert.equal(report.summary.contextCompleteRate, 0);
  assert.equal(report.results[0].errorCode, "TOO_MANY_SEARCH_TERMS");
  bundle.cases[0].acceptableEvidenceAliases = [];
  bundle.cases[0].expectedBehavior = "abstain";
  bundle.cases[0].messages = [{ role: "user", content: "未知问题" }];
  const unscored = await diagnoseDraft(fixture.db, bundle, source);
  assert.equal(unscored.summary.unscored, 1);
  assert.equal(unscored.summary.searchCompleteRate, null);
  assert.equal(unscored.results[0].contextScore, null);
});
test("diagnostics reject changed sources, duplicate source ordinals, absent development cases and oversize semantic chunks", async () => {
  const { bundle, source } = draft();
  assert.throws(
    () =>
      prepareDraftKnowledge(bundle, { ...source, parserVersion: "changed" }),
    /SOURCE_MISMATCH/,
  );
  const duplicate = { ...source, blocks: [...source.blocks, ...source.blocks] };
  assert.throws(
    () =>
      prepareDraftKnowledge(
        { ...bundle, sourceFingerprint: curationSourceFingerprint(duplicate) },
        duplicate,
      ),
    /ORDINAL_DUPLICATE/,
  );
  const missing = structuredClone(bundle);
  missing.rules[0].sourceOrdinals = [999];
  assert.throws(
    () => prepareDraftKnowledge(missing, source),
    /ORDINAL_MISSING/,
  );
  await assert.rejects(
    diagnoseDraft(
      fixture.db,
      { ...bundle, cases: bundle.cases.filter((x) => x.split === "holdout") },
      source,
    ),
    /DEVELOPMENT_EMPTY/,
  );
  const oversized = structuredClone(bundle);
  oversized.rules[0].reviewedText = "字".repeat(7999);
  oversized.rules[0].sectionPath = ["完整章节"];
  assert.throws(
    () => prepareDraftKnowledge(oversized, source),
    /SEMANTIC_SPLIT/,
  );
});
test("cycle expansion is bounded, budget gaps stay explicit and cancellation stops before queries", async () => {
  const { bundle, source } = draft(),
    report = await diagnoseDraft(fixture.db, bundle, source, {
      queryMode: "annotated_query",
      limit: 1,
      maxRules: 1,
    });
  assert.deepEqual(report.results[0].contextAliases, ["take"]);
  assert.equal(report.results[0].gaps.length, 2);
  assert.ok(
    report.results[0].gaps.every((x) => x.code === "RELATED_RULE_OMITTED"),
  );
  assert.equal(report.summary.contextGapCases, 1);
  assert.equal(report.summary.contextCompleteRate, 0);
  const one = structuredClone(bundle);
  one.cases[0].acceptableEvidenceAliases = [["take"]];
  const gapped = await diagnoseDraft(fixture.db, one, source, {
    queryMode: "annotated_query",
    limit: 1,
    maxRules: 1,
  });
  assert.equal(gapped.summary.contextCompleteRate, 1);
  assert.equal(gapped.summary.gapFreeContextCompleteRate, 0);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    diagnoseDraft(fixture.db, bundle, source, {}, controller.signal),
    { name: "AbortError" },
  );
});
test("CLI writes an exclusive private report and stdout never includes source text or labels", async () => {
  const { mkdtemp, writeFile, readFile, stat, rm } =
      await import("node:fs/promises"),
    { tmpdir } = await import("node:os"),
    { join, resolve } = await import("node:path"),
    { execFile } = await import("node:child_process"),
    { promisify } = await import("node:util");
  const dir = await mkdtemp(join(tmpdir(), "draft-cli-")),
    { bundle, source } = draft(),
    run = promisify(execFile);
  try {
    const bundlePath = join(dir, "bundle.json"),
      sourcePath = join(dir, "source.json"),
      configPath = join(dir, "config.json"),
      outputPath = join(dir, "report.json");
    for (const [path, data] of [
      [bundlePath, bundle],
      [sourcePath, source],
      [configPath, { queryMode: "annotated_query" }],
    ] as const)
      await writeFile(path, JSON.stringify(data), { mode: 0o600 });
    const args = [
      "--import",
      "tsx",
      resolve("scripts/draft-diagnostics.ts"),
      bundlePath,
      sourcePath,
      configPath,
      outputPath,
      "--isolated",
    ];
    const result = await run(process.execPath, args, { timeout: 30000 });
    assert.equal(result.stderr, "");
    assert.ok(!result.stdout.includes(source.blocks[0].rawText));
    assert.ok(!result.stdout.includes("DO_NOT_USE_CLAIM"));
    assert.ok(!result.stdout.includes("HOLDOUT_SECRET"));
    assert.equal((await stat(outputPath)).mode & 0o777, 0o600);
    const original = await readFile(outputPath, "utf8");
    assert.equal(JSON.parse(original).publishable, false);
    await assert.rejects(
      run(process.execPath, args, { timeout: 30000 }),
      (error: unknown) => {
        const e = error as { stdout: string; stderr: string };
        assert.equal(e.stdout, "");
        assert.ok(e.stderr.includes("DRAFT_DIAGNOSTIC_FAILED"));
        assert.ok(!e.stderr.includes(dir));
        return true;
      },
    );
    assert.equal(await readFile(outputPath, "utf8"), original);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
