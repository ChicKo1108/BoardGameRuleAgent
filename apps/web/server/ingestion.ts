import {
  connectQueue,
  IngestionService,
  LocalBlobStore,
  PythonPdfParser,
} from "@boardgame/backend";
import { getDatabase } from "./database";
import { isAbsolute } from "node:path";
const state = globalThis as typeof globalThis & {
  boardgameIngestion?: Promise<IngestionService>;
};
export function getIngestion(): Promise<IngestionService> {
  if (!state.boardgameIngestion) {
    state.boardgameIngestion = (async () => {
      const root = process.env.STORAGE_ROOT;
      const script = process.env.PARSER_SCRIPT;
      if (!root || !script || !isAbsolute(root) || !isAbsolute(script))
        throw new Error("Absolute STORAGE_ROOT and PARSER_SCRIPT are required");
      const db = await getDatabase();
      const queue = await connectQueue(process.env.DATABASE_URL ?? "");
      return new IngestionService(
        db,
        queue,
        new LocalBlobStore(root),
        new PythonPdfParser(process.env.PARSER_PYTHON ?? "python3", script),
      );
    })();
    state.boardgameIngestion.catch(() => {
      state.boardgameIngestion = undefined;
    });
  }
  return state.boardgameIngestion;
}
