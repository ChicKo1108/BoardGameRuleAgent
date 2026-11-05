import "dotenv/config";
import { resolve, isAbsolute } from "node:path";
import { createDataSource } from "@boardgame/db";
import {
  connectQueue,
  IngestionService,
  LocalBlobStore,
  PythonPdfParser,
} from "@boardgame/backend";
if (process.argv.includes("--check")) {
  console.info(
    "Worker modules load. Use queue:setup once, then worker:start with DATABASE_URL, STORAGE_ROOT, PARSER_PYTHON and PARSER_SCRIPT.",
  );
} else {
  const db = createDataSource(process.env.DATABASE_URL ?? "");
  const setup = process.argv.includes("--setup");
  const queue = await connectQueue(process.env.DATABASE_URL ?? "", setup);
  try {
    if (!setup) {
      if (
        !process.env.STORAGE_ROOT ||
        !process.env.PARSER_SCRIPT ||
        !isAbsolute(process.env.STORAGE_ROOT) ||
        !isAbsolute(process.env.PARSER_SCRIPT)
      )
        throw new Error(
          "STORAGE_ROOT and PARSER_SCRIPT are required absolute paths",
        );
      await db.initialize();
      const service = new IngestionService(
        db,
        queue,
        new LocalBlobStore(process.env.STORAGE_ROOT),
        new PythonPdfParser(
          process.env.PARSER_PYTHON ?? "python3",
          resolve(process.env.PARSER_SCRIPT),
        ),
      );
      if (process.argv.includes("--once"))
        console.info(JSON.stringify({ processed: await service.workOnce() }));
      else {
        await service.start();
        console.info("PDF worker started");
        await new Promise<void>((r) => {
          process.once("SIGINT", r);
          process.once("SIGTERM", r);
        });
      }
    }
  } finally {
    await queue.stop({ graceful: true, timeout: 150000 });
    if (db.isInitialized) await db.destroy();
  }
}
