import "reflect-metadata";
import { DataSource } from "typeorm";
import { entities } from "./entities.ts";
import { KnowledgeStorage1793836800000 } from "./migrations/1793836800000-KnowledgeStorage.ts";
import { AdminAudit1793836801000 } from "./migrations/1793836801000-AdminAudit.ts";
import { PdfIngestion1793836802000 } from "./migrations/1793836802000-PdfIngestion.ts";
import { KnowledgeReleases1793836803000 } from "./migrations/1793836803000-KnowledgeReleases.ts";
export * from "./entities.ts";
export * from "./knowledge-repository.ts";

export function createDataSource(databaseUrl: string): DataSource {
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const url = new URL(databaseUrl);
  if (!["postgres:", "postgresql:"].includes(url.protocol))
    throw new Error("DATABASE_URL must use PostgreSQL");
  return new DataSource({
    type: "postgres",
    url: databaseUrl,
    synchronize: false,
    migrationsRun: false,
    logging: false,
    entities,
    migrations: [
      KnowledgeStorage1793836800000,
      AdminAudit1793836801000,
      PdfIngestion1793836802000,
      KnowledgeReleases1793836803000,
    ],
    migrationsTransactionMode: "all",
    uuidExtension: "pgcrypto",
    installExtensions: false,
    extra: { max: 10, connectionTimeoutMillis: 5000, statement_timeout: 15000 },
  });
}
