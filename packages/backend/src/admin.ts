import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { adminSchemas as s } from "@boardgame/contracts";
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
};
async function ingestion(c: Pick<Context, "getIngestion">) {
  if (!c.getIngestion) throw new HttpError(503, "INGESTION_NOT_CONFIGURED");
  return c.getIngestion();
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
      [400, 401, 404, 409, 413, 415, 422, 500, 503].map((code) => [
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
        { db, id, requestId, getIngestion: deps.getIngestion },
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
    if (error instanceof HttpError || error instanceof IngestionError)
      return respond({ error: { code: error.code }, requestId }, error.status);
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
