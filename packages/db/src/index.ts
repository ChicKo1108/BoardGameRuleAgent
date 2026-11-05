import "reflect-metadata";
import { DataSource } from "typeorm";
import { entities } from "./entities.ts";
import { KnowledgeStorage1793836800000 } from "./migrations/1793836800000-KnowledgeStorage.ts";
import { AdminAudit1793836801000 } from "./migrations/1793836801000-AdminAudit.ts";
import { PdfIngestion1793836802000 } from "./migrations/1793836802000-PdfIngestion.ts";
import { KnowledgeReleases1793836803000 } from "./migrations/1793836803000-KnowledgeReleases.ts";
import { VectorRetrieval1793836804000 } from "./migrations/1793836804000-VectorRetrieval.ts";
import { RetrievalEvaluations1793836805000 } from "./migrations/1793836805000-RetrievalEvaluations.ts";
import { AnswerRuns1793836806000 } from "./migrations/1793836806000-AnswerRuns.ts";
import { AnswerEvaluations1793836807000 } from "./migrations/1793836807000-AnswerEvaluations.ts";
import { KnowledgePublications1793836808000 } from "./migrations/1793836808000-KnowledgePublications.ts";
import { GuestSessions1793836809000 } from "./migrations/1793836809000-GuestSessions.ts";
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
      VectorRetrieval1793836804000,
      RetrievalEvaluations1793836805000,
      AnswerRuns1793836806000,
      AnswerEvaluations1793836807000,
      KnowledgePublications1793836808000,
      GuestSessions1793836809000,
    ],
    migrationsTransactionMode: "all",
    uuidExtension: "pgcrypto",
    installExtensions: false,
    extra: { max: 10, connectionTimeoutMillis: 5000, statement_timeout: 15000 },
  });
}
