import { createDataSource } from "@boardgame/db";
import type { DataSource } from "typeorm";
const state = globalThis as typeof globalThis & {
  boardgameDb?: Promise<DataSource>;
};
export async function getDatabase(): Promise<DataSource> {
  if (!state.boardgameDb) {
    state.boardgameDb = (async () => {
      const db = createDataSource(process.env.DATABASE_URL ?? "");
      await db.initialize();
      return db;
    })();
    state.boardgameDb.catch(() => {
      state.boardgameDb = undefined;
    });
  }
  return state.boardgameDb;
}
