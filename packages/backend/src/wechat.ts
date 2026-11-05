import { randomBytes, randomUUID, createHash } from "node:crypto";
import type { DataSource } from "typeorm";
import { z } from "zod";
import { SessionError, type SessionService } from "./sessions.ts";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const secret = () => randomBytes(32).toString("base64url");
const err = (code: string, status = 400) => new SessionError(status, code);
export interface WechatIdentityProvider {
  readonly appId: string;
  authorizationUrl(redirectUri: string, state: string): string;
  exchange(code: string): Promise<{ subjectHash: string }>;
}
export class WechatProvider implements WechatIdentityProvider {
  readonly appId: string;
  #secret: string;
  #fetch: typeof fetch;
  constructor(
    appId: string,
    appSecret: string,
    transport: typeof fetch = fetch,
  ) {
    this.appId = z
      .string()
      .regex(/^[a-zA-Z0-9_-]{1,128}$/)
      .parse(appId);
    this.#secret = z.string().min(16).max(512).parse(appSecret);
    this.#fetch = transport;
  }
  authorizationUrl(redirectUri: string, state: string) {
    const url = new URL("https://open.weixin.qq.com/connect/qrconnect");
    url.search = new URLSearchParams({
      appid: this.appId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "snsapi_login",
      state,
    }).toString();
    url.hash = "wechat_redirect";
    return url.toString();
  }
  async exchange(code: string) {
    const signal = AbortSignal.timeout(8000);
    const url = new URL("https://api.weixin.qq.com/sns/oauth2/access_token");
    url.search = new URLSearchParams({
      appid: this.appId,
      secret: this.#secret,
      code,
      grant_type: "authorization_code",
    }).toString();
    try {
      const options = {
        signal,
        redirect: "error" as const,
        cache: "no-store" as const,
        headers: { accept: "application/json" },
      };
      const response = await this.#fetch(url, options);
      if (!response.ok) throw err("WECHAT_PROVIDER_UNAVAILABLE", 502);
      if (!response.body) throw err("WECHAT_PROVIDER_UNAVAILABLE", 502);
      const reader = response.body.getReader();
      let bytes = 0,
        text = "";
      const decoder = new TextDecoder();
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          bytes += part.value.byteLength;
          if (bytes > 65536) throw err("WECHAT_PROVIDER_UNAVAILABLE", 502);
          text += decoder.decode(part.value, { stream: true });
        }
        text += decoder.decode();
      } finally {
        void reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      const body = z
        .object({
          openid: z.string().regex(/^[a-zA-Z0-9_-]{1,256}$/),
          access_token: z.string().min(1).max(4096),
          expires_in: z.number().int().positive(),
          scope: z.string().max(512),
          errcode: z.number().optional(),
        })
        .parse(JSON.parse(text));
      if (
        (body.errcode ?? 0) !== 0 ||
        !body.scope.split(",").includes("snsapi_login")
      )
        throw err("WECHAT_AUTH_REJECTED", 401);
      return { subjectHash: hash(body.openid) };
    } catch {
      throw err("WECHAT_PROVIDER_UNAVAILABLE", 502);
    }
  }
}
export class WechatLoginService {
  readonly redirectUri: string;
  constructor(
    private readonly db: DataSource,
    readonly sessions: SessionService,
    private readonly provider: WechatIdentityProvider,
    private readonly globalStartsPerMinute = 60,
  ) {
    this.redirectUri = sessions.options.origin + "/api/auth/wechat/callback";
  }
  get bindingCookieName() {
    return this.sessions.options.secure
      ? "__Host-boardgame_oauth"
      : "boardgame_local_oauth";
  }
  private bindingCookie(value: string, maxAge = 600) {
    return `${this.bindingCookieName}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${this.sessions.options.secure ? "; Secure" : ""}`;
  }
  clearBinding() {
    return this.bindingCookie("", 0);
  }
  private binding(request: Request) {
    const cookies = (request.headers.get("cookie") ?? "")
      .split(";")
      .map((x) => x.trim())
      .filter((x) => x.startsWith(this.bindingCookieName + "="));
    if (cookies.length !== 1) throw err("WECHAT_BINDING_INVALID", 403);
    return z
      .string()
      .regex(/^[-_a-zA-Z0-9]{43}$/)
      .parse(cookies[0].slice(this.bindingCookieName.length + 1));
  }
  async start(token: string | null, requestId: string) {
    const state = secret(),
      binding = secret();
    await this.db.transaction(async (tx) => {
      const actor = await this.sessions.authenticate(token, tx, true);
      if (actor.kind !== "guest") throw err("WECHAT_ALREADY_LOGGED_IN", 409);
      await tx.query("SELECT pg_advisory_xact_lock(724501009)");
      const [{ recent, global }] = await tx.query(
        "SELECT count(*) FILTER(WHERE session_id=$1 AND created_at>clock_timestamp()-interval '10 minutes')::int AS recent,count(*) FILTER(WHERE created_at>clock_timestamp()-interval '1 minute')::int AS global FROM wechat_login_attempts WHERE created_at>clock_timestamp()-interval '10 minutes'",
        [actor.id],
      );
      if (recent >= 5 || global >= this.globalStartsPerMinute)
        throw err("WECHAT_LOGIN_LIMIT", 429);
      const [created] = await tx.query(
        "INSERT INTO wechat_login_attempts(session_id,app_id,redirect_uri,state_hash,binding_hash) VALUES($1,$2,$3,$4,$5) RETURNING id",
        [
          actor.id,
          this.provider.appId,
          this.redirectUri,
          hash(state),
          hash(binding),
        ],
      );
      await tx.query(
        "INSERT INTO admin_audit_events(request_id,actor,action,target_id) VALUES($1,'public','auth.wechat.start',$2)",
        [requestId, created.id],
      );
    });
    return {
      authorizationUrl: this.provider.authorizationUrl(this.redirectUri, state),
      cookie: this.bindingCookie(binding),
    };
  }
  async callback(request: Request, requestId: string) {
    const url = new URL(request.url),
      params = url.searchParams;
    if (
      [...params.keys()].some((k) => !["state", "code"].includes(k)) ||
      params.getAll("state").length !== 1 ||
      params.getAll("code").length > 1
    )
      throw err("WECHAT_CALLBACK_INVALID");
    const state = z
        .string()
        .regex(/^[-_a-zA-Z0-9]{43}$/)
        .parse(params.get("state")),
      binding = this.binding(request),
      code = params.get("code");
    if (code !== null && !/^[a-zA-Z0-9_-]{1,512}$/.test(code))
      throw err("WECHAT_CALLBACK_INVALID");
    const attempt = await this.db.transaction(async (tx) => {
      const [row] = await tx.query(
        "SELECT * FROM wechat_login_attempts WHERE state_hash=$1 AND binding_hash=$2 FOR UPDATE",
        [hash(state), hash(binding)],
      );
      if (
        !row ||
        row.app_id !== this.provider.appId ||
        row.redirect_uri !== this.redirectUri
      )
        throw err("WECHAT_STATE_INVALID", 403);
      if (row.state !== "pending") throw err("WECHAT_STATE_CONSUMED", 409);
      if (
        (
          await tx.query(
            "SELECT expires_at<=clock_timestamp() AS expired FROM wechat_login_attempts WHERE id=$1",
            [row.id],
          )
        )[0].expired
      )
        throw err("WECHAT_STATE_EXPIRED", 403);
      const [session] = await tx.query(
        "SELECT * FROM browser_sessions WHERE id=$1 AND revoked_at IS NULL AND expires_at>clock_timestamp() FOR UPDATE",
        [row.session_id],
      );
      if (!session) throw err("WECHAT_SESSION_CHANGED", 403);
      await tx.query(
        "UPDATE wechat_login_attempts SET state=$2,code_hash=$3,error_code=$4,finished_at=CASE WHEN $2='failed' THEN clock_timestamp() ELSE NULL END WHERE id=$1",
        [
          row.id,
          code ? "exchanging" : "failed",
          code ? hash(code) : null,
          code ? null : "WECHAT_AUTH_DENIED",
        ],
      );
      return {
        id: row.id,
        sessionId: session.id,
        guestId: session.principal_id,
      };
    });
    if (!code) throw err("WECHAT_AUTH_DENIED", 403);
    try {
      const identity = await this.provider.exchange(code),
        newSecret = secret();
      await this.db.transaction(async (tx) => {
        const [old] = await tx.query(
          "SELECT * FROM browser_sessions WHERE id=$1 AND revoked_at IS NULL AND expires_at>clock_timestamp() FOR UPDATE",
          [attempt.sessionId],
        );
        if (!old) throw err("WECHAT_SESSION_CHANGED", 403);
        const [row] = await tx.query(
          "SELECT state FROM wechat_login_attempts WHERE id=$1 AND expires_at>clock_timestamp() FOR UPDATE",
          [attempt.id],
        );
        if (!row || row.state !== "exchanging")
          throw err("WECHAT_STATE_EXPIRED", 403);
        await tx.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1,12))",
          [this.provider.appId + ":" + identity.subjectHash],
        );
        let [account] = await tx.query(
          "SELECT principal_id FROM wechat_identities WHERE app_id=$1 AND subject_hash=$2",
          [this.provider.appId, identity.subjectHash],
        );
        if (!account) {
          const [member] = await tx.query(
            "INSERT INTO public_principals(kind) VALUES('member') RETURNING id",
          );
          await tx.query(
            "INSERT INTO wechat_identities(app_id,subject_hash,principal_id) VALUES($1,$2,$3)",
            [this.provider.appId, identity.subjectHash, member.id],
          );
          account = { principal_id: member.id };
        }
        await tx.query(
          "INSERT INTO guest_account_claims(guest_principal_id,account_principal_id) VALUES($1,$2)",
          [attempt.guestId, account.principal_id],
        );
        await tx.query(
          "UPDATE browser_sessions SET revoked_at=clock_timestamp() WHERE principal_id=$1 AND revoked_at IS NULL",
          [attempt.guestId],
        );
        await tx.query(
          "INSERT INTO browser_sessions(principal_id,token_hash,expires_at) VALUES($1,$2,clock_timestamp()+($3::int*interval '1 second'))",
          [
            account.principal_id,
            hash(newSecret),
            this.sessions.options.ttlSeconds,
          ],
        );
        await tx.query(
          "UPDATE wechat_login_attempts SET state='succeeded',finished_at=clock_timestamp() WHERE id=$1",
          [attempt.id],
        );
        await tx.query(
          "INSERT INTO admin_audit_events(request_id,actor,action,target_id,details) VALUES($1,'public','auth.wechat.login',$2,$3)",
          [
            requestId,
            account.principal_id,
            JSON.stringify({
              attemptId: attempt.id,
              guestPrincipalId: attempt.guestId,
            }),
          ],
        );
      });
      return {
        sessionCookie: this.sessions.cookie(newSecret),
        bindingCookie: this.clearBinding(),
      };
    } catch (error) {
      await this.db.query(
        "UPDATE wechat_login_attempts SET state='failed',error_code='WECHAT_LOGIN_FAILED',finished_at=clock_timestamp() WHERE id=$1 AND state='exchanging'",
        [attempt.id],
      );
      if (error instanceof SessionError) throw error;
      throw err("WECHAT_LOGIN_FAILED", 503);
    }
  }
}
export function wechatProviderFromEnvironment() {
  if (!process.env.WECHAT_APP_ID || !process.env.WECHAT_APP_SECRET)
    throw err("WECHAT_NOT_CONFIGURED", 503);
  return new WechatProvider(
    process.env.WECHAT_APP_ID,
    process.env.WECHAT_APP_SECRET,
  );
}
export async function handleWechat(
  request: Request,
  getService: () => Promise<WechatLoginService>,
) {
  const headers = new Headers({
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "content-security-policy": "default-src 'none'",
    "x-request-id": randomUUID(),
  });
  try {
    const service = await getService(),
      url = new URL(request.url);
    if (
      url.pathname === "/api/auth/wechat/start" &&
      request.method === "POST"
    ) {
      service.sessions.authorizeRequest(request);
      await service.sessions.authenticate(service.sessions.token(request));
      if (request.body) {
        const reader = request.body.getReader();
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const deadline = new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(err("WECHAT_BODY_TIMEOUT", 408)),
            5000,
          );
        });
        try {
          const part = await Promise.race([reader.read(), deadline]);
          if (!part.done && part.value.length)
            throw err("WECHAT_BODY_NOT_ALLOWED");
        } finally {
          clearTimeout(timeout);
          void reader.cancel().catch(() => {});
          reader.releaseLock();
        }
      }
      const result = await service.start(
        service.sessions.token(request),
        headers.get("x-request-id")!,
      );
      headers.append("set-cookie", result.cookie);
      return Response.json(
        { data: { authorizationUrl: result.authorizationUrl } },
        { headers },
      );
    }
    if (
      url.pathname === "/api/auth/wechat/callback" &&
      request.method === "GET"
    ) {
      const result = await service.callback(
        request,
        headers.get("x-request-id")!,
      );
      headers.append("set-cookie", result.sessionCookie);
      headers.append("set-cookie", result.bindingCookie);
      headers.set("location", service.sessions.options.origin + "/");
      return new Response(null, { status: 303, headers });
    }
    throw err("NOT_FOUND", 404);
  } catch (error) {
    const known = error instanceof SessionError;
    return Response.json(
      {
        error: {
          code: known
            ? error.code
            : error instanceof z.ZodError
              ? "WECHAT_CALLBACK_INVALID"
              : "WECHAT_LOGIN_UNAVAILABLE",
        },
      },
      {
        status: known ? error.status : error instanceof z.ZodError ? 400 : 503,
        headers,
      },
    );
  }
}

export function wechatOpenApiPaths() {
  const errors = Object.fromEntries(
    [400, 401, 403, 408, 409, 429, 502, 503].map((status) => [
      status,
      { description: "Stable authentication error; no provider data" },
    ]),
  );
  const startSchema = z.toJSONSchema(
    z.object({ data: z.object({ authorizationUrl: z.url() }) }),
  );
  return {
    "/api/auth/wechat/start": {
      post: {
        summary:
          "Start WeChat website login for current guest; no request body",
        parameters: [
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
        ],
        responses: {
          200: {
            description: "Authorization URL and short-lived binding Cookie",
            content: { "application/json": { schema: startSchema } },
          },
          ...errors,
        },
      },
    },
    "/api/auth/wechat/callback": {
      get: {
        summary:
          "Consume bound state, rotate credentials and claim guest history",
        parameters: [
          {
            in: "query",
            name: "state",
            required: true,
            schema: { type: "string" },
          },
          { in: "query", name: "code", schema: { type: "string" } },
        ],
        responses: {
          303: {
            description:
              "New session Cookie and fixed same-origin clean redirect",
          },
          ...errors,
        },
      },
    },
  };
}
