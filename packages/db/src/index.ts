import "reflect-metadata";
import { DataSource } from "typeorm";

// Explicit factory: importing this module never opens a database connection.
export function createDataSource(databaseUrl: string): DataSource {
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  return new DataSource({
    type: "postgres",
    url: databaseUrl,
    synchronize: false,
    migrationsRun: false,
    logging: false,
    entities: [],
    migrations: [],
  });
}
