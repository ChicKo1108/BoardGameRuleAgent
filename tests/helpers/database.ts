import { mkdtemp, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { randomBytes, randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { createDataSource } from "../../packages/db/src/index.ts";
const exec = promisify(execFile);
/** Uses only an explicit local test administrator or an isolated native cluster; never DATABASE_URL. */
export async function testDatabase() {
  const shared = process.env.TEST_DATABASE_ADMIN_URL;
  if (shared) {
    const url = new URL(shared);
    if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
      throw new Error("Test database administrator must be loopback");
    const admin = createDataSource(shared);
    await admin.initialize();
    const name = `boardgame_test_${randomUUID().replaceAll("-", "")}`;
    let db: ReturnType<typeof createDataSource> | undefined;
    try {
      await admin.query(`CREATE DATABASE "${name}"`);
      url.pathname = `/${name}`;
      db = createDataSource(url.toString());
      await db.initialize();
      return {
        db,
        close: async () => {
          try {
            if (db?.isInitialized) await db.destroy();
            await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
          } finally {
            await admin.destroy();
          }
        },
      };
    } catch (error) {
      if (db?.isInitialized) await db.destroy();
      await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await admin.destroy();
      throw error;
    }
  }
  const bin =
    process.env.PG_TEST_BIN ??
    (process.platform === "darwin"
      ? process.arch === "arm64"
        ? "/opt/homebrew/opt/postgresql@18/bin"
        : "/usr/local/opt/postgresql@18/bin"
      : "");
  if (!bin)
    throw new Error(
      "Set PG_TEST_BIN to PostgreSQL 18 with pgvector, or TEST_DATABASE_ADMIN_URL to an isolated local test server",
    );
  await access(join(bin, "initdb"));
  const dir = await mkdtemp(join(tmpdir(), "boardgame-db-test-"));
  const password = randomBytes(24).toString("hex");
  const pwfile = join(dir, "password");
  await writeFile(pwfile, password, { mode: 0o600 });
  const socket = createServer();
  await new Promise<void>((r) => socket.listen(0, "127.0.0.1", r));
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>((r) => socket.close(() => r()));
  const db = createDataSource(
    `postgresql://postgres:${password}@127.0.0.1:${port}/postgres`,
  );
  let child: ReturnType<typeof spawn> | undefined;
  let exit: Promise<unknown> | undefined;
  const close = async () => {
    try {
      if (db.isInitialized) await db.destroy();
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGINT");
        const timer = setTimeout(() => child?.kill("SIGKILL"), 15000);
        try {
          await exit;
        } finally {
          clearTimeout(timer);
        }
      }
      await rm(dir, { recursive: true, force: true });
    }
  };
  try {
    await exec(
      join(bin, "initdb"),
      [
        "-D",
        join(dir, "pg"),
        "-U",
        "postgres",
        "--auth=scram-sha-256",
        `--pwfile=${pwfile}`,
        "--encoding=UTF8",
        "--no-locale",
      ],
      { timeout: 30000, maxBuffer: 1024 * 1024 },
    );
    await rm(pwfile);
    child = spawn(
      join(bin, "postgres"),
      ["-D", join(dir, "pg"), "-h", "127.0.0.1", "-p", String(port), "-k", dir],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let log = "";
    child.stderr?.on("data", (chunk) => {
      log = (log + String(chunk)).slice(-12000);
    });
    exit = once(child, "exit");
    exit.catch(() => {});
    for (let i = 0; i < 80; i++) {
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error(`Test Postgres failed: ${log}`);
      try {
        await db.initialize();
        return { db, close };
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    throw new Error(`Test Postgres did not start: ${log}`);
  } catch (error) {
    await close();
    throw error;
  }
}
