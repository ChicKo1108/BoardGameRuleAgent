import { VectorService } from "@boardgame/backend";
import { embeddingProviderFromEnvironment } from "@boardgame/retrieval";
import { getDatabase } from "./database";
import { getQueue } from "./queue";
export async function getVectors() {
  return new VectorService(
    await getDatabase(),
    await getQueue(),
    embeddingProviderFromEnvironment(),
  );
}
