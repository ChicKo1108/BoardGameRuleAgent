import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { testDatabase } from "./helpers/database.js";
import { chatServer } from "./helpers/chat.js";
import { embeddingServer } from "./helpers/embedding.js";
import {
  publicationCases,
  publicationReply,
  publicationPolicy,
  passingReview,
} from "./helpers/publication.js";
import { KnowledgeRepository } from "../packages/db/src/index.ts";
import { KnowledgeIndexService } from "../packages/retrieval/src/index.ts";
import { CompatibleChatProvider } from "../packages/agent/src/index.ts";
import {
  PublicationService,
  SessionService,
  ConversationService,
  handleConversations,
  WechatProvider,
  WechatLoginService,
  handleWechat,
  AnswerEvaluationService,
  AnswerService,
  EvaluationService,
  VectorService,
  connectQueue,
  handleAdmin,
  openApiDocument,
} from "../packages/backend/src/index.ts";
import {
  answeringSchemas as a,
  type EvalCase,
} from "../packages/contracts/src/index.ts";
let fixture: Awaited<ReturnType<typeof testDatabase>>,
  queue: Awaited<ReturnType<typeof connectQueue>>,
  chat: Awaited<ReturnType<typeof chatServer>>,
  repo: KnowledgeRepository,
  knowledge: KnowledgeIndexService,
  vectors: VectorService,
  answers: AnswerService,
  answerEvals: AnswerEvaluationService,
  retrievalEvals: EvaluationService,
  service: PublicationService;
const previousRevision = process.env.APP_REVISION;
before(async () => {
  process.env.APP_REVISION = "0".repeat(40);
  fixture = await testDatabase();
  await fixture.db.runMigrations();
  queue = await connectQueue((fixture.db.options as { url: string }).url, true);
  chat = await chatServer((body) =>
    JSON.stringify(body).includes("force-failure")
      ? { status: 503 }
      : publicationReply(body),
  );
  repo = new KnowledgeRepository(fixture.db);
  knowledge = new KnowledgeIndexService(fixture.db);
  vectors = new VectorService(fixture.db, queue);
  answers = new AnswerService(fixture.db, vectors, chat.provider);
  answerEvals = new AnswerEvaluationService(fixture.db, queue, answers);
  retrievalEvals = new EvaluationService(fixture.db, queue, vectors);
  service = new PublicationService(fixture.db, answers);
});
after(async () => {
  if (previousRevision === undefined) delete process.env.APP_REVISION;
  else process.env.APP_REVISION = previousRevision;
  if (queue) await queue.stop();
  if (chat) await chat.close();
  if (fixture) await fixture.close();
});
async function seed(count = 3) {
  const game = await repo.createGame({
    slug: `vector-${randomUUID()}`,
    name: "合成向量测试，非规则答案",
  });
  const ruleset = await repo.createRuleset({
    gameId: game.id,
    name: "基础",
    language: "zh-CN",
    scope: "synthetic",
  });
  const hash = createHash("sha256").update(randomUUID()).digest("hex");
  const doc = await repo.createDocument({
    rulesetId: ruleset.id,
    title: "测试",
    sourceType: "rulebook",
    objectKey: `documents/${hash}.pdf`,
    sha256: hash,
  });
  const rev = await repo.createRevision(doc.id);
  const texts = Array.from(
    { length: count },
    (_, i) =>
      ["工厂拿取花砖", "地板花砖扣分", "回合结束检查"][i % 3] + `合成规则${i}`,
  );
  const blocks = await repo.saveParsedBlocks(
    rev.id,
    texts.map((rawText, ordinal) => ({
      rawText,
      ordinal,
      kind: "text" as const,
      pdfPageIndex: ordinal,
      printedPageLabel: null,
      bbox: null,
    })),
  );
  const rules = [];
  for (let i = 0; i < count; i++)
    rules.push(
      await repo.addRule(
        {
          revisionId: rev.id,
          kind: "rule",
          reviewedText: texts[i],
          sectionPath: [],
          applicability: [],
          explanation: null,
          reviewStatus: "approved",
        },
        [blocks[i].id],
      ),
    );
  await repo.approveRevision(rev.id);
  const release = await knowledge.createRelease(
    ruleset.id,
    { name: "test", revisionIds: [rev.id] },
    randomUUID(),
  );
  const build = await knowledge.build(release.id, randomUUID());
  return { release, build, rules };
}

