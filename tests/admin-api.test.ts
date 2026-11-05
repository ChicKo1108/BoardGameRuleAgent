import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { handleAdmin, openApiDocument } from "../packages/backend/src/index.js";
import { testDatabase } from "./helpers/database.js";
const token = "test-only-" + "x".repeat(40);
let fixture: Awaited<ReturnType<typeof testDatabase>>;
before(async () => {
  fixture = await testDatabase();
  await fixture.db.runMigrations();
});
after(async () => {
  if (fixture) await fixture.close();
});
async function call(
  method: string,
  path: string,
  data?: unknown,
  auth: string | undefined = `Bearer ${token}`,
) {
  const headers: Record<string, string> = {};
  if (auth) headers.authorization = auth;
  if (data !== undefined) headers["content-type"] = "application/json";
  return handleAdmin(
    new Request(`http://localhost/api/admin${path}`, {
      method,
      headers,
      ...(data !== undefined ? { body: JSON.stringify(data) } : {}),
    }),
    { getDb: async () => fixture.db, adminToken: () => token },
  );
}
async function ok(method: string, path: string, data?: unknown) {
  const res = await call(method, path, data);
  const json = JSON.parse(await res.text());
  assert.ok(res.ok, JSON.stringify(json));
  return json.data;
}
async function setup() {
  const game = await ok("POST", "/games", {
    slug: `api-${randomUUID()}`,
    name: "合成测试",
  });
  const ruleset = await ok("POST", "/rulesets", {
    gameId: game.id,
    name: "基础",
    language: "zh-CN",
    scope: "仅测试",
  });
  const doc = await ok("POST", "/documents", {
    rulesetId: ruleset.id,
    title: "测试文档",
    sourceType: "rulebook",
    sha256: "b".repeat(64),
  });
  const rev = await ok("POST", `/documents/${doc.id}/revisions`, {});
  return { game, ruleset, doc, rev };
}
test("auth and malformed input fail before touching the database", async () => {
  let touched = false;
  const getDb = async () => {
    touched = true;
    return fixture.db;
  };
  const req = (authorization: string) =>
    new Request("http://local/api/admin/games", {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: '{"slug":"invalid/slug","name":"x"}',
    });
  assert.equal(
    (await handleAdmin(req("wrong"), { getDb, adminToken: () => token }))
      .status,
    401,
  );
  assert.equal(
    (
      await handleAdmin(req(`Bearer ${token}`), {
        getDb,
        adminToken: () => undefined,
      })
    ).status,
    503,
  );
  assert.equal(
    (
      await handleAdmin(req(`Bearer ${token}`), {
        getDb,
        adminToken: () => token,
      })
    ).status,
    400,
  );
  assert.equal(touched, false);
});
test("structured import, edits, source lookup, review and audit form one workflow", async () => {
  const { rev } = await setup();
  const blocks = await ok("POST", `/revisions/${rev.id}/blocks`, {
    blocks: [
      {
        ordinal: 0,
        kind: "text",
        rawText: "仅为测试：每次取一枚。",
        pdfPageIndex: 0,
      },
    ],
  });
  const rule = await ok("POST", `/revisions/${rev.id}/rules`, {
    kind: "rule",
    reviewedText: "仅为测试规则",
    sourceBlockIds: [blocks[0].id],
  });
  assert.equal(
    (await call("POST", `/revisions/${rev.id}/approve`, {})).status,
    409,
  );
  await ok("PATCH", `/rules/${rule.id}`, { reviewStatus: "approved" });
  const sources = await ok("GET", `/rules/${rule.id}/sources`);
  assert.equal(sources[0].pdfPageIndex, 0);
  const approved = await ok("POST", `/revisions/${rev.id}/approve`, {});
  assert.equal(approved.status, "approved");
  const edit = await call("PATCH", `/rules/${rule.id}`, {
    reviewedText: "不能修改",
  });
  assert.equal(edit.status, 409);
  const events = await fixture.db.query(
    "SELECT action FROM admin_audit_events WHERE target_id=$1 ORDER BY created_at",
    [rule.id],
  );
  assert.deepEqual(
    events.map((e: { action: string }) => e.action),
    ["rule.create", "rule.edit"],
  );
});
test("invalid cross-revision sources roll back edits and do not append audit", async () => {
  const a = await setup();
  const b = await setup();
  const block = async (id: string) =>
    (
      await ok("POST", `/revisions/${id}/blocks`, {
        blocks: [
          { ordinal: 0, kind: "text", rawText: "测试", pdfPageIndex: 0 },
        ],
      })
    )[0];
  const ab = await block(a.rev.id);
  const bb = await block(b.rev.id);
  const rule = await ok("POST", `/revisions/${a.rev.id}/rules`, {
    kind: "rule",
    reviewedText: "旧内容",
    sourceBlockIds: [ab.id],
  });
  assert.equal(
    (
      await call("PATCH", `/rules/${rule.id}`, {
        reviewedText: "新内容",
        sourceBlockIds: [bb.id],
      })
    ).status,
    422,
  );
  const rules = await ok("GET", `/revisions/${a.rev.id}/rules`);
  assert.equal(rules.items[0].reviewedText, "旧内容");
  const sources = await ok("GET", `/rules/${rule.id}/sources`);
  assert.equal(sources[0].id, ab.id);
  assert.equal(
    (
      await fixture.db.query(
        "SELECT count(*)::int AS n FROM admin_audit_events WHERE target_id=$1",
        [rule.id],
      )
    )[0].n,
    1,
  );
});
test("pagination, duplicate data and unexpected fields have explicit errors", async () => {
  const { game } = await setup();
  assert.equal(
    (await call("POST", "/games", { slug: game.slug, name: "重复" })).status,
    409,
  );
  assert.equal(
    (await call("POST", "/games", { slug: "x", name: "x", isAdmin: true }))
      .status,
    400,
  );
  assert.equal((await call("GET", "/games?limit=1000")).status, 400);
  const page = await ok("GET", "/games?limit=1&offset=0");
  assert.equal(page.items.length, 1);
  assert.ok(page.total > 0);
  assert.equal((await call("GET", `/revisions/${randomUUID()}`)).status, 404);
});
test("body cap is enforced without content-length; internal failures are sanitized", async () => {
  const tooBig = new Request("http://local/api/admin/games", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ name: "x".repeat(1024 * 1024), slug: "test" }),
  });
  assert.equal(
    (
      await handleAdmin(tooBig, {
        getDb: async () => fixture.db,
        adminToken: () => token,
      })
    ).status,
    413,
  );
  const res = await handleAdmin(
    new Request("http://local/api/admin/games", {
      headers: { authorization: `Bearer ${token}` },
    }),
    {
      getDb: async () => {
        throw new Error("postgres://secret");
      },
      adminToken: () => token,
    },
  );
  assert.equal(res.status, 500);
  assert.ok(!(await res.text()).includes("secret"));
});
test("OpenAPI matches implemented operations and is authenticated", async () => {
  const doc = openApiDocument();
  assert.equal(doc.openapi, "3.1.0");
  assert.ok(doc.paths["/api/admin/revisions/{id}/approve"].post);
  assert.equal((await call("GET", "/openapi", undefined, "wrong")).status, 401);
  const res = await call("GET", "/openapi");
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(await res.text()).openapi, "3.1.0");
});
