import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  adminSchemas as s,
  knowledgeSchemas as k,
  vectorSchemas as v,
  evaluationSchemas as e,
  answeringSchemas as a,
  answerEvaluationSchemas as ae,
  publicationSchemas as p,
  curationSchemas as cu,
} from "@boardgame/contracts";
import {
  KnowledgeRepository,
  GameEntity,
  RulesetEntity,
  SourceDocumentEntity,
  DocumentRevisionEntity,
  SourceBlockEntity,
  RuleUnitEntity,
} from "@boardgame/db";
import type { DataSource, EntityManager } from "typeorm";

import { IngestionError, type IngestionService } from "./ingestion.ts";
import { parserResultSchema } from "./parser.ts";
import {
  KnowledgeIndexService,
  RetrievalError,
  EmbeddingError,
} from "@boardgame/retrieval";

import type { VectorService } from "./vectors.ts";
import type { EvaluationService } from "./evaluations.ts";
import type { AnswerService } from "./answers.ts";
import type { AnswerEvaluationService } from "./answer-evaluations.ts";
import type { PublicationService } from "./publications.ts";
import { CurationService } from "./curation.ts";
class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}
type Context = {
  db: DataSource;
  id: string;
  requestId: string;
  getIngestion?: () => Promise<IngestionService>;
  getVectors?: () => Promise<VectorService>;
  getEvaluations?: () => Promise<EvaluationService>;
  getAnswers?: () => Promise<AnswerService>;
  getAnswerEvaluations?: () => Promise<AnswerEvaluationService>;
  getPublications?: () => Promise<PublicationService>;
  signal?: AbortSignal;
};
async function ingestion(c: Pick<Context, "getIngestion">) {
  if (!c.getIngestion) throw new HttpError(503, "INGESTION_NOT_CONFIGURED");
  return c.getIngestion();
}
async function vectors(c: Pick<Context, "getVectors">) {
  if (!c.getVectors) throw new HttpError(503, "VECTORS_NOT_CONFIGURED");
  return c.getVectors();
}
async function evaluations(c: Pick<Context, "getEvaluations">) {
  if (!c.getEvaluations) throw new HttpError(503, "EVALUATIONS_NOT_CONFIGURED");
  return c.getEvaluations();
}
async function answers(c: Pick<Context, "getAnswers">) {
  if (!c.getAnswers) throw new HttpError(503, "ANSWERS_NOT_CONFIGURED");
  return c.getAnswers();
}
async function answerEvaluations(c: Pick<Context, "getAnswerEvaluations">) {
  if (!c.getAnswerEvaluations)
    throw new HttpError(503, "ANSWER_EVALUATIONS_NOT_CONFIGURED");
  return c.getAnswerEvaluations();
}
async function publications(c: Pick<Context, "getPublications">) {
  if (!c.getPublications)
    throw new HttpError(503, "PUBLICATIONS_NOT_CONFIGURED");
  return c.getPublications();
}
interface Operation {
  method: string;
  path: string;
  summary: string;
  input: z.ZodType;
  output: z.ZodType;
  success: number;
  invoke: (context: Context, raw: unknown) => Promise<unknown>;
}
function operation<T>(
  method: string,
  path: string,
  summary: string,
  input: z.ZodType<T>,
  output: z.ZodType,
  run: (c: Context, data: T) => Promise<unknown>,
  success = 200,
): Operation {
  return {
    method,
    path,
    summary,
    input,
    output,
    success,
    invoke: async (c, raw) => run(c, input.parse(raw)),
  };
}
async function audit<T>(
  c: Context,
  action: string,
  run: (tx: EntityManager) => Promise<T & { id: string }>,
) {
  return c.db.transaction(async (tx) => {
    const result = await run(tx);
    await tx.query(
      "INSERT INTO admin_audit_events(request_id,actor,action,target_id) VALUES ($1,'admin',$2,$3)",
      [c.requestId, action, result.id],
    );
    return result;
  });
}
async function exists(
  tx: EntityManager,
  entity: typeof DocumentRevisionEntity,
  id: string,
) {
  const record = await tx.getRepository(entity).findOne({ where: { id } });
  if (!record) throw new HttpError(404, "NOT_FOUND");
  return record;
}
export const operations: Operation[] = [
  operation(
    "GET",
    "/curation-imports/{id}/annotation-reviews",
    "分页读取评测标签的人工复核声明",
    s.pageQuery,
    s.listResult(cu.annotationReviewResult),
    async (c, q) => new CurationService(c.db).annotationReviews(c.id, q),
  ),

  operation(
    "GET",
    "/revisions/{id}/curation-template",
    "导出来源指纹和私有整理模板",
    s.empty,
    cu.template,
    async (c) => new CurationService(c.db).template(c.id),
  ),
  operation(
    "POST",
    "/revisions/{id}/curation-imports",
    "按来源指纹原子导入待审核规则及标签",
    cu.importInput,
    cu.importResult,
    async (c, data) =>
      new CurationService(c.db).import(c.id, data, c.requestId),
    201,
  ),
  operation(
    "GET",
    "/curation-imports/{id}",
    "查看不可变整理包与规则映射",
    s.empty,
    cu.importResult,
    async (c) => new CurationService(c.db).get(c.id),
  ),
  operation(
    "POST",
    "/curation-imports/{id}/evaluation-datasets",
    "复核标签后映射到同快照评测集",
    cu.materializeInput,
    e.datasetResult,
    async (c, data) =>
      new CurationService(c.db).materialize(
        c.id,
        data,
        c.requestId,
        await evaluations(c),
      ),
    201,
  ),

  operation(
    "POST",
    "/rulesets/{id}/publication-policies",
    "在评测前冻结发布阈值和基线",
    p.policyInput,
    p.policyResult,
    async (c, data) =>
      (await publications(c)).createPolicy(c.id, data, c.requestId),
    201,
  ),
  operation(
    "GET",
    "/publication-policies/{id}",
    "查看不可变发布策略",
    s.empty,
    p.policyResult,
    async (c) => (await publications(c)).policy(c.id),
  ),
  operation(
    "POST",
    "/publications",
    "评估候选发布并保存门禁结果",
    p.assessmentInput,
    p.publicationResult,
    async (c, data) => (await publications(c)).assess(data, c.requestId),
    201,
  ),
  operation(
    "GET",
    "/publications/{id}",
    "读取发布清单与失败原因",
    s.empty,
    p.publicationResult,
    async (c) => (await publications(c)).get(c.id),
  ),
  operation(
    "GET",
    "/rulesets/{id}/publication",
    "读取当前版本指针",
    s.empty,
    p.headResult,
    async (c) => (await publications(c)).head(c.id),
  ),
  operation(
    "POST",
    "/rulesets/{id}/publication-transitions",
    "发布、回滚或停用知识版本",
    p.transitionInput,
    p.eventResult,
    async (c, data) =>
      (await publications(c)).transition(c.id, data, c.requestId),
    201,
  ),
  operation(
    "GET",
    "/rulesets/{id}/publication-history",
    "分页查看版本切换历史",
    s.pageQuery,
    s.listResult(p.eventResult),
    async (c, q) => (await publications(c)).history(c.id, q),
  ),

  operation(
    "POST",
    "/evaluation-datasets/{id}/answer-evaluations",
    "异步生成固定测试集的问答结果",
    ae.enqueueInput,
    z.object({ evaluationId: s.uuid }),
    async (c, data) =>
      (await answerEvaluations(c)).enqueue(c.id, data, c.requestId),
    202,
  ),
  operation(
    "GET",
    "/answer-evaluations/{id}",
    "读取答案评测进度及自动/人工统计",
    s.empty,
    ae.runResult,
    async (c) => (await answerEvaluations(c)).get(c.id),
  ),
  operation(
    "GET",
    "/answer-evaluations/{id}/cases",
    "分页读取题目、实际答案与最新人工审核",
    s.pageQuery,
    s.listResult(ae.caseResult),
    async (c, q) => (await answerEvaluations(c)).cases(c.id, q),
  ),
  operation(
    "POST",
    "/answer-evaluations/{id}/retry",
    "恢复失败的答案评测，不重做已存在的问答运行",
    s.empty,
    z.object({ evaluationId: s.uuid }),
    async (c) => (await answerEvaluations(c)).retry(c.id, c.requestId),
    202,
  ),
  operation(
    "POST",
    "/answer-evaluation-cases/{id}/reviews",
    "逐项提交人工审核或追加更正",
    ae.reviewInput,
    ae.reviewResult,
    async (c, data) =>
      (await answerEvaluations(c)).review(c.id, data, c.requestId),
    201,
  ),
  operation(
    "GET",
    "/answer-evaluation-cases/{id}/reviews",
    "读取人工审核修订历史",
    s.pageQuery,
    s.listResult(ae.reviewResult),
    async (c, q) => (await answerEvaluations(c)).reviews(c.id, q),
  ),
  operation(
    "POST",
    "/answer-evaluations/{id}/seal",
    "封存全部已审核结果，不代表发布通过",
    ae.sealInput,
    ae.runResult,
    async (c, data) =>
      (await answerEvaluations(c)).seal(c.id, data, c.requestId),
  ),

  operation(
    "POST",
    "/answer-runs",
    "同步执行固定知识版本的管理员问答验收",
    a.previewInput,
    a.runResult,
    async (c, data) => (await answers(c)).preview(data, c.requestId, c.signal),
  ),
  operation(
    "GET",
    "/answer-runs/{id}",
    "查看问答状态、已验证结果和配置",
    s.empty,
    a.runResult,
    async (c) => (await answers(c)).get(c.id),
  ),
  operation(
    "GET",
    "/answer-runs/{id}/events",
    "分页读取检索、工具和模型用量审计",
    s.pageQuery,
    s.listResult(a.eventResult),
    async (c, q) => (await answers(c)).events(c.id, q),
  ),

  operation(
    "POST",
    "/releases/{id}/evaluation-datasets",
    "创建不可变评测集（证据须已审核）",
    e.datasetInput,
    e.datasetResult,
    async (c, data) =>
      (await evaluations(c)).createDataset(c.id, data, c.requestId),
    201,
  ),
  operation(
    "GET",
    "/evaluation-datasets/{id}",
    "读取固定版本评测集",
    s.empty,
    e.datasetResult,
    async (c) => (await evaluations(c)).dataset(c.id),
  ),
  operation(
    "POST",
    "/evaluation-datasets/{id}/runs",
    "异步执行指定开发集或保留集",
    e.runInput,
    z.object({ runId: s.uuid }),
    async (c, data) => (await evaluations(c)).enqueue(c.id, data, c.requestId),
    202,
  ),
  operation(
    "GET",
    "/evaluation-runs/{id}",
    "读取进度、配置和评测报告",
    s.empty,
    e.runResult,
    async (c) => (await evaluations(c)).get(c.id),
  ),
  operation(
    "GET",
    "/evaluation-runs/{id}/results",
    "分页查看逐题证据和评分",
    s.pageQuery,
    s.listResult(e.caseResult),
    async (c, q) => (await evaluations(c)).results(c.id, q),
  ),
  operation(
    "POST",
    "/evaluation-runs/{id}/retry",
    "恢复失败的评测任务（保留已完成题目）",
    s.empty,
    z.object({ runId: s.uuid }),
    async (c) => (await evaluations(c)).retry(c.id, c.requestId),
    202,
  ),

  operation(
    "POST",
    "/index-builds/{id}/vectors",
    "创建可恢复的向量构建任务",
    s.empty,
    z.object({ vectorIndexId: s.uuid }),
    async (c) => (await vectors(c)).enqueue(c.id, c.requestId),
    202,
  ),
  operation(
    "GET",
    "/vector-indexes/{id}",
    "读取向量配置与构建进度",
    s.empty,
    v.vectorIndexResult,
    async (c) => (await vectors(c)).get(c.id),
  ),
  operation(
    "POST",
    "/vector-indexes/{id}/retry",
    "重试失败的向量任务并复用已完成批次",
    s.empty,
    z.object({ vectorIndexId: s.uuid }),
    async (c) => (await vectors(c)).retry(c.id, c.requestId),
    202,
  ),
  operation(
    "POST",
    "/vector-indexes/{id}/search",
    "关键词、向量或 RRF 混合检索",
    v.vectorSearchInput,
    v.vectorSearchResult,
    async (c, data) =>
      (await vectors(c)).search(c.id, data, c.signal, c.requestId),
  ),
  operation(
    "GET",
    "/retrieval-runs/{id}",
    "读取检索实验记录与双路候选",
    s.empty,
    v.retrievalRunResult,
    async (c) => (await vectors(c)).run(c.id),
  ),
  operation(
    "POST",
    "/rulesets/{id}/releases",
    "冻结已审核资料为知识快照（不代表上线发布）",
    k.createRelease,
    k.releaseResult,
    (c, data) =>
      new KnowledgeIndexService(c.db).createRelease(c.id, data, c.requestId),
    201,
  ),
  operation(
    "GET",
    "/releases/{id}",
    "读取知识版本信息",
    s.empty,
    k.releaseResult,
    (c) => new KnowledgeIndexService(c.db).release(c.id),
  ),
  operation(
    "GET",
    "/releases/{id}/manifest",
    "读取不可变规则与原始来源清单",
    s.empty,
    k.manifestSchema,
    (c) => new KnowledgeIndexService(c.db).manifest(c.id),
  ),
  operation(
    "POST",
    "/releases/{id}/indexes",
    "构建完整规则的中文关键词索引（幂等）",
    s.empty,
    k.indexBuildResult,
    (c) => new KnowledgeIndexService(c.db).build(c.id, c.requestId),
    201,
  ),
  operation(
    "GET",
    "/index-builds/{id}",
    "读取索引配置版本",
    s.empty,
    k.indexBuildResult,
    (c) => new KnowledgeIndexService(c.db).index(c.id),
  ),
  operation(
    "POST",
    "/index-builds/{id}/search",
    "版本内关键词检索基线（管理员实验）",
    k.searchInput,
    k.searchResult,
    (c, data) => new KnowledgeIndexService(c.db).search(c.id, data),
  ),
  operation(
    "POST",
    "/index-builds/{id}/context",
    "读取同版本证据并补齐关联规则及缺口",
    k.contextInput,
    k.contextResult,
    (c, data) => new KnowledgeIndexService(c.db).context(c.id, data),
  ),
  operation(
    "POST",
    "/revisions/{id}/parse",
    "创建持久 PDF 解析任务（幂等）",
    s.empty,
    z.object({ jobId: s.uuid }),
    async (c) => (await ingestion(c)).enqueue(c.id, c.requestId),
    202,
  ),
  operation(
    "GET",
    "/jobs/{id}",
    "查询解析任务状态",
    s.empty,
    z.object({
      id: s.uuid,
      revision_id: s.uuid,
      state: z.string(),
      attempts: z.number(),
      error_code: z.string().nullable(),
      created_at: z.string(),
      updated_at: z.string(),
      queueState: z.string().nullable(),
    }),
    async (c) => (await ingestion(c)).job(c.id),
  ),
  operation(
    "POST",
    "/jobs/{id}/retry",
    "重试已终止的失败任务",
    s.empty,
    z.object({ jobId: s.uuid }),
    async (c) => (await ingestion(c)).retry(c.id, c.requestId),
    202,
  ),
  operation(
    "GET",
    "/revisions/{id}/parse-result",
    "读取原始解析结果与警告",
    s.empty,
    parserResultSchema,
    async (c) => (await ingestion(c)).result(c.id),
  ),
  operation(
    "POST",
    "/revisions/{id}/parser-review",
    "确认已人工检查解析警告",
    z.strictObject({ note: z.string().trim().min(10).max(4000) }),
    z.object({ revisionId: s.uuid, acknowledged: z.boolean() }),
    async (c, data) =>
      (await ingestion(c)).acknowledge(c.id, data.note, c.requestId),
  ),

  operation(
    "POST",
    "/games",
    "创建游戏",
    s.createGame,
    s.gameResult,
    (c, data) =>
      audit(c, "game.create", (tx) =>
        new KnowledgeRepository(tx).createGame(data),
      ),
    201,
  ),
  operation(
    "GET",
    "/games",
    "分页列出游戏",
    s.pageQuery,
    s.listResult(s.gameResult),
    async (c, q) => {
      const [items, total] = await c.db.getRepository(GameEntity).findAndCount({
        order: { createdAt: "ASC", id: "ASC" },
        take: q.limit,
        skip: q.offset,
      });
      return { items, total, ...q };
    },
  ),
  operation(
    "POST",
    "/rulesets",
    "创建规则集",
    s.createRuleset,
    s.rulesetResult,
    (c, data) =>
      audit(c, "ruleset.create", (tx) =>
        new KnowledgeRepository(tx).createRuleset(data),
      ),
    201,
  ),
  operation(
    "GET",
    "/games/{id}/rulesets",
    "分页列出游戏规则集",
    s.pageQuery,
    s.listResult(s.rulesetResult),
    async (c, q) => {
      if (!(await c.db.getRepository(GameEntity).existsBy({ id: c.id })))
        throw new HttpError(404, "NOT_FOUND");
      const [items, total] = await c.db
        .getRepository(RulesetEntity)
        .findAndCount({
          where: { gameId: c.id },
          order: { createdAt: "ASC", id: "ASC" },
          take: q.limit,
          skip: q.offset,
        });
      return { items, total, ...q };
    },
  ),
  operation(
    "POST",
    "/documents",
    "登记资料元数据（不上传文件）",
    s.createDocument,
    s.documentResult,
    (c, data) =>
      audit(c, "document.create", (tx) =>
        new KnowledgeRepository(tx).createDocument({
          ...data,
          objectKey: `documents/${data.sha256}.pdf`,
        }),
      ),
    201,
  ),
  operation(
    "GET",
    "/rulesets/{id}/documents",
    "分页列出资料",
    s.pageQuery,
    s.listResult(s.documentResult),
    async (c, q) => {
      if (!(await c.db.getRepository(RulesetEntity).existsBy({ id: c.id })))
        throw new HttpError(404, "NOT_FOUND");
      const [items, total] = await c.db
        .getRepository(SourceDocumentEntity)
        .findAndCount({
          where: { rulesetId: c.id },
          order: { createdAt: "ASC", id: "ASC" },
          take: q.limit,
          skip: q.offset,
        });
      return { items, total, ...q };
    },
  ),
  operation(
    "POST",
    "/documents/{id}/revisions",
    "创建资料修订",
    s.createRevision,
    s.revisionResult,
    (c, data) =>
      audit(c, "revision.create", (tx) =>
        new KnowledgeRepository(tx).createRevision(c.id, data.parserConfig),
      ),
    201,
  ),
  operation(
    "GET",
    "/revisions/{id}",
    "查看修订状态",
    s.empty,
    s.revisionResult,
    (c) => exists(c.db.manager, DocumentRevisionEntity, c.id),
  ),
  operation(
    "POST",
    "/revisions/{id}/blocks",
    "导入结构化来源块（解析适配器入口）",
    s.parsedBlocks,
    z.array(s.blockResult),
    async (c, data) => {
      return c.db.transaction(async (tx) => {
        const result = await new KnowledgeRepository(tx).saveParsedBlocks(
          c.id,
          data.blocks,
        );
        await tx.query(
          "INSERT INTO admin_audit_events(request_id,actor,action,target_id,details) VALUES ($1,'admin','blocks.import',$2,$3)",
          [c.requestId, c.id, JSON.stringify({ count: result.length })],
        );
        return result;
      });
    },
    201,
  ),
  operation(
    "GET",
    "/revisions/{id}/blocks",
    "分页查看来源块",
    s.pageQuery,
    s.listResult(s.blockResult),
    async (c, q) => {
      await exists(c.db.manager, DocumentRevisionEntity, c.id);
      const [items, total] = await c.db
        .getRepository(SourceBlockEntity)
        .findAndCount({
          where: { revisionId: c.id },
          order: { ordinal: "ASC" },
          take: q.limit,
          skip: q.offset,
        });
      return { items, total, ...q };
    },
  ),
  operation(
    "POST",
    "/revisions/{id}/rules",
    "创建带来源规则",
    s.createRule,
    s.ruleResult,
    (c, data) =>
      audit(c, "rule.create", (tx) => {
        const { sourceBlockIds, ...fields } = data;
        return new KnowledgeRepository(tx).addRule(
          { ...fields, revisionId: c.id },
          sourceBlockIds,
        );
      }),
    201,
  ),
  operation(
    "GET",
    "/revisions/{id}/rules",
    "分页查看规则",
    s.pageQuery,
    s.listResult(s.ruleResult),
    async (c, q) => {
      await exists(c.db.manager, DocumentRevisionEntity, c.id);
      const [items, total] = await c.db
        .getRepository(RuleUnitEntity)
        .findAndCount({
          where: { revisionId: c.id },
          order: { id: "ASC" },
          take: q.limit,
          skip: q.offset,
        });
      return { items, total, ...q };
    },
  ),
  operation(
    "PATCH",
    "/rules/{id}",
    "修改待审核规则及证据关联",
    s.editRule,
    s.ruleResult,
    (c, data) =>
      audit(c, "rule.edit", async (tx) => {
        const rule = await tx
          .getRepository(RuleUnitEntity)
          .findOneBy({ id: c.id });
        if (!rule) throw new HttpError(404, "NOT_FOUND");
        const revision = await tx
          .getRepository(DocumentRevisionEntity)
          .findOne({
            where: { id: rule.revisionId },
            lock: { mode: "pessimistic_write" },
          });
        if (revision?.status !== "awaiting_review")
          throw new HttpError(409, "REVISION_NOT_EDITABLE");
        const { sourceBlockIds, ...patch } = data;
        if (Object.keys(patch).length)
          await tx.getRepository(RuleUnitEntity).update(c.id, patch);
        if (sourceBlockIds) {
          await tx.query("DELETE FROM rule_sources WHERE rule_unit_id=$1", [
            c.id,
          ]);
          for (const blockId of new Set(sourceBlockIds))
            await tx.query(
              "INSERT INTO rule_sources(revision_id,rule_unit_id,block_id) VALUES ($1,$2,$3)",
              [rule.revisionId, c.id, blockId],
            );
        }
        return await tx
          .getRepository(RuleUnitEntity)
          .findOneByOrFail({ id: c.id });
      }),
  ),
  operation(
    "GET",
    "/rules/{id}/sources",
    "读取规则的原文位置",
    s.empty,
    z.array(s.blockResult),
    async (c) => {
      if (!(await c.db.getRepository(RuleUnitEntity).existsBy({ id: c.id })))
        throw new HttpError(404, "NOT_FOUND");
      return c.db
        .getRepository(SourceBlockEntity)
        .createQueryBuilder("b")
        .innerJoin("rule_sources", "s", "s.block_id=b.id")
        .where("s.rule_unit_id=:id", { id: c.id })
        .orderBy("b.ordinal", "ASC")
        .getMany();
    },
  ),
  operation(
    "POST",
    "/revisions/{id}/relations",
    "关联条件、例外及图例",
    s.relationInput,
    s.relationInput,
    async (c, data) => {
      await c.db.transaction(async (tx) => {
        const rev = await tx.getRepository(DocumentRevisionEntity).findOne({
          where: { id: c.id },
          lock: { mode: "pessimistic_write" },
        });
        if (!rev) throw new HttpError(404, "NOT_FOUND");
        if (rev.status !== "awaiting_review")
          throw new HttpError(409, "REVISION_NOT_EDITABLE");
        await tx.query(
          "INSERT INTO rule_relations(revision_id,from_rule_id,to_rule_id,kind) VALUES ($1,$2,$3,$4)",
          [c.id, data.fromRuleId, data.toRuleId, data.kind],
        );
        await tx.query(
          "INSERT INTO admin_audit_events(request_id,actor,action,target_id) VALUES ($1,'admin','relation.create',$2)",
          [c.requestId, c.id],
        );
      });
      return data;
    },
    201,
  ),
  operation(
    "POST",
    "/revisions/{id}/approve",
    "审核并冻结资料修订",
    s.empty,
    s.revisionResult,
    (c) =>
      audit(c, "revision.approve", (tx) =>
        new KnowledgeRepository(tx).approveRevision(c.id),
      ),
  ),
];
const errorSchema = {
  type: "object",
  required: ["error", "requestId"],
  properties: {
    error: {
      type: "object",
      properties: { code: { type: "string" } },
      required: ["code"],
    },
    requestId: { type: "string", format: "uuid" },
  },
};
export function openApiDocument() {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const op of operations) {
    const parameters: unknown[] = [];
    if (op.path.includes("{id}"))
      parameters.push({
        in: "path",
        name: "id",
        required: true,
        schema: { type: "string", format: "uuid" },
      });
    if (op.method === "GET" && op.input === s.pageQuery)
      parameters.push(
        {
          in: "query",
          name: "limit",
          schema: { type: "integer", minimum: 1, maximum: 100, default: 25 },
        },
        {
          in: "query",
          name: "offset",
          schema: { type: "integer", minimum: 0, maximum: 100000, default: 0 },
        },
      );
    const responseSchema = {
      type: "object",
      required: ["data", "requestId"],
      properties: {
        data: z.toJSONSchema(op.output, { io: "output" }),
        requestId: { type: "string", format: "uuid" },
      },
    };
    const errors = Object.fromEntries(
      [400, 401, 404, 409, 413, 415, 422, 500, 502, 503, 504].map((code) => [
        code,
        {
          description: `HTTP ${code}`,
          content: { "application/json": { schema: errorSchema } },
        },
      ]),
    );
    const endpoint = {
      summary: op.summary,
      operationId: `${op.method.toLowerCase()}_${op.path.replace(/[^a-zA-Z0-9]+/g, "_")}`,
      parameters,
      security: [{ adminBearer: [] }],
      ...(op.method !== "GET"
        ? {
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: z.toJSONSchema(op.input, { io: "input" }),
                },
              },
            },
          }
        : {}),
      responses: {
        [op.success]: {
          description: "成功",
          content: { "application/json": { schema: responseSchema } },
        },
        ...errors,
      },
    };
    (paths[`/api/admin${op.path}`] ??= {})[op.method.toLowerCase()] = endpoint;
  }
  paths["/api/admin/documents/{id}/file"] = {
    put: {
      summary: "上传原始 PDF，校验登记的 SHA-256（20 MiB 上限）",
      security: [{ adminBearer: [] }],
      parameters: [
        {
          in: "path",
          name: "id",
          required: true,
          schema: { type: "string", format: "uuid" },
        },
      ],
      requestBody: {
        required: true,
        content: {
          "application/pdf": { schema: { type: "string", format: "binary" } },
        },
      },
      responses: {
        200: { description: "文件已保存（重复上传幂等）" },
        401: { description: "未认证" },
        413: { description: "超出大小" },
        422: { description: "哈希或文件头不符" },
      },
    },
    get: {
      summary: "下载原始 PDF（管理员）",
      security: [{ adminBearer: [] }],
      parameters: [
        {
          in: "path",
          name: "id",
          required: true,
          schema: { type: "string", format: "uuid" },
        },
      ],
      responses: {
        200: {
          description: "原始 PDF",
          content: {
            "application/pdf": { schema: { type: "string", format: "binary" } },
          },
        },
        404: { description: "尚未上传" },
      },
    },
  };
  return {
    openapi: "3.1.0",
    info: {
      title: "Board Game Rules Admin API",
      version: "0.2.0",
      description:
        "管理员后端 API。登记资料后上传 PDF，再创建异步解析任务；解析结果必须人工审核。",
    },
    paths,
    components: {
      securitySchemes: {
        adminBearer: {
          type: "http",
          scheme: "bearer",
          description:
            "服务端配置的管理员令牌；只用于单管理员后端，不是公众微信登录。",
        },
      },
    },
  };
}
const MAX_BODY = 1024 * 1024;
async function body(request: Request) {
  if (
    !/^application\/json(?:\s*;|$)/i.test(
      request.headers.get("content-type") ?? "",
    )
  )
    throw new HttpError(415, "JSON_REQUIRED");
  const bytes = await readBytes(request, MAX_BODY);
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new HttpError(400, "INVALID_JSON");
  }
}
async function readBytes(request: Request, max: number): Promise<Buffer> {
  const length = request.headers.get("content-length");
  if (length && (!/^\d+$/.test(length) || Number(length) > max))
    throw new HttpError(413, "BODY_TOO_LARGE");
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, "BODY_REQUIRED");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > max) {
        await reader.cancel();
        throw new HttpError(413, "BODY_TOO_LARGE");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

export interface AdminDependencies {
  getDb: () => Promise<DataSource>;
  getIngestion?: () => Promise<IngestionService>;
  getVectors?: () => Promise<VectorService>;
  getEvaluations?: () => Promise<EvaluationService>;
  getAnswers?: () => Promise<AnswerService>;
  getAnswerEvaluations?: () => Promise<AnswerEvaluationService>;
  getPublications?: () => Promise<PublicationService>;
  signal?: AbortSignal;
  adminToken: () => string | undefined;
  reportError?: (error: unknown, requestId: string) => void;
}
export async function handleAdmin(
  request: Request,
  deps: AdminDependencies,
): Promise<Response> {
  const requestId = randomUUID();
  const respond = (value: unknown, status = 200) =>
    Response.json(value, {
      status,
      headers: { "x-request-id": requestId, "cache-control": "no-store" },
    });
  try {
    const secret = deps.adminToken();
    if (!secret || secret.length < 32)
      throw new HttpError(503, "ADMIN_NOT_CONFIGURED");
    const supplied = request.headers.get("authorization") ?? "";
    const digest = (v: string) => createHash("sha256").update(v).digest();
    if (!timingSafeEqual(digest(supplied), digest(`Bearer ${secret}`)))
      throw new HttpError(401, "UNAUTHORIZED");
    const url = new URL(request.url);
    if (url.pathname === "/api/admin/openapi" && request.method === "GET")
      return respond(openApiDocument());
    const fileMatch = /^\/api\/admin\/documents\/([^/]+)\/file$/.exec(
      url.pathname,
    );
    if (fileMatch && ["PUT", "GET"].includes(request.method)) {
      const id = s.uuid.parse(fileMatch[1]);
      if (request.method === "PUT") {
        if (
          !/^application\/pdf(?:\s*;|$)/i.test(
            request.headers.get("content-type") ?? "",
          )
        )
          throw new HttpError(415, "PDF_REQUIRED");
        const bytes = await readBytes(request, 20 * 1024 * 1024);
        return respond({
          data: await (await ingestion(deps)).upload(id, bytes, requestId),
          requestId,
        });
      }
      const bytes = await (await ingestion(deps)).download(id);
      return new Response(new Uint8Array(bytes), {
        headers: {
          "content-type": "application/pdf",
          "content-disposition": "attachment; filename=rules.pdf",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "x-request-id": requestId,
        },
      });
    }
    for (const op of operations) {
      if (op.method !== request.method) continue;
      const match = new RegExp(
        `^/api/admin${op.path.replace("{id}", "([^/]+)")}$`,
      ).exec(url.pathname);
      if (!match) continue;
      const id = match[1] ? s.uuid.parse(match[1]) : "";
      const raw =
        request.method === "GET"
          ? Object.fromEntries(url.searchParams)
          : await body(request);
      // Reject invalid input before opening database connections.
      op.input.parse(raw);
      const db = await deps.getDb();
      const data = await op.invoke(
        {
          db,
          id,
          requestId,
          getIngestion: deps.getIngestion,
          getVectors: deps.getVectors,
          getEvaluations: deps.getEvaluations,
          getAnswers: deps.getAnswers,
          getAnswerEvaluations: deps.getAnswerEvaluations,
          getPublications: deps.getPublications,
          signal: request.signal,
        },
        raw,
      );
      let serialized: unknown;
      try {
        serialized = op.output.parse(JSON.parse(JSON.stringify(data)));
      } catch (error) {
        deps.reportError?.(error, requestId);
        throw new HttpError(500, "INVALID_SERVER_RESPONSE");
      }
      return respond({ data: serialized, requestId }, op.success);
    }
    throw new HttpError(404, "NOT_FOUND");
  } catch (error) {
    if (
      error instanceof HttpError ||
      error instanceof IngestionError ||
      error instanceof RetrievalError
    )
      return respond({ error: { code: error.code }, requestId }, error.status);
    if (error instanceof EmbeddingError) {
      const status =
        error.code === "EMBEDDING_TIMEOUT"
          ? 504
          : ["EMBEDDING_RATE_LIMIT", "EMBEDDING_UNAVAILABLE"].includes(
                error.code,
              )
            ? 503
            : ["EMBEDDING_INPUT_LIMIT", "EMBEDDING_BATCH_LIMIT"].includes(
                  error.code,
                )
              ? 422
              : 502;
      return respond({ error: { code: error.code }, requestId }, status);
    }
    if (error instanceof z.ZodError)
      return respond(
        {
          error: {
            code: "VALIDATION_FAILED",
            issues: error.issues.map((i) => ({
              path: i.path,
              message: i.message,
            })),
          },
          requestId,
        },
        400,
      );
    const err = error as {
      code?: string;
      driverError?: { code?: string };
      message?: string;
    };
    const code = err.driverError?.code ?? err.code;
    if (code === "23505")
      return respond({ error: { code: "ALREADY_EXISTS" }, requestId }, 409);
    if (code === "23503")
      return respond({ error: { code: "INVALID_REFERENCE" }, requestId }, 422);
    if (code === "23514")
      return respond(
        { error: { code: "KNOWLEDGE_CONSTRAINT" }, requestId },
        409,
      );
    if (err.message === "DOCUMENT_NOT_FOUND")
      return respond({ error: { code: "NOT_FOUND" }, requestId }, 404);
    if (
      [
        "REVISION_NOT_PARSEABLE",
        "REVISION_NOT_EDITABLE",
        "REVISION_NOT_REVIEWABLE",
      ].includes(err.message ?? "")
    )
      return respond({ error: { code: err.message }, requestId }, 409);
    deps.reportError?.(error, requestId);
    return respond({ error: { code: "INTERNAL_ERROR" }, requestId }, 500);
  }
}