async function nextSnapshot(source: Awaited<ReturnType<typeof seed>>) {
  const hash = createHash("sha256").update(randomUUID()).digest("hex");
  const doc = await repo.createDocument({
    rulesetId: source.release.rulesetId,
    title: "Synthetic revised source",
    sourceType: "rulebook",
    objectKey: `documents/${hash}.pdf`,
    sha256: hash,
  });
  const revision = await repo.createRevision(doc.id);
  const [block] = await repo.saveParsedBlocks(revision.id, [
    {
      ordinal: 0,
      kind: "text",
      rawText: "工厂拿取花砖合成新修订",
      pdfPageIndex: 0,
      printedPageLabel: null,
      bbox: null,
    },
  ]);
  const rule = await repo.addRule(
    {
      revisionId: revision.id,
      kind: "rule",
      reviewedText: block.rawText,
      sectionPath: [],
      applicability: [],
      explanation: null,
      reviewStatus: "approved",
    },
    [block.id],
  );
  await repo.approveRevision(revision.id);
  const release = await knowledge.createRelease(
    source.release.rulesetId,
    { name: "Synthetic next snapshot", revisionIds: [revision.id] },
    randomUUID(),
  );
  return {
    release,
    build: await knowledge.build(release.id, randomUUID()),
    rules: [rule],
  };
}
async function setup(
  existing?: Awaited<ReturnType<typeof seed>>,
  transform?: (cases: EvalCase[]) => EvalCase[],
  threshold = 1,
) {
  const source = existing ?? (await seed());
  let cases = publicationCases(source.rules[0].id);
  if (transform) cases = transform(cases);
  const dataset = await retrievalEvals.createDataset(
    source.release.id,
    { name: "synthetic-publication", revision: randomUUID(), cases },
    randomUUID(),
  );
  const head = await service.head(source.release.rulesetId),
    policy = await service.createPolicy(
      source.release.rulesetId,
      {
        idempotencyKey: randomUUID(),
        datasetId: dataset.id,
        expectedRevision: head.revision,
        config: { ...publicationPolicy, minCorrectRate: threshold },
        note: "Synthetic test policy",
      },
      randomUUID(),
    );
  return { ...source, dataset, policy };
}
async function evaluate(
  s: Awaited<ReturnType<typeof setup>>,
  badCase?: string,
  split = "holdout",
  limit = 6,
) {
  const retrieval = a.retrievalConfig.parse({
    indexBuildId: s.build.id,
    mode: "lexical",
    limit,
  });
  const { maxRules, maxChars, ...search } = retrieval;
  const er = await retrievalEvals.enqueue(
    s.dataset.id,
    {
      idempotencyKey: randomUUID(),
      config: { ...search, split, context: { maxRules, maxChars } },
    },
    randomUUID(),
  );
  await retrievalEvals.workOnce();
  const ar = await answerEvals.enqueue(
    s.dataset.id,
    { idempotencyKey: randomUUID(), config: { split, retrieval } },
    randomUUID(),
  );
  await answerEvals.workOnce();
  const cases = await answerEvals.cases(ar.evaluationId);
  for (const c of cases.items)
    await answerEvals.review(
      c.id,
      {
        expectedRevision: 0,
        review: { ...passingReview, conclusionCorrect: c.caseId !== badCase },
      },
      randomUUID(),
    );
  const sealed = await answerEvals.seal(
    ar.evaluationId,
    { note: "Synthetic report" },
    randomUUID(),
  );
  assert.equal(sealed.summary.runtimeFailures, 0);
  return { answerEvaluationId: ar.evaluationId, retrievalRunId: er.runId };
}
async function assess(s: Awaited<ReturnType<typeof setup>>, badCase?: string) {
  const ids = await evaluate(s, badCase);
  return service.assess(
    { idempotencyKey: randomUUID(), policyId: s.policy.id, ...ids },
    randomUUID(),
  );
}
async function move(
  scope: string,
  id: string | null,
  action: "publish" | "rollback" | "deactivate" = "publish",
  revision?: number,
) {
  return service.transition(
    scope,
    {
      idempotencyKey: randomUUID(),
      expectedRevision: revision ?? (await service.head(scope)).revision,
      action,
      publicationId: id,
      note: "Synthetic transition",
    },
    randomUUID(),
  );
}

