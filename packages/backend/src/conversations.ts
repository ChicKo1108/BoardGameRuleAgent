import { isDeepStrictEqual } from "node:util";
import { randomUUID, createHash } from "node:crypto";
import type { DataSource, EntityManager } from "typeorm";
import { z } from "zod";
import {
  conversationSchemas as s,
  answeringSchemas as a,
  adminSchemas,
} from "@boardgame/contracts";
import { RetrievalError } from "@boardgame/retrieval";
import { SessionError, type SessionService } from "./sessions.ts";
import { AnswerService } from "./answers.ts";
import type { PublicationService } from "./publications.ts";
const json = (v: unknown) => JSON.parse(JSON.stringify(v));
const error = (code: string, status = 409) => new SessionError(status, code);
type Row = {
  id: string;
  conversation_id: string;
  sequence: number;
  question: string;
  input: z.infer<typeof a.previewInput>;
  execution_key: string;
  allowance_id: string;
  state: string;
  answer: unknown;
  error_code: string | null;
  created_at: Date;
  finished_at: Date | null;
  expired: boolean;
};
export class ConversationService {
  constructor(
    private readonly db: DataSource,
    readonly sessions: SessionService,
    private readonly publications: PublicationService,
    private readonly getAnswers: () => Promise<AnswerService>,
  ) {}
  private async owned(
    id: string,
    principal: string,
    tx: EntityManager = this.db.manager,
    lock = false,
  ) {
    const [row] = await tx.query(
      `SELECT c.*,(SELECT coalesce(max(sequence),0) FROM public_turns WHERE conversation_id=c.id)::int AS revision FROM public_conversations c WHERE c.id=$1 AND c.principal_id=$2${lock ? " FOR UPDATE" : ""}`,
      [id, principal],
    );
    if (!row) throw error("CONVERSATION_NOT_FOUND", 404);
    return row;
  }
  private view(row: any) {
    return s.conversation.parse({
      id: row.id,
      rulesetId: row.ruleset_id,
      publicationId: row.publication_id,
      revision: row.revision ?? 0,
      createdAt: row.created_at.toISOString(),
    });
  }
  async create(token: string | null, raw: unknown) {
    const input = s.createConversation.parse(raw);
    const actor = await this.sessions.authenticate(token);
    const [observed] = await this.db.query(
      "SELECT id FROM public_conversations WHERE id=$1",
      [input.idempotencyKey],
    );
    const pinned = observed
      ? null
      : await this.publications.resolve(input.rulesetId);
    return this.db.transaction(async (tx) => {
      const actor = await this.sessions.authenticate(token, tx, true);
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,11))", [
        input.idempotencyKey,
      ]);
      const [old] = await tx.query(
        "SELECT id,principal_id,ruleset_id FROM public_conversations WHERE id=$1",
        [input.idempotencyKey],
      );
      if (old) {
        if (old.principal_id !== actor.principalId)
          throw error("CONVERSATION_NOT_FOUND", 404);
        if (old.ruleset_id !== input.rulesetId)
          throw error("CONVERSATION_IDEMPOTENCY_CONFLICT");
        return this.view(await this.owned(old.id, actor.principalId, tx));
      }
      const [{ count }] = await tx.query(
        "SELECT count(*)::int AS count FROM public_conversations WHERE principal_id=$1",
        [actor.principalId],
      );
      if (count >= 100) throw error("CONVERSATION_LIMIT", 429);
      if (!pinned) throw error("CONVERSATION_IDEMPOTENCY_CONFLICT");
      if (
        !(
          await tx.query(
            "SELECT ruleset_id FROM publication_heads WHERE ruleset_id=$1 AND publication_id=$2 FOR SHARE",
            [input.rulesetId, pinned.publication.id],
          )
        ).length
      )
        throw error("CONVERSATION_VERSION_CHANGED");
      const [row] = await tx.query(
        "INSERT INTO public_conversations(id,principal_id,ruleset_id,publication_id) VALUES($1,$2,$3,$4) RETURNING *",
        [
          input.idempotencyKey,
          actor.principalId,
          input.rulesetId,
          pinned.publication.id,
        ],
      );
      return this.view(row);
    });
  }
  async list(token: string | null, page = { limit: 25, offset: 0 }) {
    const actor = await this.sessions.authenticate(token);
    const [{ total }] = await this.db.query(
      "SELECT count(*)::int AS total FROM public_conversations WHERE principal_id=$1",
      [actor.principalId],
    );
    const rows = await this.db.query(
      "SELECT c.*,(SELECT coalesce(max(sequence),0) FROM public_turns WHERE conversation_id=c.id)::int AS revision FROM public_conversations c WHERE principal_id=$1 ORDER BY created_at DESC,id LIMIT $2 OFFSET $3",
      [actor.principalId, page.limit, page.offset],
    );
    return { items: rows.map((r: any) => this.view(r)), total, ...page };
  }
  async get(token: string | null, id: string) {
    const actor = await this.sessions.authenticate(token);
    return this.view(await this.owned(id, actor.principalId));
  }
  private async row(
    id: string,
    tx: EntityManager = this.db.manager,
    lock = false,
  ): Promise<Row> {
    const [row] = await tx.query(
      `SELECT t.*,expires_at<=clock_timestamp() AS expired FROM public_turns t WHERE id=$1${lock ? " FOR UPDATE" : ""}`,
      [id],
    );
    if (!row) throw error("MESSAGE_NOT_FOUND", 404);
    return row;
  }
  private async result(id: string) {
    const row = await this.row(id);
    const [conv] = await this.db.query(
      "SELECT publication_id FROM public_conversations WHERE id=$1",
      [row.conversation_id],
    );
    return s.turn.parse(
      json({
        id: row.id,
        conversationId: row.conversation_id,
        publicationId: conv.publication_id,
        sequence: row.sequence,
        question: row.question,
        state: row.state,
        answer: row.answer,
        errorCode: row.error_code,
        createdAt: row.created_at,
        finishedAt: row.finished_at,
      }),
    );
  }
  private async finish(id: string, failed = false) {
    const row = await this.row(id);
    if (!["prepared", "running"].includes(row.state)) return;
    const [present] = await this.db.query(
      "SELECT id FROM answer_runs WHERE id=$1",
      [row.execution_key],
    );
    const answer = present
      ? await AnswerService.read(this.db, row.execution_key)
      : null;
    if (!failed && !row.expired && (!answer || answer.state === "running"))
      return;
    await this.db.transaction(async (tx) => {
      const current = await this.row(id, tx, true);
      if (!["prepared", "running"].includes(current.state)) return;
      const [p] = await tx.query(
        "SELECT p.manifest FROM public_conversations c JOIN knowledge_publications p ON p.id=c.publication_id WHERE c.id=$1",
        [current.conversation_id],
      );
      const complete =
        answer?.state === "completed" &&
        isDeepStrictEqual(answer.config, p.manifest.answerConfig);
      // Equality below is rechecked by the database against the exact persisted execution.
      const valid = complete && !!answer?.answer;
      await this.sessions.transition(
        current.allowance_id,
        current.state === "prepared" ? "released" : "settled",
        tx,
      );
      await tx.query(
        "UPDATE public_turns SET state=$2,answer=$3,error_code=$4,finished_at=clock_timestamp() WHERE id=$1",
        [
          id,
          valid ? "completed" : "failed",
          valid ? JSON.stringify(answer.answer) : null,
          valid
            ? null
            : row.expired
              ? "ANSWER_INTERRUPTED"
              : "ANSWER_UNAVAILABLE",
        ],
      );
    });
  }
  async send(
    token: string | null,
    conversationId: string,
    raw: unknown,
    requestId: string,
    signal?: AbortSignal,
  ) {
    const input = s.messageInput.parse(raw);
    // Reconcile a previous in-flight turn before acquiring the conversation lock.
    const actor = await this.sessions.authenticate(token);
    const initialConversation = await this.owned(
      conversationId,
      actor.principalId,
    );
    const pending: Array<{ id: string }> = await this.db.query(
      "SELECT id FROM public_turns WHERE conversation_id=$1 AND state IN ('prepared','running')",
      [conversationId],
    );
    for (const p of pending) await this.finish(p.id);
    const [observed] = await this.db.query(
      "SELECT id FROM public_turns WHERE id=$1",
      [input.idempotencyKey],
    );
    const pinned = observed
      ? null
      : await this.publications.resolve(initialConversation.ruleset_id);
    const id = await this.db.transaction(async (tx) => {
      const actor = await this.sessions.authenticate(token, tx, true),
        conv = await this.owned(conversationId, actor.principalId, tx, true);
      const [old] = await tx.query("SELECT * FROM public_turns WHERE id=$1", [
        input.idempotencyKey,
      ]);
      if (old) {
        if (old.conversation_id !== conversationId)
          throw error("MESSAGE_NOT_FOUND", 404);
        if (
          old.question !== input.question ||
          old.sequence !== input.expectedRevision + 1
        )
          throw error("MESSAGE_IDEMPOTENCY_CONFLICT");
        return old.id;
      }
      if (conv.revision !== input.expectedRevision)
        throw error("CONVERSATION_REVISION_CONFLICT");
      if (conv.revision >= 200) throw error("MESSAGE_LIMIT", 429);
      if (
        (
          await tx.query(
            "SELECT id FROM public_turns WHERE conversation_id=$1 AND state IN ('prepared','running')",
            [conversationId],
          )
        ).length
      )
        throw error("CONVERSATION_BUSY");
      if (!pinned || pinned.publication.id !== conv.publication_id)
        throw error("CONVERSATION_VERSION_CHANGED");
      const previous: Array<{
        question: string;
        answer: z.infer<typeof a.verifiedAnswer>;
      }> = await tx.query(
        "SELECT question,answer FROM public_turns WHERE conversation_id=$1 AND state='completed' ORDER BY sequence DESC LIMIT 5",
        [conversationId],
      );
      const history = previous.reverse().flatMap((t) => [
        { role: "user" as const, content: t.question },
        {
          role: "assistant" as const,
          content: [
            `status: ${t.answer.status}`,
            `ambiguity: ${t.answer.ambiguity ?? ""}`,
            `assumedMeaning: ${t.answer.assumedMeaning ?? ""}`,
            `answer: ${t.answer.answer}`,
            `basis: ${t.answer.basis ?? ""}`,
            `followUp: ${t.answer.followUp ?? ""}`,
          ].join("\n"),
        },
      ]);
      const execution = a.previewInput.parse({
        idempotencyKey: randomUUID(),
        question: input.question,
        history,
        retrieval: pinned.publication.manifest.retrieval,
      });
      const requestHash = createHash("sha256")
        .update(
          JSON.stringify({
            conversationId,
            publicationId: conv.publication_id,
            input,
          }),
        )
        .digest("hex");
      await this.sessions.reserve(
        token,
        { id: input.idempotencyKey, requestHash },
        tx,
      );
      await tx.query(
        "INSERT INTO public_turns(id,conversation_id,sequence,question,input,execution_key,allowance_id) VALUES($1,$2,$3,$4,$5,$6,$1)",
        [
          input.idempotencyKey,
          conversationId,
          conv.revision + 1,
          input.question,
          JSON.stringify(execution),
          execution.idempotencyKey,
        ],
      );
      return input.idempotencyKey;
    });
    let claimed = false;
    try {
      const prepared = await this.db.transaction(async (tx) => {
        const row = await this.row(id, tx, true);
        if (row.state !== "prepared") return null;
        const [publication] = await tx.query(
          "SELECT p.manifest FROM public_conversations c JOIN publication_heads h ON h.ruleset_id=c.ruleset_id AND h.publication_id=c.publication_id JOIN knowledge_publications p ON p.id=c.publication_id WHERE c.id=$1 FOR SHARE OF h",
          [conversationId],
        );
        if (!publication) throw error("CONVERSATION_VERSION_CHANGED");
        signal?.throwIfAborted();
        await this.sessions.transition(row.allowance_id, "dispatched", tx);
        await tx.query(
          "UPDATE public_turns SET state='running',expires_at=clock_timestamp()+($2::int*interval '1 millisecond') WHERE id=$1",
          [id, publication.manifest.answerConfig.budgets.timeoutMs + 30000],
        );
        return { row, config: publication.manifest.answerConfig };
      });
      if (prepared) {
        claimed = true;
        await (
          await this.getAnswers()
        ).preview(prepared.row.input, requestId, signal, {
          expectedConfig: prepared.config,
          actor: "public",
        });
        await this.finish(id, true);
      }
    } catch {
      if (claimed || (await this.row(id)).state === "prepared")
        await this.finish(id, true);
    }
    return this.result(id);
  }
  async messages(
    token: string | null,
    conversationId: string,
    page = { limit: 25, offset: 0 },
  ) {
    const actor = await this.sessions.authenticate(token);
    await this.owned(conversationId, actor.principalId);
    const rows: Array<{ id: string }> = await this.db.query(
      "SELECT id FROM public_turns WHERE conversation_id=$1 ORDER BY sequence LIMIT $2 OFFSET $3",
      [conversationId, page.limit, page.offset],
    );
    for (const row of rows) await this.finish(row.id);
    const [{ total }] = await this.db.query(
      "SELECT count(*)::int AS total FROM public_turns WHERE conversation_id=$1",
      [conversationId],
    );
    return {
      items: await Promise.all(rows.map((r) => this.result(r.id))),
      total,
      ...page,
    };
  }
}
export async function handleConversations(
  request: Request,
  getService: () => Promise<ConversationService>,
) {
  const headers = {
    "cache-control": "no-store",
    vary: "Cookie, Origin",
    "x-request-id": randomUUID(),
  };
  try {
    const url = new URL(request.url),
      parts = url.pathname.split("/").filter(Boolean).slice(2);
    if (parts.length > 2 || !["GET", "POST"].includes(request.method))
      return Response.json(
        { error: { code: "NOT_FOUND" } },
        { status: 404, headers },
      );
    const service = await getService();
    service.sessions.authorizeRequest(request);
    const token = service.sessions.token(request);
    // Authentication precedes body parsing and scope lookups.
    await service.sessions.authenticate(token);
    const id = parts[0] ? z.uuid().parse(parts[0]).toLowerCase() : null;
    let body: unknown;
    if (request.method === "POST") {
      if (
        request.headers.get("content-type")?.split(";")[0] !==
        "application/json"
      )
        throw error("JSON_REQUIRED", 415);
      if (!request.body) throw error("JSON_REQUIRED", 400);
      const reader = request.body.getReader();
      let text = "",
        bytes = 0;
      const decoder = new TextDecoder();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(error("BODY_TIMEOUT", 408)), 5000);
      });
      try {
        while (true) {
          const part = await Promise.race([reader.read(), deadline]);
          if (part.done) break;
          bytes += part.value.byteLength;
          if (bytes > 8192) throw error("BODY_TOO_LARGE", 413);
          text += decoder.decode(part.value, { stream: true });
        }
        text += decoder.decode();
        try {
          body = JSON.parse(text);
        } catch {
          throw error("INVALID_JSON", 400);
        }
      } finally {
        clearTimeout(timer);
        void reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    }
    const page = adminSchemas.pageQuery.parse(
      Object.fromEntries(url.searchParams),
    );
    let data;
    if (!id && parts.length === 0)
      data =
        request.method === "GET"
          ? await service.list(token, page)
          : await service.create(token, body);
    else if (id && parts.length === 1 && request.method === "GET")
      data = await service.get(token, id);
    else if (id && parts[1] === "messages")
      data =
        request.method === "GET"
          ? await service.messages(token, id, page)
          : await service.send(
              token,
              id,
              body,
              headers["x-request-id"],
              request.signal,
            );
    else throw error("NOT_FOUND", 404);
    return Response.json({ data }, { headers });
  } catch (e) {
    const known = e instanceof SessionError || e instanceof RetrievalError;
    return Response.json(
      {
        error: {
          code: known
            ? e.code
            : e instanceof z.ZodError
              ? "VALIDATION_FAILED"
              : "PUBLIC_SERVICE_UNAVAILABLE",
        },
      },
      {
        status: known ? e.status : e instanceof z.ZodError ? 400 : 503,
        headers,
      },
    );
  }
}

