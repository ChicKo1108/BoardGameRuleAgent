import { readFile, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { curationSchemas as s } from "@boardgame/contracts";
import {
  CurationService,
  curationHash,
  curationSourceFingerprint,
} from "@boardgame/backend";
import { createDataSource } from "@boardgame/db";
async function read(path: string) {
  if ((await stat(path)).size > 16000000)
    throw new Error("CURATION_FILE_TOO_LARGE");
  return JSON.parse(await readFile(path, "utf8"));
}
try {
  const [command, path, other, key] = process.argv.slice(2);
  if (command === "fingerprint" && path) {
    const source = s.source.parse(await read(path));
    console.info(
      JSON.stringify({
        sourceFingerprint: curationSourceFingerprint(source),
        blocks: source.blocks.length,
      }),
    );
  } else if (command === "validate" && path) {
    const bundle = s.bundle.parse(await read(path));
    if (Buffer.byteLength(JSON.stringify(bundle)) > 900000)
      throw new Error("CURATION_BUNDLE_TOO_LARGE");
    if (
      other &&
      curationSourceFingerprint(await read(other)) !== bundle.sourceFingerprint
    )
      throw new Error("CURATION_SOURCE_MISMATCH");
    console.info(
      JSON.stringify({
        valid: true,
        bundleHash: curationHash(bundle),
        rules: bundle.rules.length,
        relations: bundle.relations.length,
        cases: bundle.cases.length,
        status: "draft-needs-review",
      }),
    );
  } else if (command === "import" && path && other && key) {
    const revisionId = z.uuid().parse(path),
      idempotencyKey = z.uuid().parse(key),
      bundle = s.bundle.parse(await read(other));
    const db = createDataSource(process.env.DATABASE_URL ?? "");
    try {
      await db.initialize();
      const result = await new CurationService(db).import(
        revisionId,
        { idempotencyKey, bundle },
        randomUUID(),
      );
      console.info(
        JSON.stringify({
          importId: result.id,
          revisionId: result.revisionId,
          bundleHash: result.bundleHash,
          rules: Object.keys(result.ruleMap).length,
          status: "pending",
        }),
      );
    } finally {
      if (db.isInitialized) await db.destroy();
    }
  } else
    throw new Error(
      "USAGE: curation fingerprint <private-source.json> | validate <private-bundle.json> [private-source.json] | import <revision-uuid> <private-bundle.json> <idempotency-uuid>",
    );
} catch (error) {
  console.error(
    error instanceof z.ZodError
      ? {
          code: "CURATION_VALIDATION_FAILED",
          issues: error.issues.map((i) => ({ path: i.path, code: i.code })),
        }
      : {
          code:
            error instanceof Error &&
            /^[A-Z0-9_ :<>.\[\]|-]+$/.test(error.message)
              ? error.message
              : "CURATION_COMMAND_FAILED",
        },
  );
  process.exitCode = 1;
}
