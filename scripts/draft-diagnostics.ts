import { readFile, stat, writeFile } from "node:fs/promises";
import { z } from "zod";
import { diagnoseDraft } from "@boardgame/backend";
import { createDataSource } from "@boardgame/db";
import { testDatabase } from "../tests/helpers/database.js";
async function json(path: string) {
  if ((await stat(path)).size > 16000000)
    throw new Error("DIAGNOSTIC_FILE_TOO_LARGE");
  return JSON.parse(await readFile(path, "utf8"));
}
try {
  const [bundlePath, sourcePath, configPath, outputPath, ...flags] =
    process.argv.slice(2);
  if (
    !bundlePath ||
    !sourcePath ||
    !configPath ||
    !outputPath ||
    flags.some((f) => f !== "--isolated") ||
    flags.length > 1
  )
    throw new Error("DIAGNOSTIC_ARGUMENTS_REQUIRED");
  const isolated = flags[0] === "--isolated",
    fixture = isolated ? await testDatabase() : null,
    db = fixture?.db ?? createDataSource(process.env.DATABASE_URL ?? "");
  try {
    if (!db.isInitialized) await db.initialize();
    const report = await diagnoseDraft(
      db,
      await json(bundlePath),
      await json(sourcePath),
      await json(configPath),
    );
    await writeFile(outputPath, JSON.stringify(report, null, 2), {
      mode: 0o600,
      flag: "wx",
    });
    console.info(
      JSON.stringify({
        runId: report.runId,
        kind: report.kind,
        publishable: false,
        config: report.config,
        summary: report.summary,
        sourceFingerprint: report.sourceFingerprint,
      }),
    );
  } finally {
    if (fixture) await fixture.close();
    else if (db.isInitialized) await db.destroy();
  }
} catch (error) {
  console.error(
    error instanceof z.ZodError
      ? {
          code: "DRAFT_DIAGNOSTIC_VALIDATION_FAILED",
          issues: error.issues.map((i) => ({ code: i.code, path: i.path })),
        }
      : {
          code:
            error instanceof Error && /^[A-Z0-9_]+$/.test(error.message)
              ? error.message
              : "DRAFT_DIAGNOSTIC_FAILED",
        },
  );
  process.exitCode = 1;
}
