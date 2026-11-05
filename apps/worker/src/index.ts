import "dotenv/config";
import { resolve, isAbsolute } from "node:path";
import { createDataSource } from "@boardgame/db";
import {
  connectQueue,
  IngestionService,
  LocalBlobStore,
  PythonPdfParser,
  VectorService,
  EvaluationService,
} from "@boardgame/backend";
import { embeddingProviderFromEnvironment } from "@boardgame/retrieval";
if (process.argv.includes("--check")) {
  console.info(
    "Worker modules load. Run queue:setup first. WORKER_TASKS selects pdf (default), vectors, evaluations, or a comma-separated combination.",
  );
} else {
  const db = createDataSource(process.env.DATABASE_URL ?? "");
  const setup = process.argv.includes("--setup");
  const queue = await connectQueue(process.env.DATABASE_URL ?? "", setup);
  try {
    if (!setup) {
      const tasks = new Set(
        (process.env.WORKER_TASKS ?? "pdf").split(",").map((s) => s.trim()),
      );
      if (
        [...tasks].some(
          (task) => !["pdf", "vectors", "evaluations"].includes(task),
        )
      )
        throw new Error(
          "WORKER_TASKS must contain pdf, vectors, or evaluations",
        );
      await db.initialize();
      const workers: Array<{
        start(): Promise<void>;
        workOnce(): Promise<number>;
      }> = [];
      if (tasks.has("pdf")) {
        if (
          !process.env.STORAGE_ROOT ||
          !process.env.PARSER_SCRIPT ||
          !isAbsolute(process.env.STORAGE_ROOT) ||
          !isAbsolute(process.env.PARSER_SCRIPT)
        )
          throw new Error(
            "STORAGE_ROOT and PARSER_SCRIPT must be absolute paths",
          );
        workers.push(
          new IngestionService(
            db,
            queue,
            new LocalBlobStore(process.env.STORAGE_ROOT),
            new PythonPdfParser(
              process.env.PARSER_PYTHON ?? "python3",
              resolve(process.env.PARSER_SCRIPT),
            ),
          ),
        );
      }
      if (tasks.has("vectors")) {
        const provider = embeddingProviderFromEnvironment();
        if (!provider)
          throw new Error(
            "EMBEDDING configuration is required for vectors worker",
          );
        workers.push(new VectorService(db, queue, provider));
      }
      if (tasks.has("evaluations")) {
        workers.push(
          new EvaluationService(
            db,
            queue,
            new VectorService(db, queue, embeddingProviderFromEnvironment()),
          ),
        );
      }
      if (process.argv.includes("--once")) {
        for (const worker of workers)
          console.info(JSON.stringify({ processed: await worker.workOnce() }));
      } else {
        for (const worker of workers) await worker.start();
        console.info(`Workers started: ${[...tasks].join(",")}`);
        await new Promise<void>((r) => {
          process.once("SIGINT", r);
          process.once("SIGTERM", r);
        });
      }
    }
  } finally {
    await queue.stop({ graceful: true, timeout: 160000 });
    if (db.isInitialized) await db.destroy();
  }
}
