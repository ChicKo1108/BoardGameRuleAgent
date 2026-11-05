import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { testDatabase } from "./helpers/database.js";
import {
  SessionService,
  SessionError,
  handleSession,
} from "../packages/backend/src/index.ts";
let fixture: Awaited<ReturnType<typeof testDatabase>>, service: SessionService;
const config = {
  origin: "https://game.example",
  guestDailyQuestions: 2,
  globalDailyQuestions: 3,
  mintsPerMinute: 1000,
};
const digest = (v: string) => createHash("sha256").update(v).digest("hex");
const input = () => ({
  id: randomUUID(),
  requestHash: digest("synthetic question"),
});
const token = (cookie: string) => cookie.split(";")[0].split("=")[1];
before(async () => {
  fixture = await testDatabase();
  await fixture.db.runMigrations();
  service = new SessionService(fixture.db, config);
});
after(async () => {
  if (fixture) await fixture.close();
});
test("opaque guest credentials are hashed, reused without renewal and revoked without revealing identity", async () => {
  const created = await service.initialize(null),
    secret = token(created.cookie!);
  assert.equal(secret.length, 43);
  assert.match(
    created.cookie!,
    /__Host-boardgame_session=.*; Path=\/; HttpOnly; SameSite=Strict; Max-Age=2592000; Secure/,
  );
  const [row] = await fixture.db.query(
    "SELECT * FROM browser_sessions WHERE token_hash=$1",
    [digest(secret)],
  );
  assert.ok(row);
  assert.ok(!JSON.stringify(row).includes(secret));
  assert.equal("principalId" in created.session, false);
  assert.deepEqual(await service.initialize(secret), {
    session: created.session,
    cookie: null,
  });
  await assert.rejects(service.current("guessed"), /SESSION_REQUIRED/);
  await assert.rejects(service.current("A".repeat(43)), /SESSION_INVALID/);
  await service.revoke(secret);
  await service.revoke(secret);
  await assert.rejects(service.current(secret), /SESSION_INVALID/);
  await assert.rejects(
    fixture.db.query(
      "UPDATE browser_sessions SET revoked_at=NULL WHERE id=$1",
      [row.id],
    ),
    /terminal/,
  );
});
test("expired credentials cannot authenticate or reserve quota", async () => {
  const secret = "B".repeat(43);
  const [p] = await fixture.db.query(
    "INSERT INTO public_principals DEFAULT VALUES RETURNING id",
  );
  await fixture.db.query(
    "INSERT INTO browser_sessions(principal_id,token_hash,created_at,expires_at) VALUES($1,$2,clock_timestamp()-interval '2 days',clock_timestamp()-interval '1 day')",
    [p.id, digest(secret)],
  );
  await assert.rejects(service.reserve(secret, input()), /SESSION_INVALID/);
});
test("concurrent replicas share quota; retries cannot spend twice or steal another principal's key", async () => {
  const local = new SessionService(fixture.db, {
    ...config,
    globalDailyQuestions: 100,
  });
  const secret = token((await local.initialize(null)).cookie!);
  const second = new SessionService(fixture.db, {
    ...config,
    globalDailyQuestions: 100,
  });
  const req = input();
  const same = await Promise.all([
    local.reserve(secret, req),
    second.reserve(secret, req),
  ]);
  assert.equal(same[0].id, same[1].id);
  assert.equal((await local.current(secret)).quota.used, 1);
  const requests = await Promise.allSettled(
    Array.from({ length: 5 }, () => second.reserve(secret, input())),
  );
  assert.equal(requests.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal((await local.current(secret)).quota.remaining, 0);
  await assert.rejects(
    local.reserve(secret, { ...req, requestHash: digest("different") }),
    /IDEMPOTENCY_CONFLICT/,
  );
  const other = token((await local.initialize(null)).cookie!);
  await assert.rejects(local.reserve(other, req), /ALLOWANCE_NOT_FOUND/);
});
test("global daily budget blocks a second guest, while only pre-dispatch releases restore allowance", async () => {
  const local = new SessionService(fixture.db, {
    ...config,
    guestDailyQuestions: 100,
    globalDailyQuestions: 1,
  });
  // Earlier test leases count globally; use an isolated database day table state by releasing their reserved rows.
  for (const r of await fixture.db.query(
    "SELECT id FROM question_allowances WHERE state='reserved'",
  ))
    await local.transition(r.id, "released");
  const first = token((await local.initialize(null)).cookie!),
    second = token((await local.initialize(null)).cookie!),
    req = input();
  await local.reserve(first, req);
  await assert.rejects(local.reserve(second, input()), /QUOTA_EXHAUSTED/);
  await local.transition(req.id, "released");
  assert.equal((await local.reserve(first, req)).state, "released");
  const dispatched = await local.reserve(second, input());
  await local.transition(dispatched.id, "dispatched");
  await local.transition(dispatched.id, "dispatched");
  await assert.rejects(
    local.transition(dispatched.id, "released"),
    /TRANSITION_INVALID/,
  );
  await local.transition(dispatched.id, "settled");
  await assert.rejects(local.reserve(first, input()), /QUOTA_EXHAUSTED/);
  await assert.rejects(
    fixture.db.query(
      "UPDATE question_allowances SET state='released' WHERE id=$1",
      [dispatched.id],
    ),
    /transition invalid/,
  );
  const [day] = await fixture.db.query(
    "SELECT timezone('Asia/Shanghai',clock_timestamp())::date::text AS day",
  );
  assert.equal((await local.current(first)).quota.day, day.day);
});
test("expired reservations free capacity but never dispatch; retention does not alter charged state", async () => {
  const local = new SessionService(fixture.db, {
      ...config,
      globalDailyQuestions: 100,
    }),
    secret = token((await local.initialize(null)).cookie!);
  const [actor] = await fixture.db.query(
      "SELECT principal_id FROM browser_sessions WHERE token_hash=$1",
      [digest(secret)],
    ),
    id = randomUUID();
  await fixture.db.query(
    "INSERT INTO question_allowances(id,principal_id,request_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()-interval '1 second')",
    [id, actor.principal_id, digest("expired")],
  );
  assert.equal((await local.current(secret)).quota.used, 0);
  await assert.rejects(local.transition(id, "dispatched"), /ALLOWANCE_EXPIRED/);
  await local.reserve(secret, input());
  await assert.rejects(
    fixture.db.query(
      "UPDATE question_allowances SET request_hash=$2 WHERE id=$1",
      [id, digest("changed")],
    ),
    /immutable/,
  );
});
test("HTTP rejects cross-origin mutations, identity payloads and duplicate cookies; logout clears credential", async () => {
  const deps = async () => service;
  const call = (
    method: string,
    headers: Record<string, string> = {},
    body?: string,
  ) =>
    handleSession(
      new Request("https://game.example/api/session", {
        method,
        headers,
        ...(body ? { body } : {}),
      }),
      deps,
    );
  assert.equal((await call("POST")).status, 403);
  assert.equal(
    (
      await call("POST", {
        origin: "https://attacker.example",
        "x-boardgame-request": "1",
      })
    ).status,
    403,
  );
  const headers = { origin: config.origin, "x-boardgame-request": "1" };
  assert.equal(
    (await call("POST", headers, JSON.stringify({ principalId: randomUUID() })))
      .status,
    400,
  );
  const created = await call("POST", headers);
  assert.equal(created.status, 200);
  const cookie = created.headers.get("set-cookie")!.split(";")[0];
  assert.equal(created.headers.get("cache-control"), "no-store");
  assert.ok(!(await created.text()).includes(cookie.split("=")[1]));
  assert.equal((await call("GET", { cookie })).status, 200);
  assert.equal(
    (await call("GET", { cookie: `${cookie}; ${cookie}` })).status,
    401,
  );
  assert.equal(
    (await call("GET", { cookie, "sec-fetch-site": "cross-site" })).status,
    403,
  );
  const logout = await call("DELETE", { ...headers, cookie });
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get("set-cookie")!, /Max-Age=0/);
  assert.equal((await call("GET", { cookie })).status, 401);
});
test("mint limits and public configuration fail closed", async () => {
  const local = new SessionService(fixture.db, {
    ...config,
    mintsPerMinute: 1,
  });
  await assert.rejects(local.initialize(null), /MINT_LIMIT/);
  assert.throws(
    () => new SessionService(fixture.db, { origin: "http://game.example" }),
    /HTTPS/,
  );
  assert.throws(
    () =>
      new SessionService(fixture.db, { origin: "https://game.example/path" }),
    /exact/,
  );
  const disabled = new SessionService(fixture.db, { origin: config.origin }),
    secret = token((await disabled.initialize(null)).cookie!);
  await assert.rejects(disabled.reserve(secret, input()), /QUOTA_EXHAUSTED/);
  const localCookie = new SessionService(fixture.db, {
    origin: "http://127.0.0.1:3000",
  });
  assert.equal(localCookie.cookieName, "boardgame_local_session");
  assert.ok(!localCookie.cookie("x").includes("Secure"));
});