export function publicConversationPaths() {
  const output = (schema: z.ZodType) => ({
    description: "Successful request; inspect message state for completion",
    content: {
      "application/json": {
        schema: {
          type: "object",
          properties: { data: z.toJSONSchema(schema, { io: "output" }) },
        },
      },
    },
  });
  const list = (schema: z.ZodType) =>
    z.object({
      items: z.array(schema),
      total: z.number(),
      limit: z.number(),
      offset: z.number(),
    });
  const errors = Object.fromEntries(
    [400, 401, 403, 404, 408, 409, 413, 415, 429, 503].map((code) => [
      code,
      { description: "Stable error code" },
    ]),
  );
  const endpoint = (
    summary: string,
    schema: z.ZodType,
    input?: z.ZodType,
    id = false,
  ) => ({
    summary,
    parameters: [
      ...(id
        ? [
            {
              in: "path",
              name: "id",
              required: true,
              schema: { type: "string", format: "uuid" },
            },
          ]
        : []),
      ...(input
        ? [
            {
              in: "header",
              name: "Origin",
              required: true,
              schema: { type: "string" },
            },
            {
              in: "header",
              name: "X-Boardgame-Request",
              required: true,
              schema: { type: "string", const: "1" },
            },
          ]
        : [
            {
              in: "query",
              name: "limit",
              schema: { type: "integer", minimum: 1, maximum: 100 },
            },
            {
              in: "query",
              name: "offset",
              schema: { type: "integer", minimum: 0 },
            },
          ]),
    ],
    ...(input
      ? {
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: z.toJSONSchema(input, { io: "input" }),
              },
            },
          },
        }
      : {}),
    responses: { 200: output(schema), ...errors },
  });
  return {
    "/api/conversations": {
      get: endpoint("List this guest's conversations", list(s.conversation)),
      post: endpoint(
        "Create a conversation pinned to active knowledge",
        s.conversation,
        s.createConversation,
      ),
    },
    "/api/conversations/{id}": {
      get: endpoint(
        "Read an owned conversation",
        s.conversation,
        undefined,
        true,
      ),
    },
    "/api/conversations/{id}/messages": {
      get: endpoint(
        "Read paginated messages and recover interrupted state",
        list(s.turn),
        undefined,
        true,
      ),
      post: endpoint(
        "Ask using server history, publication and question allowance",
        s.turn,
        s.messageInput,
        true,
      ),
    },
  };
}
