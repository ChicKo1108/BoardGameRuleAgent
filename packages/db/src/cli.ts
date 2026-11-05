import "dotenv/config";
import { createDataSource } from "./index.js";
const action = process.argv[2];
if (!["up", "down", "status"].includes(action ?? "")) throw new Error("Usage: db:migrate | db:revert | db:status");
const db = createDataSource(process.env.DATABASE_URL ?? "");
try {
  await db.initialize();
  if (action === "up") console.info((await db.runMigrations()).map(m => m.name));
  if (action === "down") { await db.undoLastMigration(); console.info("Last migration reverted"); }
  if (action === "status") console.info({ pending: await db.showMigrations() });
} finally { if (db.isInitialized) await db.destroy(); }
