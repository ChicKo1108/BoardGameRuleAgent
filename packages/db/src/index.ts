import "reflect-metadata";
import { DataSource } from "typeorm";
import { entities } from "./entities.js";
import { KnowledgeStorage1793836800000 } from "./migrations/1793836800000-KnowledgeStorage.js";
export * from "./entities.js";
export * from "./knowledge-repository.js";

export function createDataSource(databaseUrl: string): DataSource {
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const url = new URL(databaseUrl);
  if (!["postgres:", "postgresql:"].includes(url.protocol)) throw new Error("DATABASE_URL must use PostgreSQL");
  return new DataSource({
    type: "postgres", url: databaseUrl, synchronize: false, migrationsRun: false, logging: false,
    entities, migrations: [KnowledgeStorage1793836800000],
    migrationsTransactionMode: "all", uuidExtension: "pgcrypto", installExtensions: false,
    extra: { max: 10, connectionTimeoutMillis: 5000, statement_timeout: 15000 },
  });
}
