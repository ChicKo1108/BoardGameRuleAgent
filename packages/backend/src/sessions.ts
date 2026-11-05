import { randomBytes, createHash } from "node:crypto";
import type { DataSource, EntityManager } from "typeorm";
import { z } from "zod";
import { sessionView } from "@boardgame/contracts";
export class SessionError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}
const hash = (token: string) =>
  createHash("sha256").update(token).digest("hex");
export const sessionOptions = z
  .strictObject({
    origin: z.string().url(),
    ttlSeconds: z.number().int().min(900).max(2592000).default(2592000),
    guestDailyQuestions: z.number().int().min(0).max(1000).default(0),
    globalDailyQuestions: z.number().int().min(0).max(1000000).default(0),
    mintsPerMinute: z.number().int().min(1).max(10000).default(60),
  })
  .transform((c) => {
    const u = new URL(c.origin);
    if (
      u.origin !== c.origin ||
      (u.protocol !== "https:" &&
        !(
          u.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)
        ))
    )
      throw new Error(
        "PUBLIC_APP_ORIGIN must be an exact HTTPS origin or loopback HTTP origin",
      );
    return { ...c, secure: u.protocol === "https:" };
  });
const allowanceInput = z.strictObject({
  id: z.uuid().toLowerCase(),
  requestHash: z.string().regex(/^[a-f0-9]{64}$/),
});
export class SessionService {
  readonly options: z.output<typeof sessionOptions>;
  constructor(
    private readonly db: DataSource,
    config: z.input<typeof sessionOptions>,
  ) {
    this.options = sessionOptions.parse(config);
  }
  get cookieName() {
    return this.options.secure
      ? "__Host-boardgame_session"
      : "boardgame_local_session";
  }
  cookie(token: string, maxAge = this.options.ttlSeconds) {
    return `${this.cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${this.options.secure ? "; Secure" : ""}`;
  }
  authorizeRequest(request: Request) {
    const origin = request.headers.get("origin"),
      site = request.headers.get("sec-fetch-site");
    if (
      (origin && origin !== this.options.origin) ||
      (site && !["same-origin", "none"].includes(site)) ||
      (request.method !== "GET" &&
        (origin !== this.options.origin ||
          request.headers.get("x-boardgame-request") !== "1"))
    )
      throw new SessionError(403, "ORIGIN_REJECTED");
  }
  token(request: Request) {
    const values = (request.headers.get("cookie") ?? "")
      .split(";")
      .map((x) => x.trim())
      .filter((x) => x.startsWith(this.cookieName + "="));
    if (values.length > 1) throw new SessionError(401, "SESSION_INVALID");
    return values[0]?.slice(this.cookieName.length + 1) ?? null;
  }
  async authenticate(
    token: string | null,
    tx: EntityManager = this.db.manager,
    lock = false,
  ) {
    if (!token || !/^[-_a-zA-Z0-9]{43}$/.test(token))
      throw new SessionError(401, "SESSION_REQUIRED");
    const [row] = await tx.query(
      `SELECT id,principal_id AS "principalId",expires_at AS "expiresAt" FROM browser_sessions WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at>clock_timestamp()${lock ? " FOR UPDATE" : ""}`,
      [hash(token)],
    );
    if (!row) throw new SessionError(401, "SESSION_INVALID");
    return row as { id: string; principalId: string; expiresAt: Date };
  }
  async initialize(token: string | null) {
    if (token) return { session: await this.current(token), cookie: null };
    const secret = randomBytes(32).toString("base64url");
    const actor = await this.db.transaction(async (tx) => {
      const [{ window }] = await tx.query(
        "SELECT date_trunc('minute',clock_timestamp()) AS window",
      );
      const rows = await tx.query(
        "INSERT INTO session_mint_windows(window_start,minted) VALUES($1,1) ON CONFLICT(window_start) DO UPDATE SET minted=session_mint_windows.minted+1 WHERE session_mint_windows.minted<$2 RETURNING minted",
        [window, this.options.mintsPerMinute],
      );
      if (!rows.length) throw new SessionError(429, "SESSION_MINT_LIMIT");
      const [principal] = await tx.query(
        "INSERT INTO public_principals DEFAULT VALUES RETURNING id",
      );
      const [created] = await tx.query(
        `INSERT INTO browser_sessions(principal_id,token_hash,expires_at) VALUES($1,$2,clock_timestamp()+($3::int*interval '1 second')) RETURNING id,principal_id AS "principalId",expires_at AS "expiresAt"`,
        [principal.id, hash(secret), this.options.ttlSeconds],
      );
      return created;
    });
    return { session: await this.describe(actor), cookie: this.cookie(secret) };
  }
  private async usage(
    principalId: string,
    tx: EntityManager = this.db.manager,
  ) {
    const [row] = await tx.query(
      `SELECT timezone('Asia/Shanghai',clock_timestamp())::date::text AS day,count(*) FILTER(WHERE principal_id=$1)::int AS used,count(*)::int AS global_used FROM question_allowances WHERE quota_day=timezone('Asia/Shanghai',clock_timestamp())::date AND state<>'released' AND (state<>'reserved' OR expires_at>clock_timestamp())`,
      [principalId],
    );
    return {
      day: row.day,
      limit: this.options.guestDailyQuestions,
      used: row.used,
      remaining: Math.max(
        0,
        Math.min(
          this.options.guestDailyQuestions - row.used,
          this.options.globalDailyQuestions - row.global_used,
        ),
      ),
      resetAt: (
        await tx.query(
          "SELECT ((timezone('Asia/Shanghai',clock_timestamp())::date+1)::timestamp AT TIME ZONE 'Asia/Shanghai') AS reset",
        )
      )[0].reset.toISOString(),
    };
  }
  private async describe(actor: { principalId: string; expiresAt: Date }) {
    return sessionView.parse({
      kind: "guest" as const,
      expiresAt: actor.expiresAt.toISOString(),
      quota: await this.usage(actor.principalId),
    });
  }
  async current(token: string | null) {
    return this.describe(await this.authenticate(token));
  }
  async revoke(token: string | null) {
    if (token && /^[-_a-zA-Z0-9]{43}$/.test(token))
      await this.db.query(
        "UPDATE browser_sessions SET revoked_at=clock_timestamp() WHERE token_hash=$1 AND revoked_at IS NULL",
        [hash(token)],
      );
    return this.cookie("", 0);
  }
  async reserve(token: string | null, raw: unknown, manager?: EntityManager) {
    const input = allowanceInput.parse(raw);
    const work = async (tx: EntityManager) => {
      const actor = await this.authenticate(token, tx, true);
      // One database lock across replicas protects the shared daily question budget.
      await tx.query("SELECT pg_advisory_xact_lock(724501008)");
      const [old] = await tx.query(
        "SELECT * FROM question_allowances WHERE id=$1",
        [input.id],
      );
      if (old) {
        if (old.principal_id !== actor.principalId)
          throw new SessionError(404, "ALLOWANCE_NOT_FOUND");
        if (old.request_hash !== input.requestHash)
          throw new SessionError(409, "ALLOWANCE_IDEMPOTENCY_CONFLICT");
        return this.allowance(old);
      }
      const quota = await this.usage(actor.principalId, tx);
      if (quota.remaining <= 0)
        throw new SessionError(429, "QUESTION_QUOTA_EXHAUSTED");
      const [row] = await tx.query(
        "INSERT INTO question_allowances(id,principal_id,request_hash) VALUES($1,$2,$3) RETURNING *",
        [input.id, actor.principalId, input.requestHash],
      );
      return this.allowance(row);
    };
    return manager ? work(manager) : this.db.transaction(work);
  }
  private allowance(row: any) {
    return {
      id: row.id,
      state: row.state as "reserved" | "dispatched" | "settled" | "released",
      quotaDay:
        typeof row.quota_day === "string"
          ? row.quota_day
          : row.quota_day.toISOString().slice(0, 10),
      expiresAt: row.expires_at.toISOString(),
    };
  }
  // Internal orchestration only. Public clients cannot dispatch, refund or settle allowances.
  async transition(
    id: string,
    target: "dispatched" | "settled" | "released",
    manager?: EntityManager,
  ) {
    id = z.uuid().parse(id).toLowerCase();
    const work = async (tx: EntityManager) => {
      const [row] = await tx.query(
        "SELECT * FROM question_allowances WHERE id=$1 FOR UPDATE",
        [id],
      );
      if (!row) throw new SessionError(404, "ALLOWANCE_NOT_FOUND");
      if (row.state === target) return this.allowance(row);
      if (!(
        (row.state === "reserved" &&
          ["dispatched", "released"].includes(target)) ||
        (row.state === "dispatched" && target === "settled")
      ))
        throw new SessionError(409, "ALLOWANCE_TRANSITION_INVALID");
      if (
        target === "dispatched" &&
        (
          await tx.query(
            "SELECT (expires_at<=clock_timestamp() OR quota_day<>timezone('Asia/Shanghai',clock_timestamp())::date) AS expired FROM question_allowances WHERE id=$1",
            [id],
          )
        )[0].expired
      )
        throw new SessionError(409, "ALLOWANCE_EXPIRED");
      const [[updated]] = await tx.query(
        "UPDATE question_allowances SET state=$2,updated_at=clock_timestamp() WHERE id=$1 RETURNING *",
        [id, target],
      );
      return this.allowance(updated);
    };
    return manager ? work(manager) : this.db.transaction(work);
  }
}
export function sessionConfigFromEnvironment() {
  const v = (name: string, fallback: number) =>
    process.env[name] === undefined ? fallback : Number(process.env[name]);
  if (!process.env.PUBLIC_APP_ORIGIN)
    throw new SessionError(503, "PUBLIC_SESSION_NOT_CONFIGURED");
  return {
    origin: process.env.PUBLIC_APP_ORIGIN,
    guestDailyQuestions: v("PUBLIC_GUEST_DAILY_QUESTIONS", 0),
    globalDailyQuestions: v("PUBLIC_GLOBAL_DAILY_QUESTIONS", 0),
    mintsPerMinute: v("PUBLIC_SESSION_MINTS_PER_MINUTE", 60),
    ttlSeconds: v("PUBLIC_SESSION_TTL_SECONDS", 2592000),
  };
}
export async function handleSession(
  request: Request,
  getService: () => Promise<SessionService>,
) {
  const headers: Record<string, string> = {
    "cache-control": "no-store",
    vary: "Cookie, Origin",
    "x-request-id": randomBytes(16).toString("hex"),
  };
  const response = (status: number, data: unknown) =>
    Response.json(data, { status, headers });
  try {
    if (!["GET", "POST", "DELETE"].includes(request.method))
      return response(405, { error: { code: "METHOD_NOT_ALLOWED" } });
    const service = await getService();
    const origin = request.headers.get("origin"),
      site = request.headers.get("sec-fetch-site");
    if (
      (origin && origin !== service.options.origin) ||
      (site && !["same-origin", "none"].includes(site))
    )
      throw new SessionError(403, "ORIGIN_REJECTED");
    if (request.method !== "GET") {
      if (
        origin !== service.options.origin ||
        request.headers.get("x-boardgame-request") !== "1"
      )
        throw new SessionError(403, "ORIGIN_REJECTED");
      // This API has no input fields; reject bodies rather than accepting user-controlled identity.
      if (request.body) {
        const reader = request.body.getReader();
        try {
          const part = await reader.read();
          if (!part.done && part.value.length)
            throw new SessionError(400, "SESSION_BODY_NOT_ALLOWED");
        } finally {
          await reader.cancel();
          reader.releaseLock();
        }
      }
    }
    const token = service.token(request);
    if (request.method === "DELETE") {
      headers["set-cookie"] = await service.revoke(token);
      return response(200, { data: { loggedOut: true } });
    }
    if (request.method === "POST") {
      const result = await service.initialize(token);
      if (result.cookie) headers["set-cookie"] = result.cookie;
      return response(200, { data: result.session });
    }
    return response(200, { data: await service.current(token) });
  } catch (error) {
    if (error instanceof SessionError)
      return response(error.status, { error: { code: error.code } });
    return response(503, { error: { code: "SESSION_SERVICE_UNAVAILABLE" } });
  }
}

export function publicSessionOpenApi() {
  const response = {
    description: "Successful request",
    content: {
      "application/json": {
        schema: {
          type: "object",
          properties: { data: z.toJSONSchema(sessionView) },
        },
      },
    },
  };
  const error = {
    description: "Stable error code; no credentials or provider data",
  };
  const mutationParameters = [
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
  ];
  return {
    openapi: "3.1.0",
    info: { title: "Boardgame public API", version: "0.1.0" },
    paths: {
      "/api/session": {
        get: {
          summary: "Read guest session and shared daily allowance",
          responses: { 200: response, 401: error, 403: error, 503: error },
        },
        post: {
          summary: "Create or reuse guest session; no request body",
          parameters: mutationParameters,
          responses: {
            200: {
              ...response,
              headers: {
                "Set-Cookie": {
                  description: "Opaque HttpOnly session credential",
                  schema: { type: "string" },
                },
              },
            },
            400: error,
            401: error,
            403: error,
            429: error,
            503: error,
          },
        },
        delete: {
          summary: "Revoke this browser credential",
          parameters: mutationParameters,
          responses: {
            200: { description: "Session revoked and cookie cleared" },
            400: error,
            403: error,
            503: error,
          },
        },
      },
    },
  };
}