async function start() {
  const s = await setup(),
    published = await assess(s);
  assert.equal(published.passed, true);
  await move(s.release.rulesetId, published.id);
  const sessions = new SessionService(fixture.db, {
    origin: "https://public.example",
    guestDailyQuestions: 5,
    memberDailyQuestions: 10,
    globalDailyQuestions: 1000,
    mintsPerMinute: 1000,
  });
  const minted = await sessions.initialize(null),
    token = minted.cookie!.split(";")[0].split("=")[1];
  const conversations = new ConversationService(
    fixture.db,
    sessions,
    service,
    async () => answers,
  );
  return { s, published, sessions, token, conversations };
}
const newConversation = (state: Awaited<ReturnType<typeof start>>) =>
  state.conversations.create(state.token, {
    idempotencyKey: randomUUID(),
    rulesetId: state.s.release.rulesetId,
  });
const ask = (revision = 0, question = "工厂花砖怎么拿？") => ({
  idempotencyKey: randomUUID(),
  expectedRevision: revision,
  question,
});

function providerFixture(
  appId = "wx_" + randomUUID().replaceAll("-", ""),
  subject = "member-A",
) {
  const requests: Array<{ url: URL; init: RequestInit | undefined }> = [];
  const transport: typeof fetch = async (input, init) => {
    requests.push({ url: new URL(String(input)), init });
    return Response.json({
      openid: subject,
      access_token: "synthetic-private-access-token",
      refresh_token: "synthetic-private-refresh-token",
      expires_in: 7200,
      scope: "snsapi_login",
      unionid: "ignored-sensitive-unionid",
    });
  };
  const provider = new WechatProvider(
    appId,
    "synthetic-private-app-secret",
    transport,
  );
  return { provider, requests };
}
async function begin(
  x: Awaited<ReturnType<typeof start>>,
  provider: WechatProvider,
  token = x.token,
) {
  const login = new WechatLoginService(fixture.db, x.sessions, provider, 1000),
    started = await login.start(token, randomUUID()),
    url = new URL(started.authorizationUrl),
    state = url.searchParams.get("state")!,
    binding = started.cookie.split(";")[0];
  const callback = (code = randomUUID()) =>
    new Request(
      x.sessions.options.origin +
        "/api/auth/wechat/callback?" +
        new URLSearchParams({ code, state }),
      { headers: { cookie: binding, "sec-fetch-site": "cross-site" } },
    );
  return { login, started, state, binding, callback };
}
const credential = (cookie: string) => cookie.split(";")[0].split("=")[1];
test("WeChat code exchange is fixed-host and never persists provider credentials", async () => {
  const x = await start(),
    p = providerFixture(),
    flow = await begin(x, p.provider);
  assert.match(flow.started.cookie, /SameSite=Lax/);
  const authorize = new URL(flow.started.authorizationUrl);
  assert.equal(authorize.hostname, "open.weixin.qq.com");
  assert.equal(authorize.searchParams.get("scope"), "snsapi_login");
  assert.equal(
    authorize.searchParams.get("redirect_uri"),
    flow.login.redirectUri,
  );
  const result = await flow.login.callback(flow.callback(), randomUUID());
  assert.notEqual(credential(result.sessionCookie), x.token);
  assert.match(result.sessionCookie, /SameSite=Strict/);
  assert.equal(p.requests.length, 1);
  assert.equal(p.requests[0].url.origin, "https://api.weixin.qq.com");
  assert.equal(p.requests[0].url.pathname, "/sns/oauth2/access_token");
  assert.equal(
    p.requests[0].url.searchParams.get("grant_type"),
    "authorization_code",
  );
  assert.equal(p.requests[0].init!.redirect, "error");
  assert.equal(
    JSON.stringify(p.provider).includes("synthetic-private-app-secret"),
    false,
  );
  await assert.rejects(x.sessions.current(x.token), /SESSION_INVALID/);
  assert.equal(
    (await x.sessions.current(credential(result.sessionCookie))).kind,
    "member",
  );
  const attempts = await fixture.db.query(
      "SELECT * FROM wechat_login_attempts",
    ),
    identities = await fixture.db.query("SELECT * FROM wechat_identities");
  const stored = JSON.stringify({ attempts, identities });
  for (const forbidden of [
    "synthetic-private",
    "member-A",
    "ignored-sensitive-unionid",
    flow.state,
    flow.binding.split("=")[1],
  ])
    assert.ok(!stored.includes(forbidden));
});
test("login claims real guest conversations and usage without rewriting immutable history", async () => {
  const x = await start(),
    c = await newConversation(x),
    question = ask();
  await x.conversations.send(x.token, c.id, question, randomUUID());
  const [original] = await fixture.db.query(
    "SELECT principal_id FROM public_conversations WHERE id=$1",
    [c.id],
  );
  const p = providerFixture(),
    flow = await begin(x, p.provider),
    result = await flow.login.callback(flow.callback(), randomUUID()),
    member = credential(result.sessionCookie);
  assert.equal((await x.sessions.current(member)).quota.used, 1);
  assert.equal((await x.sessions.current(member)).quota.limit, 10);
  assert.equal((await x.conversations.messages(member, c.id)).total, 1);
  const answer = await x.conversations.send(member, c.id, ask(1), randomUUID());
  assert.equal(answer.state, "completed", JSON.stringify(answer));
  assert.equal((await x.sessions.current(member)).quota.used, 2);
  assert.equal(
    (
      await fixture.db.query(
        "SELECT principal_id FROM public_conversations WHERE id=$1",
        [c.id],
      )
    )[0].principal_id,
    original.principal_id,
  );
  await assert.rejects(
    fixture.db.query(
      "UPDATE guest_account_claims SET account_principal_id=guest_principal_id WHERE guest_principal_id=$1",
      [original.principal_id],
    ),
    /immutable/,
  );
  await x.sessions.revoke(member);
  const anotherGuest = credential((await x.sessions.initialize(null)).cookie!);
  await assert.rejects(
    x.conversations.messages(anotherGuest, c.id),
    /NOT_FOUND/,
  );
  const relog = await begin(x, p.provider, anotherGuest),
    again = credential(
      (await relog.login.callback(relog.callback(), randomUUID()))
        .sessionCookie,
    );
  assert.equal((await x.conversations.messages(again, c.id)).total, 2);
  assert.equal((await x.sessions.current(again)).quota.used, 2);
  const differentGuest = credential(
      (await x.sessions.initialize(null)).cookie!,
    ),
    otherProvider = providerFixture(p.provider.appId, "member-B"),
    otherFlow = await begin(x, otherProvider.provider, differentGuest),
    other = credential(
      (await otherFlow.login.callback(otherFlow.callback(), randomUUID()))
        .sessionCookie,
    );
  await assert.rejects(x.conversations.messages(other, c.id), /NOT_FOUND/);
});
test("binding mismatch, expired state and callback replay fail before provider exchange", async () => {
  const x = await start(),
    p = providerFixture(),
    flow = await begin(x, p.provider);
  const wrong = new Request(flow.callback().url, {
    headers: { cookie: flow.login.bindingCookieName + "=" + "a".repeat(43) },
  });
  await assert.rejects(
    flow.login.callback(wrong, randomUUID()),
    /STATE_INVALID/,
  );
  assert.equal(p.requests.length, 0);
  const result = await Promise.allSettled([
    flow.login.callback(flow.callback(), randomUUID()),
    flow.login.callback(flow.callback(), randomUUID()),
  ]);
  assert.equal(result.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(p.requests.length, 1);
  const fresh = credential((await x.sessions.initialize(null)).cookie!),
    expired = await begin(x, p.provider, fresh);
  // Insert a deliberately expired independent attempt; identity columns cannot be changed in-place.
  const expiredState = "e".repeat(43),
    expiredBinding = "b".repeat(43),
    actor = await x.sessions.authenticate(fresh);
  await fixture.db.query(
    "INSERT INTO wechat_login_attempts(session_id,app_id,redirect_uri,state_hash,binding_hash,expires_at) VALUES($1,$2,$3,$4,$5,clock_timestamp()-interval '1 second')",
    [
      actor.id,
      p.provider.appId,
      expired.login.redirectUri,
      createHash("sha256").update(expiredState).digest("hex"),
      createHash("sha256").update(expiredBinding).digest("hex"),
    ],
  );
  await assert.rejects(
    expired.login.callback(
      new Request(
        expired.login.redirectUri +
          "?state=" +
          expiredState +
          "&code=" +
          randomUUID(),
        {
          headers: {
            cookie: expired.login.bindingCookieName + "=" + expiredBinding,
          },
        },
      ),
      randomUUID(),
    ),
    /STATE_EXPIRED/,
  );
  assert.equal(p.requests.length, 1);
});
test("logout or session change during exchange cannot attach history to a new account", async () => {
  const x = await start();
  let ready!: () => void, release!: () => void;
  const entered = new Promise<void>((r) => (ready = r)),
    waiting = new Promise<void>((r) => (release = r));
  const p = new WechatProvider(
    "wx_" + randomUUID().replaceAll("-", ""),
    "synthetic-secret-value",
    async () => {
      ready();
      await waiting;
      return Response.json({
        openid: "member",
        access_token: "access",
        expires_in: 7200,
        scope: "snsapi_login",
      });
    },
  );
  const flow = await begin(x, p),
    result = flow.login.callback(flow.callback(), randomUUID()),
    rejected = assert.rejects(result, /SESSION_CHANGED/);
  await entered;
  await x.sessions.revoke(x.token);
  release();
  await rejected;
  const [{ count }] = await fixture.db.query(
    "SELECT count(*)::int AS count FROM wechat_identities WHERE app_id=$1",
    [p.appId],
  );
  assert.equal(count, 0);
});
test("provider failures and denied authorization consume their flow without persisting raw errors", async () => {
  const x = await start(),
    p = new WechatProvider(
      "wx_" + randomUUID().replaceAll("-", ""),
      "synthetic-secret-value",
      async () =>
        Response.json({
          errcode: 40029,
          errmsg: "sensitive-provider-error-body",
        }),
    ),
    flow = await begin(x, p);
  await assert.rejects(
    flow.login.callback(flow.callback(), randomUUID()),
    /PROVIDER_UNAVAILABLE/,
  );
  await assert.rejects(
    flow.login.callback(flow.callback(), randomUUID()),
    /STATE_CONSUMED/,
  );
  assert.equal((await x.sessions.current(x.token)).kind, "guest");
  const deny = await begin(x, p);
  await assert.rejects(
    deny.login.callback(
      new Request(deny.login.redirectUri + "?state=" + deny.state, {
        headers: { cookie: deny.binding },
      }),
      randomUUID(),
    ),
    /AUTH_DENIED/,
  );
  const rows = await fixture.db.query(
    "SELECT error_code FROM wechat_login_attempts",
  );
  assert.ok(!JSON.stringify(rows).includes("sensitive-provider-error-body"));
});
test("malformed, oversized and redirected provider responses cannot create identities", async () => {
  for (const transport of [
    async () =>
      Response.json({
        openid: "user",
        access_token: "token",
        expires_in: 7200,
        scope: "snsapi_base",
      }),
    async () => new Response("x".repeat(65537)),
    async () => {
      throw new Error("redirect URL contains secret");
    },
  ]) {
    const p = new WechatProvider(
      "wx_test",
      "synthetic-secret-value",
      transport,
    );
    await assert.rejects(p.exchange(randomUUID()), /PROVIDER_UNAVAILABLE/);
  }
});
test("login transaction rolls back identity, claim and revocation if audit persistence fails", async () => {
  const x = await start(),
    p = providerFixture(),
    flow = await begin(x, p.provider);
  await fixture.db.query(
    "CREATE FUNCTION fail_login_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='auth.wechat.login' THEN RAISE EXCEPTION 'synthetic login audit failure';END IF;RETURN NEW;END $$;CREATE TRIGGER synthetic_login_audit BEFORE INSERT ON admin_audit_events FOR EACH ROW EXECUTE FUNCTION fail_login_audit()",
  );
  try {
    await assert.rejects(
      flow.login.callback(flow.callback(), randomUUID()),
      /LOGIN_FAILED/,
    );
    assert.equal((await x.sessions.current(x.token)).kind, "guest");
    const [{ count }] = await fixture.db.query(
      "SELECT count(*)::int AS count FROM wechat_identities WHERE app_id=$1",
      [p.provider.appId],
    );
    assert.equal(count, 0);
  } finally {
    await fixture.db.query(
      "DROP TRIGGER synthetic_login_audit ON admin_audit_events;DROP FUNCTION fail_login_audit()",
    );
  }
});
test("HTTP uses protected start and binding-only cross-site callback with clean redirect", async () => {
  const x = await start(),
    p = providerFixture(),
    login = new WechatLoginService(fixture.db, x.sessions, p.provider, 1000),
    get = async () => login;
  const startRequest = (origin = x.sessions.options.origin) =>
    new Request(origin + "/api/auth/wechat/start", {
      method: "POST",
      headers: {
        origin,
        "x-boardgame-request": "1",
        cookie: x.sessions.cookieName + "=" + x.token,
      },
    });
  assert.equal(
    (await handleWechat(startRequest("https://evil.example"), get)).status,
    403,
  );
  const beginResponse = await handleWechat(startRequest(), get);
  assert.equal(beginResponse.status, 200);
  const state = new URL(
    JSON.parse(await beginResponse.text()).data.authorizationUrl,
  ).searchParams.get("state")!;
  const binding = beginResponse.headers.get("set-cookie")!.split(";")[0];
  const callback = new Request(
      login.redirectUri + "?state=" + state + "&code=" + randomUUID(),
      { headers: { cookie: binding, "sec-fetch-site": "cross-site" } },
    ),
    response = await handleWechat(callback, get);
  assert.equal(response.status, 303, await response.clone().text());
  assert.equal(
    response.headers.get("location"),
    x.sessions.options.origin + "/",
  );
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.ok(!response.headers.get("location")!.includes(state));
  const memberCookie = response.headers
    .getSetCookie()
    .find((c) => c.startsWith(x.sessions.cookieName + "="))!;
  const member = credential(memberCookie);
  assert.equal((await x.sessions.current(member)).kind, "member");
  await assert.rejects(login.start(member, randomUUID()), /ALREADY_LOGGED_IN/);
});

test("concurrent devices for one verified identity create one account and two immutable guest claims", async () => {
  const x = await start(),
    p = providerFixture(),
    other = credential((await x.sessions.initialize(null)).cookie!),
    a = await begin(x, p.provider),
    b = await begin(x, p.provider, other);
  const results = await Promise.all([
    a.login.callback(a.callback(), randomUUID()),
    b.login.callback(b.callback(), randomUUID()),
  ]);
  const actors = await Promise.all(
    results.map((r) => x.sessions.authenticate(credential(r.sessionCookie))),
  );
  assert.equal(actors[0].principalId, actors[1].principalId);
  const [{ count }] = await fixture.db.query(
    "SELECT count(*)::int AS count FROM wechat_identities WHERE app_id=$1",
    [p.provider.appId],
  );
  assert.equal(count, 1);
  const [{ claims }] = await fixture.db.query(
    "SELECT count(*)::int AS claims FROM guest_account_claims WHERE account_principal_id=$1",
    [actors[0].principalId],
  );
  assert.equal(claims, 2);
});
