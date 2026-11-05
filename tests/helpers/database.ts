import EmbeddedPostgres from "embedded-postgres";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
import { createDataSource } from "../../packages/db/src/index.js";

export async function testDatabase() {
  const dir = await mkdtemp(join(tmpdir(), "boardgame-db-test-"));
  const socket = createServer();
  await new Promise<void>(resolve => socket.listen(0, "127.0.0.1", resolve));
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>(resolve => socket.close(() => resolve()));
  const password = randomBytes(24).toString("hex");
  const pg = new EmbeddedPostgres({ databaseDir: join(dir, "pg"), port, user: "postgres", password,
    persistent: true, authMethod: "scram-sha-256", postgresFlags: ["-h", "127.0.0.1"], onLog() {}, onError() {} });
  const db = createDataSource(`postgresql://postgres:${password}@127.0.0.1:${port}/postgres`);
  let started = false;
  try {
    await pg.initialise(); await pg.start(); started = true; await db.initialize();
    return { db, close: async () => {
      try { if (db.isInitialized) await db.destroy(); } finally { await pg.stop(); await rm(dir, { recursive: true, force: true }); }
    } };
  } catch (error) {
    if (db.isInitialized) await db.destroy();
    if (started) await pg.stop();
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}
